/**
 * `ContextSession` — the Context tab's data plane.
 *
 * One session = one main transcript file plus every child (subagent) file.
 * Each file is folded SEPARATELY: a subagent is its own context, with its own
 * system prompt, tool schemas, surface and request history, exactly like a
 * separate session. The session is fed the same JSONL lines the trajectory
 * parser already receives (`apps/web/src/session-runtime.ts`), so the Context
 * tab costs one extra fold, not a second stream.
 *
 * Per file the session owns:
 *   - an {@link EventSynthesizer} (the harness→event adapter),
 *   - the timeline fold state (`./fold.ts`) and the header-epoch fold state
 *     (`./headers.ts`),
 *   - the CONTENT the fold deliberately does not keep: the fold prices nodes
 *     and forgets their text, but the browser must show it, so the synthesized
 *     content blocks are retained per seq. The strings are already in memory
 *     as transcript lines; retaining one reference each costs nothing more.
 *
 * `timelineOf` / `headersOf` are revision-memoized: repeated calls return the
 * SAME object until that file's fold state actually changes, so a React store
 * can use them as identity-stable props.
 */

import type { HarnessKind, SessionFileRef } from '@harness-trajectory/core'
import type { ContextHeaders, ContextTimeline, HeaderEpochContent } from '../shared/types.ts'
import type { ContentBlock, TimelineEvent } from './event.ts'
import type { EventSynthesizer, SynthesizerFactory, SynthMeta } from '../synth/types.ts'
import { createSynthesizer } from '../synth/index.ts'
import type { Config, FoldBounds } from './config.ts'
import { resolveBounds } from './config.ts'
import { defaultCostPeriod, type CostPeriodResolver } from '../shared/pricingRules.ts'
import type { TimelineState } from './fold.ts'
import { applyTimeline, buildTimelineView, createTimelineState } from './fold.ts'
import type { HeadersState, ToolSourceResolver } from './headers.ts'
import { applyHeaders, buildHeadersView, createHeadersState } from './headers.ts'
import { toolSourceOf } from './toolSources.ts'

export interface ContextSessionOptions {
  /** Retention bounds for every file's fold (defaults: config.ts DEFAULT_BOUNDS). */
  bounds?: Config
  /** Tool → producer attribution applied to the header views (default: MCP servers). */
  resolveToolSource?: ToolSourceResolver
  /**
   * Which pricing period a billed request books under (default: DeepSeek's
   * period-based list, everything else `peak`). Pass
   * `makeCostPeriod(settings.modelPricing)` to honor the user's price rules;
   * changing the resolver only takes effect through a refold.
   */
  costPeriod?: CostPeriodResolver
}

interface FileFold {
  file: SessionFileRef
  synth: EventSynthesizer
  timeline: TimelineState
  headers: HeadersState
  /** Synthesized message content by event seq (the browser's per-node body). */
  content: Map<number, ContentBlock[]>
  /** Synthesized header-epoch content by `request/header` seq. */
  headerContent: Map<number, HeaderEpochContent>
  /** Bumps whenever this file's fold state changes (drives the view memos). */
  rev: number
  timelineView?: { rev: number; value: ContextTimeline }
  headersView?: { rev: number; value: ContextHeaders }
}

/** The content blocks one event carries, or null when it carries none. */
function contentOfEvent(event: TimelineEvent): ContentBlock[] | null {
  const data = event.data
  if (data === undefined) return null
  if (event.type === 'user/message') {
    return Array.isArray(data.content) ? data.content as ContentBlock[] : null
  }
  if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'system/message') {
    const message = data.message
    if (message === null || message === undefined || typeof message !== 'object') return null
    const content = (message as { content?: unknown }).content
    return Array.isArray(content) ? content as ContentBlock[] : null
  }
  return null
}

/**
 * The full text + tool schemas one `request/header` carried — what the
 * browser's System and Tool Schemas sections render. `parameters` is the
 * schema field of the event contract; `schema` / `input_schema` are accepted
 * as the spellings a foreign producer may use.
 */
function headerContentOfEvent(event: TimelineEvent): HeaderEpochContent | null {
  if (event.type !== 'request/header') return null
  const rawHeader = event.data?.header
  if (rawHeader === null || rawHeader === undefined || typeof rawHeader !== 'object') return null
  const header = rawHeader as { system?: unknown; tools?: unknown }
  const rawTools = Array.isArray(header.tools) ? header.tools : []
  const tools: HeaderEpochContent['tools'] = rawTools.map(t => {
    const tool = (t !== null && typeof t === 'object' ? t : {}) as {
      name?: unknown
      description?: unknown
      parameters?: unknown
      schema?: unknown
      input_schema?: unknown
    }
    const entry: HeaderEpochContent['tools'][number] = {
      name: typeof tool.name === 'string' ? tool.name : '?',
    }
    if (typeof tool.description === 'string' && tool.description !== '') entry.description = tool.description
    const schema = tool.parameters ?? tool.schema ?? tool.input_schema
    if (schema !== undefined) entry.schema = schema
    return entry
  })
  const content: HeaderEpochContent = { tools }
  if (typeof header.system === 'string' && header.system !== '') content.system = header.system
  return content
}

export class ContextSession {
  readonly kind: HarnessKind

