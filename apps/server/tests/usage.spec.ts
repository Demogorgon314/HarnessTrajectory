import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UsageReport, UsageStreamEvent } from '@harness-trajectory/core'
import { SessionIndex } from '../src/index.ts'
import { createApp } from '../src/app.ts'
import { UsageService } from '../src/usage.ts'

let dir: string
let source: SessionIndex
const time = '2026-09-20T12:00:00Z'
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n'

const parentId = '0199aaaa-0000-7000-8000-00000000000a'
const forkId = '0199aaaa-0000-7000-8000-00000000000b'
const headId = '0199aaaa-0000-7000-8000-00000000000c'
const meta = (id: string, extra = {}) => ({ type: 'session_meta', timestamp: time,
  payload: { id, model_provider: 'openai', ...extra } })
const turn = (id: string, second: number, tokens: number) => {
  const timestamp = `2026-09-20T12:00:${String(second).padStart(2, '0')}Z`
  return [
    { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: id } },
    { type: 'turn_context', timestamp, payload: { turn_id: id, model: 'gpt-test' } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: id }] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } },
    { type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens },
      total_token_usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens },
    } } },
    { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: id } },
  ]
}

async function codexSource(files: { id: string; records: unknown[] }[]) {
  source.stop()
  const root = join(dir, 'codex')
  await mkdir(root, { recursive: true })
  for (const file of files) await writeFile(join(root, `rollout-2026-09-20T12-00-00-${file.id}.jsonl`), jsonl(file.records))
  source = new SessionIndex({ roots: [{ kind: 'codex', dir: root }], watch: false })
  await source.start()
}

it('counts copied Codex history only in its parent, including empty and nested forks', async () => {
  const parent = [meta(parentId), ...turn('parent', 1, 100)]
  const fork = [meta(forkId, { forked_from_id: parentId }), ...parent, ...turn('fork', 2, 100)]
  await codexSource([
    { id: parentId, records: parent }, { id: forkId, records: fork },
    { id: headId, records: [meta(headId, { forked_from_id: forkId }), ...fork] },
  ])
  const service = new UsageService(source)
  for (let scan = 0; scan < 2; scan++) {
    const report = await service.read()
    expect(report.failedSessions).toBe(0)
    expect(report.buckets.reduce((sum, row) => sum + row.total, 0)).toBe(200)
    expect(report.buckets.filter(row => row.sessionId === headId)).toEqual([])
  }
})

it.each([false, true])('keeps same-thread base usage but excludes foreign fork bases (revert=%s)', async revert => {
  const parent = [meta(parentId), ...turn('parent', 1, 100)]
  const owner = revert ? parentId : forkId
  await codexSource([
    { id: parentId, records: parent },
    { id: `${owner}_${headId}`, records: [meta(owner, { history_base: {
      thread_id: parentId, end_byte_offset: Buffer.byteLength(jsonl(parent)), end_ordinal_exclusive: parent.length,
    } }), ...turn('new', 2, 20)] },
  ])
  const report = await new UsageService(source).read()
  expect(report.failedSessions).toBe(0)
  expect(report.buckets.reduce((sum, row) => sum + row.total, 0)).toBe(120)
  expect(report.buckets.filter(row => row.sessionId === owner).reduce((sum, row) => sum + row.total, 0)).toBe(revert ? 120 : 20)
})

it('retries forks with missing parents when the parent becomes available', async () => {
  const parent = [meta(parentId), ...turn('parent', 1, 100)]
  await codexSource([{ id: forkId, records: [meta(forkId, { forked_from_id: parentId }), ...parent, ...turn('fork', 2, 20)] }])
  const service = new UsageService(source)
  expect((await service.read()).failedSessions).toBe(1)
  const path = join(dir, 'codex', `rollout-2026-09-20T12-00-00-${parentId}.jsonl`)
  await writeFile(path, jsonl(parent))
  await source.refreshPath(path)
  const report = await service.read()
  expect(report.failedSessions).toBe(0)
  expect(report.buckets.reduce((sum, row) => sum + row.total, 0)).toBe(120)
})

