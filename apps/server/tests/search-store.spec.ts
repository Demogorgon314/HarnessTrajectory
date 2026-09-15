import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SEARCH_GROUP_HIT_LIMIT } from '@harness-trajectory/core'
import { search, splitMarkers, toPhraseQuery } from '../src/search/query.ts'
import { SEARCH_SCHEMA_VERSION, SearchStore, type SearchDoc, type SearchFileKey } from '../src/search/store.ts'

/** The markers `snippet()` wraps a match in, before `splitMarkers` strips them. */
const OPEN = '\u0002'
const CLOSE = '\u0003'

const stores: SearchStore[] = []
const dirs: string[] = []

function open(path = ':memory:'): SearchStore {
  const store = new SearchStore({ path })
  stores.push(store)
  return store
}

function key(overrides: Partial<SearchFileKey> = {}): SearchFileKey {
  return {
    path: '/r/claude/-slug/main-1.jsonl',
    kind: 'claude',
    sessionId: 'main-1',
    fileId: 'main-1',
    ...overrides,
  }
}

function add(store: SearchStore, file: SearchFileKey, docs: readonly SearchDoc[]): void {
  store.transaction(() => {
    store.insertDocs(file, docs)
    store.setFileState(file, { size: 100, mtimeMs: 1_000, indexedBytes: 100, indexedLines: docs.length })
  })
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('SearchStore', () => {
  it('drops and rebuilds an index written under another schema version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-search-'))
    dirs.push(dir)
    const path = join(dir, 'nested', 'search.sqlite')
    const first = open(path)
    expect(first.db.prepare('pragma user_version').get()?.['user_version']).toBe(SEARCH_SCHEMA_VERSION)
    add(first, key(), [{ line: 0, role: 'human', text: 'port the trajectory viewer' }])
    expect(first.docCount()).toBe(1)
    // Reopening the same file keeps everything.
    first.close()
    const again = open(path)
    expect(again.docCount()).toBe(1)
    // An index written by an older build is a cache with a stale shape: it is
    // dropped rather than migrated.
    again.db.exec('pragma user_version = 0')
    again.close()
    const rebuilt = open(path)
    expect(rebuilt.docCount()).toBe(0)
    expect(rebuilt.fileCount()).toBe(0)
    expect(rebuilt.db.prepare('pragma user_version').get()?.['user_version']).toBe(SEARCH_SCHEMA_VERSION)
  })

  it('tracks per-file progress, clears and deletes a file, and re-homes its documents', () => {
    const store = open()
    const file = key()
    add(store, file, [
      { line: 0, role: 'human', text: 'first prompt' },
      { line: 3, role: 'assistant', text: 'first answer' },
    ])
    expect(store.fileState(file.path)).toMatchObject({
      kind: 'claude', sessionId: 'main-1', fileId: 'main-1', indexedLines: 2, indexedBytes: 100,
    })
    expect(store.paths()).toEqual([file.path])

    store.rebind(file.path, 'parent-1', 'main-1/agent-a')
    expect(store.fileState(file.path)).toMatchObject({ sessionId: 'parent-1', fileId: 'main-1/agent-a' })
    expect(search(store, { q: 'first prompt' }).groups[0]).toMatchObject({
      sessionId: 'parent-1',
      hits: [{ fileId: 'main-1/agent-a', line: 0 }],
    })

    store.transaction(() => { store.clearDocs(file.path) })
    expect(store.docCount()).toBe(0)
    expect(store.fileState(file.path)).toBeDefined()
    store.transaction(() => { store.deleteFile(file.path) })
    expect(store.fileState(file.path)).toBeUndefined()
  })
})

