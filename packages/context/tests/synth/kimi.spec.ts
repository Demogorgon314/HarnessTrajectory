/**
 * Kimi synthesizer — synthetic fixtures only.
 *
 * Every record below is hand-written with the REAL Kimi wire field names
 * (`context.append_loop_event`, `llmFirstTokenLatencyMs`, `inputCacheRead`, …)
 * and fake payloads ("hello", `/tmp/a.ts`). No transcript content is copied
 * here. `time` is epoch MILLISECONDS on every record, as Kimi writes it.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import type { ContentBlock, TimelineEvent } from '../../src/fold/event.ts'
import { createKimiSynthesizer } from '../../src/synth/kimi.ts'
import { ContextSession } from '../../src/fold/session.ts'

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

const T0 = Date.UTC(2025, 0, 1, 12, 0, 0)
/** Epoch MILLISECONDS `s` seconds into the fixture session (Kimi's `time`). */
const ms = (s: number): number => T0 + s * 1000

const MAIN: SessionFileRef = { id: 'session_abc', role: 'main', path: '/tmp/session_abc/agents/main/wire.jsonl' }

interface Rec { [key: string]: unknown }

const line = (s: number, type: string, rest: Rec = {}): string =>
  JSON.stringify({ type, time: ms(s), agentId: 'main', ...rest })

const SYSTEM_TEXT = 'You are Kimi, a coding agent. hello hello hello'

const profileBind = (s: number, rest: Rec = {}): string => line(s, 'profile.bind', {
  profileName: 'agent',
  modelAlias: 'kimi-code/k3',
  thinkingEffort: 'medium',
  systemPrompt: SYSTEM_TEXT,
  activeToolNames: ['Read', 'Write', 'Edit', 'Bash'],
  agentsMdPaths: [],
  environmentDisclosure: { cwd: '/tmp/work' },
  subagents: [],
  ...rest,
})

