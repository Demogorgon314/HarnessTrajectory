/**
 * Reading side of the search index: a trigram cover of the query, verified
 * and ranked in JavaScript.
 *
 * The index deduplicates document text (see store.ts): FTS candidates are
 * *unique texts*, each verified once, then expanded to every occurrence —
 * the (kind, session, file, line) quadruples a hit addresses — through
 * `docs_by_text` and the in-memory `files` snapshot. On the reference corpus
 * a duplicate document appears in ~1.8 sessions on average, so one
 * verification covers what used to take ~1.8 candidate slots.
 *
 * The FTS table is `detail=none`: it answers "which texts contain this
 * trigram" but stores no positions, so FTS5 phrase queries, `snippet()` and
 * `bm25` are unavailable on it. The read side therefore slices the user's
 * string into the same trigram set the tokenizer would extract and ANDs the
 * terms — every true substring match is covered, plus some texts where the
 * trigrams merely coexist — then verifies the substring against the text
 * (inflated from `texts.text`, the only copy the index keeps), counts
 * occurrences for ranking, and cuts the snippet window itself. Verification
 * makes the result set identical to a phrase query; only very common queries
 * change shape, when the candidate cap cuts in and `truncated` plus
 * lower-bound group counts report it.
 *
 * Query cost is linear in verified candidates (inflate + case fold +
 * occurrence count, ~25 µs each), and the candidate cap is the knob that
 * bounds it: 4096 texts ≈ 110 ms worst case on the reference corpus. The
 * fold and the snippet are the two heaviest per-text steps, so the fold is
 * computed once per text and reused for counting and snippets, and snippets
 * are built only for the hits a page actually displays — never for the
 * thousands of candidates that verify but do not rank in.
 *
 * Expansion is bounded too: texts are processed best-first, the displayed
 * page is collected while scanning occurrences in chunks, and once the page
 * is full the per-session totals keep counting per file instead of per row —
 * a text pasted into 200k records costs one SQL aggregate, not 200k JS
 * objects and an event-loop stall.
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
 * Most unique texts one query reads back and verifies. With `detail=none`
 * the FTS match is a superset of the real hits, so verification reads the
 * stored text; this bounds that read at roughly 4096 × the average text size
 * (~12 MB on the reference corpus, ~110 ms worst case). A query that hits
 * the cap reports `truncated` and its group counts are lower bounds — the
 * same honesty the UI already shows when the page limit cuts a result set.
 */
export const SEARCH_CANDIDATE_LIMIT = 4_096

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
  /**
   * Restrict hits to one harness. Pushed into the candidate query as an
   * `EXISTS`, so the candidate cap only counts texts that can produce a hit
   * in this harness (a text may still span kinds: expansion counts only the
   * matching occurrences).
   */
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
 * it. Both sides are folded here, so ranges are always valid UTF-16 indices
 * into the returned snippet. A needle that is not in the text — impossible
 * after verification — yields the document head.
 */
export function buildSnippet(text: string, needle: string): { snippet: string; matches: SearchMatchRange[] } {
  return buildSnippetFromFolded(text, foldCase(text), foldCase(needle))
}