describe('search', () => {
  it('matches an arbitrary substring, case-insensitively, and marks it in the snippet', () => {
    const store = open()
    add(store, key(), [
      { line: 2, role: 'tool', text: 'Bash\ncommand: pnpm vitest run --project server', timeMs: 1_700 },
    ])
    const response = search(store, { q: 'Run --Project' })
    expect(response).toMatchObject({ enabled: true, query: 'Run --Project', totalHits: 1, truncated: false })
    const hit = response.groups[0]?.hits[0]
    expect(hit).toMatchObject({
      kind: 'claude', sessionId: 'main-1', fileId: 'main-1', line: 2, role: 'tool', timeMs: 1_700,
    })
    // Trigram is a substring index: a match need not start at a word boundary.
    expect(search(store, { q: 'itest ru' }).totalHits).toBe(1)
    expect(search(store, { q: 'not in there' }).totalHits).toBe(0)
    const range = hit?.matches[0]
    expect(range).toBeDefined()
    expect(hit?.snippet.slice(range?.start, range?.end).toLowerCase()).toContain('run --project')
    // The markers themselves never reach the caller.
    expect(hit?.snippet).not.toContain(OPEN)
  })

  it('answers nothing below the trigram minimum rather than scanning', () => {
    const store = open()
    add(store, key(), [{ line: 0, role: 'human', text: 'ab cd' }])
    expect(search(store, { q: 'ab' })).toMatchObject({ minLength: 3, groups: [], totalHits: 0 })
    expect(search(store, { q: '' })).toMatchObject({ groups: [], totalHits: 0 })
    expect(search(store, { q: 'ab ' })).toMatchObject({ groups: [], totalHits: 0 })
  })

  it('treats the query as a literal phrase, so FTS5 operators are not operators', () => {
    const store = open()
    add(store, key(), [
      { line: 0, role: 'human', text: 'search for "quoted" AND NOT plain' },
      { line: 1, role: 'human', text: 'something entirely else' },
    ])
    expect(toPhraseQuery('say "hi"')).toBe('"say ""hi"""')
    expect(search(store, { q: '"quoted" AND NOT' }).totalHits).toBe(1)
    expect(search(store, { q: 'AND NOT plain' }).totalHits).toBe(1)
    // A syntactically hostile query returns nothing instead of throwing.
    expect(search(store, { q: 'a" OR b NEAR(' }).totalHits).toBe(0)
  })

  it('groups hits by session, caps them per group, and keeps the total count', () => {
    const store = open()
    const claude = key()
    const codex = key({ path: '/r/codex/r-1.jsonl', kind: 'codex', sessionId: 'thread-1', fileId: 'thread-1' })
    add(store, claude, Array.from({ length: 8 }, (_unused, index) => ({
      line: index, role: 'assistant' as const, text: `needle in record number ${index}`,
    })))
    add(store, codex, [{ line: 0, role: 'human', text: 'a needle over here' }])

    const response = search(store, { q: 'needle' })
    expect(response.totalHits).toBe(9)
    const byKind = new Map(response.groups.map(group => [group.kind, group]))
    expect(byKind.get('claude')).toMatchObject({ sessionId: 'main-1', hitCount: 8 })
    expect(byKind.get('claude')?.hits).toHaveLength(SEARCH_GROUP_HIT_LIMIT)
    expect(byKind.get('codex')).toMatchObject({ sessionId: 'thread-1', hitCount: 1 })

    // Title, cwd and last activity come from the live session index, not SQLite.
    const described = search(store, {
      q: 'needle',
      describe: kind => (kind === 'claude' ? { title: 'Ported viewer', cwd: '/work', updatedAt: 42 } : undefined),
    })
    expect(described.groups.find(group => group.kind === 'claude'))
      .toMatchObject({ title: 'Ported viewer', cwd: '/work', updatedAt: 42 })
    // An unknown session falls back to its id.
    expect(described.groups.find(group => group.kind === 'codex')?.title).toBe('thread-1')
  })

  it('filters by harness kind and reports a truncated result set', () => {
    const store = open()
    add(store, key(), [
      { line: 0, role: 'human', text: 'shared needle one' },
      { line: 1, role: 'human', text: 'shared needle two' },
      { line: 2, role: 'human', text: 'shared needle three' },
    ])
    add(store, key({ path: '/r/grok/u.jsonl', kind: 'grok', sessionId: 'g-1', fileId: 'g-1' }), [
      { line: 0, role: 'human', text: 'shared needle in grok' },
    ])
    expect(search(store, { q: 'shared needle' }).totalHits).toBe(4)
    expect(search(store, { q: 'shared needle', kind: 'grok' })).toMatchObject({
      totalHits: 1,
      truncated: false,
      groups: [{ kind: 'grok', sessionId: 'g-1' }],
    })
    expect(search(store, { q: 'shared needle', limit: 2 })).toMatchObject({ totalHits: 2, truncated: true })
    // The limit is clamped, never trusted.
    expect(search(store, { q: 'shared needle', limit: 10_000 }).totalHits).toBe(4)
  })

  it('reports the session hit total, not the page slice, on the group badge', () => {
    const store = open()
    add(store, key(), Array.from({ length: 8 }, (_unused, index) => ({
      line: index, role: 'assistant' as const, text: `needle in record number ${index}`,
    })))
    const limited = search(store, { q: 'needle', limit: 3 })
    expect(limited).toMatchObject({ totalHits: 3, truncated: true })
    expect(limited.groups).toHaveLength(1)
    expect(limited.groups[0]).toMatchObject({ sessionId: 'main-1', hitCount: 8 })
    expect(limited.groups[0]?.hits).toHaveLength(3)
  })

  it('reports whether the startup backfill is still running', () => {
    const store = open()
    expect(search(store, { q: 'anything', indexing: { pendingFiles: 3, ready: false } }).indexing)
      .toEqual({ pendingFiles: 3, ready: false })
    // Even a query that is answered without touching the index carries the state.
    expect(search(store, { q: 'ab', indexing: { pendingFiles: 1, ready: false } }).indexing)
      .toEqual({ pendingFiles: 1, ready: false })
  })
})

describe('splitMarkers', () => {
  it('turns the snippet markers into character ranges', () => {
    expect(splitMarkers(`…the ${OPEN}needle${CLOSE} in a ${OPEN}needle${CLOSE}stack…`)).toEqual({
      snippet: '…the needle in a needlestack…',
      matches: [{ start: 5, end: 11 }, { start: 17, end: 23 }],
    })
    expect(splitMarkers('no markers at all')).toEqual({ snippet: 'no markers at all', matches: [] })
    // A marker the snippet window cut short still yields a usable range.
    expect(splitMarkers(`${OPEN}unclosed`)).toEqual({ snippet: 'unclosed', matches: [{ start: 0, end: 8 }] })
  })
})
