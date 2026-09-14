import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionLiveEvent } from '@harness-trajectory/core'
import { SessionIndex, classifyPath, lineTime, lineTimes, mergeChronologically, scopeToFile } from '../src/index.ts'
import { createMetaScanner } from '../src/meta.ts'
import { defaultRoots } from '../src/roots.ts'

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

/** Kimi wire records: `{ type, time (epoch ms), agentId, ...payload }`. */
function kimi(type: string, offset: number, payload: Record<string, unknown> = {}, agentId = 'main') {
  return { type, time: T0 + offset, agentId, ...payload }
}

function kimiUser(text: string, offset: number, origin: unknown = { kind: 'user' }) {
  return kimi('context.append_message', offset, {
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin },
  })
}

function kimiMain(prompt: string): string {
  return jsonl([
    { type: 'metadata', created_at: T0, protocol_version: '1.5' },
    kimi('runtime.set_binding', 1, { runtimeId: 'rt-1', workspaceId: 'wd_project_abc123def456' }),
    kimi('profile.bind', 2, {
      profileName: 'agent', modelAlias: 'kimi-code/k3', thinkingEffort: 'medium',
      systemPrompt: 'You are Kimi.', activeToolNames: ['Read'], agentsMdPaths: [],
      environmentDisclosure: { cwd: '/work/kimi' }, subagents: [],
    }),
    kimiUser(prompt, 10),
    kimi('context.append_loop_event', 11, { event: { type: 'step.begin', turnId: '0', step: 1, uuid: 's-1' } }),
    kimi('llm.request', 12, {
      kind: 'loop', model: 'k3', modelAlias: 'kimi-code/k3', provider: 'openai',
      maxTokens: 1048576, messageCount: 2, turnStep: '0.1',
    }),
    kimiUser('Todo list reminder', 20, { kind: 'injection', variant: 'todo_list_reminder' }),
    kimi('turn.ended', 30, { durationMs: 30, reason: 'completed', turnId: 0 }),
  ])
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

  it('recognizes Kimi wire transcripts and binds children to their session directory', () => {
    const root = '/r'
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/agents/main/wire.jsonl'))
      .toEqual({ id: 'session_k1', role: 'main' })
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/agents/sub-1/wire.jsonl'))
      .toEqual({ id: 'sub-1', role: 'child', parentId: 'session_k1' })
    // Side stores and anything that is not `wire.jsonl` at exactly that depth are not transcripts.
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/agents/main/tasks/t1.jsonl')).toBeNull()
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/agents/main/notes.jsonl')).toBeNull()
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/wire.jsonl')).toBeNull()
    expect(classifyPath('kimi', root, '/r/session_index.jsonl')).toBeNull()
  })
})

