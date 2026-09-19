/**
 * OpencodeSource — real temporary `opencode.db` fixtures.
 *
 * The schema is created by `OpencodeDb.createSchema` (the same DDL the real
 * store uses); rows are hand-written with the real column names and the real
 * V1 `Message`/`Part` field names opencode 1.18.x writes (`role`,
 * `time.{created,completed}`, `state.{status,input,output,time.compacted}`,
 * `state.metadata.sessionId`, `parent_id`). All times are epoch ms.
 */

import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionLiveEvent } from '@harness-trajectory/core'
import { OpencodeDb } from '../src/opencode/db.ts'
import { OpencodeSource } from '../src/opencode/source.ts'
import { SearchIndexer } from '../src/search/indexer.ts'
import { search } from '../src/search/query.ts'
import { SearchStore } from '../src/search/store.ts'
import { extractSearchDocs } from '../src/search/extract.ts'

let dir: string
let dbPath: string
let source: OpencodeSource | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ht-opencode-'))
  dbPath = join(dir, 'opencode.db')
  source = null
})

afterEach(() => {
  source?.stop()
  rmSync(dir, { recursive: true, force: true })
})

const T = 1_700_000_000_000

/** A writable fixture handle; `start` re-opens the same file read-only. */
function fixture(path = dbPath): OpencodeDb {
  return new OpencodeDb(path, { readOnly: false })
}

function insertSession(
  db: OpencodeDb,
  id: string,
  overrides: {
    parent_id?: string | null
    title?: string
    directory?: string
    agent?: string | null
    model?: string | null
    time_created?: number
    time_updated?: number
  } = {},
): void {
  db.db.prepare(
    `INSERT INTO session (id, parent_id, slug, directory, title, version, agent, model,
      cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, '1.18.31', ?, ?, 0, 0, 0, 0, 0, 0, ?, ?)`,
  ).run(
    id,
    overrides.parent_id ?? null,
    `slug-${id}`,
    overrides.directory ?? '/work/project',
    overrides.title ?? `Session ${id}`,
    overrides.agent ?? null,
    overrides.model ?? null,
    overrides.time_created ?? T,
    overrides.time_updated ?? overrides.time_created ?? T,
  )
}

function insertMessage(
  db: OpencodeDb,
  sessionId: string,
  id: string,
  data: Record<string, unknown>,
  created: number,
  updated = created,
): void {
  db.db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, sessionId, created, updated, JSON.stringify(data))
}

function updateMessage(db: OpencodeDb, id: string, data: Record<string, unknown>, updated: number): void {
  db.db.prepare(`UPDATE message SET data = ?, time_updated = ? WHERE id = ?`)
    .run(JSON.stringify(data), updated, id)
}

function insertPart(
  db: OpencodeDb,
  sessionId: string,
  messageId: string,
  id: string,
  data: Record<string, unknown>,
  created: number,
  updated = created,
): void {
  db.db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, messageId, sessionId, created, updated, JSON.stringify(data))
}

function updatePart(db: OpencodeDb, id: string, data: Record<string, unknown>, updated: number): void {
  db.db.prepare(`UPDATE part SET data = ?, time_updated = ? WHERE id = ?`)
    .run(JSON.stringify(data), updated, id)
}

const userData = (created: number): Record<string, unknown> => ({
  role: 'user', time: { created }, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude' },
})

const assistantData = (
  created: number,
  extra: { completed?: number; finish?: string; modelID?: string } = {},
): Record<string, unknown> => ({
  role: 'assistant', parentID: 'msg_u', modelID: extra.modelID ?? 'claude', providerID: 'anthropic',
  time: { created, ...(extra.completed === undefined ? {} : { completed: extra.completed }) },
  tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
  ...(extra.finish === undefined ? {} : { finish: extra.finish }),
})

const userText = (text: string): Record<string, unknown> => ({ type: 'text', text })

const textPart = (text: string, start: number, end?: number): Record<string, unknown> => ({
  type: 'text', text, time: { start, ...(end === undefined ? {} : { end }) },
})

const toolPart = (
  status: string,
  extra: { callID?: string; tool?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown>; compacted?: number } = {},
): Record<string, unknown> => ({
  type: 'tool', callID: extra.callID ?? 'call_1', tool: extra.tool ?? 'bash',
  state: {
    status,
    input: extra.input ?? { command: 'ls' },
    output: 'result body',
    title: 'bash ls',
    ...(extra.metadata === undefined ? {} : { metadata: extra.metadata }),
    time: { start: T, end: T + 5, ...(extra.compacted === undefined ? {} : { compacted: extra.compacted }) },
  },
})

