/**
 * Sidebar "Content matches": full-text hits from the server's transcript
 * index, under the instant metadata filter.
 *
 * The metadata filter stays what it always was — a synchronous scan of the
 * loaded listing rows. This section is the slow half: it debounces, asks
 * `/api/search`, and aborts whatever is in flight as soon as the query moves
 * on, so only the newest query can ever paint.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  SEARCH_MIN_QUERY_LENGTH,
  type HarnessKind, type SearchHit, type SearchMatchRange, type SearchResponse, type SearchSessionGroup,
} from '@harness-trajectory/core'
import { searchSessions } from './api.ts'
import type { Route } from './App.tsx'
import { HarnessMark, harnessMeta } from './harnesses.tsx'
import { relativeTime } from './SessionList.tsx'
import css from './app.module.css'

/** Keystrokes settle for this long before a request goes out. */
export const SEARCH_DEBOUNCE_MS = 200

export type ContentSearchStatus = 'idle' | 'searching' | 'ready' | 'error'

export interface ContentSearchState {
  status: ContentSearchStatus
  /** Last answered response; kept while a newer query is in flight so the section never blanks. */
  response: SearchResponse | null
  error: string | null
  /** The floor the gate uses: the server's `minLength` once it has answered. */
  minLength: number
}

interface ContentSearchResult {
  status: ContentSearchStatus
  response: SearchResponse | null
  error: string | null
}

const IDLE: ContentSearchResult = { status: 'idle', response: null, error: null }

export interface ContentSearchOptions {
  debounceMs?: number | undefined
  /** Cap handed to the server; omitted, the server picks. */
  limit?: number | undefined
}

/**
 * Debounced, abortable content search for one query.
 *
 * The endpoint narrows to at most one harness, so a single selected kind
 * travels with the request and a wider selection is filtered on the client.
 */
