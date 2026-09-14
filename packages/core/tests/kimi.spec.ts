import { describe, expect, it } from 'vitest'
import { createKimiParser, kimiMessageClass } from '../src/adapters/kimi.ts'
import type { SessionFileRef } from '../src/session.ts'
import type {
  AssistantMessageNode, ContextMessageNode, ToolResultNode,
} from '../src/contract.ts'

const SESSION_ID = 'session_11111111-2222-3333-4444-555555555555'
const CHILD_ID = 'agent_aaaa1111'

const MAIN: SessionFileRef = {
  id: SESSION_ID,
  role: 'main',
  path: `/tmp/sessions/wd_project_0123456789ab/${SESSION_ID}/agents/main/wire.jsonl`,
}
const CHILD: SessionFileRef = {
  id: CHILD_ID,
  role: 'child',
  path: `/tmp/sessions/wd_project_0123456789ab/${SESSION_ID}/agents/${CHILD_ID}/wire.jsonl`,
  parentId: SESSION_ID,
}

/** Kimi writes epoch milliseconds, not ISO strings. */
const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function at(offsetMs: number): number {
  return T0 + offsetMs
}

function line(type: string, body: Record<string, unknown>, offsetMs: number, agentId = 'main'): string {
  return JSON.stringify({ type, time: at(offsetMs), agentId, ...body })
}

const metadata = () => JSON.stringify({ type: 'metadata', created_at: T0, protocol_version: '1.5' })

const profileBind = (offset: number, extra: Record<string, unknown> = {}) => line('profile.bind', {
  profileName: 'agent',
  modelAlias: 'kimi-code/k3',
  thinkingEffort: 'high',
  systemPrompt: 'You are a test agent.',
  activeToolNames: ['Read', 'Write', 'Agent'],
  agentsMdPaths: [],
  environmentDisclosure: { cwd: '/work/project' },
  subagents: [],
  ...extra,
}, offset)

const turnPrompt = (offset: number, text: string) => line('turn.prompt', {
  promptId: `prompt-${offset}`, input: [{ type: 'text', text }], origin: { kind: 'user' },
}, offset)

const appendMessage = (offset: number, text: string, origin?: Record<string, unknown>) => line(
  'context.append_message',
  {
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      ...(origin === undefined ? {} : { origin }),
    },
  },
  offset,
)

const loop = (offset: number, event: Record<string, unknown>, agentId = 'main') => line(
  'context.append_loop_event', { event: { uuid: `evt-${offset}`, ...event } }, offset, agentId,
)

const stepBegin = (offset: number, turnId: string, step: number, agentId = 'main') => loop(
  offset, { type: 'step.begin', turnId, step }, agentId,
)

const llmRequest = (offset: number, turnStep: string, extra: Record<string, unknown> = {}) => line('llm.request', {
  kind: 'loop',
  model: 'k3',
  modelAlias: 'kimi-code/k3',
  // The wire protocol, never the vendor.
  provider: 'openai',
  maxTokens: 1_048_576,
  messageCount: 4,
  systemPromptHash: 'sp-1',
  toolsHash: 'th-1',
  turnStep,
  thinkingEffort: 'high',
  ...extra,
}, offset)

const thinkPart = (offset: number, turnId: string, step: number, think: string) => loop(offset, {
  type: 'content.part', part: { type: 'think', think }, step, stepUuid: `step-${turnId}-${step}`, turnId,
})

const textPart = (offset: number, turnId: string, step: number, text: string) => loop(offset, {
  type: 'content.part', part: { type: 'text', text }, step, stepUuid: `step-${turnId}-${step}`, turnId,
})

const toolCall = (
  offset: number,
  turnId: string,
  step: number,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  agentId = 'main',
) => loop(offset, {
  type: 'tool.call', toolCallId, name, args, step, stepUuid: `step-${turnId}-${step}`, turnId,
}, agentId)

const toolResult = (
  offset: number,
  toolCallId: string,
  result: Record<string, unknown>,
  agentId = 'main',
) => loop(offset, { type: 'tool.result', toolCallId, parentUuid: `evt-${toolCallId}`, result }, agentId)