async function start(): Promise<OpencodeSource> {
  source = new OpencodeSource({ dbPath, watch: false })
  await source.start()
  return source
}

/** Collect a replay of one session as events. */
async function replay(
  source: OpencodeSource,
  id: string,
  fileId?: string,
): Promise<SessionLiveEvent[]> {
  const events: SessionLiveEvent[] = []
  await source.readAll('opencode', id, event => events.push(event), fileId)
  return events
}

function chunksOf(events: SessionLiveEvent[]): { file: string; lines: string[]; startLine: number }[] {
  return events.flatMap(event =>
    event.type === 'lines'
      ? [{ file: event.file.id, lines: [...event.lines], startLine: event.startLine }]
      : [])
}

const tagOf = (line: string): string => (JSON.parse(line) as { t: string }).t

/** Stream lines only — sidecars ride `startLine: -1` outside the numbering. */
function streamLines(events: SessionLiveEvent[]): string[] {
  return chunksOf(events).filter(chunk => chunk.startLine >= 0).flatMap(chunk => chunk.lines)
}

/** A session with one user prompt and one completed assistant step. */
function seedSimple(db: OpencodeDb, id = 'alpha'): void {
  db.createSchema()
  insertSession(db, id)
  insertMessage(db, id, 'msg_u1', userData(T), T)
  insertPart(db, id, 'msg_u1', 'prt_u1', userText('hello there'), T)
  insertMessage(db, id, 'msg_a1', assistantData(T + 10, { completed: T + 19, finish: 'stop' }), T + 10)
  insertPart(db, id, 'msg_a1', 'prt_1', textPart('hi back', T + 11, T + 15), T + 11)
}

