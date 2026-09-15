import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchResponse } from '@harness-trajectory/core'
import { createApp } from '../src/app.ts'
import { cacheDir, searchDbPath, searchEnabled } from '../src/cache.ts'
import { SessionIndex } from '../src/index.ts'
import { createSearchService, type SearchService } from '../src/search/index.ts'

const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function jsonl(records: readonly unknown[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

function claudeUser(text: string, sessionId: string, offset: number) {
  return {
    type: 'user', uuid: `u-${offset}`, parentUuid: null, isSidechain: false, sessionId,
    cwd: '/work/project', timestamp: iso(offset), message: { role: 'user', content: text },
  }
}

describe('cache paths', () => {
  it('keeps the index out of the harness roots and honours the usual overrides', () => {
    expect(cacheDir({ HARNESS_TRAJECTORY_CACHE_DIR: join('/tmp', 'ht') })).toBe(join('/tmp', 'ht'))
    expect(cacheDir({ XDG_CACHE_HOME: '/xdg' })).toBe(join('/xdg', 'harness-trajectory'))
    expect(cacheDir({})).toBe(join(homedir(), '.cache', 'harness-trajectory'))
    // An empty override is not an override.
    expect(cacheDir({ HARNESS_TRAJECTORY_CACHE_DIR: '', XDG_CACHE_HOME: '' }))
      .toBe(join(homedir(), '.cache', 'harness-trajectory'))
    expect(searchDbPath({ XDG_CACHE_HOME: '/xdg' })).toBe(join('/xdg', 'harness-trajectory', 'search.sqlite'))
  })

  it('switches indexing off only for the documented values', () => {
    expect(searchEnabled({})).toBe(true)
    expect(searchEnabled({ HARNESS_TRAJECTORY_SEARCH: '1' })).toBe(true)
    expect(searchEnabled({ HARNESS_TRAJECTORY_SEARCH: '0' })).toBe(false)
    expect(searchEnabled({ HARNESS_TRAJECTORY_SEARCH: 'false' })).toBe(false)
    expect(searchEnabled({ HARNESS_TRAJECTORY_SEARCH: 'off' })).toBe(false)
  })
})

describe('GET /api/search', () => {
  let dir: string
  let index: SessionIndex
  let service: SearchService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-route-'))
    await mkdir(join(dir, 'claude', '-slug'), { recursive: true })
    await mkdir(join(dir, 'codex', '2026', '09', '14'), { recursive: true })
    await writeFile(join(dir, 'claude', '-slug', 'main-1.jsonl'), jsonl([
      claudeUser('Port the trajectory viewer to this project', 'main-1', 0),
      { type: 'ai-title', aiTitle: 'Trajectory port', sessionId: 'main-1' },
    ]))
    await writeFile(join(dir, 'codex', '2026', '09', '14', 'rollout-2026-09-14T10-00-00-thread-1.jsonl'), jsonl([
      { timestamp: iso(0), type: 'session_meta', payload: { id: 'thread-1', cwd: '/work/codex' } },
      {
        timestamp: iso(10), type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Port the parser instead' }] },
      },
    ]))
    service = createSearchService({ path: ':memory:', flushDelayMs: 5 })
    index = new SessionIndex({
      roots: [
        { kind: 'claude', dir: join(dir, 'claude') },
        { kind: 'codex', dir: join(dir, 'codex') },
      ],
      watch: false,
      now: () => T0 + 60_000,
      search: service.indexer,
    })
    await index.start()
  })

  afterEach(async () => {
    index.stop()
    service.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('answers with the search contract, joining session facts from the live index', async () => {
    const app = createApp({ index, search: service })
    const response = await app.request('/api/search?q=Port%20the')
    expect(response.status).toBe(200)
    const body = await response.json() as SearchResponse
    expect(body).toMatchObject({
      enabled: true,
      query: 'Port the',
      minLength: 3,
      totalHits: 2,
      truncated: false,
      indexing: { pendingFiles: 0, ready: true },
    })
    const claude = body.groups.find(group => group.kind === 'claude')
    expect(claude).toMatchObject({
      sessionId: 'main-1',
      title: 'Trajectory port',
      cwd: '/work/project',
      hitCount: 1,
      hits: [expect.objectContaining({ fileId: 'main-1', line: 0, role: 'human' })],
    })
    expect(claude?.updatedAt).toBeTypeOf('number')
    const hit = claude?.hits[0]
    expect(hit?.snippet.slice(hit.matches[0]?.start, hit.matches[0]?.end).toLowerCase()).toBe('port the')
    expect(hit?.score).toBeLessThan(0)
  })

  it('honours the kind filter and the limit, and clamps a hostile one', async () => {
    const app = createApp({ index, search: service })
    const byKind = await (await app.request('/api/search?q=Port%20the&kind=codex')).json() as SearchResponse
    expect(byKind.groups.map(group => group.kind)).toEqual(['codex'])
    expect(byKind.groups[0]).toMatchObject({ sessionId: 'thread-1', title: 'Port the parser instead' })

    const limited = await (await app.request('/api/search?q=Port%20the&limit=1')).json() as SearchResponse
    expect(limited).toMatchObject({ totalHits: 1, truncated: true })
    // An unknown kind is ignored rather than rejected; a nonsense limit falls back.
    expect(((await (await app.request('/api/search?q=Port%20the&kind=nope')).json()) as SearchResponse).totalHits).toBe(2)
    expect(((await (await app.request('/api/search?q=Port%20the&limit=abc')).json()) as SearchResponse).totalHits).toBe(2)
    expect(((await (await app.request('/api/search?q=Port%20the&limit=99999')).json()) as SearchResponse).totalHits).toBe(2)
  })

  it('reports the minimum length for a query the trigram index cannot answer', async () => {
    const app = createApp({ index, search: service })
    const body = await (await app.request('/api/search?q=po')).json() as SearchResponse
    expect(body).toMatchObject({ enabled: true, query: 'po', minLength: 3, groups: [], totalHits: 0 })
    expect(((await (await app.request('/api/search')).json()) as SearchResponse).query).toBe('')
  })

  it('reports itself disabled when nothing is indexed', async () => {
    const app = createApp({ index })
    const body = await (await app.request('/api/search?q=Port%20the')).json() as SearchResponse
    expect(body).toEqual({
      enabled: false,
      query: 'Port the',
      minLength: 3,
      groups: [],
      totalHits: 0,
      truncated: false,
      indexing: { pendingFiles: 0, ready: true },
    })
    // The rest of the API is unaffected.
    expect((await app.request('/api/sessions')).status).toBe(200)
  })
})
