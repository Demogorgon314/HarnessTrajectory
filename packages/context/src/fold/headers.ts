/**
 * Vendored from dsh-context `src/host/headers.ts` (Apache-2.0, see ../../NOTICE):
 * the FOLD half only — the zod state/wire schemas and the projection-definition
 * wrapper are gone (this package has no validator dependency and no projection
 * registry; `ContextSession` drives the fold directly).
 *
 * The request-header EPOCH METADATA behind the timeline's envelope figures.
 *
 * The timeline fold carries only token prices of the system prompt and tool
 * schemas; this companion fold keeps the per-epoch METADATA (epoch seq/time
 * boundaries, per-tool token prices and plugin attribution) so the Context
 * browser can pick the header epoch in force at any step and size its sections
 * immediately. The epoch CONTENT (full system prompt text, full tool JSON
 * schemas) deliberately does NOT ride the view — `ContextSession` keeps it in
 * its own per-file map and serves it through `headerContentOf(fileId, seq)`.
 *
 * Same contract as the timeline fold: pure init/apply/view, `Object.is`
 * reference stability for uninteresting events, bounded plain-JSON state (the
 * epoch list is capped — see HEADERS_MAX).
 */

import type { ContextHeaders, HeaderRecord, HeaderTool } from '../shared/types.ts'
import type { TimelineEvent } from './event.ts'
import { estimateToolSchema } from './pricing.ts'
import { estimateSystemTokens } from '../shared/estimate.ts'

/**
 * Retention cap on header epochs (metadata only; changes are rare). dsh
 * capped at 50 for wire size; a local viewer keeps the whole session, and a
 * Claude transcript records a `prompt_snapshot` epoch far more often than dsh
 * logged a header — 500 keeps every realistic session whole.
 */
export const HEADERS_MAX = 500

/**
 * One stored tool. `description`/`schema` are accepted on the shape but never
 * written by this fold: the epoch CONTENT lives in `ContextSession`.
 */
export interface StoredHeaderTool {
  name: string
  tokens: number
  description?: string
  plugin?: string
  schema?: unknown
}

/** One stored epoch. `system` is the legacy content-bearing spelling (accepted, never written). */
export interface StoredHeaderRecord {
  seq: number
  time: number
  system?: string
  systemTokens?: number
  tools: StoredHeaderTool[]
}

export interface HeadersState {
  headers: StoredHeaderRecord[]
}

/** Best-effort tool → producer attribution, applied at view time (see toolSources.ts). */
export type ToolSourceResolver = (name: string) => string | undefined

function recordOf(event: TimelineEvent): StoredHeaderRecord | null {
  if (event.type !== 'request/header') return null
  const rawHeader = event.data?.header
  if (rawHeader === null || rawHeader === undefined || typeof rawHeader !== 'object') return null
  const header = rawHeader as { system?: unknown; tools?: unknown[] }
  const tools = Array.isArray(header.tools) ? header.tools : []
  const record: StoredHeaderRecord = {
    seq: event.seq,
    time: event.time,
    tools: tools.map((t): StoredHeaderTool => {
      // The transcript is untrusted input: a null or primitive entry degrades
      // to an unnamed, JSON-priced tool instead of throwing the fold.
      const tool = (t !== null && typeof t === 'object' ? t : {}) as { name?: unknown; plugin?: unknown }
      const entry: StoredHeaderTool = {
        name: typeof tool.name === 'string' ? tool.name : '?',
        tokens: estimateToolSchema(t),
      }
      // An attribution carried by the raw entry is kept verbatim so the
      // view-time resolver never overrides it.
      if (typeof tool.plugin === 'string' && tool.plugin !== '') {
        entry.plugin = tool.plugin
      }
      return entry
    }),
  }
  if (typeof header.system === 'string' && header.system.length > 0) {
    record.systemTokens = estimateSystemTokens(header.system)
  }
  return record
}

export function createHeadersState(): HeadersState {
  return { headers: [] }
}

/**
 * Fold one event into the header-epoch metadata. Returns the SAME reference
 * for every event that is not a readable `request/header` (callers gate their
 * change feed on `Object.is`).
 */
export function applyHeaders(state: HeadersState, event: TimelineEvent): HeadersState {
  const record = recordOf(event)
  if (record === null) return state
  // A cheap guard against the same epoch arriving twice in a row (a resume
  // replay, or a synthesizer re-emitting its opening header).
  const last = state.headers.at(-1)
  if (last !== undefined && last.seq === record.seq) return state
  const headers = [...state.headers, record]
  return { headers: headers.length > HEADERS_MAX ? headers.slice(-HEADERS_MAX) : headers }
}

/**
 * The served epoch list: metadata only, as COPIES (the served value must
 * never alias the fold state). A legacy content-bearing record is normalized
 * here — its system text is priced at read time and stripped.
 *
 * @param resolve - best-effort tool-to-plugin attribution (see toolSources.ts);
 * fills a missing `plugin` at view time so epochs folded without attribution
 * still render a tag when the source is known.
 */
export function buildHeadersView(state: HeadersState, resolve?: ToolSourceResolver): ContextHeaders {
  return {
    headers: state.headers.map((h): HeaderRecord => {
      const record: HeaderRecord = {
        seq: h.seq,
        time: h.time,
        tools: h.tools.map((t): HeaderTool => {
          const entry: HeaderTool = { name: t.name, tokens: t.tokens }
          const plugin = t.plugin ?? (resolve !== undefined ? resolve(t.name) : undefined)
          if (plugin !== undefined) entry.plugin = plugin
          return entry
        }),
      }
      const systemTokens = h.systemTokens
        ?? (typeof h.system === 'string' && h.system !== '' ? estimateSystemTokens(h.system) : undefined)
      if (systemTokens !== undefined) record.systemTokens = systemTokens
      return record
    }),
  }
}
