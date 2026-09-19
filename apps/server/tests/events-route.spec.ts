/**
 * The session event stream, read as a client reads it: every `lines` event
 * carries where its first line sits in the file it came from, which is what
 * lets a content-search hit be resolved back to a record.
 */

import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionLiveEvent } from '@harness-trajectory/core'
import { createApp } from '../src/app.ts'
import { SessionIndex } from '../src/index.ts'
import type { Subscriber } from '../src/source.ts'

const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function jsonl(records: readonly unknown[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

function claudeUser(text: string, sessionId: string, offset: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'user', uuid: `u-${offset}`, parentUuid: null, isSidechain: false, sessionId,
    cwd: '/work/project', timestamp: iso(offset), message: { role: 'user', content: text },
    origin: { kind: 'human' }, ...extra,
  }
}

/** Read the SSE body until `ready`, decoding every event. */
async function replay(app: ReturnType<typeof createApp>, path: string): Promise<SessionLiveEvent[]> {
  const response = await app.request(path)
  expect(response.status).toBe(200)
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('no body')
  const decoder = new TextDecoder()
  const events: SessionLiveEvent[] = []
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let at = buffer.indexOf('\n\n')
    while (at >= 0) {
      const frame = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      const data = frame.split('\n').find(part => part.startsWith('data:'))?.slice(5).trim()
      if (data !== undefined && data !== '') events.push(JSON.parse(data) as SessionLiveEvent)
      at = buffer.indexOf('\n\n')
    }
    if (events.some(event => event.type === 'ready')) break
  }
  await reader.cancel()
  return events
}

/** `[startLine, count]` of every `lines` event about one file. */
function numbering(events: readonly SessionLiveEvent[], fileId: string): number[][] {
  return events.flatMap(event => (event.type === 'lines' && event.file.id === fileId
    ? [[event.startLine, event.lines.length]]
    : []))
}

