/**
 * CursorSource — temporary session stores built with the real schema.
 * Blobs and the protobuf root are synthetic; field names match Cursor CLI 2026.09.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionLiveEvent } from '@harness-trajectory/core'
import { CursorDb } from '../src/cursor/db.ts'
import { CursorSource } from '../src/cursor/source.ts'
import { extractSearchDocs } from '../src/search/extract.ts'
import { SearchIndexer } from '../src/search/indexer.ts'
import { search } from '../src/search/query.ts'
import { SearchStore } from '../src/search/store.ts'

const T = 1_700_000_000_000
const AGENT = '11111111-1111-4111-8111-111111111111'

let dir: string
let chats: string
let source: CursorSource | null
let clock = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ht-cursor-'))
  chats = join(dir, 'chats')
  source = null
  clock = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  source?.stop()
  rmSync(dir, { recursive: true, force: true })
})

function varint(value: number): Uint8Array {
  const bytes: number[] = []
  let rest = value
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest & 0x7f)
  return Uint8Array.from(bytes)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function bytesField(field: number, data: Uint8Array): Uint8Array {
  return concat(varint(field * 8 + 2), varint(data.length), data)
}

function strField(field: number, text: string): Uint8Array {
  return bytesField(field, new TextEncoder().encode(text))
}

function varField(field: number, value: number): Uint8Array {
  return concat(varint(field * 8), varint(value))
}

function idBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes[31] = n
  return bytes
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function jsonBlob(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function rootBlob(ids: Uint8Array[], extra: Uint8Array = new Uint8Array()): Uint8Array {
  return concat(...ids.map(id => bytesField(1, id)), extra)
}

function usageBlob(): Uint8Array {
  const bucket = concat(strField(1, 'conversation'), strField(2, 'Conversation'), varField(3, 100), varField(4, 400))
  const usage = concat(varField(1, 1_500), varField(2, 256_000), bytesField(3, bytesField(3, bucket)))
  return concat(
    bytesField(5, usage),
    strField(9, 'file:///work/project'),
    bytesField(21, concat(strField(1, '/work/project'), strField(2, 'main'))),
    strField(22, 'cli'),
  )
}

interface SeedOptions {
  title?: string
  cwd?: string
  name?: string
  lastUsedModel?: string
  hasConversation?: boolean
  withStore?: boolean
  ids?: Uint8Array[]
  messages?: Record<string, unknown>[]
  rootExtra?: Uint8Array
  metaValue?: string
}

function sessionDir(id = AGENT): string {
  return join(chats, 'abcd', id)
}

function writeMetaJson(id: string, options: SeedOptions): void {
  const path = join(sessionDir(id), 'meta.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    createdAtMs: T,
    updatedAtMs: T + 5_000,
    hasConversation: options.hasConversation !== false,
    ...(options.title === undefined ? {} : { title: options.title }),
    cwd: options.cwd ?? '/work/project',
  }))
}

function touch(path: string): void {
  clock += 1
  const seconds = (T / 1000) + clock
  utimesSync(path, seconds, seconds)
}

function seed(options: SeedOptions = {}, id = AGENT): { ids: string[]; rootId: string } {
  const folder = sessionDir(id)
  mkdirSync(folder, { recursive: true })
  writeMetaJson(id, options)
  const ids = options.ids ?? [idBytes(1), idBytes(2)]
  const messages = options.messages ?? [
    { role: 'system', content: 'You are a coding assistant.' },
    {
      role: 'user',
      content: [{ type: 'text', text: '<timestamp>t</timestamp>\n<user_query>\nFix the parser\n</user_query>' }],
      providerOptions: { cursor: { requestId: 'req-1' } },
    },
  ]
  const rootId = hex(idBytes(9))
  if (options.withStore === false) return { ids: ids.map(hex), rootId }
  const dbPath = join(folder, 'store.db')
  const db = new CursorDb(dbPath, { readOnly: false })
  db.createSchema()
  const meta = options.metaValue ?? Buffer.from(JSON.stringify({
    agentId: id,
    latestRootBlobId: rootId,
    ...(options.name === undefined ? {} : { name: options.name }),
    mode: 'agent',
    approvalMode: 'unrestricted',
    createdAt: T,
    lastUsedModel: options.lastUsedModel ?? 'default',
  }), 'utf8').toString('hex')
  db.db.prepare(`INSERT INTO meta (key, value) VALUES ('0', ?)`).run(meta)
  const insert = db.db.prepare(`INSERT INTO blobs (id, data) VALUES (?, ?)`)
  ids.forEach((blobId, index) => {
    const message = messages[index]
    if (message !== undefined) insert.run(hex(blobId), jsonBlob(message))
  })
  insert.run(rootId, rootBlob(ids, options.rootExtra ?? usageBlob()))
  db.close()
  touch(dbPath)
  touch(join(folder, 'meta.json'))
  return { ids: ids.map(hex), rootId }
}

function rewrite(id: string, rootId: string, ids: Uint8Array[], messages: Record<string, unknown>[], name?: string): void {
  const dbPath = join(sessionDir(id), 'store.db')
  const db = new CursorDb(dbPath, { readOnly: false })
  db.db.prepare(`DELETE FROM blobs`).run()
  db.db.prepare(`UPDATE meta SET value = ? WHERE key = '0'`).run(Buffer.from(JSON.stringify({
    agentId: id,
    latestRootBlobId: rootId,
    ...(name === undefined ? {} : { name }),
    createdAt: T,
    lastUsedModel: 'default',
  }), 'utf8').toString('hex'))
  const insert = db.db.prepare(`INSERT INTO blobs (id, data) VALUES (?, ?)`)
  ids.forEach((blobId, index) => {
    const message = messages[index]
    if (message !== undefined) insert.run(hex(blobId), jsonBlob(message))
  })
  insert.run(rootId, rootBlob(ids, usageBlob()))
  db.close()
  touch(dbPath)
}

async function replay(id = AGENT): Promise<SessionLiveEvent[]> {
  const events: SessionLiveEvent[] = []
  await source?.readAll('cursor', id, event => { events.push(event) })
  return events
}

/** Switch roots without deleting the append-only store's previous blobs. */
function publishRoot(data: Uint8Array, n: number): void {
  const dbPath = join(sessionDir(), 'store.db')
  const db = new CursorDb(dbPath, { readOnly: false })
  try {
    const rootId = hex(idBytes(n))
    db.db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(rootId, data)
    db.db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(JSON.stringify({ latestRootBlobId: rootId }))
  } finally {
    db.close()
  }
  touch(dbPath)
}

