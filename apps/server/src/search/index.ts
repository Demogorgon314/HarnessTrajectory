/**
 * Full-text session search: a SQLite FTS5 index over every transcript the
 * session index walks, fed from the same byte stream and queried by
 * `GET /api/search`.
 *
 * `store.ts` owns the schema, `extract.ts` turns one JSONL record into
 * documents, `indexer.ts` batches the writes, `query.ts` reads. Nothing here
 * writes inside a harness root: the database lives under the cache directory
 * (`cache.ts`).
 */

import { SearchIndexer } from './indexer.ts'
import { SearchStore } from './store.ts'

export { extractSearchDocs, MAX_DOC_CHARS, type SearchDocDraft } from './extract.ts'
export { SearchIndexer, type SearchIndexerOptions } from './indexer.ts'
export {
  buildSnippet, search, SEARCH_CANDIDATE_LIMIT, toTrigramQuery,
  type SearchOptions, type SearchSessionFacts,
} from './query.ts'
export {
  SearchStore, SEARCH_SCHEMA_VERSION,
  type SearchDoc, type SearchFileKey, type SearchFileState, type SearchStoreOptions,
} from './store.ts'

/** The store and its writer, opened together and closed together. */
export interface SearchService {
  readonly store: SearchStore
  readonly indexer: SearchIndexer
  close(): void
}

export interface SearchServiceOptions {
  /** Database file, or `':memory:'`. */
  path: string
  flushDelayMs?: number
  maxBatchDocs?: number
  /** Retention window in days; older transcripts stay out of the index. 0 = all. */
  maxAgeDays?: number
}

export function createSearchService(options: SearchServiceOptions): SearchService {
  const store = new SearchStore({ path: options.path })
  const indexer = new SearchIndexer({
    store,
    ...(options.flushDelayMs === undefined ? {} : { flushDelayMs: options.flushDelayMs }),
    ...(options.maxBatchDocs === undefined ? {} : { maxBatchDocs: options.maxBatchDocs }),
    ...(options.maxAgeDays === undefined ? {} : { maxAgeDays: options.maxAgeDays }),
  })
  return {
    store,
    indexer,
    close() {
      indexer.stop()
      store.close()
    },
  }
}