  private readonly factory: SynthesizerFactory
  private readonly bounds: FoldBounds
  private readonly resolveToolSource: ToolSourceResolver
  private readonly costPeriod: CostPeriodResolver
  private readonly folds = new Map<string, FileFold>()
  private filesCache: readonly SessionFileRef[] | null = null
  private rev = 0

  /**
   * @param kind - the harness whose synthesizer folds this session's files.
   * @param factory - synthesizer factory override (tests inject a fake one);
   * defaults to the registry in `../synth/index.ts`.
   */
  constructor(kind: HarnessKind, factory?: SynthesizerFactory, options: ContextSessionOptions = {}) {
    this.kind = kind
    this.factory = factory ?? (file => createSynthesizer(kind, file))
    this.bounds = resolveBounds(options.bounds)
    this.resolveToolSource = options.resolveToolSource ?? toolSourceOf
    this.costPeriod = options.costPeriod ?? defaultCostPeriod
  }

  /** Bumps on every change to any file's fold — the UI store's dirty marker. */
  get revision(): number {
    return this.rev
  }

  /** The session's files in first-seen order, main transcripts first. */
  files(): readonly SessionFileRef[] {
    if (this.filesCache === null) {
      const main: SessionFileRef[] = []
      const children: SessionFileRef[] = []
      for (const fold of this.folds.values()) {
        if (fold.file.role === 'main') main.push(fold.file)
        else children.push(fold.file)
      }
      this.filesCache = [...main, ...children]
    }
    return this.filesCache
  }

  /**
   * Feed one raw JSONL line of `file`. Malformed lines fold to nothing; a
   * synthesizer that throws is contained here rather than taking the tab down.
   */
  push(line: string, file: SessionFileRef): void {
    const fold = this.foldFor(file)
    let events: readonly TimelineEvent[]
    try {
      events = fold.synth.push(line)
    } catch {
      return
    }
    for (const event of events) {
      const timeline = applyTimeline(fold.timeline, event, this.bounds, this.costPeriod)
      if (timeline !== fold.timeline) {
        fold.timeline = timeline
        fold.rev++
      }
      const headers = applyHeaders(fold.headers, event)
      if (headers !== fold.headers) {
        fold.headers = headers
        fold.rev++
      }
      const content = contentOfEvent(event)
      if (content !== null) {
        fold.content.set(event.seq, content)
        fold.rev++
      }
      const headerContent = headerContentOfEvent(event)
      if (headerContent !== null) {
        fold.headerContent.set(event.seq, headerContent)
        fold.rev++
      }
    }
    // The synthesizer's own meta (model, label, running, children, cost) can
    // move without any event folding, so a delivered line always bumps the
    // session revision even when the fold stayed put.
    this.rev++
  }

  /**
   * The whole timeline value of one file (head scalars + collections), or
   * null for a file this session has never seen. Memoized: the SAME object
   * comes back until that file's fold state changes.
   */
  timelineOf(fileId: string): ContextTimeline | null {
    const fold = this.folds.get(fileId)
    if (fold === undefined) return null
    const cached = fold.timelineView
    if (cached !== undefined && cached.rev === fold.rev) return cached.value
    const value = buildTimelineView(fold.timeline, this.bounds)
    fold.timelineView = { rev: fold.rev, value }
    return value
  }

  /** The header-epoch metadata of one file, memoized like {@link timelineOf}. */
  headersOf(fileId: string): ContextHeaders | null {
    const fold = this.folds.get(fileId)
    if (fold === undefined) return null
    const cached = fold.headersView
    if (cached !== undefined && cached.rev === fold.rev) return cached.value
    const value = buildHeadersView(fold.headers, this.resolveToolSource)
    fold.headersView = { rev: fold.rev, value }
    return value
  }

  /** The retained content blocks of one folded node, or null when none were kept. */
  contentOf(fileId: string, seq: number): ContentBlock[] | null {
    return this.folds.get(fileId)?.content.get(seq) ?? null
  }

  /** The retained system text + tool schemas of one header epoch, or null. */
  headerContentOf(fileId: string, seq: number): HeaderEpochContent | null {
    return this.folds.get(fileId)?.headerContent.get(seq) ?? null
  }

  /** The synthesizer's live metadata for one file (model, label, children, …). */
  metaOf(fileId: string): SynthMeta | null {
    const fold = this.folds.get(fileId)
    if (fold === undefined) return null
    try {
      return fold.synth.meta()
    } catch {
      return null
    }
  }

  private foldFor(file: SessionFileRef): FileFold {
    const existing = this.folds.get(file.id)
    if (existing !== undefined) {
      // Later `lines` events may carry a richer ref for the same file (a
      // child that only learns its parent once the spawning call settles).
      if (existing.file !== file) {
        existing.file = file
        this.filesCache = null
      }
      return existing
    }
    const fold: FileFold = {
      file,
      synth: this.factory(file),
      timeline: createTimelineState(),
      headers: createHeadersState(),
      content: new Map<number, ContentBlock[]>(),
      headerContent: new Map<number, HeaderEpochContent>(),
      rev: 0,
    }
    this.folds.set(file.id, fold)
    this.filesCache = null
    this.rev++
    return fold
  }
}