const usage = (inputOther: number, inputCacheRead: number, inputCacheCreation: number, output: number) => ({
  inputOther, inputCacheRead, inputCacheCreation, output,
})

const stepEnd = (
  offset: number,
  turnId: string,
  step: number,
  extra: Record<string, unknown> = {},
) => loop(offset, {
  type: 'step.end',
  finishReason: 'stop',
  providerFinishReason: 'stop',
  rawFinishReason: 'stop',
  messageId: `msg-${turnId}-${step}`,
  llmFirstTokenLatencyMs: 300,
  llmStreamDurationMs: 700,
  llmServerDecodeMs: 600,
  step,
  turnId,
  ...extra,
})

const usageRecord = (offset: number, value: Record<string, number>) => line('usage.record', {
  model: 'kimi-code/k3', usageScope: 'turn', usage: value,
}, offset)

const turnEnded = (offset: number, turnId: number, reason = 'completed') => line('turn.ended', {
  durationMs: 1_000, reason, turnId,
}, offset)

function feed(lines: readonly string[], file: SessionFileRef = MAIN) {
  const parser = createKimiParser()
  for (const item of lines) parser.push(item, file)
  return parser
}

function assistants(parser: ReturnType<typeof createKimiParser>): AssistantMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is AssistantMessageNode => node.kind === 'assistant')
}

function toolResults(parser: ReturnType<typeof createKimiParser>): ToolResultNode[] {
  return parser.snapshot().eventNodes.filter((node): node is ToolResultNode => node.kind === 'tool-result')
}

function contexts(parser: ReturnType<typeof createKimiParser>): ContextMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is ContextMessageNode => node.kind === 'context')
}

/** One turn, two steps: a Read tool loop and then the answer. */
function twoStepFixture(): string[] {
  return [
    metadata(),
    profileBind(10),
    turnPrompt(100, 'read a.ts'),
    appendMessage(110, 'read a.ts', { kind: 'user' }),
    stepBegin(200, '0', 1),
    llmRequest(210, '0.1'),
    usageRecord(900, usage(100, 900, 0, 20)),
    thinkPart(1_000, '0', 1, 'Open the file first.'),
    toolCall(1_010, '0', 1, 'call-1', 'Read', { path: '/tmp/a.ts' }),
    stepEnd(1_020, '0', 1, { finishReason: 'tool_use', usage: usage(100, 900, 0, 20) }),
    toolResult(1_100, 'call-1', { output: 'export const a = 1' }),
    stepBegin(1_200, '0', 2),
    llmRequest(1_210, '0.2'),
    textPart(2_000, '0', 2, 'It exports a.'),
    stepEnd(2_010, '0', 2, { usage: usage(150, 1_000, 0, 12) }),
    turnEnded(2_100, 0),
  ]
}

