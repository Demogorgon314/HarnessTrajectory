import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionIndex } from '../src/index.ts'
import { extractSearchDocs } from '../src/search/extract.ts'
import { SearchIndexer } from '../src/search/indexer.ts'
import { search } from '../src/search/query.ts'
import { SearchStore } from '../src/search/store.ts'
import type { HarnessRoot } from '../src/roots.ts'

const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function jsonl(records: readonly unknown[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

function claudeUser(text: string, sessionId: string, offset: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'user', uuid: `u-${offset}`, parentUuid: null, isSidechain: false, sessionId,
    cwd: '/work/project', timestamp: iso(offset), message: { role: 'user', content: text },
    ...extra,
  }
}

function claudeAssistant(text: string, sessionId: string, offset: number) {
  return {
    type: 'assistant', uuid: `a-${offset}`, sessionId, timestamp: iso(offset),
    message: {
      id: `msg-${offset}`, role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
    },
  }
}

describe('SearchIndexer with SessionIndex', () => {
  let dir: string
  let store: SearchStore
  let indexer: SearchIndexer
  let index: SessionIndex | null = null
  let extractCalls = 0

  const roots = (): HarnessRoot[] => [{ kind: 'claude', dir: join(dir, 'claude') }]

  /** A fresh index over the same store, as a server restart would build. */
  async function start(): Promise<SessionIndex> {
    index?.stop()
    const fresh = new SessionIndex({ roots: roots(), watch: false, now: () => T0 + 60_000, search: indexer })
    index = fresh
    await fresh.start()
    // The backfill flush already ran inside `start`; nothing is left pending.
    return fresh
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-index-'))
    await mkdir(join(dir, 'claude', '-slug'), { recursive: true })
    store = new SearchStore({ path: ':memory:' })
    extractCalls = 0
    // Real extraction, wrapped so the spec can count how often it ran.
    indexer = new SearchIndexer({
      store,
      flushDelayMs: 5,
      extract: (kind, line) => {
        extractCalls += 1
        return extractSearchDocs(kind, line)
      },
    })
  })

  afterEach(async () => {
    index?.stop()
    index = null
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('indexes a transcript found at startup and addresses each hit by line', async () => {
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await writeFile(path, jsonl([
      claudeUser('Port the trajectory viewer', 'main-1', 0),
      claudeAssistant('Starting with the server.', 'main-1', 1000),
    ]))
    await start()
    expect(store.fileState(path)).toMatchObject({
      kind: 'claude', sessionId: 'main-1', fileId: 'main-1', indexedLines: 2,
    })
    expect(search(store, { q: 'trajectory viewer' }).groups).toEqual([expect.objectContaining({
      kind: 'claude',
      sessionId: 'main-1',
      hits: [expect.objectContaining({ fileId: 'main-1', line: 0, role: 'human' })],
    })])
    expect(search(store, { q: 'with the server' }).groups[0]?.hits[0])
      .toMatchObject({ line: 1, role: 'assistant' })
    expect(indexer.stats()).toEqual({ pendingFiles: 0, ready: true, filesDone: 1, filesTotal: 1 })
  })

  it('indexes only the appended lines and advances the recorded progress', async () => {
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await writeFile(path, jsonl([claudeUser('First prompt here', 'main-1', 0)]))
    const live = await start()
    expect(store.fileState(path)?.indexedLines).toBe(1)
    const afterStartup = extractCalls

    await appendFile(path, jsonl([claudeUser('Second prompt here', 'main-1', 5000)]))
    await live.refreshPath(path)
    indexer.flush()
    expect(extractCalls - afterStartup).toBe(1)
    expect(store.fileState(path)?.indexedLines).toBe(2)
    expect(search(store, { q: 'Second prompt' }).groups[0]?.hits[0]).toMatchObject({ line: 1 })
    expect(store.docCount()).toBe(2)
  })

  it('re-indexes from line 0 when the file is truncated and rewritten', async () => {
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await writeFile(path, jsonl([
      claudeUser('Original opening prompt', 'main-1', 0),
      claudeAssistant('Original answer text', 'main-1', 100),
    ]))
    const live = await start()
    expect(store.docCount()).toBe(2)

    await writeFile(path, jsonl([claudeUser('Rewritten opening', 'main-1', 0)]))
    await live.refreshPath(path)
    indexer.flush()
    expect(store.docCount()).toBe(1)
    expect(search(store, { q: 'Original opening' }).totalHits).toBe(0)
    expect(search(store, { q: 'Rewritten opening' }).groups[0]?.hits[0]).toMatchObject({ line: 0 })
    expect(store.fileState(path)?.indexedLines).toBe(1)
  })

  it('forgets a file that disappeared from disk on the next startup sweep', async () => {
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    const other = join(dir, 'claude', '-slug', 'main-2.jsonl')
    await writeFile(path, jsonl([claudeUser('Doomed session prompt', 'main-1', 0)]))
    await writeFile(other, jsonl([claudeUser('Surviving session prompt', 'main-2', 0)]))
    await start()
    expect(store.fileCount()).toBe(2)

    await rm(path)
    await start()
    expect(store.paths()).toEqual([other])
    expect(search(store, { q: 'Doomed session' }).totalHits).toBe(0)
    expect(search(store, { q: 'Surviving session' }).totalHits).toBe(1)
  })

  it('does not re-extract or duplicate an unchanged file when the server restarts', async () => {
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await writeFile(path, jsonl([
      claudeUser('A prompt that survives a restart', 'main-1', 0),
      claudeAssistant('And an answer that does too', 'main-1', 100),
    ]))
    await start()
    const firstRun = extractCalls
    expect(firstRun).toBe(2)
    expect(store.docCount()).toBe(2)

    // A second SessionIndex over the same store: the meta scanner replays from
    // byte 0, but the search index already holds every line.
    await start()
    expect(extractCalls).toBe(firstRun)
    expect(store.docCount()).toBe(2)
    expect(store.fileState(path)?.indexedLines).toBe(2)

    // An append after the restart is still picked up from where it left off.
    const live = index
    await appendFile(path, jsonl([claudeUser('One more thing to do', 'main-1', 5000)]))
    await live?.refreshPath(path)
    indexer.flush()
    expect(extractCalls).toBe(firstRun + 1)
    expect(search(store, { q: 'One more thing' }).groups[0]?.hits[0]).toMatchObject({ line: 2 })
  })

  it('carries the parent session id and the child file id for a subagent transcript', async () => {
    await mkdir(join(dir, 'claude', '-slug', 'main-1', 'subagents'), { recursive: true })
    await writeFile(join(dir, 'claude', '-slug', 'main-1.jsonl'), jsonl([
      claudeUser('Spawn a helper for this', 'main-1', 0),
    ]))
    const childPath = join(dir, 'claude', '-slug', 'main-1', 'subagents', 'agent-a1.jsonl')
    await writeFile(`${childPath.slice(0, -'.jsonl'.length)}.meta.json`, JSON.stringify({
      agentType: 'Explore', description: 'Find things', toolUseId: 'toolu_1',
    }))
    await writeFile(childPath, jsonl([
      claudeUser('Find every call site of consume', 'main-1', 500, { isSidechain: true, agentId: 'a1' }),
      claudeAssistant('Found four call sites of it', 'main-1', 800),
    ]))
    await start()

    expect(store.fileState(childPath)).toMatchObject({
      kind: 'claude', sessionId: 'main-1', fileId: 'main-1/agent-a1',
    })
    // A hit in a child opens the parent session with the child selected.
    expect(search(store, { q: 'four call sites' }).groups[0]?.hits[0]).toMatchObject({
      sessionId: 'main-1', fileId: 'main-1/agent-a1', line: 1, role: 'assistant',
    })
    expect(search(store, { q: 'Spawn a helper' }).groups[0]?.hits[0]).toMatchObject({
      sessionId: 'main-1', fileId: 'main-1',
    })
  })

  it('keeps a transcript older than the retention window browsable but unindexed', async () => {
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await writeFile(path, jsonl([claudeUser('Ancient prompt from long ago', 'main-1', 0)]))
    const aged = new Date(Date.now() - 120 * 86_400_000)
    await utimes(path, aged, aged)
    indexer = new SearchIndexer({ store, flushDelayMs: 5, maxAgeDays: 90 })
    const live = await start()

    expect(search(store, { q: 'Ancient prompt' }).totalHits).toBe(0)
    // No `files` row either: the file is not live for the index at all.
    expect(store.fileState(path)).toBeUndefined()
    // The session itself is still listed and openable.
    expect(live.list().map(session => session.id)).toContain('main-1')
  })

  it('purges rows of a file that aged out since the last run', async () => {
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await writeFile(path, jsonl([claudeUser('Once young, now ancient', 'main-1', 0)]))
    indexer = new SearchIndexer({ store, flushDelayMs: 5, maxAgeDays: 90 })
    await start()
    expect(search(store, { q: 'Once young' }).totalHits).toBe(1)

    // The file falls out of the window before the next start; its rows go too.
    const aged = new Date(Date.now() - 120 * 86_400_000)
    await utimes(path, aged, aged)
    await start()
    expect(store.fileState(path)).toBeUndefined()
    expect(search(store, { q: 'Once young' }).totalHits).toBe(0)
  })

  it('reconsiders a skipped file on the next start once the window widens', async () => {
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await writeFile(path, jsonl([claudeUser('Old but welcome now', 'main-1', 0)]))
    const aged = new Date(Date.now() - 120 * 86_400_000)
    await utimes(path, aged, aged)
    indexer = new SearchIndexer({ store, flushDelayMs: 5, maxAgeDays: 90 })
    await start()
    expect(store.fileState(path)).toBeUndefined()

    // Widening mid-run does not re-index what is already skipped…
    expect(indexer.applyMaxAgeDays(365)).toBe(0)
    expect(store.fileState(path)).toBeUndefined()
    // …but the next start's sweep registers the file under the new window.
    await start()
    expect(search(store, { q: 'Old but welcome' }).totalHits).toBe(1)
  })
})

describe('SearchIndexer', () => {
  let store: SearchStore

  beforeEach(() => {
    store = new SearchStore({ path: ':memory:' })
  })

  afterEach(() => {
    store.close()
  })

  it('commits on its own once the batch outgrows the limit, without waiting for the timer', () => {
    // A very long debounce: only the size trigger can have written anything.
    const indexer = new SearchIndexer({ store, flushDelayMs: 60_000, maxBatchDocs: 5 })
    const key = { path: '/r/c/main.jsonl', kind: 'claude' as const, sessionId: 'm', fileId: 'm' }
    for (let line = 0; line < 5; line += 1) {
      indexer.queue(key, line, JSON.stringify(claudeUser(`prompt number ${line}`, 'm', line)))
    }
    expect(store.docCount()).toBe(5)
    // The files row lands in the same transaction, so a crash here would not
    // make the next start re-insert the same five documents.
    expect(store.fileState(key.path)).toMatchObject({ indexedLines: 5 })
    indexer.queue(key, 5, JSON.stringify(claudeUser('prompt number 5', 'm', 5)))
    expect(store.docCount()).toBe(5)
    expect(indexer.stats().pendingFiles).toBe(1)
    indexer.flush()
    expect(store.docCount()).toBe(6)
    expect(store.fileState(key.path)).toMatchObject({ indexedLines: 6 })
    expect(indexer.stats().pendingFiles).toBe(0)
    indexer.stop()
  })

  it('counts backfill files so the UI can show N / M', () => {
    const indexer = new SearchIndexer({ store, flushDelayMs: 60_000 })
    expect(indexer.stats()).toMatchObject({ ready: false, filesDone: 0, filesTotal: 0 })
    indexer.setBackfillPlan(4)
    expect(indexer.stats()).toMatchObject({ filesDone: 0, filesTotal: 4, ready: false })
    indexer.noteBackfillFile()
    indexer.noteBackfillFile()
    expect(indexer.stats()).toMatchObject({ filesDone: 2, filesTotal: 4 })
    indexer.stop()
  })

  it('does not duplicate documents when a size flush is followed by a restart', () => {
    const indexer = new SearchIndexer({ store, flushDelayMs: 60_000, maxBatchDocs: 3 })
    const key = { path: '/r/c/main.jsonl', kind: 'claude' as const, sessionId: 'm', fileId: 'm' }
    for (let line = 0; line < 3; line += 1) {
      indexer.queue(key, line, JSON.stringify(claudeUser(`prompt number ${line}`, 'm', line)))
    }
    expect(store.docCount()).toBe(3)
    indexer.stop()

    const again = new SearchIndexer({ store, flushDelayMs: 60_000, maxBatchDocs: 3 })
    expect(again.beginFile(key, { size: 4_000, mtimeMs: 2_000 })).toBe(3)
    again.queue(key, 3, JSON.stringify(claudeUser('prompt number 3', 'm', 3)))
    again.flush()
    expect(store.docCount()).toBe(4)
    expect(search(store, { q: 'prompt number 0' }).totalHits).toBe(1)
    again.stop()
  })

  it('reports itself unready until the startup sweep finishes', () => {
    const indexer = new SearchIndexer({ store })
    expect(indexer.stats().ready).toBe(false)
    indexer.finishBackfill([])
    expect(indexer.stats().ready).toBe(true)
    indexer.stop()
  })

  it('re-homes documents queued before a child was bound to its parent', () => {
    const indexer = new SearchIndexer({ store, flushDelayMs: 60_000 })
    const orphan = { path: '/r/g/child/updates.jsonl', kind: 'grok' as const, sessionId: 'child', fileId: 'child' }
    indexer.queue(orphan, 0, JSON.stringify({
      timestamp: 1, method: 'session/update',
      params: {
        sessionId: 'child',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the helper reports back' } },
        _meta: { agentTimestampMs: T0 },
      },
    }))
    indexer.flush()
    expect(search(store, { q: 'helper reports' }).groups[0]).toMatchObject({ sessionId: 'child' })
    indexer.rebind({ ...orphan, sessionId: 'parent' })
    expect(search(store, { q: 'helper reports' }).groups[0]).toMatchObject({ sessionId: 'parent' })
    expect(search(store, { q: 'helper reports' }).groups[0]?.hits[0]).toMatchObject({ fileId: 'child' })
    indexer.stop()
  })

  it('never lets a malformed line or a broken extractor stop indexing', () => {
    const indexer = new SearchIndexer({
      store,
      flushDelayMs: 0,
      extract: (_kind, line) => {
        if (line.includes('boom')) throw new Error('extractor blew up')
        return [{ role: 'human' as const, text: line }]
      },
    })
    const key = { path: '/r/c/main.jsonl', kind: 'claude' as const, sessionId: 'm', fileId: 'm' }
    expect(() => { indexer.queue(key, 0, 'boom goes the parser') }).not.toThrow()
    indexer.queue(key, 1, 'a perfectly fine line')
    indexer.flush()
    expect(store.docCount()).toBe(1)
    indexer.stop()
  })

  it('decides indexability by the retention window, 0 meaning no limit', () => {
    const NOW = Date.parse('2026-09-15T12:00:00.000Z')
    const DAY = 86_400_000
    // The default matches the settings default.
    const indexer = new SearchIndexer({ store, now: () => NOW })
    expect(indexer.shouldIndex({ mtimeMs: NOW - 89 * DAY })).toBe(true)
    expect(indexer.shouldIndex({ mtimeMs: NOW - 90 * DAY })).toBe(true)
    expect(indexer.shouldIndex({ mtimeMs: NOW - 90 * DAY - 1 })).toBe(false)
    const everything = new SearchIndexer({ store, maxAgeDays: 0, now: () => NOW })
    expect(everything.shouldIndex({ mtimeMs: 0 })).toBe(true)
    indexer.stop()
    everything.stop()
  })

  it('purges indexed rows immediately when the window narrows', () => {
    const NOW = Date.parse('2026-09-15T12:00:00.000Z')
    const DAY = 86_400_000
    const indexer = new SearchIndexer({ store, maxAgeDays: 0, now: () => NOW })
    const stale = { path: '/r/c/old.jsonl', kind: 'claude' as const, sessionId: 'old', fileId: 'old' }
    const fresh = { path: '/r/c/new.jsonl', kind: 'claude' as const, sessionId: 'new', fileId: 'new' }
    store.transaction(() => {
      store.insertDocs(stale, [{ line: 0, role: 'human', text: 'a stale prompt' }])
      store.setFileState(stale, { size: 10, mtimeMs: NOW - 120 * DAY, indexedBytes: 10, indexedLines: 1 })
      store.insertDocs(fresh, [{ line: 0, role: 'human', text: 'a fresh prompt' }])
      store.setFileState(fresh, { size: 10, mtimeMs: NOW - DAY, indexedBytes: 10, indexedLines: 1 })
    })

    expect(indexer.applyMaxAgeDays(90)).toBe(1)
    expect(store.paths()).toEqual([fresh.path])
    expect(search(store, { q: 'stale prompt' }).totalHits).toBe(0)
    expect(search(store, { q: 'fresh prompt' }).totalHits).toBe(1)
    // Narrowing further with nothing left to purge is a no-op.
    expect(indexer.applyMaxAgeDays(30)).toBe(0)
    // 0 lifts the limit and never purges.
    expect(indexer.applyMaxAgeDays(0)).toBe(0)
    expect(indexer.shouldIndex({ mtimeMs: 0 })).toBe(true)
    indexer.stop()
  })
})

describe('SessionIndex backfill sweep', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-sweep-'))
    await mkdir(join(dir, 'claude', '-slug'), { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeSession(id: string, mtimeMs: number): Promise<void> {
    const path = join(dir, 'claude', '-slug', `${id}.jsonl`)
    await writeFile(path, jsonl([claudeUser(`prompt of ${id}`, id, 0)]))
    const atime = new Date(mtimeMs)
    await utimes(path, atime, atime)
  }

  it('registers the newest transcripts first', async () => {
    const base = Date.parse('2026-09-10T00:00:00.000Z')
    const DAY = 86_400_000
    await writeSession('old-one', base)
    await writeSession('new-one', base + 4 * DAY)
    await writeSession('mid-one', base + 2 * DAY)
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, maxAgeDays: 0 })
    const order: string[] = []
    const beginFile = indexer.beginFile.bind(indexer)
    indexer.beginFile = (key, file) => {
      order.push(key.sessionId)
      return beginFile(key, file)
    }
    const index = new SessionIndex({
      roots: [{ kind: 'claude', dir: join(dir, 'claude') }],
      watch: false,
      search: indexer,
      backfillConcurrency: 1,
    })
    await index.start()
    expect(order).toEqual(['new-one', 'mid-one', 'old-one'])
    index.stop()
    store.close()
  })

  it('registers every planned file through the concurrent pool', async () => {
    const base = Date.parse('2026-09-10T00:00:00.000Z')
    for (let n = 0; n < 12; n += 1) await writeSession(`s-${n}`, base + n * 60_000)
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, maxAgeDays: 0 })
    const index = new SessionIndex({
      roots: [{ kind: 'claude', dir: join(dir, 'claude') }],
      watch: false,
      search: indexer,
    })
    await index.start()
    expect(index.list()).toHaveLength(12)
    expect(indexer.stats()).toEqual({ pendingFiles: 0, ready: true, filesDone: 12, filesTotal: 12 })
    expect(search(store, { q: 'prompt of s-7' }).totalHits).toBe(1)
    index.stop()
    store.close()
  })
})