describe('GET /api/sessions/:kind/:id/events', () => {
  let dir: string
  let index: SessionIndex

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-events-'))
    await mkdir(join(dir, 'claude', '-slug', 'main-1', 'subagents'), { recursive: true })
    // 900 records plus blank lines, which `readLines` drops: the numbering is
    // over NON-BLANK lines, exactly like the search index's.
    const records = Array.from({ length: 900 }, (_, at) => claudeUser(`prompt ${at}`, 'main-1', at * 10))
    await writeFile(
      join(dir, 'claude', '-slug', 'main-1.jsonl'),
      records.map(record => JSON.stringify(record)).join('\n\n') + '\n',
    )
    index = new SessionIndex({
      roots: [{ kind: 'claude', dir: join(dir, 'claude') }],
      watch: false,
      now: () => T0 + 60_000,
    })
    await index.start()
  })

  afterEach(async () => {
    index.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('numbers every replayed chunk continuously across chunk boundaries', async () => {
    const events = await replay(createApp({ index }), '/api/sessions/claude/main-1/events')
    expect(numbering(events, 'main-1')).toEqual([[0, 400], [400, 400], [800, 100]])
    // Line 0 of the file is the first record, blank lines and all.
    const first = events.find(event => event.type === 'lines')
    expect(JSON.parse(first?.type === 'lines' ? first.lines[0] ?? '{}' : '{}'))
      .toMatchObject({ uuid: 'u-0' })
  })

  it('pauses replay at the consumer and keeps appends outside its captured boundary', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: SessionLiveEvent[] = []
    const live: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('claude', 'main-1', event => { live.push(event) })
    const pending = index.readAll('claude', 'main-1', async event => {
      events.push(event)
      if (event.type === 'lines' && event.startLine === 0) {
        entered.resolve()
        await release.promise
      }
    })
    await entered.promise
    expect(numbering(events, 'main-1')).toEqual([[0, 400]])
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await appendFile(path, jsonl([claudeUser('while replay is paused', 'main-1', 99_000)]))
    await index.refreshPath(path)
    expect(numbering(events, 'main-1')).toEqual([[0, 400]])
    expect(numbering(live, 'main-1')).toEqual([[900, 1]])
    release.resolve()
    await pending
    expect(numbering(events, 'main-1')).toEqual([[0, 400], [400, 400], [800, 100]])
    unsubscribe()
  })

  it('stops producing replay chunks when the consumer cancels', async () => {
    const abort = new AbortController()
    const events: SessionLiveEvent[] = []
    await index.readAll('claude', 'main-1', event => {
      events.push(event)
      if (event.type === 'lines') abort.abort()
    }, undefined, abort.signal)
    expect(events.map(event => event.type)).toEqual(['file', 'lines'])
    expect(numbering(events, 'main-1')).toEqual([[0, 400]])
  })

  it('cancels source replay and unsubscribes when an HTTP reader disconnects', async () => {
    const finished = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    let signal: AbortSignal | undefined
    const original = index.readAll.bind(index)
    vi.spyOn(index, 'readAll').mockImplementation(async (...args) => {
      signal = args[4]
      started.resolve()
      try { await original(...args) } finally { finished.resolve() }
    })
    const unsubscribe = vi.fn()
    vi.spyOn(index, 'subscribe').mockReturnValue(unsubscribe)
    const response = await createApp({ index }).request('/api/sessions/claude/main-1/events')
    await started.promise
    await response.body?.cancel()
    await finished.promise
    expect(signal?.aborted).toBe(true)
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('disconnects an overflowing live queue so the viewer can recover through replay', async () => {
    const finished = Promise.withResolvers<void>()
    let subscriber: Subscriber | undefined
    const unsubscribe = vi.fn()
    vi.spyOn(index, 'subscribe').mockImplementation((_kind, _id, next) => {
      subscriber = next
      return unsubscribe
    })
    vi.spyOn(index, 'readAll').mockImplementation(async (_kind, _id, _emit, _file, signal) => {
      await new Promise<void>(resolve => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
      finished.resolve()
    })
    const response = await createApp({ index }).request('/api/sessions/claude/main-1/events')
    const file = index.get('claude', 'main-1')?.files[0]
    if (file === undefined || subscriber === undefined) throw new Error('stream not opened')
    subscriber({ type: 'lines', file, startLine: 900, lines: ['x'.repeat(5 * 1024 * 1024)] })
    await finished.promise
    expect(unsubscribe).toHaveBeenCalled()
    await response.body?.cancel()
  })

  it('continues the numbering into live appends and restarts it after a truncation', async () => {
    const app = createApp({ index })
    await replay(app, '/api/sessions/claude/main-1/events')
    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    const live: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('claude', 'main-1', event => live.push(event))

    await appendFile(path, jsonl([claudeUser('appended', 'main-1', 99_000)]))
    await index.refreshPath(path)
    expect(numbering(live, 'main-1')).toEqual([[900, 1]])

    // Rewritten shorter: subscribers are told to refold, and the file's lines
    // are numbered from zero again.
    live.length = 0
    await writeFile(path, jsonl([claudeUser('rewritten', 'main-1', 0)]))
    await index.refreshPath(path)
    expect(live.some(event => event.type === 'file' && event.reset === true)).toBe(true)
    expect(numbering(live, 'main-1')).toEqual([[0, 1]])
    unsubscribe()
  })

  it('numbers a child transcript on its own, in the session stream and in its own view', async () => {
    const childPath = join(dir, 'claude', '-slug', 'main-1', 'subagents', 'agent-a1.jsonl')
    await writeFile(childPath, jsonl([
      claudeUser('child prompt', 'main-1', 1, { isSidechain: true, agentId: 'a1' }),
      claudeUser('child follow-up', 'main-1', 2, { isSidechain: true, agentId: 'a1' }),
    ]))
    await index.refreshPath(childPath)
    const app = createApp({ index })

    const whole = await replay(app, '/api/sessions/claude/main-1/events')
    expect(numbering(whole, 'main-1/agent-a1')).toEqual([[0, 2]])
    // The child's lines sit inside the main file's replay, which keeps counting
    // where it left off.
    expect(numbering(whole, 'main-1')).toEqual([[0, 1], [1, 400], [401, 400], [801, 99]])

    const alone = await replay(app, '/api/sessions/claude/main-1/events?file=main-1%2Fagent-a1')
    expect(numbering(alone, 'main-1/agent-a1')).toEqual([[0, 2]])
    expect(numbering(alone, 'main-1')).toEqual([])
  })
})
