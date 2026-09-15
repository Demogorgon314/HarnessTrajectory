/**
 * Full-text session search: the wire contract between the server's SQLite FTS5
 * index (`apps/server/src/search`) and the web UI that renders the results.
 *
 * A hit addresses one JSONL record: `sessionId` opens the session, `fileId`
 * selects the transcript inside it (`?file=` on the events route; it equals
 * `sessionId` for a session's main file) and `line` is the 0-based index of the
 * record within that file.
 */

import type { HarnessKind } from './session.ts'

/** What a matched record is: the same human/assistant/tool split the ledger uses. */
export type SearchRole = 'human' | 'assistant' | 'tool' | 'other'

/** A highlighted range inside {@link SearchHit.snippet}, in UTF-16 code units. */
export interface SearchMatchRange {
  start: number
  end: number
}

export interface SearchHit {
  kind: HarnessKind
  /** Main session id; the parent's id for a child (subagent) transcript. */
  sessionId: string
  /** Id to pass as `?file=` to the events route; equals `sessionId` for the main file. */
  fileId: string
  /** 0-based JSONL line index within that file. */
  line: number
  role: SearchRole
  timeMs?: number
  snippet: string
  matches: SearchMatchRange[]
  /** bm25 rank: lower is better. The UI only sorts by it. */
  score: number
}

export interface SearchSessionGroup {
  kind: HarnessKind
  sessionId: string
  title: string
  cwd?: string
  updatedAt?: number
  /** Total hits in this session, which may exceed `hits.length`. */
  hitCount: number
  /** Best hits of this session, newest-ranked first, capped server-side. */
  hits: SearchHit[]
}

export interface SearchResponse {
  /** False when indexing is off (the default, unless `HARNESS_TRAJECTORY_SEARCH=1`). */
  enabled: boolean
  query: string
  /** Shortest query the index can answer; a shorter one returns no groups. */
  minLength: number
  groups: SearchSessionGroup[]
  totalHits: number
  /** Whether the hit limit cut the result set short. */
  truncated: boolean
  indexing: {
    pendingFiles: number
    /** False while the startup backfill is still running. */
    ready: boolean
  }
}

/** Hits returned per session group. */
export const SEARCH_GROUP_HIT_LIMIT = 5

/** Trigram FTS5 cannot match fewer than three characters. */
export const SEARCH_MIN_QUERY_LENGTH = 3

/** Default and maximum number of hits one request may return. */
export const SEARCH_DEFAULT_LIMIT = 50
export const SEARCH_MAX_LIMIT = 200
