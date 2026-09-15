/**
 * Reading side of the search index: one FTS5 MATCH, ranked by bm25 and grouped
 * by session.
 *
 * The user's string is always sent as a single FTS5 **phrase** (`"..."`, with
 * embedded double quotes doubled), so every character is literal and the
 * trigram tokenizer turns it into a plain substring match — no operators, no
 * injection, no surprise when someone searches for `AND`, `-p`, or `a*b`.
 *
 * Trigram cannot index fewer than three characters, so a shorter query returns
 * no groups and reports `minLength: 3`; the UI asks for one more character
 * rather than falling back to a full `LIKE` scan over hundreds of megabytes.
 */

import {
  SEARCH_DEFAULT_LIMIT, SEARCH_GROUP_HIT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MIN_QUERY_LENGTH,
  type HarnessKind, type SearchHit, type SearchMatchRange, type SearchResponse,
  type SearchRole, type SearchSessionGroup,
} from '@harness-trajectory/core'
import type { SearchStore } from './store.ts'

/** Sentinel characters `snippet()` wraps matches in; stripped from indexed text. */
const MARK_START = '\u0002'
const MARK_END = '\u0003'

/**
 * Width of the returned snippet, in FTS5 tokens. Under the trigram tokenizer a
 * token starts at every character, so this is roughly a **character** budget,
 * not a word one, so it buys a line of context rather than a page of it.
 * Raising it costs nothing but response size.
 */
const SNIPPET_TOKENS = 64

/** Listing facts the index knows but the search tables do not. */
export interface SearchSessionFacts {
  title: string
  cwd?: string
  updatedAt?: number
}

export interface SearchOptions {
  q: string
  kind?: HarnessKind
  /** Maximum hits across all sessions; clamped to `SEARCH_MAX_LIMIT`. */
  limit?: number
  /** Session title/cwd/updatedAt lookup, normally `SessionIndex.get`. */
  describe?: (kind: HarnessKind, sessionId: string) => SearchSessionFacts | undefined
  indexing?: { pendingFiles: number; ready: boolean }
}

const ROLES: ReadonlySet<string> = new Set(['human', 'assistant', 'tool', 'other'])

function asRole(value: unknown): SearchRole {
  return typeof value === 'string' && ROLES.has(value) ? (value as SearchRole) : 'other'
}

function asInt(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Wrap the user's string as one FTS5 phrase; embedded `"` doubles. */
export function toPhraseQuery(q: string): string {
  return `"${q.replace(/"/g, '""')}"`
}

/**
 * Pull the `snippet()` markers back out, returning the clean text and the
 * character ranges they enclosed.
 */
export function splitMarkers(marked: string): { snippet: string; matches: SearchMatchRange[] } {
  let snippet = ''
  const matches: SearchMatchRange[] = []
  let start: number | null = null
  for (const char of marked) {
    if (char === MARK_START) {
      start ??= snippet.length
      continue
    }
    if (char === MARK_END) {
      if (start !== null) matches.push({ start, end: snippet.length })
      start = null
      continue
    }
    snippet += char
  }
  if (start !== null) matches.push({ start, end: snippet.length })
  return { snippet, matches }
}

/** The ranked hit query; the kind filter is applied while the FTS scan runs. */
function sql(byKind: boolean): string {
  return `
    select
      d.kind        as kind,
      d.session_id  as session_id,
      d.file_id     as file_id,
      d.line        as line,
      d.role        as role,
      d.time_ms     as time_ms,
      snippet(docs_fts, 0, char(2), char(3), '\u2026', ${SNIPPET_TOKENS}) as marked,
      rank          as score
    from docs_fts
    join docs d on d.id = docs_fts.rowid
    where docs_fts match ?${byKind ? ' and d.kind = ?' : ''}
    order by rank
    limit ?
  `
}

/** Per-session totals, so a group's badge is not the page slice. */
function countSql(byKind: boolean): string {
  return `
    select d.kind as kind, d.session_id as session_id, count(*) as n
    from docs_fts
    join docs d on d.id = docs_fts.rowid
    where docs_fts match ?${byKind ? ' and d.kind = ?' : ''}
    group by d.kind, d.session_id
  `
}

/** Run one search over the index. Never throws: a broken query returns no groups. */
export function search(store: SearchStore, options: SearchOptions): SearchResponse {
  const q = options.q.trim()
  const limit = Math.max(1, Math.min(options.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT))
  const indexing = options.indexing ?? { pendingFiles: 0, ready: true }
  const empty: SearchResponse = {
    enabled: true,
    query: q,
    minLength: SEARCH_MIN_QUERY_LENGTH,
    groups: [],
    totalHits: 0,
    truncated: false,
    indexing,
  }
  if (q.length < SEARCH_MIN_QUERY_LENGTH) return empty

  let rows: Record<string, unknown>[]
  try {
    const phrase = toPhraseQuery(q)
    // One row over the limit tells the UI the result set was cut short.
    rows = options.kind === undefined
      ? store.db.prepare(sql(false)).all(phrase, limit + 1)
      : store.db.prepare(sql(true)).all(phrase, options.kind, limit + 1)
  } catch {
    // A malformed FTS expression or a database being rebuilt underneath us.
    return empty
  }

  const truncated = rows.length > limit
  const hits = rows.slice(0, limit)
  const groups = new Map<string, SearchSessionGroup>()
  for (const row of hits) {
    const kind = asText(row['kind']) as HarnessKind
    const sessionId = asText(row['session_id'])
    const marked = splitMarkers(asText(row['marked']))
    const timeMs = row['time_ms'] === null || row['time_ms'] === undefined ? undefined : asInt(row['time_ms'])
    const hit: SearchHit = {
      kind,
      sessionId,
      fileId: asText(row['file_id']),
      line: asInt(row['line']),
      role: asRole(row['role']),
      ...(timeMs === undefined ? {} : { timeMs }),
      snippet: marked.snippet,
      matches: marked.matches,
      score: typeof row['score'] === 'number' ? row['score'] : asInt(row['score']),
    }
    const key = `${kind} ${sessionId}`
    let group = groups.get(key)
    if (group === undefined) {
      const facts = options.describe?.(kind, sessionId)
      group = {
        kind,
        sessionId,
        title: facts?.title ?? sessionId,
        ...(facts?.cwd === undefined ? {} : { cwd: facts.cwd }),
        ...(facts?.updatedAt === undefined ? {} : { updatedAt: facts.updatedAt }),
        hitCount: 0,
        hits: [],
      }
      groups.set(key, group)
    }
    group.hitCount += 1
    if (group.hits.length < SEARCH_GROUP_HIT_LIMIT) group.hits.push(hit)
  }

  if (groups.size > 0) {
    try {
      const phrase = toPhraseQuery(q)
      const countRows = options.kind === undefined
        ? store.db.prepare(countSql(false)).all(phrase)
        : store.db.prepare(countSql(true)).all(phrase, options.kind)
      const totals = new Map<string, number>()
      for (const row of countRows) {
        totals.set(`${asText(row['kind'])} ${asText(row['session_id'])}`, asInt(row['n']))
      }
      for (const group of groups.values()) {
        group.hitCount = totals.get(`${group.kind} ${group.sessionId}`) ?? group.hitCount
      }
    } catch {
      // Keep the in-page counts; the ranked query already succeeded.
    }
  }

  return {
    enabled: true,
    query: q,
    minLength: SEARCH_MIN_QUERY_LENGTH,
    // Sessions keep the order their best hit ranked in, which is insertion order.
    groups: [...groups.values()],
    totalHits: hits.length,
    truncated,
    indexing,
  }
}