export function useContentSearch(
  query: string,
  kinds: ReadonlySet<HarnessKind>,
  options: ContentSearchOptions = {},
): ContentSearchState {
  const debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS
  const limit = options.limit
  const needle = query.trim()
  const onlyKind = kinds.size === 1 ? [...kinds][0] : undefined
  const [minLength, setMinLength] = useState(SEARCH_MIN_QUERY_LENGTH)
  const [result, setResult] = useState<ContentSearchResult>(IDLE)

  useEffect(() => {
    if (needle.length < minLength) {
      // A stable object: re-setting it is a no-op re-render for React.
      setResult(IDLE)
      return
    }
    const controller = new AbortController()
    let live = true
    setResult(current => (current.status === 'searching' ? current : { ...current, status: 'searching' }))
    const timer = setTimeout(() => {
      searchSessions({
        q: needle,
        ...(onlyKind === undefined ? {} : { kind: onlyKind }),
        ...(limit === undefined ? {} : { limit }),
        signal: controller.signal,
      }).then((response) => {
        if (!live) return
        // The server's floor wins from here on; a nonsense value keeps ours.
        if (Number.isFinite(response.minLength) && response.minLength > 0) setMinLength(response.minLength)
        setResult({ status: 'ready', response, error: null })
      }).catch((error: unknown) => {
        // An aborted request was superseded, never a failure to report.
        if (!live || controller.signal.aborted) return
        setResult({ status: 'error', response: null, error: error instanceof Error ? error.message : String(error) })
      })
    }, debounceMs)
    return () => {
      live = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [needle, onlyKind, minLength, debounceMs, limit])

  return { ...result, minLength }
}

export interface SnippetSegment {
  text: string
  /** Whether this run is one of the server's match ranges. */
  marked: boolean
}

/**
 * Cut a snippet into plain and highlighted runs from the server's offsets.
 * The text is never re-searched: out-of-range offsets clamp, empty ones drop,
 * and overlapping or touching ranges merge into one run.
 */
export function snippetSegments(
  snippet: string,
  matches: readonly SearchMatchRange[],
): SnippetSegment[] {
  const clamped = matches
    .map(range => ({
      start: Math.min(Math.max(0, range.start), snippet.length),
      end: Math.min(Math.max(0, range.end), snippet.length),
    }))
    .filter(range => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: SearchMatchRange[] = []
  for (const range of clamped) {
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end }
      continue
    }
    merged.push(range)
  }
  const segments: SnippetSegment[] = []
  let at = 0
  for (const range of merged) {
    if (range.start > at) segments.push({ text: snippet.slice(at, range.start), marked: false })
    segments.push({ text: snippet.slice(range.start, range.end), marked: true })
    at = range.end
  }
  if (at < snippet.length) segments.push({ text: snippet.slice(at), marked: false })
  return segments
}

/** Last path segment of the project a session ran in. */
function projectBasename(cwd: string | undefined): string | null {
  if (cwd === undefined || cwd === '') return null
  const parts = cwd.split('/').filter(part => part !== '')
  return parts.at(-1) ?? cwd
}

/** The address a hit opens: the session, its child transcript, and the record. */
export function hitRoute(hit: SearchHit): Route {
  return {
    kind: hit.kind,
    id: hit.sessionId,
    // The main transcript is addressed as the session itself; only a child
    // transcript becomes a `file` of its own.
    ...(hit.fileId === hit.sessionId ? {} : { file: hit.fileId }),
    line: hit.line,
  }
}

function Snippet({ hit }: { hit: SearchHit }) {
  const segments = useMemo(() => snippetSegments(hit.snippet, hit.matches), [hit.snippet, hit.matches])
  return (
    <span className={css.matchSnippet}>
      {segments.map((segment, index) => segment.marked
        // Segments are positional, so the offset is the only stable key.
        ? <mark key={index} className={css.matchMark}>{segment.text}</mark>
        : <span key={index}>{segment.text}</span>)}
    </span>
  )
}

function MatchGroup({ group, selected, onSelect }: {
  group: SearchSessionGroup
  selected: Route | null
  onSelect: (route: Route) => void
}) {
  const meta = harnessMeta(group.kind)
  const project = projectBasename(group.cwd)
  const active = selected !== null && selected.kind === group.kind && selected.id === group.sessionId
  return (
    <section className={css.matchGroup}>
      <button
        type="button"
        className={css.matchSessionRow}
        data-active={active || undefined}
        title={[group.title, meta.label, group.cwd ?? '', group.sessionId].filter(part => part !== '').join('\n')}
        onClick={() => { onSelect({ kind: group.kind, id: group.sessionId }) }}
      >
        <span className={css.slot} data-role="mark" aria-label={meta.label}>
          <HarnessMark kind={group.kind} size={14} />
        </span>
        <span className={css.title}>{group.title}</span>
        {project !== null && <span className={css.matchProject}>{project}</span>}
        <span className={css.matchCount}>{group.hitCount}</span>
      </button>
      {group.hits.map(hit => (
        <button
          key={`${hit.fileId}:${hit.line}`}
          type="button"
          className={css.matchHitRow}
          title={hit.snippet}
          onClick={() => { onSelect(hitRoute(hit)) }}
        >
          <span className={css.matchRole} data-role={hit.role}>{hit.role}</span>
          <Snippet hit={hit} />
          {hit.timeMs !== undefined && <span className={css.time}>{relativeTime(hit.timeMs)}</span>}
        </button>
      ))}
    </section>
  )
}

export interface SessionSearchProps {
  /** The raw sidebar query; the same string the metadata filter reads. */
  query: string
  /** The harness filter in force; one kind narrows the request itself. */
  kinds: ReadonlySet<HarnessKind>
  selected: Route | null
  onSelect: (route: Route) => void
  debounceMs?: number | undefined
  limit?: number | undefined
}

export function SessionSearch({ query, kinds, selected, onSelect, debounceMs, limit }: SessionSearchProps) {
  const { status, response, error, minLength } = useContentSearch(query, kinds, {
    ...(debounceMs === undefined ? {} : { debounceMs }),
    ...(limit === undefined ? {} : { limit }),
  })
  const groups = useMemo(() => {
    // A disabled index has nothing to say, whatever it shipped in `groups`.
    const all = response === null || !response.enabled ? [] : response.groups
    // One kind already narrowed the request; a wider selection filters here.
    return kinds.size <= 1 ? all : all.filter(group => kinds.has(group.kind))
  }, [response, kinds])

  // Below the floor the section is not part of the sidebar at all.
  if (query.trim().length < minLength) return null

  const searching = status === 'searching'
  const disabled = response !== null && !response.enabled
  const indexing = response !== null && response.enabled && !response.indexing.ready
  return (
    <div className={css.matches} aria-label="Content matches">
      <div className={css.matchesHeader}>
        <span className={css.matchesTitle}>Content matches</span>
        {searching && <span className={css.matchesNote}>Searching…</span>}
        {!searching && response !== null && response.enabled && (
          <span className={css.matchesNote}>
            {response.totalHits}
            {response.truncated ? '+' : ''}
          </span>
        )}
      </div>
      {error !== null && <div className={css.matchesState} data-tone="error">{error}</div>}
      {disabled && <div className={css.matchesState}>Search index disabled</div>}
      {indexing && (
        <div className={css.matchesState}>
          Index building…
          {response.indexing.pendingFiles > 0 && ` ${response.indexing.pendingFiles} files left`}
        </div>
      )}
      {groups.map(group => (
        <MatchGroup
          key={`${group.kind}/${group.sessionId}`}
          group={group}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
      {!searching && error === null && !disabled && response !== null && groups.length === 0 && (
        <div className={css.matchesState}>No content matches</div>
      )}
    </div>
  )
}