describe('kimi adapter', () => {
  it('reads the system prompt, model, and cwd from profile.bind', () => {
    const parser = feed(twoStepFixture())
    expect(parser.snapshot().systemPrompts).toEqual([
      { seq: 1, time: at(10), turn: 0, step: 0, text: 'You are a test agent.', update: false },
    ])
    expect(parser.meta()).toEqual({
      title: 'read a.ts',
      cwd: '/work/project',
      model: 'k3',
      startedAt: T0,
      promptCount: 1,
    })
    expect(parser.kind).toBe('kimi')
  })

  it('takes the model from the alias tail before the first request', () => {
    const parser = feed([
      metadata(),
      profileBind(10, { modelAlias: 'moonshotai/kimi-k2.7-code' }),
      turnPrompt(100, 'hi'),
      appendMessage(110, 'hi', { kind: 'user' }),
      stepBegin(200, '0', 1),
      textPart(300, '0', 1, 'hello'),
      stepEnd(310, '0', 1, { usage: usage(1, 0, 0, 1) }),
    ])
    expect(parser.meta().model).toBe('kimi-k2.7-code')
    // The alias decides the vendor; `llm.request.provider` ('openai') never does.
    expect(assistants(parser)[0]?.provenance).toEqual({ provider: 'moonshotai', model: 'kimi-k2.7-code' })
  })

  it('records a later profile.bind with different instructions as a new system prompt', () => {
    const parser = feed([
      ...twoStepFixture(),
      profileBind(3_000, { profileName: 'plan' }),
      profileBind(3_100, { profileName: 'plan', systemPrompt: 'You are a planning agent.' }),
    ])
    expect(parser.snapshot().systemPrompts?.map(prompt => [prompt.text, prompt.update])).toEqual([
      ['You are a test agent.', false],
      ['You are a planning agent.', true],
    ])
  })

  it('numbers turns from the loop turnId and steps from the loop step', () => {
    const parser = feed([
      ...twoStepFixture(),
      turnPrompt(3_000, 'thanks'),
      appendMessage(3_010, 'thanks', { kind: 'user' }),
      stepBegin(3_100, '1', 1),
      llmRequest(3_110, '1.1'),
      textPart(3_200, '1', 1, 'Any time.'),
      stepEnd(3_210, '1', 1, { usage: usage(10, 0, 0, 2) }),
      turnEnded(3_300, 1),
    ])
    // Wire turns are 0-based, the contract's are 1-based.
    expect(assistants(parser).map(node => [node.turn, node.step])).toEqual([[1, 1], [1, 2], [2, 1]])
    expect(parser.meta().promptCount).toBe(2)
    const requests = parser.snapshot().requests.filter(request => request.purpose === 'assistant')
    expect(requests.map(request => [request.turn, request.step, request.status]))
      .toEqual([[1, 1, 'complete'], [1, 2, 'complete'], [2, 1, 'complete']])
    expect(parser.snapshot().partial).toBeNull()
  })

  it('keeps think, text, and tool-call blocks in model order with step timings', () => {
    const parser = feed(twoStepFixture())
    const [first, second] = assistants(parser)
    expect(first?.blocks).toEqual([
      { kind: 'reasoning', text: 'Open the file first.' },
      { kind: 'tool-call', callId: 'call-1', name: 'Read', argsRaw: JSON.stringify({ path: '/tmp/a.ts' }) },
    ])
    expect(second?.blocks).toEqual([{ kind: 'text', text: 'It exports a.' }])
    // TTFT is a latency from the request start, not a timestamp.
    expect(first?.timing).toEqual({
      stepStartTime: at(200), firstTokenTime: at(500), completedTime: at(1_020),
    })
  })

  it('maps step.end usage onto disjoint contract buckets', () => {
    const parser = feed(twoStepFixture())
    const [first] = assistants(parser)
    expect(first?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 1_020,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    })
    const request = parser.snapshot().requests.find(item => item.startSeq === first?.seq)
    expect(request?.usage).toEqual(first?.usage)
    expect(request?.provenance).toEqual({ provider: 'kimi-for-coding', model: 'k3' })
    // Kimi's `maxTokens` is the context window, not a generation cap.
    expect(request?.requestConfig).toEqual({
      provider: 'kimi-for-coding', model: 'k3', reasoningEffort: 'high', maxTokens: 1_048_576,
    })
  })

  it('pairs a tool result with its call and its arguments', () => {
    const parser = feed(twoStepFixture())
    const results = toolResults(parser)
    expect(results.map(result => result.callId)).toEqual(['call-1'])
    const [result] = results
    expect(result?.call).toEqual({ name: 'Read', argsRaw: JSON.stringify({ path: '/tmp/a.ts' }) })
    expect(result?.content).toEqual([{ type: 'text', text: 'export const a = 1' }])
    expect(result?.isError).toBe(false)
    expect(result?.seq).toBeGreaterThan(assistants(parser)[0]?.seq ?? Infinity)
  })

  it('appends the result note and flags failures', () => {
    const parser = feed([
      metadata(),
      profileBind(10),
      turnPrompt(100, 'write it'),
      appendMessage(110, 'write it', { kind: 'user' }),
      stepBegin(200, '0', 1),
      toolCall(300, '0', 1, 'call-1', 'Write', { path: '/tmp/a.ts', content: 'hello\n' }),
      stepEnd(310, '0', 1, { finishReason: 'tool_use', usage: usage(1, 0, 0, 1) }),
      toolResult(400, 'call-1', { output: 'Error: read-only', isError: true, note: 'retry with sudo' }),
    ])
    const [result] = toolResults(parser)
    expect(result?.isError).toBe(true)
    expect(result?.content).toEqual([
      { type: 'text', text: 'Error: read-only' },
      { type: 'text', text: 'retry with sudo' },
    ])
  })

  it('emits a result flushed before step.end after the step it belongs to', () => {
    // Loop events are written after the response, so the flush order varies.
    const parser = feed([
      metadata(),
      profileBind(10),
      turnPrompt(100, 'read it'),
      appendMessage(110, 'read it', { kind: 'user' }),
      stepBegin(200, '0', 1),
      toolCall(300, '0', 1, 'call-1', 'Read', { path: '/tmp/a.ts' }),
      toolResult(310, 'call-1', { output: 'ok' }),
      stepEnd(320, '0', 1, { finishReason: 'tool_use', usage: usage(1, 0, 0, 1) }),
    ])
    const kinds = parser.snapshot().eventNodes.map(node => node.kind)
    expect(kinds).toEqual(['user', 'assistant', 'tool-result'])
    const [assistant] = assistants(parser)
    const [result] = toolResults(parser)
    expect(result?.seq).toBeGreaterThan(assistant?.seq ?? Infinity)
  })

  it('exposes the open step as partial output with its running call', () => {
    const parser = feed(twoStepFixture().slice(0, 9))
    const snapshot = parser.snapshot()
    expect(snapshot.partial).toEqual({
      turn: 1,
      step: 1,
      blocks: [
        { kind: 'reasoning', text: 'Open the file first.' },
        { kind: 'tool-call', callId: 'call-1', name: 'Read', argsRaw: JSON.stringify({ path: '/tmp/a.ts' }) },
      ],
    })
    expect(assistants(parser)).toHaveLength(0)
    expect(snapshot.runningCalls.map(call => call.callId)).toEqual(['call-1'])
    // The snapshot object is stable until another line arrives.
    expect(parser.snapshot()).toBe(snapshot)
    parser.push(stepEnd(1_020, '0', 1, { finishReason: 'tool_use', usage: usage(1, 0, 0, 1) }), MAIN)
    expect(parser.snapshot()).not.toBe(snapshot)
    expect(parser.snapshot().partial).toBeNull()
  })

  it('closes the turn locations when the turn ends', () => {
    const parser = feed(twoStepFixture())
    const locations = [...parser.snapshot().eventLocations.values()]
    expect(locations).toHaveLength(4)
    expect(locations.every(location => location.kind === 'turn' && location.turn.status === 'closed')).toBe(true)
  })

  it('classifies human prompts and injected context by origin, never by text', () => {
    const parser = feed([
      metadata(),
      profileBind(10),
      turnPrompt(100, 'first'),
      appendMessage(110, 'first', { kind: 'user' }),
      // An early record without an origin is still a person.
      appendMessage(120, 'second'),
      appendMessage(130, '<system-reminder>todo list</system-reminder>', {
        kind: 'injection', variant: 'todo_list_reminder',
      }),
      appendMessage(140, '# repo rules', { kind: 'injection', variant: 'agents_md' }),
      appendMessage(150, 'it is a new day', {
        kind: 'injection', variant: 'date_change', disclosure: { date: '2026-01-02' },
      }),
      appendMessage(160, 'unlabelled', { kind: 'injection' }),
      appendMessage(170, 'task 1 finished', {
        kind: 'task', taskId: 'task-1', notificationId: 'n-1', status: 'completed',
      }),
      appendMessage(180, 'skill body', {
        kind: 'skill_activation', skillName: 'code-review', skillPath: '/tmp/skill.md', trigger: 'explicit',
      }),
      appendMessage(190, '/compact', { kind: 'plugin_command' }),
      appendMessage(200, 'summary of the session so far', { kind: 'compaction_summary' }),
      appendMessage(210, 'from the future', { kind: 'brand_new_origin' }),
    ])
    expect(contexts(parser).map(node => [node.provenance.label, node.provenance.role, node.form])).toEqual([
      ['todo_list_reminder', 'inject', 'notice'],
      ['agents_md', 'inject', 'instructions'],
      ['date_change', 'inject', 'snapshot'],
      ['injection', 'inject', 'notice'],
      ['task-notification', 'inject', 'relay'],
      ['code-review', 'inject', 'catalog'],
      ['plugin-command', 'inject', 'notice'],
      ['compaction', 'recall', 'recall'],
      ['brand_new_origin', 'inject', 'notice'],
    ])
    // Only the two human messages count as prompts, and only they open turns.
    expect(parser.meta().promptCount).toBe(2)
    expect(parser.snapshot().eventNodes.filter(node => node.kind === 'user')).toHaveLength(2)
    expect(parser.meta().title).toBe('first')
  })

  it('binds a subagent run from task.started and task.terminated', () => {
    const parser = createKimiParser()
    for (const item of [
      metadata(),
      profileBind(10),
      turnPrompt(100, 'fix the bug'),
      appendMessage(110, 'fix the bug', { kind: 'user' }),
      stepBegin(200, '0', 1),
      llmRequest(210, '0.1'),
      toolCall(300, '0', 1, 'call-agent', 'Agent', {
        subagent_type: 'coder', prompt: 'fix the bug in a.ts', description: 'Fix the bug',
      }),
      stepEnd(310, '0', 1, { finishReason: 'tool_use', usage: usage(10, 0, 0, 5) }),
      line('task.started', {
        info: {
          kind: 'agent',
          taskId: 'task-1',
          agentId: CHILD_ID,
          parentToolCallId: 'call-agent',
          description: 'Fix the bug',
          subagentType: 'coder',
          model: 'k3',
          thinkingEffort: 'high',
          status: 'running',
          startedAt: at(400),
          detached: false,
        },
      }, 400),
    ]) parser.push(item, MAIN)
    for (const item of [
      JSON.stringify({ type: 'metadata', created_at: at(410), protocol_version: '1.5' }),
      line('runtime.set_binding', { runtimeId: 'rt-1', workspaceId: 'wd-1' }, 420, CHILD_ID),
      stepBegin(500, '0', 1, CHILD_ID),
      toolCall(600, '0', 1, 'child-call-1', 'Read', { path: '/tmp/a.ts' }, CHILD_ID),
      toolResult(700, 'child-call-1', { output: 'export const a = 1' }, CHILD_ID),
      loop(800, { type: 'step.end', finishReason: 'stop', step: 1, turnId: '0' }, CHILD_ID),
    ]) parser.push(item, CHILD)
    for (const item of [
      line('task.terminated', {
        info: {
          kind: 'agent',
          taskId: 'task-1',
          agentId: CHILD_ID,
          status: 'completed',
          startedAt: at(400),
          endedAt: at(900),
          exitCode: 0,
          parentToolCallId: 'call-agent',
          outputTail: 'done',
        },
      }, 900),
      toolResult(1_000, 'call-agent', { output: `agent_id: ${CHILD_ID}\nFixed it.` }),
      turnEnded(1_100, 0),
    ]) parser.push(item, MAIN)

    expect(parser.subagents()).toEqual([{
      agentId: CHILD_ID,
      fileId: CHILD_ID,
      callId: 'call-agent',
      description: 'Fix the bug',
      agentType: 'coder',
      model: 'k3',
      status: 'completed',
      startedAt: at(400),
      endedAt: at(900),
      lastTime: at(800),
      toolCalls: 1,
    }])
    // The child's tool calls nest under the parent's Agent call.
    const [agentResult] = toolResults(parser)
    expect(agentResult?.callId).toBe('call-agent')
    expect(agentResult?.subCalls.map(call => call.callId)).toEqual(['child-call-1'])
    expect(toolResults(parser)).toHaveLength(1)
  })

  it('falls back to the agent_id line of an Agent result when no task.started was seen', () => {
    const parser = feed([
      metadata(),
      profileBind(10),
      turnPrompt(100, 'review it'),
      appendMessage(110, 'review it', { kind: 'user' }),
      stepBegin(200, '0', 1),
      toolCall(300, '0', 1, 'call-agent', 'AgentSwarm', {
        subagent_type: 'explore', prompt: 'review the diff carefully', items: ['a.ts'],
      }),
      stepEnd(310, '0', 1, { finishReason: 'tool_use', usage: usage(10, 0, 0, 5) }),
      toolResult(400, 'call-agent', { output: 'task_id: task-9\nagent_id: agent_bbbb2222\n' }),
    ])
    expect(parser.subagents()).toEqual([{
      agentId: 'agent_bbbb2222',
      fileId: 'agent_bbbb2222',
      callId: 'call-agent',
      description: 'review the diff carefully',
      agentType: 'explore',
      model: null,
      status: 'running',
      startedAt: at(400),
      endedAt: null,
      lastTime: null,
      toolCalls: 0,
    }])
  })

  it('folds a child transcript into counters even when nothing bound it', () => {
    const parser = createKimiParser()
    for (const item of twoStepFixture()) parser.push(item, MAIN)
    for (const item of [
      stepBegin(3_000, '0', 1, CHILD_ID),
      toolCall(3_100, '0', 1, 'child-call-1', 'Read', { path: '/tmp/a.ts' }, CHILD_ID),
      toolResult(3_200, 'child-call-1', { output: 'export const a = 1' }, CHILD_ID),
      toolCall(3_300, '0', 1, 'child-call-2', 'Write', { path: '/tmp/b.ts', content: 'hello\n' }, CHILD_ID),
      toolResult(3_400, 'child-call-2', { output: 'written' }, CHILD_ID),
      appendMessage(3_500, 'child prompt', { kind: 'user' }),
    ]) parser.push(item, CHILD)
    expect(parser.subagents()).toEqual([{
      agentId: CHILD_ID,
      fileId: CHILD_ID,
      callId: null,
      description: null,
      agentType: null,
      model: null,
      status: 'running',
      startedAt: at(3_000),
      endedAt: null,
      lastTime: at(3_500),
      toolCalls: 2,
    }])
    // Unbound child records never reach the parent ledger.
    expect(toolResults(parser).map(result => result.callId)).toEqual(['call-1'])
    expect(parser.meta().promptCount).toBe(1)
  })

  it('records a compaction as a summary node and a compaction request', () => {
    const parser = feed([
      ...twoStepFixture(),
      line('context.apply_compaction', {
        summary: 'Earlier context summarized.',
        compactedCount: 12,
        tokensBefore: 5_000,
        tokensAfter: 800,
        summaryOutputTokens: 120,
        keptUserMessageCount: 2,
        wireLines: { start: 1, end: 16 },
      }, 3_000),
      appendMessage(3_010, 'Earlier context summarized.', { kind: 'compaction_summary' }),
    ])
    const compaction = parser.snapshot().eventNodes.find(node => node.kind === 'compaction')
    expect(compaction).toMatchObject({
      kind: 'compaction',
      time: at(3_000),
      summary: 'Earlier context summarized.',
      shadowedItemCount: 12,
      shadowedTokenCount: 5_000,
    })
    expect(parser.snapshot().requests.find(item => item.purpose === 'compaction')).toMatchObject({
      purpose: 'compaction',
      status: 'complete',
      turn: 1,
      summary: [{ type: 'text', text: 'Earlier context summarized.' }],
    })
  })

  it('reads a legacy message-shaped compaction summary', () => {
    const parser = feed([
      ...twoStepFixture(),
      line('context.apply_compaction', {
        summary: { role: 'user', content: [{ type: 'text', text: 'Legacy summary.' }] },
        count: 3,
      }, 3_000),
    ])
    expect(parser.snapshot().eventNodes.find(node => node.kind === 'compaction')).toMatchObject({
      summary: 'Legacy summary.',
      shadowedItemCount: 3,
      shadowedTokenCount: null,
    })
  })

  it('closes an interrupted step without usage', () => {
    const parser = feed([
      metadata(),
      profileBind(10),
      turnPrompt(100, 'run something long'),
      appendMessage(110, 'run something long', { kind: 'user' }),
      stepBegin(200, '0', 1),
      llmRequest(210, '0.1'),
      textPart(300, '0', 1, 'Starting…'),
      line('turn.step.interrupted', { reason: 'aborted', step: 1, turnId: 0 }, 400),
      line('turn.ended', { durationMs: 400, reason: 'cancelled', turnId: 0 }, 410),
    ])
    const [assistant] = assistants(parser)
    expect(assistant?.interrupted).toBe(true)
    expect(assistant?.usage).toBeUndefined()
    const request = parser.snapshot().requests.find(item => item.startSeq === assistant?.seq)
    expect(request?.status).toBe('error')
    expect(request?.error).toBe('Step interrupted')
    expect(parser.snapshot().partial).toBeNull()
  })

  it('treats an aborted step.end as interrupted and keeps its blocks', () => {
    const parser = feed([
      metadata(),
      profileBind(10),
      turnPrompt(100, 'go'),
      appendMessage(110, 'go', { kind: 'user' }),
      stepBegin(200, '0', 1),
      textPart(300, '0', 1, 'Partial answ'),
      // An interrupted step.end carries no usage and no timings.
      loop(400, { type: 'step.end', finishReason: 'aborted', step: 1, turnId: '0' }),
    ])
    const [assistant] = assistants(parser)
    expect(assistant?.interrupted).toBe(true)
    expect(assistant?.usage).toBeUndefined()
    expect(assistant?.blocks).toEqual([{ kind: 'text', text: 'Partial answ' }])
    expect(parser.snapshot().requests[0]?.errorCode).toBe('aborted')
  })

  it('opens a step for an llm.request whose step.begin was lost', () => {
    const parser = feed([
      metadata(),
      profileBind(10),
      appendMessage(110, 'hello', { kind: 'user' }),
      llmRequest(200, '2.3'),
      textPart(300, '2', 3, 'hi'),
      stepEnd(310, '2', 3, { usage: usage(5, 0, 0, 1) }),
    ])
    expect(assistants(parser).map(node => [node.turn, node.step])).toEqual([[3, 3]])
  })

  it('ignores blank, malformed, and truncated lines', () => {
    const parser = feed(twoStepFixture())
    parser.push('', MAIN)
    parser.push('   ', MAIN)
    parser.push('{"type":"context.append_loop_event","time":1767225600000,"event":{"type":"cont', MAIN)
    parser.push('not json at all', MAIN)
    parser.push(JSON.stringify({ time: at(2_500) }), MAIN)
    parser.push(JSON.stringify({ type: 'context.append_loop_event', time: at(2_600) }), MAIN)
    parser.push(JSON.stringify({ type: 'context.append_message', time: at(2_700), message: 'oops' }), MAIN)
    const before = parser.snapshot()
    expect(assistants(parser)).toHaveLength(2)
    parser.push(stepBegin(3_000, '1', 1), MAIN)
    parser.push(textPart(3_100, '1', 1, 'late'), MAIN)
    expect(parser.snapshot()).not.toBe(before)
    expect(parser.snapshot().partial?.blocks).toEqual([{ kind: 'text', text: 'late' }])
  })
})

