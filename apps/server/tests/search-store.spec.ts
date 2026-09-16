import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SEARCH_GROUP_HIT_LIMIT } from '@harness-trajectory/core'
import { buildSnippet, search, toTrigramQuery } from '../src/search/query.ts'
import { SEARCH_SCHEMA_VERSION, SearchStore, packText, unpackText, type SearchDoc, type SearchFileKey } from '../src/search/store.ts'

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
    expect(hit?.snippet.slice(range?.start, range?.end).toLowerCase()).toBe('run --project')
  })

  it('rejects documents where the trigrams merely coexist, exactly like a phrase query', () => {
    const store = open()
    add(store, key(), [
      // Every trigram of `packages/co`, scattered: detail=none sends this row
      // back as a candidate and the verification must drop it.
      { line: 0, role: 'tool', text: 'pac ack cka kag age ges es/ s/c /co' },
      { line: 1, role: 'tool', text: 'cat packages/core/src alive' },
    ])
    const response = search(store, { q: 'packages/co' })
    expect(response.totalHits).toBe(1)
    expect(response.groups[0]?.hits[0]).toMatchObject({ line: 1 })
    expect(response.groups[0]?.hitCount).toBe(1)
  })

  it('answers nothing below the trigram minimum rather than scanning', () => {
    const store = open()
    add(store, key(), [{ line: 0, role: 'human', text: 'ab cd' }])
    expect(search(store, { q: 'ab' })).toMatchObject({ minLength: 3, groups: [], totalHits: 0 })
    expect(search(store, { q: '' })).toMatchObject({ groups: [], totalHits: 0 })
    expect(search(store, { q: 'ab ' })).toMatchObject({ groups: [], totalHits: 0 })
  })

  it('treats the query as a literal string, so FTS5 operators are not operators', () => {
    const store = open()
    add(store, key(), [
      { line: 0, role: 'human', text: 'search for "quoted" AND NOT plain' },
      { line: 1, role: 'human', text: 'something entirely else' },
    ])
    // The trigram cover slides over spaces and punctuation, folds ASCII case,
    // dedupes, and doubles embedded quotes.
    expect(toTrigramQuery('abcde')).toBe('"abc" AND "bcd" AND "cde"')
    expect(toTrigramQuery('ABCABC')).toBe('"abc" AND "bca" AND "cab"')
    expect(toTrigramQuery('a"bcd')).toBe('"a""b" AND """bc" AND "bcd"')
    expect(search(store, { q: '"quoted" AND NOT' }).totalHits).toBe(1)
    expect(search(store, { q: 'AND NOT plain' }).totalHits).toBe(1)
    // A syntactically hostile query returns nothing instead of throwing.
    expect(search(store, { q: 'a" OR b NEAR(' }).totalHits).toBe(0)
  })

  it('ranks records with more occurrences first, bm25-style', () => {
    const store = open()
    add(store, key(), [
      { line: 0, role: 'assistant', text: 'needle' },
      { line: 1, role: 'assistant', text: 'needle needle needle' },
      { line: 2, role: 'assistant', text: 'needle needle' },
    ])
    const hits = search(store, { q: 'needle' }).groups[0]?.hits
    expect(hits?.map(hit => hit.line)).toEqual([1, 2, 0])
    expect(hits?.map(hit => hit.score)).toEqual([3, 2, 1])
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

  it('reports truncation and a lower-bound count when the candidate cap cuts in', () => {
    const store = open()
    add(store, key(), Array.from({ length: 5 }, (_unused, index) => ({
      line: index, role: 'assistant' as const, text: `needle in record number ${index}`,
    })))
    const response = search(store, { q: 'needle', candidateLimit: 3 })
    expect(response).toMatchObject({ totalHits: 3, truncated: true })
    // Only the scanned candidates could be verified, so the badge is a floor.
    expect(response.groups[0]?.hitCount).toBe(3)
  })

  it('reports whether the startup backfill is still running', () => {
    const store = open()
    expect(search(store, { q: 'anything', indexing: { pendingFiles: 3, ready: false, filesDone: 2, filesTotal: 9 } }).indexing)
      .toEqual({ pendingFiles: 3, ready: false, filesDone: 2, filesTotal: 9 })
    // Even a query that is answered without touching the index carries the state.
    expect(search(store, { q: 'ab', indexing: { pendingFiles: 1, ready: false, filesDone: 0, filesTotal: 4 } }).indexing)
      .toEqual({ pendingFiles: 1, ready: false, filesDone: 0, filesTotal: 4 })
  })
})

describe('buildSnippet', () => {
  it('marks every occurrence when the document fits the window', () => {
    expect(buildSnippet('the needle in a needlestack', 'needle')).toEqual({
      snippet: 'the needle in a needlestack',
      matches: [{ start: 4, end: 10 }, { start: 16, end: 22 }],
    })
  })

  it('centres a window on the first occurrence and ellipsizes both ends', () => {
    const text = `${'x'.repeat(100)}needle${'y'.repeat(100)}`
    const { snippet, matches } = buildSnippet(text, 'needle')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(matches).toHaveLength(1)
    expect(snippet.slice(matches[0]?.start, matches[0]?.end)).toBe('needle')
  })

  it('matches case-insensitively while keeping the document case', () => {
    const { snippet, matches } = buildSnippet('Some NEEDLE here', 'needle')
    expect(snippet.slice(matches[0]?.start, matches[0]?.end)).toBe('NEEDLE')
  })

  it('widens the window when the needle itself is longer than the window', () => {
    const needle = 'n'.repeat(70)
    const { snippet, matches } = buildSnippet(`xx${needle}yy`, needle)
    expect(snippet).toBe(`…${needle}…`)
    expect(matches).toEqual([{ start: 1, end: 71 }])
  })

  it('falls back to the document head when the needle is absent', () => {
    expect(buildSnippet('nothing here', 'zzz')).toEqual({ snippet: 'nothing here', matches: [] })
  })
})

