import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionLiveEvent } from '@harness-trajectory/core'
import { SessionIndex, classifyPath, lineTimes, mergeChronologically } from '../src/index.ts'
import { createMetaScanner } from '../src/meta.ts'

function jsonl(records: readonly unknown[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function claudeUser(text: string, sessionId: string, offset: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'user', uuid: `u-${offset}`, parentUuid: null, isSidechain: false, sessionId,
    cwd: '/work/project', timestamp: iso(offset), message: { role: 'user', content: text },
    origin: { kind: 'human' }, ...extra,
  }
}

function claudeAssistant(text: string, sessionId: string, offset: number) {
  return {
    type: 'assistant', uuid: `a-${offset}`, sessionId, timestamp: iso(offset), requestId: `req-${offset}`,
    message: { id: `msg-${offset}`, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  }
}

function codexMeta(id: string, offset: number, parent?: string) {
  return {
    timestamp: iso(offset), type: 'session_meta',
    payload: { id, cwd: '/work/codex', model_provider: 'openai', thread_source: parent === undefined ? 'user' : 'subagent', ...(parent === undefined ? {} : { parent_thread_id: parent }) },
  }
}

function codexUser(text: string, offset: number) {
  return { timestamp: iso(offset), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
}

describe('classifyPath', () => {
  it('recognizes Claude main transcripts, agent files, and subagent directories', () => {
    const root = '/r'
    expect(classifyPath('claude', root, '/r/-slug/abc.jsonl')).toEqual({ id: 'abc', role: 'main' })
    expect(classifyPath('claude', root, '/r/-slug/agent-x.jsonl')).toEqual({ id: 'agent-x', role: 'child' })
    expect(classifyPath('claude', root, '/r/-slug/abc/subagents/agent-y.jsonl'))
      .toEqual({ id: 'abc/agent-y', role: 'child', parentId: 'abc' })
    expect(classifyPath('claude', root, '/r/-slug/memory/notes.md')).toBeNull()
  })

  it('recognizes Codex rollouts by name and extracts the thread id', () => {
    const path = '/r/2026/09/14/rollout-2026-09-14T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl'
    expect(classifyPath('codex', '/r', path)).toEqual({ id: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', role: 'main' })
    expect(classifyPath('codex', '/r', '/r/2026/09/14/notes.jsonl')).toBeNull()
  })
})

describe('chronological merge', () => {
  it('inherits timestamps for housekeeping lines and back-fills leading ones', () => {
    const lines = [
      JSON.stringify({ type: 'mode' }),
      JSON.stringify({ type: 'user', timestamp: iso(1000) }),
      JSON.stringify({ type: 'last-prompt' }),
      JSON.stringify({ type: 'assistant', timestamp: iso(3000) }),
    ]
    expect(lineTimes(lines)).toEqual([T0 + 1000, T0 + 1000, T0 + 1000, T0 + 3000])
  })

  it('interleaves child lines by time and keeps the main file first on ties', () => {
    const main = { id: 'm', role: 'main' as const, path: '/m' }
    const child = { id: 'c', role: 'child' as const, path: '/c', parentId: 'm' }
    const mainLines = [iso(0), iso(2000), iso(4000)].map(timestamp => JSON.stringify({ timestamp, f: 'm' }))
    const childLines = [iso(2000), iso(3000)].map(timestamp => JSON.stringify({ timestamp, f: 'c' }))
    const chunks = [...mergeChronologically([
      { ref: main, lines: mainLines, times: lineTimes(mainLines) },
      { ref: child, lines: childLines, times: lineTimes(childLines) },
    ])]
    expect(chunks.map(chunk => `${chunk.ref.id}:${chunk.lines.length}`)).toEqual(['m:2', 'c:2', 'm:1'])
  })
})

describe('meta scanners', () => {
  it('summarizes a Claude transcript: title, cwd, model, prompts, and ai-title precedence', () => {
    const scanner = createMetaScanner('claude')
    const lines = [
      claudeUser('Fix the flaky test please', 's1', 0),
      claudeAssistant('On it', 's1', 500),
      claudeUser('<command-name>/model</command-name>', 's1', 800),
      claudeUser('notification', 's1', 900, { origin: { kind: 'task-notification' } }),
      { type: 'ai-title', aiTitle: 'Flaky test fix', sessionId: 's1' },
    ]
    for (const line of jsonl(lines).split('\n')) scanner.push(line)
    expect(scanner.state).toMatchObject({
      title: 'Fix the flaky test please', aiTitle: 'Flaky test fix', cwd: '/work/project',
      model: 'claude-test', promptCount: 1, startedAt: T0,
    })
  })

  it('summarizes a Codex rollout and ignores injected context messages', () => {
    const scanner = createMetaScanner('codex')
    const lines = [
      codexMeta('t1', 0),
      { timestamp: iso(10), type: 'turn_context', payload: { model: 'gpt-test', cwd: '/work/codex' } },
      codexUser('<environment_context>cwd</environment_context>', 20),
      codexUser('Refactor the parser', 30),
    ]
    for (const line of jsonl(lines).split('\n')) scanner.push(line)
    expect(scanner.state).toMatchObject({ title: 'Refactor the parser', cwd: '/work/codex', model: 'gpt-test', promptCount: 1 })
  })
})

describe('SessionIndex', () => {
  let dir: string
  let index: SessionIndex

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-'))
    await mkdir(join(dir, 'claude', '-slug', 'main-1', 'subagents'), { recursive: true })
    await mkdir(join(dir, 'codex', '2026', '09', '14'), { recursive: true })
    await writeFile(join(dir, 'claude', '-slug', 'main-1.jsonl'), jsonl([
      claudeUser('Hello there', 'main-1', 0),
      claudeAssistant('Hi', 'main-1', 1000),
    ]))
    await writeFile(join(dir, 'claude', '-slug', 'main-1', 'subagents', 'agent-a.jsonl'), jsonl([
      claudeUser('child prompt', 'main-1', 500, { isSidechain: true }),
    ]))
    await writeFile(join(dir, 'codex', '2026', '09', '14', 'rollout-2026-09-14T10-00-00-parent.jsonl'), jsonl([
      codexMeta('parent-thread', 0),
      codexUser('Parent prompt', 100),
    ]))
    await writeFile(join(dir, 'codex', '2026', '09', '14', 'rollout-2026-09-14T10-00-01-child.jsonl'), jsonl([
      codexMeta('child-thread', 50, 'parent-thread'),
    ]))
    index = new SessionIndex({
      roots: [
        { kind: 'claude', dir: join(dir, 'claude') },
        { kind: 'codex', dir: join(dir, 'codex') },
      ],
      watch: false,
      now: () => T0 + 60_000,
    })
    await index.start()
  })

  afterEach(async () => {
    index.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('lists main sessions with metadata and attaches children by parent id', () => {
    const sessions = index.list()
    expect(sessions.map(session => `${session.kind}:${session.id}`).sort())
      .toEqual(['claude:main-1', 'codex:parent-thread'])
    const claude = index.get('claude', 'main-1')
    expect(claude).toMatchObject({ title: 'Hello there', cwd: '/work/project', childCount: 1, promptCount: 1 })
    expect(claude?.files.map(file => file.role)).toEqual(['main', 'child'])
    const codex = index.get('codex', 'parent-thread')
    expect(codex).toMatchObject({ title: 'Parent prompt', childCount: 1 })
    expect(codex?.files[1]).toMatchObject({ id: 'child-thread', role: 'child', parentId: 'parent-thread' })
    expect(index.get('codex', 'child-thread')).toBeUndefined()
  })

  it('replays files in timestamp order and then reports live appends', async () => {
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('claude', 'main-1', event => events.push(event))
    const replay: SessionLiveEvent[] = []
    await index.readAll('claude', 'main-1', event => replay.push(event))
    const order = replay.flatMap(event => (event.type === 'lines'
      ? event.lines.map(line => `${event.file.role}:${(JSON.parse(line) as { type: string }).type}`)
      : []))
    expect(order).toEqual(['main:user', 'child:user', 'main:assistant'])
    expect(replay.at(-1)?.type).toBe('meta')

    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await appendFile(path, jsonl([claudeUser('Second prompt', 'main-1', 5000)]))
    await index.refreshPath(path)
    const appended = events.filter(event => event.type === 'lines')
    expect(appended).toHaveLength(1)
    expect(appended[0]?.type === 'lines' && appended[0].lines).toHaveLength(1)
    expect(index.get('claude', 'main-1')?.promptCount).toBe(2)
    unsubscribe()
  })

  it('discovers a transcript created after startup', async () => {
    const path = join(dir, 'claude', '-slug', 'main-2.jsonl')
    await writeFile(path, jsonl([claudeUser('Late arrival', 'main-2', 0)]))
    await index.refreshPath(path)
    expect(index.get('claude', 'main-2')).toMatchObject({ title: 'Late arrival' })
  })
})