describe('OpencodeSource', () => {
  it('lists sessions from the catalog tier without materializing transcripts', async () => {
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha', { title: 'Alpha work', directory: '/work/alpha' })
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('first prompt'), T)
    insertMessage(db, 'alpha', 'msg_u2', userData(T + 10), T + 10)
    insertPart(db, 'alpha', 'msg_u2', 'prt_u2',
      { type: 'text', text: 'injected only', synthetic: true }, T + 10)
    insertMessage(db, 'alpha', 'msg_a1', assistantData(T + 20, { completed: T + 25, finish: 'stop' }), T + 20)
    insertPart(db, 'alpha', 'msg_a1', 'prt_1', textPart('answer', T + 21, T + 22), T + 21)
    db.close()
    const src = await start()
    const list = src.list()
    expect(list.map(session => session.id)).toEqual(['alpha'])
    expect(list[0]?.kind).toBe('opencode')
    expect(list[0]?.title).toBe('Alpha work')
    expect(list[0]?.cwd).toBe('/work/alpha')
    // msg_u2 is an injection (all-synthetic) — only the human prompt counts.
    expect(list[0]?.promptCount).toBe(1)
    expect(list[0]?.startedAt).toBe(T)
  })

  it('readAll emits header → parts → finish with stream indices and a sidecar', async () => {
    const db = fixture()
    seedSimple(db)
    db.close()
    const src = await start()
    const chunks = chunksOf(await replay(src, 'alpha'))
    const stream = chunks.filter(chunk => chunk.startLine >= 0).flatMap(chunk => chunk.lines)
    expect(stream.map(tagOf)).toEqual([
      'opencode.message', 'opencode.message', 'opencode.part', 'opencode.finish',
    ])
    // The session sidecar rides startLine -1, outside the stream numbering.
    const synthetic = chunks.filter(chunk => chunk.startLine === -1).flatMap(chunk => chunk.lines)
    expect(synthetic.map(tagOf)).toEqual(['opencode.session'])
    expect(stream[0]).toContain('msg_u1')
    expect(stream[0]).toContain('prt_u1') // user parts ride inside the header
    expect(stream[2]).toContain('hi back')
  })

  it('a pending tool part is not emitted until it completes', async () => {
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('run it'), T)
    insertMessage(db, 'alpha', 'msg_a1', assistantData(T + 10), T + 10)
    insertPart(db, 'alpha', 'msg_a1', 'prt_1', toolPart('running'), T + 11)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    // Materialize happens on subscribe (the batch goes to the replay, not
    // this subscriber); the emitted prefix shows headers only — the running
    // tool part and no finish yet.
    const soFar = streamLines(await replay(src, 'alpha')).map(tagOf)
    expect(soFar).toEqual(['opencode.message', 'opencode.message'])
    const write = fixture()
    updatePart(write, 'prt_1', toolPart('completed'), T + 50)
    updateMessage(write, 'msg_a1', assistantData(T + 10, { completed: T + 60, finish: 'stop' }), T + 60)
    write.close()
    await src.refresh()
    const after = streamLines(seen).map(tagOf)
    expect(after).toEqual(['opencode.part', 'opencode.finish'])
  })

  it('appends new rows live with the correct startLine', async () => {
    const db = fixture()
    seedSimple(db)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    await src.refresh()
    const write = fixture()
    insertMessage(write, 'alpha', 'msg_a2', assistantData(T + 30, { completed: T + 39, finish: 'stop' }), T + 30)
    insertPart(write, 'alpha', 'msg_a2', 'prt_2', textPart('more', T + 31, T + 35), T + 31)
    write.db.prepare(`UPDATE session SET time_updated = ? WHERE id = 'alpha'`).run(T + 40)
    write.close()
    await src.refresh()
    const appended = chunksOf(seen).filter(chunk => chunk.startLine >= 3)
    // Lines 0-3 shipped at materialize; the append starts at index 4.
    expect(chunksOf(seen).filter(chunk => chunk.startLine === 4).flatMap(chunk => chunk.lines)
      .map(tagOf)).toEqual(['opencode.message', 'opencode.part', 'opencode.finish'])
    expect(appended.length).toBeGreaterThan(0)
  })

  it('a prompt queued behind a streaming assistant still ships the finish with tokens', async () => {
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('go'), T)
    insertMessage(db, 'alpha', 'msg_a1', assistantData(T + 10), T + 10)
    insertPart(db, 'alpha', 'msg_a1', 'prt_1', textPart('thinking', T + 11), T + 11)
    insertPart(db, 'alpha', 'msg_a1', 'prt_2', toolPart('running'), T + 12)
    // The queued prompt's row lands while msg_a1 is still streaming — real
    // store behavior; it must not force-settle or close the assistant.
    insertMessage(db, 'alpha', 'msg_u2', userData(T + 15), T + 15)
    insertPart(db, 'alpha', 'msg_u2', 'prt_u2', userText('queued prompt'), T + 15)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    // Materialize: u1 + a1 headers only — the running tool, the streaming
    // text, and the queued user header all wait.
    expect(streamLines(await replay(src, 'alpha')).map(tagOf))
      .toEqual(['opencode.message', 'opencode.message'])
    const write = fixture()
    updatePart(write, 'prt_1', textPart('thinking', T + 11, T + 18), T + 20)
    updatePart(write, 'prt_2', toolPart('completed'), T + 20)
    updateMessage(write, 'msg_a1', assistantData(T + 10, { completed: T + 25, finish: 'stop' }), T + 25)
    write.close()
    await src.refresh()
    const tags = streamLines(seen).map(tagOf)
    expect(tags).toEqual([
      'opencode.part', 'opencode.part', 'opencode.finish', 'opencode.message',
    ])
    // The finish carries the terminal facts — tokens intact.
    const finish = streamLines(seen).find(line => tagOf(line) === 'opencode.finish')
    expect(finish).toContain('"input":10')
    expect(streamLines(seen).at(-1)).toContain('msg_u2')
  })

  it('a live compaction header ships with tail_start_id after the part update lands', async () => {
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('go'), T)
    insertMessage(db, 'alpha', 'msg_a1', assistantData(T + 10, { completed: T + 19, finish: 'stop' }), T + 10)
    insertPart(db, 'alpha', 'msg_a1', 'prt_1', textPart('done', T + 11, T + 15), T + 11)
    // Compaction: the part row is written WITHOUT tail_start_id (the update
    // lands ~1–2 ms after the summary's time.completed in the real store).
    insertMessage(db, 'alpha', 'msg_c', userData(T + 20), T + 20)
    insertPart(db, 'alpha', 'msg_c', 'prt_c0', { type: 'compaction', auto: true }, T + 20)
    insertMessage(db, 'alpha', 'msg_s', { ...assistantData(T + 30), summary: true }, T + 30)
    insertPart(db, 'alpha', 'msg_s', 'prt_s1', textPart('summary text', T + 31, T + 35), T + 31)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    // Materialize: u1/a1 emit fully; msg_c's header waits — msg_s is not
    // terminal yet.
    expect(streamLines(await replay(src, 'alpha')).map(tagOf)).toEqual([
      'opencode.message', 'opencode.message', 'opencode.part', 'opencode.finish',
    ])
    // The summary goes terminal — the header still waits one tick (the part
    // update has not landed).
    const write = fixture()
    updateMessage(write, 'msg_s',
      { ...assistantData(T + 30, { completed: T + 39, finish: 'stop' }), summary: true }, T + 39)
    write.close()
    await src.refresh()
    expect(streamLines(seen).filter(line => line.includes('msg_c'))).toEqual([])
    // The part UPDATE lands: the header ships WITH tail_start_id, then the
    // summary's block right behind it.
    const write2 = fixture()
    updatePart(write2, 'prt_c0', { type: 'compaction', auto: true, tail_start_id: 'msg_u1' }, T + 40)
    write2.close()
    await src.refresh()
    const shipped = streamLines(seen)
    expect(shipped.map(tagOf)).toEqual([
      'opencode.message', 'opencode.message', 'opencode.part', 'opencode.finish',
    ])
    expect(shipped[0]).toContain('tail_start_id')
    expect(shipped[0]).toContain('msg_c')
  })

  it('a same-millisecond second write is picked up while the tail is open', async () => {
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('go'), T)
    insertMessage(db, 'alpha', 'msg_a1', assistantData(T + 10), T + 10)
    insertPart(db, 'alpha', 'msg_a1', 'prt_1', toolPart('running'), T + 11)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    expect(streamLines(await replay(src, 'alpha')).map(tagOf))
      .toEqual(['opencode.message', 'opencode.message'])
    // Both writes land at the SAME ms the watermark already consumed — the
    // strict `moved` gate sees nothing, but the open tail re-queries.
    const write = fixture()
    updatePart(write, 'prt_1', toolPart('completed'), T + 11)
    updateMessage(write, 'msg_a1', assistantData(T + 10, { completed: T + 20, finish: 'stop' }), T + 10)
    write.close()
    await src.refresh()
    expect(streamLines(seen).map(tagOf)).toEqual(['opencode.part', 'opencode.finish'])
  })

  it('a trailing user message waits one tick before its header ships', async () => {
    const db = fixture()
    seedSimple(db)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    await src.refresh()
    const write = fixture()
    insertMessage(write, 'alpha', 'msg_u2', userData(T + 30), T + 30)
    insertPart(write, 'alpha', 'msg_u2', 'prt_u2', userText('second'), T + 30)
    write.db.prepare(`UPDATE session SET time_updated = ? WHERE id = 'alpha'`).run(T + 40)
    write.close()
    // First tick after the write: the prompt is the trailing row — held back.
    await src.refresh()
    expect(streamLines(seen).filter(line => line.includes('msg_u2')))
      .toEqual([])
    // The patience pass releases it (no new rows needed).
    await src.refresh()
    expect(streamLines(seen).filter(line => line.includes('msg_u2')))
      .toHaveLength(1)
  })

  it('out-of-order settling still emits parts in id order', async () => {
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('go'), T)
    insertMessage(db, 'alpha', 'msg_a1', assistantData(T + 10), T + 10)
    insertPart(db, 'alpha', 'msg_a1', 'prt_1', toolPart('pending', { callID: 'c1' }), T + 11)
    insertPart(db, 'alpha', 'msg_a1', 'prt_2', toolPart('completed', { callID: 'c2' }), T + 12)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    await src.refresh()
    // prt_2 settled but prt_1 has not — neither emits.
    expect(streamLines(await replay(src, 'alpha')).map(tagOf))
      .toEqual(['opencode.message', 'opencode.message'])
    const write = fixture()
    updatePart(write, 'prt_1', toolPart('completed', { callID: 'c1' }), T + 50)
    write.close()
    await src.refresh()
    const parts = streamLines(seen)
      .filter(line => tagOf(line) === 'opencode.part')
      .map(line => (JSON.parse(line) as { id: string }).id)
    expect(parts).toEqual(['prt_1', 'prt_2'])
  })

  it('replay after live appends reproduces the exact emitted sequence', async () => {
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('first'), T)
    db.close()
    source = new OpencodeSource({ dbPath, watch: false })
    await source.start()
    // The transcript tier is lazy: subscribing materializes the stream and
    // the batch reaches the subscriber as ordinary lines events.
    const live: SessionLiveEvent[] = []
    source.subscribe('opencode', 'alpha', event => live.push(event))
    await source.refresh()
    const write = fixture()
    insertMessage(write, 'alpha', 'msg_a1', assistantData(T + 10, { completed: T + 19, finish: 'stop' }), T + 10)
    insertPart(write, 'alpha', 'msg_a1', 'prt_1', textPart('reply', T + 11, T + 12), T + 11)
    write.db.prepare(`UPDATE session SET time_updated = ? WHERE id = 'alpha'`).run(T + 40)
    write.close()
    await source.refresh()
    const liveLines = live.flatMap(event =>
      event.type === 'lines' && event.file.id === 'alpha' && event.startLine >= 0 ? event.lines : [])
    const replayed = chunksOf(await replay(source, 'alpha'))
      .filter(chunk => chunk.file === 'alpha' && chunk.startLine >= 0)
      .flatMap(chunk => chunk.lines)
    // The emitted SET is identical; replay re-derives content from current
    // rows (msg headers may carry fresher data), so compare record identity.
    const shape = (line: string): string => {
      const record = JSON.parse(line) as { t: string; id: string }
      return `${record.t}:${record.id}`
    }
    expect(replayed.map(shape)).toEqual(liveLines.map(shape))
    expect(replayed.length).toBeGreaterThan(0)
  })

  it('reports UTF-8 byte sizes consistently in grouped and per-session catalog reads', async () => {
    const db = fixture()
    seedSimple(db)
    insertSession(db, 'empty')
    insertMessage(db, 'alpha', 'msg_z', userData(T + 100), T + 100)
    insertPart(db, 'alpha', 'msg_z', 'prt_z', userText('中文 😀'), T + 100)
    const expected = [...db.messages('alpha'), ...db.parts('alpha')]
      .reduce((sum, row) => sum + Buffer.byteLength(row.data), 0)
    expect(db.sizeOf('message', 'alpha') + db.sizeOf('part', 'alpha')).toBe(expected)
    db.close()
    const src = await start()
    expect(src.list().find(row => row.id === 'alpha')?.bytes).toBe(expected)
    expect(src.list().find(row => row.id === 'empty')?.bytes).toBe(0)
  })

  it('indexes sessions at startup when a SearchIndexer is injected', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    seedSimple(db)
    db.close()
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    // Never opened — the startup backfill materialized and queued it.
    expect(search(store, { q: 'hello there' }).totalHits).toBe(1)
    expect(search(store, { q: 'hi back' }).totalHits).toBe(1)
  })

  it('a second boot skips streams the index already covers', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    seedSimple(db)
    db.close()
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    const docs = store.docCount()
    const covered = indexer.coverage('opencode://sessions/alpha')
    expect(covered).toBeDefined()
    source.stop()
    // Second boot: the index already covers every row — no bodies are read
    // (nothing is ever queued).
    const queueSpy = vi.spyOn(indexer, 'queue')
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    expect(store.docCount()).toBe(docs)
    expect(indexer.coverage('opencode://sessions/alpha')?.size).toBe(covered?.size)
    expect(queueSpy).not.toHaveBeenCalled()
  })

  it('reopening a partially consumed stream does not reset its indexed prefix', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, maxAgeDays: 0 })
    const db = fixture()
    seedSimple(db)
    insertMessage(db, 'alpha', 'msg_z', userData(T + 100), T + 100)
    insertPart(db, 'alpha', 'msg_z', 'prt_z', userText('waiting prompt'), T + 100)
    db.close()
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    const before = store.docCount()
    source.stop()
    const queue = vi.spyOn(indexer, 'queue')
    const reset = vi.spyOn(indexer, 'reset')
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    expect(reset).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
    expect(store.docCount()).toBe(before)
    await source.refresh()
    indexer.flush()
    expect(search(store, { q: 'waiting prompt' }).totalHits).toBe(1)
    indexer.stop()
    store.close()
  })

  it('a covered stream indexes appended content on the next tick', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    seedSimple(db)
    db.close()
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    const docs = store.docCount()
    source.stop()
    // Second boot: covered → the stream stays unmaterialized.
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    expect(store.docCount()).toBe(docs)
    // Append a prompt + reply to the covered session while search is live.
    const write = fixture()
    insertMessage(write, 'alpha', 'msg_u2', userData(T + 100), T + 100)
    insertPart(write, 'alpha', 'msg_u2', 'prt_u2', userText('second thought'), T + 100)
    insertMessage(write, 'alpha', 'msg_a2', assistantData(T + 110, { completed: T + 119, finish: 'stop' }), T + 110)
    insertPart(write, 'alpha', 'msg_a2', 'prt_a2', textPart('fresh reply', T + 111, T + 112), T + 111)
    write.db.prepare(`UPDATE session SET time_updated = ? WHERE id = 'alpha'`).run(T + 120)
    write.close()
    await source.refresh()
    await source.refresh()
    indexer.flush()
    // The new lines queued from the `indexedLines` watermark — and the
    // covered prefix was not re-queued (hits stay at 1, not 2).
    expect(search(store, { q: 'second thought' }).totalHits).toBe(1)
    expect(search(store, { q: 'fresh reply' }).totalHits).toBe(1)
    expect(search(store, { q: 'hello there' }).totalHits).toBe(1)
    expect(search(store, { q: 'hi back' }).totalHits).toBe(1)
    expect(store.docCount()).toBe(docs + 2)
  })

  it('a session reverted while the source was down re-indexes from scratch', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('keep me'), T)
    insertMessage(db, 'alpha', 'msg_a1', assistantData(T + 10, { completed: T + 19, finish: 'stop' }), T + 10)
    insertPart(db, 'alpha', 'msg_a1', 'prt_a1', textPart('first reply', T + 11, T + 15), T + 11)
    insertMessage(db, 'alpha', 'msg_u2', userData(T + 20), T + 20)
    insertPart(db, 'alpha', 'msg_u2', 'prt_u2', userText('delete me'), T + 20)
    insertMessage(db, 'alpha', 'msg_a2', assistantData(T + 30, { completed: T + 39, finish: 'stop' }), T + 30)
    insertPart(db, 'alpha', 'msg_a2', 'prt_a2', textPart('gone reply', T + 31, T + 35), T + 31)
    db.close()
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    expect(search(store, { q: 'delete me' }).totalHits).toBe(1)
    source.stop()
    // Revert: drop the last prompt+reply while the source is down.
    const write = fixture()
    write.db.prepare(`DELETE FROM part WHERE message_id IN ('msg_u2','msg_a2')`).run()
    write.db.prepare(`DELETE FROM message WHERE id IN ('msg_u2','msg_a2')`).run()
    write.close()
    // New boot: prior.size (8 rows) > the reverted count (4) — NOT covered,
    // so it materializes and `beginFile` resets the shrunken stream.
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    expect(search(store, { q: 'delete me' }).totalHits).toBe(0)
    expect(search(store, { q: 'gone reply' }).totalHits).toBe(0)
    expect(search(store, { q: 'keep me' }).totalHits).toBe(1)
    expect(search(store, { q: 'first reply' }).totalHits).toBe(1)
    expect(indexer.coverage('opencode://sessions/alpha')?.size).toBe(4)
  })

  it('a stream stopped mid-patience is not mistaken for covered', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('held prompt'), T)
    db.close()
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    // The trailing prompt's header still waits for the patience tick —
    // nothing emitted, and coverage must read as INCOMPLETE (size = all
    // rows, indexedBytes = consumed rows).
    expect(store.docCount()).toBe(0)
    const prior = indexer.coverage('opencode://sessions/alpha')
    expect(prior?.size).toBe(2)
    expect(prior?.indexedBytes).toBe(0)
    source.stop()
    // Restart: not covered → materializes; the next tick's patience pass
    // releases the held header and the prompt indexes.
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    await source.refresh()
    indexer.flush()
    expect(search(store, { q: 'held prompt' }).totalHits).toBe(1)
  })

  it('a session inserted after start indexes on the next tick', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('first'), T)
    db.close()
    source = new OpencodeSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    const write = fixture()
    insertSession(write, 'beta', { title: 'Beta session', time_created: T + 100, time_updated: T + 100 })
    insertMessage(write, 'beta', 'msg_b1', userData(T + 100), T + 100)
    insertPart(write, 'beta', 'msg_b1', 'prt_b1', userText('beta prompt'), T + 100)
    write.close()
    await source.refresh()
    await source.refresh() // patience pass releases the trailing prompt's header
    indexer.flush()
    expect(search(store, { q: 'beta prompt' }).totalHits).toBe(1)
  })

  it('enableSearch materializes and indexes existing sessions', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    seedSimple(db)
    db.close()
    source = new OpencodeSource({ dbPath, watch: false })
    await source.start()
    indexer.flush()
    expect(store.docCount()).toBe(0)

    await source.enableSearch(indexer)
    indexer.finishBackfill(source.livePaths())
    const path = 'opencode://sessions/alpha'
    expect(store.fileState(path)?.indexedLines).toBe(4)
    expect(search(store, { q: 'hello there' }).totalHits).toBe(1)
    expect(search(store, { q: 'hi back' }).totalHits).toBe(1)

    source.disableSearch()
    const docs = store.docCount()
    await source.enableSearch(indexer)
    indexer.flush()
    expect(store.docCount()).toBe(docs)
  })

  it('a pruned tool part emits one sidecar line at startLine -1', async () => {
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha')
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('go'), T)
    insertMessage(db, 'alpha', 'msg_a1', assistantData(T + 10), T + 10)
    insertPart(db, 'alpha', 'msg_a1', 'prt_1', toolPart('completed'), T + 11)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    await src.refresh()
    const write = fixture()
    updatePart(write, 'prt_1', toolPart('completed', { compacted: T + 500 }), T + 500)
    write.close()
    await src.refresh()
    const prunes = chunksOf(seen)
      .filter(chunk => chunk.startLine === -1)
      .flatMap(chunk => chunk.lines)
      .filter(line => tagOf(line) === 'opencode.prune')
    expect(prunes).toHaveLength(1)
    expect(prunes[0]).toContain('call_1')
    // Replay: the prune is a synthetic source, never a stream index.
    const chunks = chunksOf(await replay(src, 'alpha'))
    expect(chunks.filter(chunk => chunk.startLine === -1).flatMap(chunk => chunk.lines)
      .filter(line => tagOf(line) === 'opencode.prune')).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.startLine >= 0).flatMap(chunk => chunk.lines)
      .some(line => tagOf(line) === 'opencode.prune')).toBe(false)
  })

  it('a count regression rebuilds the stream with a file reset', async () => {
    const db = fixture()
    seedSimple(db)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    await src.refresh()
    const write = fixture()
    // Revert: rows deleted below the consumed watermark.
    write.db.prepare(`DELETE FROM part`).run()
    write.db.prepare(`DELETE FROM message`).run()
    insertMessage(write, 'alpha', 'msg_u9', userData(T + 90), T + 90)
    insertPart(write, 'alpha', 'msg_u9', 'prt_u9', userText('after revert'), T + 90)
    write.db.prepare(`UPDATE session SET time_updated = ? WHERE id = 'alpha'`).run(T + 100)
    write.close()
    await src.refresh()
    await src.refresh() // patience pass releases the trailing prompt
    expect(seen.some(event => event.type === 'file' && event.reset === true)).toBe(true)
    const lines = chunksOf(await replay(src, 'alpha'))
      .filter(chunk => chunk.startLine >= 0)
      .flatMap(chunk => chunk.lines)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('after revert')
  })

  it('flattens child sessions under the root and binds the task part', async () => {
    const db = fixture()
    db.createSchema()
    insertSession(db, 'alpha', { title: 'Parent session' })
    insertSession(db, 'child1', {
      parent_id: 'alpha', title: 'Survey the repo (@explore subagent)', agent: 'explore',
      time_created: T + 100, time_updated: T + 100,
    })
    insertMessage(db, 'alpha', 'msg_u1', userData(T), T)
    insertPart(db, 'alpha', 'msg_u1', 'prt_u1', userText('delegate'), T)
    insertMessage(db, 'alpha', 'msg_a1', assistantData(T + 10, { completed: T + 19, finish: 'stop' }), T + 10)
    insertPart(db, 'alpha', 'msg_a1', 'prt_1', toolPart('completed', {
      callID: 'call_spawn', tool: 'task',
      input: { description: 'Survey the repo', subagent_type: 'explore' },
      metadata: { sessionId: 'child1', model: { modelID: 'claude-small' } },
    }), T + 11)
    insertMessage(db, 'child1', 'msg_cu', userData(T + 110), T + 110)
    insertPart(db, 'child1', 'msg_cu', 'prt_cu', userText('child task'), T + 110)
    db.close()
    const src = await start()
    // Catalog: the child lists under its root with row-derived facts.
    const detail = src.get('opencode', 'alpha')
    const children = detail?.files.filter(file => file.role === 'child') ?? []
    expect(children).toHaveLength(1)
    expect(children[0]?.id).toBe('child1')
    expect(children[0]?.path).toBe('opencode://sessions/alpha/child1')
    expect(children[0]?.agent?.agentId).toBe('child1')
    expect(children[0]?.agent?.description).toBe('Survey the repo')
    expect(children[0]?.agent?.agentType).toBe('explore')
    expect(src.hasChild('opencode', 'alpha', 'child1')).toBe(true)
    // The parent materializes → the task part binds toolUseId/model.
    const events = await replay(src, 'alpha')
    const childRef = events.flatMap(event => (event.type === 'file' ? [event.file] : []))
      .find(file => file.id === 'child1')
    expect(childRef?.agent?.toolUseId).toBe('call_spawn')
    expect(childRef?.agent?.model).toBe('claude-small')
    // The sidecar lists the flattened child.
    const sidecar = chunksOf(events)
      .filter(chunk => chunk.startLine === -1)
      .flatMap(chunk => chunk.lines)
      .find(line => tagOf(line) === 'opencode.session')
    expect(sidecar).toContain('child1')
    // A tick releases the child's trailing user header.
    await src.refresh()
    // Standalone child replay serves its own stream.
    const childLines = chunksOf(await replay(src, 'alpha', 'child1'))
      .flatMap(chunk => chunk.lines)
    expect(childLines.some(line => line.includes('child task'))).toBe(true)
    expect(childLines.some(line => line.includes('delegate'))).toBe(false)
  })

  it('a late session title re-sends the facts sidecar', async () => {
    const db = fixture()
    seedSimple(db)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    await src.refresh()
    const sidecars = () => chunksOf(seen)
      .filter(chunk => chunk.startLine === -1)
      .flatMap(chunk => chunk.lines)
      .filter(line => tagOf(line) === 'opencode.session')
    const before = sidecars().length
    const write = fixture()
    write.db.prepare(`UPDATE session SET title = 'Renamed session', time_updated = ? WHERE id = 'alpha'`)
      .run(T + 500)
    write.close()
    await src.refresh()
    const after = sidecars()
    expect(after.length).toBe(before + 1)
    expect(after.at(-1)).toContain('Renamed session')
  })

  it('a missing database degrades to empty and recovers when it appears', async () => {
    source = new OpencodeSource({ dbPath, watch: false })
    const errors: unknown[] = []
    source.on('error', error => errors.push(error))
    await source.start()
    expect(source.list()).toEqual([])
    expect(errors).toEqual([])
    const db = fixture()
    seedSimple(db)
    db.close()
    await source.refresh()
    expect(source.list().map(session => session.id)).toEqual(['alpha'])
    expect(errors).toEqual([])
    const lines = chunksOf(await replay(source, 'alpha')).flatMap(chunk => chunk.lines)
    expect(lines.some(line => line.includes('hi back'))).toBe(true)
  })

  it('an atomic store replacement rebuilds every stream', async () => {
    const db = fixture()
    seedSimple(db)
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('opencode', 'alpha', event => seen.push(event))
    await src.refresh()
    // Build a NEW store beside it and rename over — new inode, same path.
    // 'alpha' survives with different rows (its stream resets); 'beta' is new.
    const nextPath = join(dir, 'opencode-next.db')
    const next = fixture(nextPath)
    next.createSchema()
    insertSession(next, 'alpha', { title: 'Replacement alpha' })
    insertMessage(next, 'alpha', 'msg_nu', userData(T), T)
    insertPart(next, 'alpha', 'msg_nu', 'prt_nu', userText('fresh store'), T)
    insertSession(next, 'beta', { title: 'Replacement beta' })
    next.close()
    renameSync(nextPath, dbPath)
    await src.refresh()
    await src.refresh() // patience pass releases the trailing prompt
    expect(seen.some(event => event.type === 'file' && event.reset === true)).toBe(true)
    expect(src.list().map(session => session.id).sort()).toEqual(['alpha', 'beta'])
    const lines = chunksOf(await replay(src, 'alpha'))
      .filter(chunk => chunk.startLine >= 0)
      .flatMap(chunk => chunk.lines)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('fresh store')
  })
})