describe('kimiMessageClass', () => {
  it('treats a missing or user origin as a person', () => {
    expect(kimiMessageClass(undefined)).toEqual({ kind: 'human' })
    expect(kimiMessageClass(null)).toEqual({ kind: 'human' })
    expect(kimiMessageClass({})).toEqual({ kind: 'human' })
    expect(kimiMessageClass({ kind: 'user' })).toEqual({ kind: 'human' })
  })

  it('names every injected origin kind', () => {
    expect(kimiMessageClass({ kind: 'injection', variant: 'interruption' }))
      .toEqual({ kind: 'injection', name: 'interruption' })
    expect(kimiMessageClass({ kind: 'injection' })).toEqual({ kind: 'injection', name: 'injection' })
    expect(kimiMessageClass({ kind: 'task', taskId: 'task-1', status: 'completed' }))
      .toEqual({ kind: 'task', name: 'task-notification' })
    expect(kimiMessageClass({ kind: 'skill_activation', skillName: 'code-review' }))
      .toEqual({ kind: 'skill', name: 'code-review' })
    expect(kimiMessageClass({ kind: 'skill_activation' })).toEqual({ kind: 'skill', name: 'skill' })
    expect(kimiMessageClass({ kind: 'plugin_command' })).toEqual({ kind: 'plugin', name: 'plugin-command' })
    expect(kimiMessageClass({ kind: 'compaction_summary' })).toEqual({ kind: 'compaction', name: 'compaction' })
  })

  it('keeps an unknown origin out of the human bucket', () => {
    expect(kimiMessageClass({ kind: 'future_kind' })).toEqual({ kind: 'injection', name: 'future_kind' })
  })
})