it('does not deduplicate identical usage across unrelated Codex sessions', async () => {
  const records = turn('same', 1, 100)
  await codexSource([
    { id: parentId, records: [meta(parentId), ...records] },
    { id: forkId, records: [meta(forkId), ...records] },
  ])
  const report = await new UsageService(source).read()
  expect(report.buckets.reduce((sum, row) => sum + row.total, 0)).toBe(200)
})

it('filters authoritative response usage and shares parent reads between forks', async () => {
  const records = turn('parent', 1, 100)
  const parent = [meta(parentId), ...records.slice(0, -1), {
    type: 'token_usage_record', timestamp: time, payload: { thread_id: parentId,
      response_id: 'response-parent', turn_id: 'parent',
      usage: { input_tokens: 110, output_tokens: 10, total_tokens: 120 } },
  }, ...records.slice(-1)]
  await codexSource([
    { id: parentId, records: parent },
    { id: forkId, records: [meta(forkId, { forked_from_id: parentId }), ...parent, ...turn('new', 2, 20)] },
    { id: headId, records: [meta(headId, { forked_from_id: parentId }), ...parent] },
  ])
  const replay = vi.spyOn(source, 'readAll')
  const service = new UsageService(source)
  const report = await service.read()
  expect(report.failedSessions).toBe(0)
  expect(report.buckets.reduce((sum, row) => sum + row.total, 0)).toBe(140)
  // One ordinary replay and one shared ancestry replay, regardless of fork count.
  expect(replay.mock.calls.filter(call => call[1] === parentId)).toHaveLength(2)
  replay.mockClear()
  await service.read()
  expect(replay).not.toHaveBeenCalled()
  source.emit('change', 'codex', parentId)
  expect((await service.read()).buckets).toEqual(report.buckets)
  expect(replay.mock.calls.some(call => call[1] === forkId)).toBe(true)
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trajectory-usage-'))
  await mkdir(join(dir, 'project', 'main', 'subagents'), { recursive: true })
  const assistant = (id: string, input: number, provider = 'claude-test') => ({
    type: 'assistant', uuid: id, requestId: id, timestamp: time,
    message: { id, role: 'assistant', model: provider,
      content: [{ type: 'text', text: 'PRIVATE_PAYLOAD' }], stop_reason: 'end_turn',
      usage: { input_tokens: input, output_tokens: 20, cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10, output_tokens_details: { thinking_tokens: 5 } } },
  })
  await writeFile(join(dir, 'project', 'main.jsonl'), jsonl([
    { type: 'user', uuid: 'user', timestamp: time, message: { role: 'user', content: 'A session' } },
    assistant('a', 100), assistant('a', 100),
    { type: 'assistant', uuid: 'missing', requestId: 'missing', timestamp: time,
      message: { id: 'missing', role: 'assistant', model: 'other', content: [{ type: 'text', text: 'unknown usage' }], stop_reason: 'end_turn' } },
  ]))
  await writeFile(join(dir, 'project', 'main', 'subagents', 'agent-child.jsonl'), jsonl([assistant('child', 200)]))
  source = new SessionIndex({ roots: [{ kind: 'claude', dir }], watch: false })
  await source.start()
})

afterEach(async () => {
  vi.restoreAllMocks()
  source.stop()
  await rm(dir, { recursive: true, force: true })
})

it('reports main and child usage once, preserves missing coverage, and sends no message payloads', async () => {
  const app = createApp({ index: source })
  const response = await app.request('/api/usage')
  expect(response.status).toBe(200)
  const report = await response.json() as UsageReport
  expect(report.failedSessions).toBe(0)
  expect(report.sessions).toHaveLength(1)
  expect(report.buckets.reduce((sum, row) => sum + row.total, 0)).toBe(460)
  expect(report.buckets.reduce((sum, row) => sum + row.input, 0)).toBe(420)
  expect(report.buckets.reduce((sum, row) => sum + row.reasoning, 0)).toBe(10)
  expect(report.buckets.reduce((sum, row) => sum + row.requests, 0)).toBe(3)
  expect(report.buckets.reduce((sum, row) => sum + row.measured, 0)).toBe(2)
  expect(JSON.stringify(report)).not.toContain('PRIVATE_PAYLOAD')
})

