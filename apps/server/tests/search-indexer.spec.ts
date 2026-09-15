import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    expect(indexer.stats()).toEqual({ pendingFiles: 0, ready: true })
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
    indexer.queue(key, 5, JSON.stringify(claudeUser('prompt number 5', 'm', 5)))
    expect(store.docCount()).toBe(5)
    expect(indexer.stats().pendingFiles).toBe(1)
    indexer.flush()
    expect(store.docCount()).toBe(6)
    expect(indexer.stats().pendingFiles).toBe(0)
    indexer.stop()
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
})