/** {@link buildSnippet} with the folds already done, shared with verification. */
function buildSnippetFromFolded(
  text: string, folded: string, n: string,
): { snippet: string; matches: SearchMatchRange[] } {
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

/**
 * The candidate query: every unique text whose trigram set covers the
 * query's, in first-indexed order (the FTS rowid is the text id). The
 * `EXISTS` keeps two kinds of rows from spending the candidate budget:
 * texts whose last occurrence was deleted (orphans await `gcTexts`, until
 * then they would match and shadow live hits) and — for a kind-narrowed
 * search — texts with no occurrence in that harness. Filtering in SQL, not
 * after `LIMIT`, is what makes the cap count only candidates that can
 * produce a hit.
 */
const CANDIDATE_SQL = `
  select t.id as text_id, t.text as blob
  from docs_fts
  join texts t on t.id = docs_fts.rowid
  where docs_fts match ?
    and exists (select 1 from docs d where d.text = docs_fts.rowid)
  order by docs_fts.rowid
  limit ?
`

const CANDIDATE_SQL_BY_KIND = `
  select t.id as text_id, t.text as blob
  from docs_fts
  join texts t on t.id = docs_fts.rowid
  where docs_fts match ?
    and exists (
      select 1 from docs d join files f on f.id = d.file
      where d.text = docs_fts.rowid and f.kind = ?
    )
  order by docs_fts.rowid
  limit ?
`

/**
 * Occurrences of one text, paged so a text with hundreds of thousands of
 * them never materializes at once. `id` drives both the page cursor and the
 * remainder count. (`StatementSync.iterate` would avoid the chunking, but it
 * only exists on Node 23+ and the floor here is 22.13.)
 */
function occurrenceSql(byKind: boolean): string {
  return `
    select id, file, line, role, time_ms from docs
    where text = ? and id > ?
      ${byKind ? 'and file in (select id from files where kind = ?)' : ''}
    order by id limit 256
  `
}

/**
 * Occurrence counts per file, for everything past the displayed page: group
 * totals are exact without reading a quarter million rows into JS.
 */
const COUNT_BY_FILE_SQL = `
  select file, count(*) as n from docs where text = ? and id > ? group by file
`

/** One verified text: the inflate and the fold happen exactly once per text. */
interface VerifiedText {
  text: string
  folded: string
  occurrences: number
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
    // One row over the cap tells the response the candidate set was cut short.
    rows = options.kind === undefined
      ? store.db.prepare(CANDIDATE_SQL).all(toTrigramQuery(q), candidateLimit + 1)
      : store.db.prepare(CANDIDATE_SQL_BY_KIND).all(toTrigramQuery(q), options.kind, candidateLimit + 1)
  } catch {
    // A malformed FTS expression or a database being rebuilt underneath us.
    return empty
  }
  const capped = rows.length > candidateLimit
  if (capped) rows.length = candidateLimit

  const needle = foldCase(q)

  // Verify each candidate text once; keep the folded form for the snippets.
  const verified = new Map<number, VerifiedText>()
  for (const row of rows) {
    const blob = row['blob']
    let text: string
    try {
      text = blob instanceof Uint8Array ? unpackText(blob) : ''
    } catch {
      // A torn row (an interrupted write) is skipped, never fatal.
      continue
    }
    const folded = foldCase(text)
    const occurrences = countOccurrences(folded, needle)
    // detail=none also matches texts where the trigrams coexist but the
    // substring does not; those drop out here.
    if (occurrences === 0) continue
    verified.set(asInt(row['text_id']), { text, folded, occurrences })
  }

  // Rank: every hit of a text shares its occurrence count, so ordering the
  // verified texts by that count (stably — ties keep candidate order, and
  // occurrences stay in insertion order within a text) yields the exact
  // sequence a materialize-then-sort pipeline would produce, without
  // materializing it.
  const ranked = [...verified.entries()].sort((a, b) => b[1].occurrences - a[1].occurrences)

  const files = store.filesMap()
  const occurrence = store.db.prepare(occurrenceSql(options.kind !== undefined))
  const countByFile = store.db.prepare(COUNT_BY_FILE_SQL)
  const page: { hit: SearchHit; textId: number }[] = []
  const totals = new Map<string, number>()
  let pageFull = false

  const keep = (file: { kind: HarnessKind }): boolean =>
    options.kind === undefined || file.kind === options.kind
  const countHit = (file: { kind: HarnessKind; sessionId: string }, n: number): void => {
    const groupKey = `${file.kind} ${file.sessionId}`
    totals.set(groupKey, (totals.get(groupKey) ?? 0) + n)
  }
  /** Totals for occurrences past `afterId`, counted per file — never per row. */
  const countRemainder = (textId: number, afterId: number): void => {
    for (const row of countByFile.all(textId, afterId)) {
      const file = files.get(asInt(row['file']))
      if (file !== undefined && keep(file)) countHit(file, asInt(row['n']))
    }
  }

  for (const [textId, entry] of ranked) {
    if (pageFull) {
      countRemainder(textId, -1)
      continue
    }
    let afterId = -1
    for (;;) {
      // Filter before paging: a shared text may have thousands of occurrences
      // in other harnesses before the first occurrence we can display.
      const chunk = options.kind === undefined
        ? occurrence.all(textId, afterId)
        : occurrence.all(textId, afterId, options.kind)
      for (const row of chunk) {
        afterId = asInt(row['id'])
        const file = files.get(asInt(row['file']))
        if (file === undefined || !keep(file)) continue
        countHit(file, 1)
        // The first hit past the page marks truncation and stops the scan;
        // everything after it only feeds the per-session totals.
        if (page.length >= limit) { pageFull = true; break }
        const timeMs = row['time_ms'] === null || row['time_ms'] === undefined ? undefined : asInt(row['time_ms'])
        page.push({
          textId,
          hit: {
            kind: file.kind,
            sessionId: file.sessionId,
            fileId: file.fileId,
            line: asInt(row['line']),
            role: asRole(row['role']),
            ...(timeMs === undefined ? {} : { timeMs }),
            // Filled in for the displayed hits only, after grouping.
            snippet: '',
            matches: [],
            score: entry.occurrences,
          },
        })
      }
      if (pageFull || chunk.length < 256) break
    }
    // The chunk row that filled the page was counted inline; the rest of the
    // text (if any) is counted in bulk.
    if (pageFull) countRemainder(textId, afterId)
  }

  const truncated = capped || pageFull
  const groups = new Map<string, SearchSessionGroup>()
  for (const { hit, textId } of page) {
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
    if (group.hits.length < SEARCH_GROUP_HIT_LIMIT) {
      // The snippet is built only now, for the handful of hits that render;
      // every other verified text paid inflate + fold + count and no more.
      const entry = verified.get(textId)
      if (entry !== undefined) {
        const { snippet, matches } = buildSnippetFromFolded(entry.text, entry.folded, needle)
        hit.snippet = snippet
        hit.matches = matches
      }
      group.hits.push(hit)
    }
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