it('coalesces concurrent scans, reuses summaries, and invalidates on source changes', async () => {
  const replay = vi.spyOn(source, 'readAll')
  const service = new UsageService(source)
  const [first, concurrent] = await Promise.all([service.read(), service.read()])
  expect(concurrent).toBe(first)
  await service.read()
  expect(replay).toHaveBeenCalledTimes(1)
  source.emit('change', 'claude', 'main')
  expect((await service.read()).buckets).toEqual(first.buckets)
  expect(replay).toHaveBeenCalledTimes(2)
})

it('reports failed sessions and retries rather than caching a false zero', async () => {
  const replay = vi.spyOn(source, 'readAll').mockRejectedValueOnce(new Error('private path'))
  const service = new UsageService(source)
  expect(await service.read()).toMatchObject({ buckets: [], failedSessions: 1 })
  expect((await service.read()).failedSessions).toBe(0)
  expect(replay).toHaveBeenCalledTimes(2)
})

it('streams completed session data while another session is still blocked, and lets late readers catch up', async () => {
  const path = join(dir, 'project', 'slow.jsonl')
  await writeFile(path, jsonl([{ type: 'user', uuid: 'slow', timestamp: time,
    message: { role: 'user', content: 'Slow session' } }]))
  await utimes(path, new Date(0), new Date(0))
  source.stop()
  source = new SessionIndex({ roots: [{ kind: 'claude', dir }], watch: false })
  await source.start()
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const original = source.readAll.bind(source)
  const replay = vi.spyOn(source, 'readAll').mockImplementation(async (...args) => {
    if (args[1] === 'slow') await gate
    return original(...args)
  })
  const service = new UsageService(source)
  const abort = new AbortController()
  const stream = service.stream(abort.signal)
  const events: UsageStreamEvent[] = []
  try {
    let completed = 0
    while (completed < 1) {
      const { value } = await stream.next()
      if (value === undefined || value.type !== 'progress') throw new Error('Missing progress')
      events.push(value)
      completed = value.progress.completed
    }
    const initial = events[0]
    expect(initial).toMatchObject({ progress: { completed: 0, total: 2, done: false } })
    expect(events.some(event => event.type === 'progress' && event.progress.records > 0)).toBe(true)
    const partial = events.flatMap(event => event.type === 'progress' ? event.report.buckets : [])
    expect(partial.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(460)
    const lateAbort = new AbortController()
    const late = service.stream(lateAbort.signal)
    expect((await late.next()).value).toMatchObject({ report: { buckets: partial }, progress: { completed: 1 } })
    const waiting = late.next()
    lateAbort.abort()
    expect((await waiting).done).toBe(true)
    release()
    for await (const event of stream) events.push(event)
    expect(events.at(-1)).toMatchObject({ progress: { completed: 2, total: 2, done: true } })
    expect(events.flatMap(event => event.type === 'progress' ? event.report.buckets : [])).toEqual(partial)
    expect(replay).toHaveBeenCalledTimes(2)
  } finally {
    release()
    abort.abort()
    await stream.return(undefined)
  }
})

it('serves a finite NDJSON stream whose final totals match the JSON endpoint', async () => {
  const app = createApp({ index: source })
  const response = await app.request('/api/usage/stream')
  expect(response.headers.get('content-type')).toContain('application/x-ndjson')
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as UsageStreamEvent)
  expect(events[0]).toMatchObject({ progress: { completed: 0, total: 1, done: false } })
  expect(events.at(-1)).toMatchObject({ progress: { completed: 1, total: 1, done: true } })
  const json = await (await app.request('/api/usage')).json() as UsageReport
  expect(events.flatMap(event => event.type === 'progress' ? event.report.buckets : [])).toEqual(json.buckets)
})
