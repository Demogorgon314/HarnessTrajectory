/**
 * Reading side of the search index: a trigram cover of the query, verified
 * and ranked in JavaScript.
 *
 * The FTS table is `detail=none` (see store.ts): it answers "which documents
 * contain this trigram" but stores no positions, so FTS5 phrase queries,
 * `snippet()` and `bm25` are unavailable on it. The read side therefore slices
 * the user's string into the same trigram set the tokenizer would extract and
 * ANDs the terms — every true substring match is covered, plus some documents
 * where the trigrams merely coexist — then verifies the substring against the
 * document text (inflated from `docs.text`, the only copy the index keeps),
 * counts occurrences for ranking, and cuts the snippet window itself.
 * Verification makes the result set identical to a phrase query; only
 * very common queries change shape, when the candidate cap cuts in and
 * `truncated` plus lower-bound group counts report it.
 *
 * Trigram cannot index fewer than three characters, so a shorter query returns
 * no groups and reports `minLength: 3`; the UI asks for one more character
 * rather than falling back to a full `LIKE` scan over hundreds of megabytes.
 */

import {
  SEARCH_DEFAULT_LIMIT, SEARCH_GROUP_HIT_LIMIT, SEARCH_INDEXING_IDLE, SEARCH_MAX_LIMIT, SEARCH_MIN_QUERY_LENGTH,
  type HarnessKind, type SearchHit, type SearchIndexing, type SearchMatchRange, type SearchResponse,
  type SearchRole, type SearchSessionGroup,
} from '@harness-trajectory/core'
import { unpackText, type SearchStore } from './store.ts'

/**
 * Width of the returned snippet window, in characters. What used to be a
 * `snippet()` token budget — under the trigram tokenizer a token starts at
 * every character, so it was always roughly a character budget.
 */
const SNIPPET_CHARS = 64

/** Ellipsis marking that the window does not cover the document edge. */
const ELLIPSIS = '…'

/**
 * Most candidates one query reads back and verifies. With `detail=none` the
 * FTS match is a superset of the real hits, so verification reads the stored
 * text; this bounds that read at roughly 8192 × the average document size
 * (~12 MB on the reference corpus). A query that hits the cap reports
 * `truncated` and its group counts are lower bounds — the same honesty the UI
 * already shows when the page limit cuts a result set.
 */
export const SEARCH_CANDIDATE_LIMIT = 8_192

/**
 * The most trigram terms sent to FTS5. A pasted stack trace would otherwise
 * build a thousand-term AND that is slow to parse for no selectivity: the
 * first few distinct trigrams already narrow the candidate set, and the JS
 * verification keeps the result exact regardless of how many terms were sent.
 */
const MAX_QUERY_TERMS = 64

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
  /** Candidate cap, for tests; defaults to {@link SEARCH_CANDIDATE_LIMIT}. */
  candidateLimit?: number
  /** Session title/cwd/updatedAt lookup, normally `SessionIndex.get`. */
  describe?: (kind: HarnessKind, sessionId: string) => SearchSessionFacts | undefined
  indexing?: SearchIndexing
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

/**
 * The case fold the trigram tokenizer applies with `case_sensitive 0`:
 * ASCII only, one code unit at a time, so the folded string keeps the same
 * length and indices stay valid against the original text.
 */
function foldCase(text: string): string {
  return text.replace(/[A-Z]/g, char => char.toLowerCase())
}

/**
 * Slice the query into the distinct trigrams the tokenizer would extract —
 * the window slides over spaces and punctuation too — and AND them as quoted
 * terms, embedded `"` doubled. The result is a literal substring cover: no
 * operators survive, so searching for `AND`, `-p`, or `a*b` is not a syntax
 * error, and a match found this way is a superset of the real hits.
 */
export function toTrigramQuery(q: string): string {
  const folded = foldCase(q)
  const terms: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index + 3 <= folded.length && terms.length < MAX_QUERY_TERMS; index += 1) {
    const gram = folded.slice(index, index + 3)
    if (seen.has(gram)) continue
    seen.add(gram)
    terms.push(`"${gram.replace(/"/g, '""')}"`)
  }
  return terms.join(' AND ')
}