describe('defaultRoots', () => {
  it('resolves all three harness roots from harness homes and explicit overrides', () => {
    expect(defaultRoots({
      CLAUDE_CONFIG_DIR: join('/h', '.claude'),
      CODEX_HOME: join('/h', '.codex'),
      KIMI_CODE_HOME: join('/h', '.kimi-code'),
    })).toEqual([
      { kind: 'claude', dir: join('/h', '.claude', 'projects') },
      { kind: 'codex', dir: join('/h', '.codex', 'sessions') },
      { kind: 'kimi', dir: join('/h', '.kimi-code', 'sessions') },
    ])
    expect(defaultRoots({
      HARNESS_TRAJECTORY_CLAUDE_ROOT: join('/roots', 'c'),
      HARNESS_TRAJECTORY_CODEX_ROOT: join('/roots', 'x'),
      HARNESS_TRAJECTORY_KIMI_ROOT: join('/roots', 'k'),
    }).map(root => root.dir)).toEqual([join('/roots', 'c'), join('/roots', 'x'), join('/roots', 'k')])
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

  it('reads Kimi epoch-millisecond "time" fields and still prefers "timestamp"', () => {
    expect(lineTime(JSON.stringify(kimi('turn.ended', 4000)))).toBe(T0 + 4000)
    expect(lineTime(JSON.stringify({ type: 'metadata', created_at: T0 }))).toBeNull()
    // Seconds stay seconds; a record with both keeps the `timestamp`.
    expect(lineTime('{"type":"x","time":1789372800}')).toBe(1789372800_000)
    expect(lineTime(JSON.stringify({ timestamp: iso(1000), time: T0 + 9000 }))).toBe(T0 + 1000)
    expect(lineTime('{"type":"x"}')).toBeNull()
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

  it('summarizes a Kimi wire transcript and counts only origin-user messages', () => {
    const scanner = createMetaScanner('kimi')
    const lines = [
      { type: 'metadata', created_at: T0, protocol_version: '1.5' },
      kimi('profile.bind', 2, { modelAlias: 'kimi-code/k3', environmentDisclosure: { cwd: '/work/kimi' } }),
      kimiUser('Port the viewer to Kimi', 10),
      kimi('llm.request', 12, { model: 'k3', provider: 'openai', maxTokens: 1048576 }),
      kimiUser('todo reminder', 20, { kind: 'injection', variant: 'todo_list_reminder' }),
      kimiUser('agent finished', 21, { kind: 'task', taskId: 't1', status: 'completed' }),
      kimiUser('skill text', 22, { kind: 'skill_activation', skillName: 'design' }),
      kimiUser('/plugin', 23, { kind: 'plugin_command' }),
      kimiUser('previous summary', 24, { kind: 'compaction_summary' }),
      kimiUser('And now the second prompt', 30),
      kimi('turn.ended', 40, { durationMs: 40, reason: 'completed', turnId: 0 }),
    ]
    for (const line of jsonl(lines).split('\n')) scanner.push(line)
    expect(scanner.state).toMatchObject({
      title: 'Port the viewer to Kimi', cwd: '/work/kimi', model: 'k3',
      promptCount: 2, startedAt: T0, lastTime: T0 + 40,
    })
  })

  it('tolerates malformed and unknown Kimi lines', () => {
    const scanner = createMetaScanner('kimi')
    for (const line of ['', '{ not json', 'null', '[]', JSON.stringify(kimi('mcp.tools_discovered', 1))]) {
      expect(() => { scanner.push(line) }).not.toThrow()
    }
    expect(scanner.state).toMatchObject({ title: null, promptCount: 0 })
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
    const kimiSession = join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1')
    await mkdir(join(kimiSession, 'agents', 'main', 'tasks'), { recursive: true })
    await mkdir(join(kimiSession, 'agents', 'sub-1'), { recursive: true })
    await writeFile(join(kimiSession, 'state.json'), JSON.stringify({
      id: 'session_k1', version: 2, cwd: '/work/kimi', createdAt: T0, updatedAt: T0 + 30,
      title: 'Kimi session title', titleKind: 'generated', lastTurnReason: 'completed',
      agents: { main: { type: 'main' }, 'sub-1': { type: 'sub', parentAgentId: 'main' } },
    }))
    await writeFile(join(kimiSession, 'agents', 'main', 'wire.jsonl'), kimiMain('Add Kimi support'))
    await writeFile(join(kimiSession, 'agents', 'main', 'tasks', 't1.jsonl'), jsonl([{ ignored: true }]))
    await writeFile(join(kimiSession, 'agents', 'sub-1', 'wire.jsonl'), jsonl([
      kimi('runtime.set_binding', 15, { runtimeId: 'rt-2' }, 'sub-1'),
      kimi('profile.bind', 16, { profileName: 'explore', modelAlias: 'kimi-code/k3' }, 'sub-1'),
    ]))
    index = new SessionIndex({
      roots: [
        { kind: 'claude', dir: join(dir, 'claude') },
        { kind: 'codex', dir: join(dir, 'codex') },
        { kind: 'kimi', dir: join(dir, 'kimi') },
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
      .toEqual(['claude:main-1', 'codex:parent-thread', 'kimi:session_k1'])
    const claude = index.get('claude', 'main-1')
    expect(claude).toMatchObject({ title: 'Hello there', cwd: '/work/project', childCount: 1, promptCount: 1 })
    expect(claude?.files.map(file => file.role)).toEqual(['main', 'child'])
    const codex = index.get('codex', 'parent-thread')
    expect(codex).toMatchObject({ title: 'Parent prompt', childCount: 1 })
    expect(codex?.files[1]).toMatchObject({ id: 'child-thread', role: 'child', parentId: 'parent-thread' })
    expect(index.get('codex', 'child-thread')).toBeUndefined()
  })

  it('indexes a Kimi session by directory name, titles it from state.json, and attaches its agents', async () => {
    const session = index.get('kimi', 'session_k1')
    expect(session).toMatchObject({
      id: 'session_k1', kind: 'kimi', title: 'Kimi session title', cwd: '/work/kimi',
      model: 'k3', startedAt: T0, childCount: 1, promptCount: 1,
    })
    expect(session?.files.map(file => `${file.role}:${file.id}`)).toEqual(['main:session_k1', 'child:sub-1'])
    expect(session?.files[1]).toMatchObject({ parentId: 'session_k1' })
    // The subagent transcript is not a session of its own, and side stores are skipped.
    expect(index.get('kimi', 'sub-1')).toBeUndefined()
    expect(index.hasChild('kimi', 'session_k1', 'sub-1')).toBe(true)

    // state.json is rewritten as the session runs; a refresh picks the new title up.
    const statePath = join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1', 'state.json')
    const mainPath = join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1', 'agents', 'main', 'wire.jsonl')
    await writeFile(statePath, JSON.stringify({ id: 'session_k1', title: 'Renamed by the user', titleKind: 'custom' }))
    await appendFile(mainPath, jsonl([kimiUser('One more thing', 5000)]))
    await index.refreshPath(mainPath)
    expect(index.get('kimi', 'session_k1')).toMatchObject({ title: 'Renamed by the user', promptCount: 2 })
  })

  it('falls back to the first human prompt when state.json has no usable title', async () => {
    await rm(join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1', 'state.json'))
    const fresh = new SessionIndex({
      roots: [{ kind: 'kimi', dir: join(dir, 'kimi') }],
      watch: false,
      now: () => T0 + 60_000,
    })
    await fresh.start()
    expect(fresh.get('kimi', 'session_k1')).toMatchObject({ title: 'Add Kimi support', childCount: 1 })
    fresh.stop()
  })

  it('announces a Kimi subagent transcript created while the session is watched', async () => {
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('kimi', 'session_k1', event => events.push(event))
    const childDir = join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1', 'agents', 'sub-2')
    await mkdir(childDir, { recursive: true })
    const path = join(childDir, 'wire.jsonl')
    await writeFile(path, jsonl([kimi('runtime.set_binding', 2000, { runtimeId: 'rt-3' }, 'sub-2')]))
    await index.refreshPath(path)
    expect(events.map(event => event.type)).toEqual(['file', 'lines', 'meta'])
    const [file] = events
    expect(file?.type === 'file' && file.file).toMatchObject({ id: 'sub-2', role: 'child', parentId: 'session_k1' })
    expect(index.get('kimi', 'session_k1')?.childCount).toBe(2)
    unsubscribe()
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

describe('SessionIndex live children', () => {
  let dir: string
  let index: SessionIndex

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-live-'))
    await mkdir(join(dir, 'claude', '-slug'), { recursive: true })
    await writeFile(join(dir, 'claude', '-slug', 'main-1.jsonl'), jsonl([
      claudeUser('Hello there', 'main-1', 0),
      claudeAssistant('Hi', 'main-1', 1000),
    ]))
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

  it('announces a subagent transcript created while watching and forwards its existing lines', async () => {
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('claude', 'main-1', event => events.push(event))
    const childDir = join(dir, 'claude', '-slug', 'main-1', 'subagents')
    await mkdir(childDir, { recursive: true })
    const path = join(childDir, 'agent-a1.jsonl')
    await writeFile(`${childDir}/agent-a1.meta.json`, JSON.stringify({
      agentType: 'Explore', description: 'Find things', toolUseId: 'toolu_1', isFork: false, model: 'sonnet',
    }))
    await writeFile(path, jsonl([
      claudeUser('child prompt', 'main-1', 500, { isSidechain: true, agentId: 'a1' }),
      claudeAssistant('child reply', 'main-1', 800),
    ]))
    await index.refreshPath(path)
    expect(events.map(event => event.type)).toEqual(['file', 'lines', 'meta'])
    const [file, lines, meta] = events
    expect(file?.type === 'file' && file.file).toMatchObject({
      id: 'main-1/agent-a1', role: 'child', parentId: 'main-1',
      agent: { agentId: 'a1', toolUseId: 'toolu_1', description: 'Find things', agentType: 'Explore', model: 'sonnet' },
    })
    expect(file?.type === 'file' && file.reset).toBeUndefined()
    expect(lines?.type === 'lines' && lines.lines).toHaveLength(2)
    expect(meta?.type === 'meta' && meta.children.map(child => child.file.id)).toEqual(['main-1/agent-a1'])
    expect(index.get('claude', 'main-1')?.children[0]).toMatchObject({ file: { id: 'main-1/agent-a1' }, bytes: expect.any(Number) })

    // Later appends keep flowing; a truncation is flagged as a reset.
    await appendFile(path, jsonl([claudeAssistant('more', 'main-1', 900)]))
    await index.refreshPath(path)
    expect(events.filter(event => event.type === 'lines')).toHaveLength(2)
    await writeFile(path, jsonl([claudeUser('rewritten', 'main-1', 100, { isSidechain: true })]))
    await index.refreshPath(path)
    expect(events.some(event => event.type === 'file' && event.reset === true)).toBe(true)
    unsubscribe()
  })

  it('serves one child transcript as a session of its own', async () => {
    const childDir = join(dir, 'claude', '-slug', 'main-1', 'subagents')
    await mkdir(childDir, { recursive: true })
    const path = join(childDir, 'agent-a1.jsonl')
    await writeFile(path, jsonl([claudeUser('child prompt', 'main-1', 500, { isSidechain: true, agentId: 'a1' })]))
    await index.refreshPath(path)
    expect(index.hasChild('claude', 'main-1', 'main-1/agent-a1')).toBe(true)
    expect(index.hasChild('claude', 'main-1', 'main-1/agent-zz')).toBe(false)
    const replay: SessionLiveEvent[] = []
    await index.readAll('claude', 'main-1', event => replay.push(event), 'main-1/agent-a1')
    expect(replay.map(event => event.type)).toEqual(['file', 'lines', 'meta'])
    const [file, lines] = replay
    expect(file?.type === 'file' && file.file).toEqual({
      id: 'main-1/agent-a1', role: 'main', path, agent: { agentId: 'a1' },
    })
    expect(lines?.type === 'lines' && lines.file.role).toBe('main')
    expect(lines?.type === 'lines' && lines.lines).toHaveLength(1)

    const main: SessionLiveEvent = { type: 'lines', file: { id: 'main-1', role: 'main', path: '/m' }, lines: ['{}'] }
    const child: SessionLiveEvent = { type: 'lines', file: { id: 'main-1/agent-a1', role: 'child', path, parentId: 'main-1' }, lines: ['{}'] }
    expect(scopeToFile(main, 'main-1/agent-a1')).toBeNull()
    expect(scopeToFile(child, 'main-1/agent-a1')).toMatchObject({ file: { id: 'main-1/agent-a1', role: 'main' } })
    expect(scopeToFile({ type: 'ready' }, 'main-1/agent-a1')).toEqual({ type: 'ready' })
  })
})
