import { describe, expect, it } from 'vitest'
import {
  SEARCH_DEFAULT_LIMIT, SEARCH_GROUP_HIT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MIN_QUERY_LENGTH,
  type SearchResponse,
} from '../src/index.ts'

describe('search contract', () => {
  it('reaches both the server and the web app through the package root', () => {
    // The response shape is the contract; this only guards the re-export, which
    // a `export * from './search.ts'` gone missing would otherwise break at
    // runtime in the browser rather than at build time.
    expect(SEARCH_MIN_QUERY_LENGTH).toBe(3)
    expect(SEARCH_GROUP_HIT_LIMIT).toBe(5)
    expect(SEARCH_DEFAULT_LIMIT).toBe(50)
    expect(SEARCH_MAX_LIMIT).toBe(200)
  })

  it('describes a hit well enough to open the exact record', () => {
    const response: SearchResponse = {
      enabled: true,
      query: 'readLines',
      minLength: SEARCH_MIN_QUERY_LENGTH,
      totalHits: 1,
      truncated: false,
      indexing: { pendingFiles: 0, ready: true, filesDone: 0, filesTotal: 0 },
      groups: [{
        kind: 'claude',
        sessionId: 'main-1',
        title: 'Port the viewer',
        cwd: '/work',
        updatedAt: 1,
        hitCount: 1,
        hits: [{
          kind: 'claude',
          // A child transcript keeps its parent's session id and its own file id.
          sessionId: 'main-1',
          fileId: 'main-1/agent-a1',
          line: 42,
          role: 'tool',
          timeMs: 2,
          snippet: '…await readLines(path)…',
          matches: [{ start: 7, end: 16 }],
          score: -3.5,
        }],
      }],
    }
    const hit = response.groups[0]?.hits[0]
    expect(hit?.snippet.slice(hit.matches[0]?.start, hit.matches[0]?.end)).toBe('readLines')
  })
})