describe('compressed text at rest', () => {
  it('round-trips any text through the deflate blob', () => {
    expect(unpackText(packText('原文 hello ✕ ⁄ and ❮unicode❯'))).toBe('原文 hello ✕ ⁄ and ❮unicode❯')
    expect(unpackText(packText(''))).toBe('')
    expect(() => unpackText(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it('serves snippets from the compressed copy, byte-identical to the insert', () => {
    const store = open()
    // 10 KB with low redundancy near the tail, so compression cannot be
    // serving an accidental match from somewhere else.
    const tail = 'qzv'.repeat(300)
    const text = `${'the quick brown fox. '.repeat(300)}MARKER-${tail}-END`
    add(store, key(), [{ line: 4, role: 'tool', text }])
    const hit = search(store, { q: tail.slice(100, 150) }).groups[0]?.hits[0]
    const range = hit?.matches[0]
    expect(hit?.line).toBe(4)
    expect(hit?.snippet.slice(range?.start, range?.end)).toBe(tail.slice(100, 150))
  })

  it('reuses one files row across batches of the same transcript', () => {
    const store = open()
    add(store, key(), [{ line: 0, role: 'human', text: 'first batch' }])
    add(store, key(), [{ line: 1, role: 'human', text: 'second batch' }])
    expect(store.fileCount()).toBe(1)
    expect(store.docCount()).toBe(2)
  })

  it('skips a document whose stored blob is corrupt instead of failing the search', () => {
    const store = open()
    add(store, key(), [
      { line: 0, role: 'human', text: 'corrupt me please' },
      { line: 1, role: 'human', text: 'corrupt me not' },
    ])
    store.db.prepare(`update texts set text = ? where id = (select text from docs where line = 0)`)
      .run(Buffer.from([1, 2, 3, 4]))
    const response = search(store, { q: 'corrupt me' })
    // The FTS index still nominates the torn row; verification skips it.
    expect(response.totalHits).toBe(1)
    expect(response.groups[0]?.hits[0]?.line).toBe(1)
  })
})

describe('text dedup', () => {
  it('stores and indexes a repeated text once, but expands every occurrence', () => {
    const store = open()
    const shared = 'the exact same tool output in two sessions'
    add(store, key(), [{ line: 2, role: 'tool', text: shared }])
    add(store, key({ path: '/r/codex/r-1.jsonl', kind: 'codex', sessionId: 'thread-1', fileId: 'thread-1' }), [
      { line: 7, role: 'tool', text: shared },
    ])
    expect(store.docCount()).toBe(2)
    expect(store.textCount()).toBe(1)
    // One FTS row total: the inverted index holds the text once.
    expect(store.db.prepare('select count(*) as n from docs_fts').get()?.['n']).toBe(1)

    const response = search(store, { q: 'same tool output' })
    expect(response.totalHits).toBe(2)
    const byKind = new Map(response.groups.map(group => [group.kind, group]))
    expect(byKind.get('claude')?.hits[0]).toMatchObject({ line: 2 })
    expect(byKind.get('codex')?.hits[0]).toMatchObject({ line: 7 })
    // Kind filtering happens at expansion, where the session identity lives.
    expect(search(store, { q: 'same tool output', kind: 'codex' }).totalHits).toBe(1)
  })

  it('keeps a surviving occurrence searchable after the other file is cleared', () => {
    const store = open()
    const shared = 'output both transcripts printed verbatim'
    const doomed = key()
    const survivor = key({ path: '/r/codex/r-1.jsonl', kind: 'codex', sessionId: 'thread-1', fileId: 'thread-1' })
    add(store, doomed, [{ line: 0, role: 'tool', text: shared }])
    add(store, survivor, [{ line: 1, role: 'tool', text: shared }])

    store.transaction(() => { store.clearDocs(doomed.path) })
    expect(store.docCount()).toBe(1)
    // The text and its FTS row must stay: the survivor still references them.
    expect(store.textCount()).toBe(1)
    const response = search(store, { q: 'printed verbatim' })
    expect(response.totalHits).toBe(1)
    expect(response.groups[0]).toMatchObject({ kind: 'codex', sessionId: 'thread-1' })
  })

  it('reclaims orphaned texts and their FTS rows only via gcTexts', () => {
    const store = open()
    const file = key()
    add(store, file, [{ line: 0, role: 'human', text: 'a prompt nobody else typed' }])
    store.transaction(() => { store.deleteFile(file.path) })
    expect(store.docCount()).toBe(0)
    // Deferred by design: the text lingers, matches, and expands to no hits.
    expect(store.textCount()).toBe(1)
    expect(search(store, { q: 'nobody else typed' }).totalHits).toBe(0)

    store.gcTexts()
    expect(store.textCount()).toBe(0)
    expect(store.db.prepare('select count(*) as n from docs_fts').get()?.['n']).toBe(0)
    expect(search(store, { q: 'nobody else typed' }).totalHits).toBe(0)
  })
})