/** Non-overlapping occurrences of `needle` in already-folded text. */
function countOccurrences(folded: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = folded.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/**
 * Cut a window around the first occurrence and mark every occurrence inside
 * it. `needle` may be folded or not; both sides are folded here, so ranges are
 * always valid UTF-16 indices into the returned snippet. A needle that is not
 * in the text — impossible after verification — yields the document head.
 */
export function buildSnippet(text: string, needle: string): { snippet: string; matches: SearchMatchRange[] } {
  const folded = foldCase(text)
  const n = foldCase(needle)
  const first = n === '' ? -1 : folded.indexOf(n)
  if (first === -1) {
    const end = Math.min(text.length, SNIPPET_CHARS)
    return { snippet: text.slice(0, end) + (end < text.length ? ELLIPSIS : ''), matches: [] }
  }
  const width = Math.max(SNIPPET_CHARS, n.length)
  let start = Math.max(0, first - Math.floor((width - n.length) / 2))
  const end = Math.min(text.length, start + width)
  start = Math.max(0, end - width)
  const matches: SearchMatchRange[] = []
  let from = start
  for (;;) {
    const at = folded.indexOf(n, from)
    if (at === -1 || at + n.length > end) break
    matches.push({ start: at - start, end: at - start + n.length })
    from = at + n.length
  }
  const prefix = start > 0 ? ELLIPSIS : ''
  return {
    snippet: prefix + text.slice(start, end) + (end < text.length ? ELLIPSIS : ''),
    matches: matches.map(range => ({ start: range.start + prefix.length, end: range.end + prefix.length })),
  }
}

/** The candidate query: every document whose trigram set covers the query's. */
function sql(byKind: boolean): string {
  return `
    select
      f.kind        as kind,
      f.session_id  as session_id,
      f.file_id     as file_id,
      d.line        as line,
      d.role        as role,
      d.time_ms     as time_ms,
      d.text        as blob
    from docs_fts
    join docs d on d.id = docs_fts.rowid
    join files f on f.id = d.file
    where docs_fts match ?${byKind ? ' and f.kind = ?' : ''}
    order by docs_fts.rowid
    limit ?
  `
}

/** Run one search over the index. Never throws: a broken query returns no groups. */
export function search(store: SearchStore, options: SearchOptions): SearchResponse {
  const q = options.q.trim()
  const limit = Math.max(1, Math.min(options.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT))
  const candidateLimit = Math.max(1, options.candidateLimit ?? SEARCH_CANDIDATE_LIMIT)
  const indexing = options.indexing ?? SEARCH_INDEXING_IDLE
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
    const match = toTrigramQuery(q)
    // One row over the cap tells the response the candidate set was cut short.
    rows = options.kind === undefined
      ? store.db.prepare(sql(false)).all(match, candidateLimit + 1)
      : store.db.prepare(sql(true)).all(match, options.kind, candidateLimit + 1)
  } catch {
    // A malformed FTS expression or a database being rebuilt underneath us.
    return empty
  }
  const capped = rows.length > candidateLimit
  if (capped) rows.length = candidateLimit

  const needle = foldCase(q)
  const hits: SearchHit[] = []
  const totals = new Map<string, number>()
  for (const row of rows) {
    const blob = row['blob']
    let text: string
    try {
      text = blob instanceof Uint8Array ? unpackText(blob) : ''
    } catch {
      // A torn row (an interrupted write) is skipped, never fatal.
      continue
    }
    const occurrences = countOccurrences(foldCase(text), needle)
    // detail=none also matches documents where the trigrams coexist but the
    // substring does not; those drop out here.
    if (occurrences === 0) continue
    const kind = asText(row['kind']) as HarnessKind
    const sessionId = asText(row['session_id'])
    const groupKey = `${kind} ${sessionId}`
    totals.set(groupKey, (totals.get(groupKey) ?? 0) + 1)
    const timeMs = row['time_ms'] === null || row['time_ms'] === undefined ? undefined : asInt(row['time_ms'])
    const { snippet, matches } = buildSnippet(text, needle)
    hits.push({
      kind,
      sessionId,
      fileId: asText(row['file_id']),
      line: asInt(row['line']),
      role: asRole(row['role']),
      ...(timeMs === undefined ? {} : { timeMs }),
      snippet,
      matches,
      score: occurrences,
    })
  }

  // Occurrence count is the ranking bm25 used to provide; ties keep the
  // deterministic rowid order the candidate scan returned (sort is stable).
  hits.sort((a, b) => b.score - a.score)

  const truncated = capped || hits.length > limit
  const page = hits.slice(0, limit)
  const groups = new Map<string, SearchSessionGroup>()
  for (const hit of page) {
    const groupKey = `${hit.kind} ${hit.sessionId}`
    let group = groups.get(groupKey)
    if (group === undefined) {
      const facts = options.describe?.(hit.kind, hit.sessionId)
      group = {
        kind: hit.kind,
        sessionId: hit.sessionId,
        title: facts?.title ?? hit.sessionId,
        ...(facts?.cwd === undefined ? {} : { cwd: facts.cwd }),
        ...(facts?.updatedAt === undefined ? {} : { updatedAt: facts.updatedAt }),
        // Verified in the same scan, exact unless the candidate cap cut in.
        hitCount: totals.get(groupKey) ?? 1,
        hits: [],
      }
      groups.set(groupKey, group)
    }
    if (group.hits.length < SEARCH_GROUP_HIT_LIMIT) group.hits.push(hit)
  }

  return {
    enabled: true,
    query: q,
    minLength: SEARCH_MIN_QUERY_LENGTH,
    // Sessions keep the order their best hit ranked in, which is insertion order.
    groups: [...groups.values()],
    totalHits: page.length,
    truncated,
    indexing,
  }
}