function streamLines(events: readonly SessionLiveEvent[]): string[] {
  return events.flatMap(event => event.type === 'lines' && event.startLine >= 0 ? [...event.lines] : [])
}

function sidecarLines(events: readonly SessionLiveEvent[]): string[] {
  return events.flatMap(event => event.type === 'lines' && event.startLine === -1 ? [...event.lines] : [])
}

async function start(): Promise<CursorSource> {
  const opened = new CursorSource({ chatsDir: chats, watch: false })
  source = opened
  await opened.start()
  return opened
}

describe('CursorSource', () => {
  it('resumes a verified prefix across restarts and extracts only an appended suffix', async () => {
    const initial = seed()
    const cachePath = join(dir, 'search.sqlite')
    let store = new SearchStore({ path: cachePath })
    const extract = vi.fn(extractSearchDocs)
    let indexer = new SearchIndexer({ store, maxAgeDays: 0, extract })
    let src = await start()
    try {
      await src.enableSearch(indexer)
      indexer.finishBackfill(src.livePaths())
      expect(extract).toHaveBeenCalledTimes(2)
      for (const append of [false, true]) {
        src.stop()
        indexer.stop()
        store.close()
        if (append) {
          const db = new CursorDb(join(sessionDir(), 'store.db'), { readOnly: false })
          db.db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(hex(idBytes(3)), jsonBlob({
            role: 'assistant', content: [{ type: 'text', text: 'Appended answer' }],
          }))
          db.close()
          publishRoot(rootBlob([idBytes(1), idBytes(2), idBytes(3)]), 10)
        }
        extract.mockClear()
        store = new SearchStore({ path: cachePath })
        indexer = new SearchIndexer({ store, maxAgeDays: 0, extract })
        src = new CursorSource({ chatsDir: chats, watch: false, search: indexer })
        source = src
        await src.start()
        indexer.finishBackfill(src.livePaths())
        expect(extract).toHaveBeenCalledTimes(append ? 1 : 0)
        expect(search(store, { q: 'Fix the parser' }).totalHits).toBe(1)
        expect(search(store, { q: 'Appended answer' }).totalHits).toBe(append ? 1 : 0)
        expect(store.fileState('cursor://sessions/' + AGENT)?.indexedLines).toBe(initial.ids.length + Number(append))
      }
    } finally {
      src.disableSearch()
      indexer.stop()
      store.close()
    }
  })

  it('reads only new message bodies on append and retries an unavailable tail', async () => {
    seed()
    const src = await start()
    const live: SessionLiveEvent[] = []
    src.subscribe('cursor', AGENT, event => { live.push(event) })
    const reads = vi.spyOn(CursorDb.prototype, 'readBlob')
    publishRoot(rootBlob([idBytes(1), idBytes(2), idBytes(3)]), 10)
    await src.refresh()
    expect(reads.mock.calls.flat()).not.toContain(hex(idBytes(1)))
    expect(reads.mock.calls.flat()).not.toContain(hex(idBytes(2)))
    expect(streamLines(live)).toHaveLength(0)
    const db = new CursorDb(join(sessionDir(), 'store.db'), { readOnly: false })
    db.db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(hex(idBytes(3)), jsonBlob({
      role: 'assistant', content: [{ type: 'text', text: 'Recovered answer' }],
    }))
    db.close()
    reads.mockClear()
    await src.refresh()
    expect(reads.mock.calls.flat()).not.toContain(hex(idBytes(1)))
    expect(reads.mock.calls.flat()).not.toContain(hex(idBytes(2)))
    expect(streamLines(live)).toHaveLength(1)
    expect(streamLines(await replay())).toHaveLength(3)
  })

  it('detaches search between sessions during backfill and resumes without duplicate hits', async () => {
    seed()
    seed({}, 'second-agent')
    const src = await start()
    const store = new SearchStore({ path: ':memory:' })
    const extract = vi.fn(extractSearchDocs)
    const indexer = new SearchIndexer({ store, maxAgeDays: 0, extract })
    try {
      const backfill = src.enableSearch(indexer)
      src.disableSearch()
      await backfill
      expect(extract).toHaveBeenCalledTimes(2)
      await src.enableSearch(indexer)
      indexer.finishBackfill(src.livePaths())
      expect(extract).toHaveBeenCalledTimes(4)
      expect(search(store, { q: 'Fix the parser' }).totalHits).toBe(2)
    } finally {
      src.disableSearch()
      indexer.stop()
      store.close()
    }
  })

  for (const mode of ['restart', 'toggle'] as const) {
    it.each([1, 2])(`reindexes a rewritten prefix after ${mode} (new length %i)`, async length => {
      const store = new SearchStore({ path: join(dir, 'search.sqlite') })
      let indexer = new SearchIndexer({ store, maxAgeDays: 0 })
      const human = (text: string) => ({
        role: 'user', content: [{ type: 'text', text }],
        providerOptions: { cursor: { requestId: 'req' } },
      })
      seed({ ids: [idBytes(1)], messages: [human('old needle')] })
      let src = await start()
      try {
        await src.enableSearch(indexer)
        indexer.finishBackfill(src.livePaths())
        expect(search(store, { q: 'old needle' }).totalHits).toBe(1)
        src.disableSearch()
        indexer.stop()
        if (mode === 'restart') src.stop()
        const ids = [idBytes(3), idBytes(4)].slice(0, length)
        rewrite(AGENT, hex(idBytes(15)), ids, [human('new needle'), human('another prompt')])
        indexer = new SearchIndexer({ store, maxAgeDays: 0 })
        if (mode === 'restart') {
          src = new CursorSource({ chatsDir: chats, watch: false, search: indexer })
          source = src
          await src.start()
        } else {
          await src.refresh()
          await src.enableSearch(indexer)
        }
        indexer.finishBackfill(src.livePaths())
        expect(search(store, { q: 'old needle' }).totalHits).toBe(0)
        expect(search(store, { q: 'new needle' }).totalHits).toBe(1)
        expect(streamLines(await replay())).toHaveLength(length)
        // A normal append after the rebuild must neither duplicate the prefix
        // nor skip the newly emitted line under the old watermark.
        rewrite(AGENT, hex(idBytes(16)), [...ids, idBytes(5)], [
          ...[human('new needle'), human('another prompt')].slice(0, length), human('appended needle'),
        ])
        await src.refresh()
        indexer.flush()
        expect(search(store, { q: 'new needle' }).totalHits).toBe(1)
        expect(search(store, { q: 'appended needle' }).totalHits).toBe(1)
      } finally {
        src.disableSearch()
        indexer.stop()
        store.close()
      }
    })
  }

  it('clears replay, live state, prompt counts and search when a valid root becomes empty', async () => {
    seed()
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, maxAgeDays: 0 })
    const src = await start()
    try {
      await src.enableSearch(indexer)
      indexer.finishBackfill(src.livePaths())
      expect(search(store, { q: 'Fix the parser' }).totalHits).toBe(1)
      const seen: SessionLiveEvent[] = []
      src.subscribe('cursor', AGENT, event => { seen.push(event) })
      publishRoot(rootBlob([], usageBlob()), 90)
      await src.refresh()
      indexer.flush()
      expect(seen.some(event => event.type === 'file' && event.reset)).toBe(true)
      expect(streamLines(await replay())).toEqual([])
      expect(src.list()[0]?.promptCount).toBe(0)
      expect(search(store, { q: 'Fix the parser' }).totalHits).toBe(0)
      // Old blobs still exist, but only the current root defines the stream.
      publishRoot(rootBlob([idBytes(2)], usageBlob()), 91)
      await src.refresh()
      indexer.flush()
      expect(streamLines(await replay())).toHaveLength(1)
      expect(src.list()[0]?.promptCount).toBe(1)
      expect(search(store, { q: 'Fix the parser' }).totalHits).toBe(1)
    } finally {
      src.disableSearch()
      indexer.stop()
      store.close()
    }
  })

  it('retains a readable prefix through malformed roots and recovers on the next valid root', async () => {
    seed()
    const src = await start()
    const original = streamLines(await replay())
    const seen: SessionLiveEvent[] = []
    src.subscribe('cursor', AGENT, event => { seen.push(event) })
    publishRoot(Uint8Array.of(0x80), 90)
    await src.refresh()
    expect(streamLines(await replay())).toEqual(original)
    expect(seen.some(event => event.type === 'file' && event.reset)).toBe(false)
    publishRoot(rootBlob([], usageBlob()), 91)
    await src.refresh()
    expect(streamLines(await replay())).toEqual([])
    expect(seen.some(event => event.type === 'file' && event.reset)).toBe(true)
  })

  it('lists a conversation from meta.json without opening the transcript', async () => {
    seed({ title: 'API Extraction Script' })
    seed({ hasConversation: false, withStore: false }, '22222222-2222-4222-8222-222222222222')
    mkdirSync(sessionDir('33333333-3333-4333-8333-333333333333'), { recursive: true })
    writeMetaJson('33333333-3333-4333-8333-333333333333', { title: 'No store', hasConversation: true })
    const src = await start()
    const listed = src.list()
    expect(listed.map(session => session.id)).toEqual([AGENT])
    expect(listed[0]?.promptCount).toBe(0)
    expect(listed[0]?.title).toBe('API Extraction Script')
    expect(listed[0]?.cwd).toBe('/work/project')
  })

  it('replays the sidecar then messages in root order', async () => {
    const third = idBytes(3)
    const ids = [idBytes(1), idBytes(2), third]
    seed({
      title: 'API Extraction Script',
      ids,
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: '<user_info>os</user_info>' },
        {
          role: 'user',
          content: [{ type: 'text', text: '<timestamp>t</timestamp>\n<user_query>\nFix the parser\n</user_query>' }],
          providerOptions: { cursor: { requestId: 'req-1' } },
        },
      ],
    })
    const src = await start()
    const events = await replay()
    const sidecar = JSON.parse(sidecarLines(events)[0] ?? '{}') as { type?: string; usage?: { window?: number }; client?: string }
    expect(sidecar.type).toBe('cursor.session')
    expect(sidecar.usage?.window).toBe(256_000)
    expect(sidecar.client).toBe('cli')
    const lines = streamLines(events)
    expect(lines).toHaveLength(3)
    expect(lines.map(line => (JSON.parse(line) as { index: number }).index)).toEqual([0, 1, 2])
    expect(src.list()[0]?.promptCount).toBe(1)
  })

  it('uses the first human prompt as the title when meta.json and the store name are blank', async () => {
    seed({})
    const src = await start()
    expect(src.list()[0]?.title).toBe(AGENT)
    await replay()
    expect(src.list()[0]?.title).toBe('Fix the parser')
    expect(src.list()[0]?.promptCount).toBe(1)
  })

  it('appends a prefix extension and resets on a rewrite', async () => {
    const first = idBytes(1)
    const second = idBytes(2)
    seed({
      title: 'Kept',
      ids: [first, second],
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [{ type: 'text', text: '<user_query>\nfirst\n</user_query>' }],
          providerOptions: { cursor: { requestId: 'req-1' } },
        },
      ],
    })
    const src = await start()
    await replay()
    const seen: SessionLiveEvent[] = []
    src.subscribe('cursor', AGENT, event => { seen.push(event) })
    const third = idBytes(3)
    rewrite(AGENT, hex(idBytes(10)), [first, second, third], [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [{ type: 'text', text: '<user_query>\nfirst\n</user_query>' }],
        providerOptions: { cursor: { requestId: 'req-1' } },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    ])
    await src.refresh()
    expect(seen.some(event => event.type === 'file' && event.reset === true)).toBe(false)
    const appended = seen.flatMap(event => event.type === 'lines' && event.startLine >= 0 ? [...event.lines] : [])
    expect(appended).toHaveLength(1)
    expect((JSON.parse(appended[0] ?? '{}') as { index?: number }).index).toBe(2)

    seen.length = 0
    const replacement = idBytes(4)
    rewrite(AGENT, hex(idBytes(11)), [replacement], [
      {
        role: 'user',
        content: [{ type: 'text', text: '<user_query>\nrewritten\n</user_query>' }],
        providerOptions: { cursor: { requestId: 'req-2' } },
      },
    ])
    await src.refresh()
    expect(seen.some(event => event.type === 'file' && event.reset === true)).toBe(true)
    const rebuilt = await replay()
    const texts = streamLines(rebuilt).map(line => JSON.parse(line) as { message?: { content?: unknown } })
    expect(texts).toHaveLength(1)
    expect(src.list()[0]?.promptCount).toBe(1)
  })

  it('stays empty when the chats directory is missing, then recovers', async () => {
    const src = await start()
    expect(src.list()).toEqual([])
    seed({ title: 'Later' })
    await src.refresh()
    expect(src.list().map(session => session.id)).toEqual([AGENT])
  })

  it('degrades a corrupt meta row and a non-JSON blob to the catalog', async () => {
    seed({ title: 'Broken meta', metaValue: 'zzzz' })
    const src = await start()
    await expect(replay()).resolves.toEqual(expect.any(Array))
    expect(src.list()[0]?.title).toBe('Broken meta')
    expect(streamLines(await replay())).toEqual([])

    source?.stop()
    rmSync(chats, { recursive: true, force: true })
    const junk = idBytes(1)
    seed({
      title: 'Junk blob',
      ids: [junk],
      messages: [],
    })
    const db = new CursorDb(join(sessionDir(), 'store.db'), { readOnly: false })
    db.db.prepare(`INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)`).run(hex(junk), Uint8Array.of(0x0a, 0x02, 0x01, 0x02))
    db.close()
    touch(join(sessionDir(), 'store.db'))
    source = new CursorSource({ chatsDir: chats, watch: false })
    await source.start()
    await expect(replay()).resolves.toEqual(expect.any(Array))
    expect(streamLines(await replay())).toEqual([])
    await source.refresh()
    await source.refresh()
    expect(source.list()[0]?.title).toBe('Junk blob')
  })

  it('stamps lines from the turn chain and rebuilds when the chain changes', async () => {
    const callId = 'call-1\nfc_1'
    const promptAt = T + 1_000
    const toolStart = T + 2_000
    const toolEnd = T + 3_500
    const chain = idBytes(20)
    const prompt = idBytes(21)
    const toolItem = idBytes(22)
    seed({
      title: 'Timed',
      ids: [idBytes(1), idBytes(2), idBytes(3)],
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [{ type: 'text', text: '<user_query>\nfirst\n</user_query>' }],
          providerOptions: { cursor: { requestId: 'req-1' } },
        },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: callId, toolName: 'Shell', args: { command: 'true' } }],
        },
      ],
      rootExtra: concat(usageBlob(), bytesField(8, chain)),
    })
    const db = new CursorDb(join(sessionDir(), 'store.db'), { readOnly: false })
    const insert = db.db.prepare(`INSERT INTO blobs (id, data) VALUES (?, ?)`)
    insert.run(hex(chain), bytesField(1, concat(
      bytesField(1, prompt),
      bytesField(2, toolItem),
      strField(3, 'req-1'),
    )))
    insert.run(hex(prompt), concat(strField(1, 'first'), varField(25, promptAt)))
    insert.run(hex(toolItem), bytesField(2, concat(strField(57, callId), varField(59, toolStart), varField(60, toolEnd))))
    db.close()
    touch(join(sessionDir(), 'store.db'))
    const src = await start()
    const first = streamLines(await replay())
    const times = first.map(line => (JSON.parse(line) as { time?: number }).time)
    expect(times).toEqual([T, promptAt, toolStart])
    const span = JSON.parse(first[2] ?? '{}') as { span?: { start?: number; end?: number } }
    expect(span.span).toMatchObject({ start: toolStart, end: toolEnd })

    const seen: SessionLiveEvent[] = []
    src.subscribe('cursor', AGENT, event => { seen.push(event) })
    const fourth = idBytes(4)
    const nextRoot = hex(idBytes(12))
    const db2 = new CursorDb(join(sessionDir(), 'store.db'), { readOnly: false })
    const insertMore = db2.db.prepare(`INSERT INTO blobs (id, data) VALUES (?, ?)`)
    insertMore.run(hex(fourth), jsonBlob({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: callId, toolName: 'Shell', result: 'ok' }],
    }))
    insertMore.run(nextRoot, rootBlob(
      [idBytes(1), idBytes(2), idBytes(3), fourth],
      concat(usageBlob(), bytesField(8, chain)),
    ))
    db2.db.prepare(`UPDATE meta SET value = ? WHERE key = '0'`).run(Buffer.from(JSON.stringify({
      agentId: AGENT,
      latestRootBlobId: nextRoot,
      createdAt: T,
      lastUsedModel: 'default',
    }), 'utf8').toString('hex'))
    db2.close()
    touch(join(sessionDir(), 'store.db'))
    await src.refresh()
    expect(seen.some(event => event.type === 'file' && event.reset === true)).toBe(false)
    const appended = seen.flatMap(event => event.type === 'lines' && event.startLine >= 0 ? [...event.lines] : [])
    expect(JSON.parse(appended[0] ?? '{}') as { time?: number }).toMatchObject({ time: toolEnd })

    seen.length = 0
    const replacement = idBytes(30)
    const replacementPrompt = idBytes(31)
    const replacementChain = idBytes(32)
    const later = T + 8_000
    rewrite(AGENT, hex(idBytes(40)), [replacement], [
      {
        role: 'user',
        content: [{ type: 'text', text: '<user_query>\nrewritten\n</user_query>' }],
        providerOptions: { cursor: { requestId: 'req-2' } },
      },
    ])
    const db3 = new CursorDb(join(sessionDir(), 'store.db'), { readOnly: false })
    const add = db3.db.prepare(`INSERT INTO blobs (id, data) VALUES (?, ?)`)
    add.run(hex(replacementChain), bytesField(1, concat(bytesField(1, replacementPrompt), strField(3, 'req-2'))))
    add.run(hex(replacementPrompt), concat(strField(1, 'rewritten'), varField(25, later)))
    db3.db.prepare(`UPDATE blobs SET data = ? WHERE id = ?`).run(
      rootBlob([replacement], concat(usageBlob(), bytesField(8, replacementChain))),
      hex(idBytes(40)),
    )
    db3.close()
    touch(join(sessionDir(), 'store.db'))
    await src.refresh()
    expect(seen.some(event => event.type === 'file' && event.reset === true)).toBe(true)
    const rebuilt = streamLines(await replay())
    expect(JSON.parse(rebuilt[0] ?? '{}') as { time?: number }).toMatchObject({ time: later })
  })

  it('indexes human text and tool calls once, never tool output', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const callId = 'call-1\nfc_1'
    seed({
      ids: [idBytes(1), idBytes(2), idBytes(3), idBytes(4)],
      messages: [
        { role: 'user', content: '<user_info>secret environment</user_info>' },
        {
          role: 'user',
          content: [{ type: 'text', text: '<user_query>\nfind the parser\n</user_query>' }],
          providerOptions: { cursor: { requestId: 'req-1' } },
        },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: callId, toolName: 'Shell', args: { command: 'rg parser src' } }],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: callId, toolName: 'Shell', result: 'unique-tool-stdout' }],
        },
      ],
    })
    const src = await start()
    await src.enableSearch(indexer)
    indexer.finishBackfill(src.livePaths())
    expect(search(store, { q: 'find the parser' }).totalHits).toBe(1)
    expect(search(store, { q: 'rg parser src' }).totalHits).toBe(1)
    expect(search(store, { q: 'unique-tool-stdout' }).totalHits).toBe(0)
    expect(search(store, { q: 'secret environment' }).totalHits).toBe(0)
    const docs = store.docCount()
    src.disableSearch()
    await src.enableSearch(indexer)
    indexer.flush()
    expect(store.docCount()).toBe(docs)
  })
})