const toolsSnapshot = (s: number, hash = 'h1', tools: Rec[] = [
  { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'Bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
]): string => line(s, 'llm.tools_snapshot', { hash, tools })

const llmRequest = (s: number, rest: Rec = {}): string => line(s, 'llm.request', {
  kind: 'loop',
  model: 'k3',
  modelAlias: 'kimi-code/k3',
  provider: 'openai',
  maxTokens: 1_048_576,
  messageCount: 4,
  systemPromptHash: 'sp1',
  toolsHash: 'h1',
  turnStep: '0.1',
  thinkingEffort: 'medium',
  ...rest,
})

const usageRecord = (s: number, usage: Rec): string => line(s, 'usage.record', {
  model: 'kimi-code/k3', usageScope: 'turn', usage,
})

const appendMessage = (s: number, text: string, origin?: Rec): string => line(s, 'context.append_message', {
  message: {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    id: `m-${s}`,
    ...(origin === undefined ? {} : { origin }),
  },
})

const loop = (s: number, event: Rec): string => line(s, 'context.append_loop_event', { event })

const stepBegin = (s: number, turnId: string, step: number): string =>
  loop(s, { type: 'step.begin', turnId, step, uuid: `sb-${s}` })

const contentPart = (s: number, part: Rec, turnId = '0', step = 1): string =>
  loop(s, { type: 'content.part', part, step, stepUuid: `sb-${step}`, turnId, uuid: `cp-${s}` })

const toolCall = (s: number, toolCallId: string, name: string, args: Rec, turnId = '0', step = 1): string =>
  loop(s, { type: 'tool.call', toolCallId, name, args, step, stepUuid: `sb-${step}`, turnId, uuid: `tc-${s}` })

const toolResult = (s: number, toolCallId: string, result: Rec): string =>
  loop(s, { type: 'tool.result', toolCallId, parentUuid: `tc-${s}`, result, uuid: `tr-${s}` })

const stepEnd = (s: number, rest: Rec = {}): string => loop(s, {
  type: 'step.end',
  finishReason: 'stop',
  providerFinishReason: 'stop',
  rawFinishReason: 'stop',
  messageId: `msg-${s}`,
  usage: { inputOther: 900, inputCacheRead: 3000, inputCacheCreation: 0, output: 200 },
  llmFirstTokenLatencyMs: 1200,
  llmServerFirstTokenMs: 1100,
  llmStreamDurationMs: 2500,
  llmServerDecodeMs: 2400,
  llmRequestBuildMs: 5,
  llmClientConsumeMs: 3,
  step: 1,
  turnId: '0',
  uuid: `se-${s}`,
  ...rest,
})

/** Feed every line and collect the events, in order. */
function run(lines: readonly string[], file: SessionFileRef = MAIN): {
  events: TimelineEvent[]
  synth: ReturnType<typeof createKimiSynthesizer>
} {
  const synth = createKimiSynthesizer(file)
  const events: TimelineEvent[] = []
  for (const l of lines) events.push(...synth.push(l))
  return { events, synth }
}

const typesOf = (events: readonly TimelineEvent[]): string[] => events.map(e => e.type)
const firstOf = (events: readonly TimelineEvent[], type: string): TimelineEvent | undefined =>
  events.find(e => e.type === type)
const allOf = (events: readonly TimelineEvent[], type: string): TimelineEvent[] =>
  events.filter(e => e.type === type)
const dataOf = (event: TimelineEvent | undefined): Rec => (event?.data ?? {}) as Rec
const blocksOf = (event: TimelineEvent | undefined): ContentBlock[] => {
  const data = dataOf(event)
  const message = data['message'] as { content?: ContentBlock[] } | undefined
  return message?.content ?? (data['content'] as ContentBlock[] | undefined) ?? []
}
const sourceOf = (event: TimelineEvent | undefined): Record<string, unknown> =>
  (dataOf(event)['source'] ?? {}) as Record<string, unknown>

/**
 * One complete, ordinary turn in the REAL record order: the loop events
 * (parts, call, result, step.end) are flushed AFTER the response, which is why
 * `usage.record` lands before them.
 */
const TYPICAL_TURN: string[] = [
  line(0, 'metadata', { created_at: ms(0), protocol_version: '1.5' }),
  line(0, 'runtime.set_binding', { agentId: 'main', runtimeId: 'rt-1', workspaceId: 'wd-1' }),
  profileBind(0),
  line(0, 'permission.set_mode', { mode: 'yolo' }),
  line(1, 'turn.prompt', { promptId: 'p1', input: [{ type: 'text', text: 'hello there' }], origin: { kind: 'user' } }),
  appendMessage(1, 'hello there', { kind: 'user' }),
  stepBegin(2, '0', 1),
  toolsSnapshot(2),
  llmRequest(2),
  usageRecord(5, { inputOther: 900, inputCacheRead: 3000, inputCacheCreation: 0, output: 200 }),
  line(5, 'token_counting.measured', { length: 4, tokens: 4100 }),
  contentPart(6, { type: 'think', think: 'let me look at the file' }),
  contentPart(6, { type: 'text', text: 'reading now' }),
  toolCall(6, 'call_a', 'Read', { path: '/tmp/a.ts', offset: 1, limit: 40 }),
  toolResult(7, 'call_a', { output: 'line one\nline two', isError: false }),
  stepEnd(7),
  line(8, 'turn.ended', { durationMs: 7000, reason: 'completed', turnId: 0 }),
]

// -----------------------------------------------------------------------------

describe('kimi synthesizer', () => {
  it('measures disjoint input, without output, and excludes compaction model usage', () => {
    const session = new ContextSession('kimi')
    for (const entry of [
      ...TYPICAL_TURN,
      llmRequest(9, { kind: 'compaction', model: 'summary', maxTokens: 128_000 }),
      usageRecord(10, { inputOther: 999_000, output: 100 }),
      line(11, 'context.apply_compaction', { contextSummary: 'summary', keptUserMessageCount: 0 }),
    ]) session.push(entry, MAIN)
    expect(session.timelineOf(MAIN.id)?.requestInput).toMatchObject({ calls: 1, reported: 1, peak: { tokens: 3900 }, withWindow: 0 })
    expect(session.metaOf(MAIN.id)?.model).toBe('k3')
  })
  it('maps one ordinary turn to the documented event sequence', () => {
    const { events } = run(TYPICAL_TURN)
    expect(typesOf(events)).toEqual([
      'user/message',      // the human prompt
      'step/start',        // step.begin
      'request/header',    // the first tools_snapshot flushes the deferred header
      'assistant/message', // the whole buffered step, at its computed completion
      'tool/call',
      'tool/result',
      'step/end',
      // `turn.ended` finds nothing open and emits nothing.
    ])
  })

  it('never throws on malformed input and emits nothing for it', () => {
    const { events, synth } = run([
      '', 'not json', '{"no":"type"}', '[]', 'null', '{"type":"unknown"}',
      '{"type":"context.append_loop_event"}',
      '{"type":"context.append_loop_event","event":{"type":"tool.result"}}',
      '{"type":"context.append_message","message":7}',
      '{"type":"profile.bind","systemPrompt":null}',
    ])
    expect(events).toEqual([])
    expect(synth.meta().running).toBe(false)
    expect(synth.kind).toBe('kimi')
  })

  it('emits strictly increasing seqs', () => {
    const { events } = run(TYPICAL_TURN)
    const seqs = events.map(e => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('reads the system prompt and tool schemas into one initial header', () => {
    const { events } = run(TYPICAL_TURN)
    const headers = allOf(events, 'request/header')
    expect(headers).toHaveLength(1)
    const header = dataOf(headers[0])['header'] as Rec
    expect(header['system']).toBe(SYSTEM_TEXT)
    expect((header['tools'] as unknown[]).map(t => (t as Rec)['name'])).toEqual(['Read', 'Bash'])
    expect(header['config']).toEqual({ model: 'k3', provider: 'kimi-for-coding' })
    expect(dataOf(headers[0])['reason']).toBe('initial')
  })

  it('prices the kimi-code alias through the subscription provider and others through moonshot', () => {
    const { synth } = run(TYPICAL_TURN)
    expect(synth.meta().provider).toBe('kimi-for-coding')
    expect(synth.meta().model).toBe('k3')
    const other = run([profileBind(0, { modelAlias: 'moonshot/kimi-k2.7-code' }), toolsSnapshot(1)])
    expect(other.synth.meta().provider).toBe('moonshotai')
    // Before the first llm.request the model is the alias tail.
    expect(other.synth.meta().model).toBe('kimi-k2.7-code')
  })

  it('does not interpret completion limits or compaction requests as a context window', () => {
    const { events, synth } = run([
      ...TYPICAL_TURN,
      stepBegin(9, '1', 1),
      llmRequest(9, { maxTokens: 1_048_576 }),
      llmRequest(9, { maxTokens: 262_144, model: 'k3-256k' }),
      llmRequest(10, { kind: 'compaction', maxTokens: 131_072, model: 'summary-model' }),
    ])
    const windows = allOf(events, 'request/context').map(e => dataOf(e)['contextWindow'])
    expect(windows).toEqual([])
    expect(synth.meta().contextWindow).toBeUndefined()
    expect(synth.meta().model).toBe('k3-256k')
  })

  it('logs a model switch as a change header that repeats the system prompt', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      stepBegin(9, '1', 1),
      llmRequest(9, { model: 'k3-256k', modelAlias: 'kimi-code/k3-256k', maxTokens: 262_144 }),
    ])
    const headers = allOf(events, 'request/header')
    expect(headers).toHaveLength(2)
    expect(dataOf(headers[1])['reason']).toBe('change')
    const header = dataOf(headers[1])['header'] as Rec
    expect(header['system']).toBe(SYSTEM_TEXT)
    expect((header['config'] as Rec)['model']).toBe('k3-256k')
  })

  it('re-emits the header when a rebind changes the system prompt or the tool hash', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      profileBind(9, { profileName: 'plan', systemPrompt: 'You are Kimi in plan mode.' }),
      toolsSnapshot(10, 'h2', [{ name: 'Read', description: 'read', parameters: {} }]),
      toolsSnapshot(11, 'h2', [{ name: 'Read', description: 'read', parameters: {} }]),
    ])
    const headers = allOf(events, 'request/header')
    // initial + rebind + new tool hash; the repeated hash changes nothing.
    expect(headers).toHaveLength(3)
    expect(headers.slice(1).map(h => dataOf(h)['reason'])).toEqual(['change', 'change'])
    expect((dataOf(headers[2])['header'] as Rec)['system']).toBe('You are Kimi in plan mode.')
  })

  it('numbers the turn from the loop turnId string and the step verbatim', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      appendMessage(9, 'and now this', { kind: 'user' }),
      stepBegin(10, '1', 1),
      contentPart(11, { type: 'text', text: 'ok' }, '1', 1),
      stepEnd(11, { turnId: '1', step: 1, usage: undefined, llmFirstTokenLatencyMs: undefined }),
      stepBegin(12, '1', 2),
      contentPart(13, { type: 'text', text: 'done' }, '1', 2),
      stepEnd(13, { turnId: '1', step: 2 }),
    ])
    const messages = allOf(events, 'assistant/message').map(e => [dataOf(e)['turn'], dataOf(e)['step']])
    // turnId '0' → turn 1 (0-based turns, 1-based steps).
    expect(messages).toEqual([[1, 1], [2, 1], [2, 2]])
  })

  it('takes the step usage from step.end, falling back to usage.record', () => {
    const { events } = run(TYPICAL_TURN)
    expect(dataOf(firstOf(events, 'assistant/message'))['usage']).toEqual({
      inputTokens: 900, cacheReadTokens: 3000, cacheWriteTokens: 0, outputTokens: 200,
    })
    // An interrupted step.end carries only a finish reason — the usage.record
    // written when the response completed is the fallback.
    const fallback = run([
      ...TYPICAL_TURN.slice(0, -2),
      loop(7, { type: 'step.end', finishReason: 'tool_use', step: 1, turnId: '0', uuid: 'se-7' }),
    ])
    expect(dataOf(firstOf(fallback.events, 'assistant/message'))['usage']).toEqual({
      inputTokens: 900, cacheReadTokens: 3000, cacheWriteTokens: 0, outputTokens: 200,
    })
  })

  it('computes the step instants from the recorded timings, not the flush times', () => {
    const { events } = run(TYPICAL_TURN)
    const message = firstOf(events, 'assistant/message')
    // completed = the usage.record instant (the response end), NOT the step.end
    // record's own flush time (t=7s).
    expect(message?.time).toBe(ms(5))
    expect(firstOf(events, 'step/start')?.time).toBe(ms(2))
    // TTFT rides as a token chunk at stepStart + llmFirstTokenLatencyMs.
    const stream = dataOf(message)['stream'] as { time: number; chunk: Rec }[]
    expect(stream[0]?.time).toBe(ms(2) + 1200)
    expect(stream[0]?.chunk['type']).toBe('text-delta')
    // One block-start per block, all at the first-token instant (Kimi records
    // no per-block timing).
    expect(stream.slice(1).map(c => (c.chunk as Rec)['blockType'])).toEqual(['reasoning', 'text', 'tool-call'])
    expect(stream.slice(1).every(c => c.time === ms(2) + 1200)).toBe(true)
  })

  it('falls back to the decode duration when no usage.record was written', () => {
    const { events } = run([
      profileBind(0),
      appendMessage(1, 'hello', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      llmRequest(2),
      contentPart(6, { type: 'text', text: 'hi' }),
      stepEnd(7, { llmStreamDurationMs: 3000 }),
    ])
    expect(firstOf(events, 'assistant/message')?.time).toBe(ms(2) + 3000)
  })

  it('emits no stream and no usage for a step that never ended', () => {
    const { events } = run([
      profileBind(0),
      appendMessage(1, 'hello', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      contentPart(3, { type: 'text', text: 'partial' }),
      line(4, 'turn.step.interrupted', { reason: 'aborted', step: 1, turnId: 0 }),
    ])
    const message = firstOf(events, 'assistant/message')
    expect(dataOf(message)['usage']).toBeUndefined()
    expect(dataOf(message)['stream']).toBeUndefined()
    expect(blocksOf(message)).toEqual([{ type: 'text', text: 'partial' }])
    expect(typesOf(events)).toContain('step/end')
  })

  it('closes an empty interrupted step without inventing a request', () => {
    const { events } = run([
      profileBind(0),
      appendMessage(1, 'hello', { kind: 'user' }),
      stepBegin(2, '0', 1),
      line(3, 'prompt.aborted', { promptId: 'p1', abortedAt: ms(3) }),
    ])
    expect(allOf(events, 'assistant/message')).toHaveLength(0)
    expect(typesOf(events).filter(t => t.startsWith('step/'))).toEqual(['step/start', 'step/end'])
  })

  it('classifies user messages by their origin, never by their text', () => {
    const { events, synth } = run([
      profileBind(0),
      appendMessage(1, 'hello there', { kind: 'user' }),
      appendMessage(2, 'no origin at all'),
      appendMessage(3, '<system-reminder>todos</system-reminder>', { kind: 'injection', variant: 'todo_list_reminder' }),
      appendMessage(4, 'the date changed', { kind: 'injection', variant: 'date_change', disclosure: {} }),
      appendMessage(5, 'background task finished', { kind: 'task', taskId: 't1', notificationId: 'n1', status: 'completed' }),
      appendMessage(6, 'skill body', { kind: 'skill_activation', skillName: 'deploy', skillPath: '/s', trigger: 'user' }),
      appendMessage(7, 'plugin says hi', { kind: 'plugin_command' }),
      appendMessage(8, 'a brand new origin', { kind: 'future_kind' }),
    ])
    const messages = allOf(events, 'user/message')
    expect(messages.map(m => sourceOf(m)['kind'])).toEqual([
      'user', 'user', 'todo_list_reminder', 'date_change', 'task-notification',
      'skill-invocation', 'plugin-command', 'future_kind',
    ])
    expect(messages.map(m => sourceOf(m)['form'])).toEqual([
      undefined, undefined, 'context', 'context', 'context', 'skill', 'context', 'context',
    ])
    expect(sourceOf(messages[5])['name']).toBe('deploy')
    // The label is the FIRST human prompt.
    expect(synth.meta().label).toBe('hello there')
  })

  it('emits injections that arrive after turn.ended, matching kimi-code context memory', () => {
    const { events } = run([
      profileBind(0),
      line(1, 'turn.prompt', { promptId: 'p1', input: [], origin: { kind: 'user' } }),
      appendMessage(2, 'hello there', { kind: 'user' }),
      line(3, 'turn.ended', { durationMs: 1000, reason: 'completed', turnId: 0 }),
      appendMessage(4, '<system-reminder>AGENTS.md changed</system-reminder>', {
        kind: 'injection', variant: 'agents_md_change',
      }),
      appendMessage(5, '<system-reminder>AGENTS.md changed</system-reminder>', {
        kind: 'injection', variant: 'agents_md_change',
      }),
    ])
    expect(allOf(events, 'user/message').map(m => sourceOf(m)['kind'])).toEqual([
      'user', 'agents_md_change', 'agents_md_change',
    ])
  })

  it('derives file ops from the call arguments of each file tool', () => {
    const call = (s: number, id: string, name: string, args: Rec): string[] => [
      toolCall(s, id, name, args),
      toolResult(s, id, { output: 'ok' }),
    ]
    const { events } = run([
      profileBind(0),
      appendMessage(1, 'go', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      ...call(3, 'c_read', 'Read', { path: '/tmp/a.ts', offset: 10, limit: 20 }),
      ...call(3, 'c_read2', 'Read', { path: '/tmp/b.ts', limit: 20 }),
      ...call(3, 'c_write', 'Write', { path: '/tmp/c.ts', content: 'one\ntwo\n' }),
      ...call(3, 'c_edit', 'Edit', { path: '/tmp/d.ts', old_string: 'a\nb', new_string: 'x' }),
      ...call(3, 'c_grep', 'Grep', { pattern: 'TODO' }),
      ...call(3, 'c_glob', 'Glob', { pattern: '*.ts', path: '/tmp/src' }),
      ...call(3, 'c_bash', 'Bash', { command: 'ls' }),
      stepEnd(4),
    ])
    const ops = allOf(events, 'tool/result').map(e => dataOf(e)['fileOps'])
    expect(ops).toEqual([
      [{ kind: 'read', path: '/tmp/a.ts', read: { start: 10, count: 20 } }],
      [{ kind: 'read', path: '/tmp/b.ts', read: { count: 20, est: true } }],
      [{ kind: 'write', path: '/tmp/c.ts', added: 2 }],
      [{ kind: 'write', path: '/tmp/d.ts', added: 1, removed: 2 }],
      [{ kind: 'search', path: 'TODO', pattern: true, detail: 'TODO' }],
      [{ kind: 'search', path: '/tmp/src', detail: '*.ts' }],
      undefined,
    ])
  })

  it('carries the tool result output, note and error flag', () => {
    const { events } = run([
      profileBind(0),
      appendMessage(1, 'go', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      toolCall(3, 'c1', 'Bash', { command: 'false' }),
      toolResult(3, 'c1', { output: 'boom', isError: true, note: 'exit code 1' }),
      stepEnd(4),
    ])
    const result = firstOf(events, 'tool/result')
    expect(dataOf(result)['error']).toBe(true)
    const block = blocksOf(result)[0]
    expect(block?.type).toBe('tool-result')
    expect(block?.toolCallId).toBe('c1')
    expect(block?.isError).toBe(true)
    expect(block?.content).toEqual([{ type: 'text', text: 'boom' }, { type: 'text', text: 'exit code 1' }])
    // A tool result's source rides INSIDE data.message (the fold's pairing key).
    expect((dataOf(result)['message'] as Rec)['source']).toEqual({ callId: 'c1', name: 'Bash' })
  })

  it('binds a child from task.started and closes it on task.terminated', () => {
    const { synth } = run([
      profileBind(0),
      appendMessage(1, 'go', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      toolCall(3, 'c_agent', 'Agent', { subagent_type: 'explore', prompt: 'look around', description: 'survey the repo' }),
      line(3, 'task.started', {
        info: {
          kind: 'agent', taskId: 'task-1', status: 'running', startedAt: ms(3),
          parentToolCallId: 'c_agent', description: 'survey the repo', detached: false,
          agentId: 'agent-77', subagentType: 'explore', model: 'k3', thinkingEffort: 'low',
        },
      }),
      toolResult(4, 'c_agent', { output: 'agent_id: agent-77\nsurveyed' }),
      stepEnd(4),
      line(5, 'task.terminated', {
        info: { kind: 'agent', taskId: 'task-1', status: 'completed', endedAt: ms(5), agentId: 'agent-77', exitCode: 0 },
      }),
    ])
    const children = [...synth.meta().children.values()]
    expect(children).toEqual([{
      key: 'agent-77',
      label: 'survey the repo',
      agentType: 'explore',
      model: 'k3',
      callId: 'c_agent',
      startedAt: ms(3),
      completedAt: ms(5),
    }])
  })

  it('binds a child from the agent_id: line when no task.started was seen', () => {
    const { synth } = run([
      profileBind(0),
      appendMessage(1, 'go', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      toolCall(3, 'c_agent', 'AgentSwarm', { subagent_type: 'coder', prompt: 'fix everything' }),
      toolResult(4, 'c_agent', { output: 'task_id: t9\nagent_id: agent-42\nstarted' }),
      stepEnd(4),
    ])
    const children = [...synth.meta().children.values()]
    expect(children).toEqual([{
      key: 'agent-42',
      label: 'fix everything',
      agentType: 'coder',
      callId: 'c_agent',
      startedAt: ms(4),
    }])
  })

  it('binds every agent of a swarm result, with its item as the label', () => {
    const { synth } = run([
      profileBind(0),
      appendMessage(1, 'go', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      toolCall(3, 'c_swarm', 'AgentSwarm', { prompt_template: 'Review {{item}}', items: ['a.ts', 'b.ts'] }),
      toolResult(4, 'c_swarm', {
        output: [
          '<agent_swarm_result>',
          '<summary>1 completed, 1 failed, 0 aborted</summary>',
          '<subagent agent_id="agent-3" item="Review a.ts" outcome="completed">fine</subagent>',
          '<subagent agent_id="agent-4" item="Review b.ts &amp; co" outcome="failed">boom</subagent>',
          '</agent_swarm_result>',
        ].join('\n'),
      }),
      stepEnd(4),
    ])
    expect([...synth.meta().children.values()]).toEqual([
      { key: 'agent-3', label: 'Review a.ts', callId: 'c_swarm', startedAt: ms(4), completedAt: ms(4) },
      { key: 'agent-4', label: 'Review b.ts & co', callId: 'c_swarm', startedAt: ms(4), completedAt: ms(4) },
    ])
  })

  it('treats a delegated subagent prompt as the human message of its own transcript', () => {
    const delegated = '<git-context>\nWorking directory: /tmp/work\n</git-context>\n\nsurvey the repo'
    const { events, synth } = run([
      line(0, 'metadata', { created_at: ms(0), protocol_version: '1.5' }),
      profileBind(0),
      line(1, 'turn.prompt', {
        promptId: 'p1', input: [{ type: 'text', text: delegated }],
        origin: { kind: 'system_trigger', name: 'subagent' },
      }),
      line(1, 'context.append_message', {
        message: {
          role: 'user', content: [{ type: 'text', text: delegated }], toolCalls: [],
          origin: { kind: 'system_trigger', name: 'subagent' },
        },
      }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      llmRequest(2),
      contentPart(6, { type: 'text', text: 'on it' }),
      stepEnd(7),
    ])
    const prompt = firstOf(events, 'user/message')
    expect(sourceOf(prompt)).toEqual({ kind: 'user' })
    // The `<git-context>` prelude is boilerplate; the label is the task itself.
    expect(synth.meta().label).toBe('survey the repo')
  })

  it('folds a media result into text and image blocks', () => {
    const { events } = run([
      profileBind(0),
      appendMessage(1, 'look', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      toolCall(3, 'c_media', 'ReadMediaFile', { path: '/tmp/shot.png' }),
      toolResult(4, 'c_media', {
        output: [
          { type: 'text', text: '<image path="/tmp/shot.png">' },
          { type: 'image_url', imageUrl: { url: `blobref:image/png;${'a'.repeat(64)}` } },
        ],
      }),
      stepEnd(5),
    ])
    const block = blocksOf(firstOf(events, 'tool/result'))[0]
    expect(block?.type).toBe('tool-result')
    expect(block?.content).toEqual([
      { type: 'text', text: '<image path="/tmp/shot.png">' },
      { type: 'image' },
    ])
  })

  it('keeps an image part of a prompt as an image block', () => {
    const { events } = run([
      profileBind(0),
      line(1, 'context.append_message', {
        message: {
          role: 'user',
          content: [
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            { type: 'text', text: 'what is this?' },
          ],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      }),
      stepBegin(2, '0', 1),
      stepEnd(3),
    ])
    expect(blocksOf(firstOf(events, 'user/message'))).toEqual([
      { type: 'image' },
      { type: 'text', text: 'what is this?' },
    ])
  })

  it('shadows everything but the kept user messages on a compaction', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      appendMessage(9, 'second prompt', { kind: 'user' }),
      appendMessage(10, 'third prompt', { kind: 'user' }),
      // The answer to the last prompt: kept user messages do NOT keep their turns.
      stepBegin(10, '1', 1),
      contentPart(10, { type: 'text', text: 'third answer' }, '1', 1),
      stepEnd(10),
      line(11, 'context.apply_compaction', {
        summary: 'working summary',
        contextSummary: 'we read a file',
        compactedCount: 3,
        tokensBefore: 4100,
        tokensAfter: 900,
        keptUserMessageCount: 1,
        droppedCount: 3,
      }),
    ])
    const summary = firstOf(events, 'compaction/summary')
    const shadowed = dataOf(summary)['shadowedSeqs'] as number[]
    const thirdPrompt = allOf(events, 'user/message').find(m => blocksOf(m)[0]?.text === 'third prompt')
    const thirdAnswer = allOf(events, 'assistant/message').at(-1)
    expect(dataOf(summary)['shadowedTokenCount']).toBe(4100)
    // The most recent human prompt (k = 1) stays live; its own answer does not.
    expect(shadowed).not.toContain(thirdPrompt?.seq)
    expect(shadowed).toContain(thirdAnswer?.seq)
    const replacement = allOf(events, 'user/message').at(-1)
    expect(sourceOf(replacement)).toEqual({ kind: 'plugin', form: 'compaction', plugin: 'compaction' })
    // The fold prices the message that enters the context (contextSummary),
    // not the shorter working summary.
    expect(blocksOf(replacement)).toEqual([{ type: 'text', text: 'we read a file' }])
    expect(replacement?.surfaceOp).toEqual({
      op: 'replace', startSeq: Math.min(...shadowed), endSeq: Math.max(...shadowed),
    })
  })

  it('keeps the head and tail user messages an elided compaction declares', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      appendMessage(9, 'second prompt', { kind: 'user' }),
      appendMessage(10, 'third prompt', { kind: 'user' }),
      line(11, 'context.apply_compaction', {
        contextSummary: 'we read a file',
        compactedCount: 3,
        tokensBefore: 4100,
        tokensAfter: 900,
        keptUserMessageCount: 2,
        keptHeadUserMessageCount: 1,
        droppedCount: 3,
      }),
    ])
    const shadowed = dataOf(firstOf(events, 'compaction/summary'))['shadowedSeqs'] as number[]
    const prompts = allOf(events, 'user/message').filter(m => sourceOf(m)['kind'] === 'user')
    const [first, second, third] = prompts
    // keptHeadUserMessageCount from the head, the rest from the tail; the
    // elided middle joins the shadow claim.
    expect(shadowed).not.toContain(first?.seq)
    expect(shadowed).toContain(second?.seq)
    expect(shadowed).not.toContain(third?.seq)
  })

  it('shadows the whole surface when the compaction declares a legacy tail', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      line(9, 'context.apply_compaction', {
        contextSummary: 'older shape',
        count: 3,
        keptUserMessageCount: 2,
        legacyTail: true,
      }),
    ])
    const shadowed = dataOf(firstOf(events, 'compaction/summary'))['shadowedSeqs'] as number[]
    const surfaceSeqs = events
      .filter(e => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')
      .map(e => e.seq)
      .slice(0, -1)
    expect(shadowed).toEqual(surfaceSeqs)
    expect(blocksOf(allOf(events, 'user/message').at(-1))).toEqual([{ type: 'text', text: 'older shape' }])
  })

  it('does not double the summary when the compaction_summary message is mirrored', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      line(9, 'context.apply_compaction', { summary: 'the story so far', keptUserMessageCount: 0 }),
      appendMessage(9, 'the story so far', { kind: 'compaction_summary' }),
    ])
    const summaries = allOf(events, 'user/message').filter(m => sourceOf(m)['form'] === 'compaction')
    expect(summaries).toHaveLength(1)
  })

  it('prunes the surface on context.clear and context.undo', () => {
    const cleared = run([...TYPICAL_TURN, line(9, 'context.clear', { agentId: 'main' })])
    const prune = firstOf(cleared.events, 'compaction/prune')
    const shadowed = dataOf(prune)['shadowedSeqs'] as number[]
    expect(shadowed.length).toBeGreaterThan(0)
    const marker = allOf(cleared.events, 'user/message').at(-1)
    expect(sourceOf(marker)['plugin']).toBe('context-clear')
    expect(marker?.surfaceOp).toEqual({
      op: 'replace', startSeq: Math.min(...shadowed), endSeq: Math.max(...shadowed),
    })

    const undone = run([...TYPICAL_TURN, line(9, 'context.undo', { count: 1 })])
    const undoPrune = firstOf(undone.events, 'compaction/prune')
    const humanSeq = firstOf(undone.events, 'user/message')?.seq ?? 0
    // The undo unwinds from the most recent human prompt onward.
    expect(dataOf(undoPrune)['shadowedSeqs']).toContain(humanSeq)
    expect(sourceOf(allOf(undone.events, 'user/message').at(-1))['plugin']).toBe('context-undo')
  })

  it('maps the plan-mode toggles', () => {
    const { events } = run([
      profileBind(0),
      line(1, 'plan_mode.enter', { id: 'plan-1' }),
      line(2, 'plan_mode.exit', { id: 'plan-1' }),
      line(3, 'plan_mode.enter', { id: 'plan-2' }),
      line(4, 'plan_mode.cancel', { id: 'plan-2' }),
    ])
    expect(allOf(events, 'plan/mode').map(e => dataOf(e)['active'])).toEqual([true, false, true, false])
  })

  it('tracks liveness across the prompt lifecycle', () => {
    const synth = createKimiSynthesizer(MAIN)
    const feed = (l: string): void => { synth.push(l) }
    feed(profileBind(0))
    expect(synth.meta().running).toBe(false)
    feed(line(1, 'turn.prompt', { promptId: 'p1', input: [], origin: { kind: 'user' } }))
    expect(synth.meta().running).toBe(true)
    feed(line(2, 'turn.ended', { durationMs: 1000, reason: 'completed', turnId: 0 }))
    expect(synth.meta().running).toBe(false)
    feed(line(3, 'turn.steer', { input: [{ text: 'more' }], origin: { kind: 'user' } }))
    expect(synth.meta().running).toBe(true)
    feed(line(4, 'prompt.completed', { promptId: 'p1', reason: 'completed', finishedAt: ms(4) }))
    expect(synth.meta().running).toBe(false)
  })

  it('records no CLI version and no reported cost (Kimi writes neither)', () => {
    const { synth } = run(TYPICAL_TURN)
    expect(synth.meta().version).toBeUndefined()
    expect(synth.meta().reportedCostUsd).toBeUndefined()
  })

  it('keeps an injection from splitting a buffered step', () => {
    const { events } = run([
      profileBind(0),
      appendMessage(1, 'go', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      usageRecord(5, { inputOther: 10, inputCacheRead: 0, inputCacheCreation: 0, output: 5 }),
      contentPart(6, { type: 'text', text: 'half' }),
      appendMessage(6, 'you were interrupted', { kind: 'injection', variant: 'interruption' }),
      contentPart(6, { type: 'text', text: 'and the rest' }),
      stepEnd(7),
    ])
    // ONE response, not two: the injection is context, not a step boundary.
    expect(allOf(events, 'assistant/message')).toHaveLength(1)
    expect(blocksOf(firstOf(events, 'assistant/message'))).toEqual([
      { type: 'text', text: 'half' }, { type: 'text', text: 'and the rest' },
    ])
  })

  it('emits a tool result of an already-settled step at its own time', () => {
    const { events } = run([
      profileBind(0),
      appendMessage(1, 'go', { kind: 'user' }),
      stepBegin(2, '0', 1),
      toolsSnapshot(2),
      toolCall(3, 'c1', 'Read', { path: '/tmp/a.ts' }),
      stepEnd(3),
      // The result lands after its step already settled (the other flush order).
      toolResult(9, 'c1', { output: 'contents' }),
    ])
    const result = allOf(events, 'tool/result')
    expect(result).toHaveLength(1)
    expect(result[0]?.time).toBe(ms(9))
    expect(dataOf(result[0])['fileOps']).toEqual([{ kind: 'read', path: '/tmp/a.ts' }])
    // The call event still precedes it, so the fold can pair them.
    expect(typesOf(events).indexOf('tool/call')).toBeLessThan(typesOf(events).indexOf('tool/result'))
  })
})
