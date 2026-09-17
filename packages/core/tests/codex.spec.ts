import { describe, expect, it } from 'vitest'
import { codexHumanPromptText, codexUserItems, createCodexParser, isCodexHumanPrompt } from '../src/adapters/codex.ts'
import type { SessionFileRef } from '../src/session.ts'
import type { AssistantMessageNode, ToolResultNode } from '../src/contract.ts'

const MAIN: SessionFileRef = { id: 'thread-main', role: 'main', path: '/tmp/rollout-main.jsonl' }
const CHILD: SessionFileRef = { id: 'thread-child', role: 'child', path: '/tmp/rollout-child.jsonl', parentId: 'thread-main' }

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString()
}

function line(type: string, payload: unknown, offsetMs: number): string {
  return JSON.stringify({ timestamp: at(offsetMs), type, payload })
}

const sessionMeta = (offset: number, extra: Record<string, unknown> = {}) => line('session_meta', {
  id: 'thread-main',
  timestamp: at(offset),
  cwd: '/work/project',
  originator: 'codex-tui',
  cli_version: '0.153.0',
  source: 'cli',
  thread_source: 'user',
  model_provider: 'openai',
  base_instructions: { text: 'You are a test agent.' },
  ...extra,
}, offset)

const turnContext = (offset: number, turnId: string) => line('turn_context', {
  turn_id: turnId,
  cwd: '/work/project',
  model: 'gpt-test-1',
  effort: 'medium',
  approval_policy: 'never',
}, offset)

const taskStarted = (offset: number, turnId: string) => line('event_msg', {
  type: 'task_started', turn_id: turnId, started_at: Math.floor((T0 + offset) / 1000),
}, offset)

const taskComplete = (offset: number, turnId: string, last: string) => line('event_msg', {
  type: 'task_complete', turn_id: turnId, last_agent_message: last,
}, offset)

const userMessage = (offset: number, text: string) => line('response_item', {
  type: 'message', id: `msg-u-${offset}`, role: 'user', content: [{ type: 'input_text', text }],
}, offset)

const developerMessage = (offset: number, text: string) => line('response_item', {
  type: 'message', id: `msg-d-${offset}`, role: 'developer', content: [{ type: 'input_text', text }],
}, offset)

const assistantMessage = (offset: number, text: string) => line('response_item', {
  type: 'message', id: `msg-a-${offset}`, role: 'assistant', content: [{ type: 'output_text', text }],
}, offset)

const reasoning = (offset: number, ...summaries: string[]) => line('response_item', {
  type: 'reasoning',
  id: `rs-${offset}`,
  summary: summaries.map(text => ({ type: 'summary_text', text })),
  encrypted_content: 'opaque',
}, offset)

const customToolCall = (offset: number, callId: string, input: string) => line('response_item', {
  type: 'custom_tool_call', id: `ctc-${offset}`, call_id: callId, name: 'exec', input, status: 'completed',
}, offset)

const customToolOutput = (offset: number, callId: string, text: string) => line('response_item', {
  type: 'custom_tool_call_output', id: `ctco-${offset}`, call_id: callId,
  output: [{ type: 'input_text', text }],
}, offset)

const functionCall = (offset: number, callId: string, name: string, args: string) => line('response_item', {
  type: 'function_call', id: `fc-${offset}`, call_id: callId, name, arguments: args,
}, offset)

const functionOutput = (offset: number, callId: string, output: string) => line('response_item', {
  type: 'function_call_output', id: `fco-${offset}`, call_id: callId, output,
}, offset)

const usageRecord = (offset: number, turnId: string, usage: Record<string, number>) => line('token_usage_record', {
  thread_id: 'thread-main', turn_id: turnId, response_id: `resp-${offset}`, usage,
}, offset)

function feed(lines: readonly string[], file: SessionFileRef = MAIN) {
  const parser = createCodexParser()
  for (const item of lines) parser.push(item, file)
  return parser
}

function assistants(parser: ReturnType<typeof createCodexParser>): AssistantMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is AssistantMessageNode => node.kind === 'assistant')
}

function toolResults(parser: ReturnType<typeof createCodexParser>): ToolResultNode[] {
  return parser.snapshot().eventNodes.filter((node): node is ToolResultNode => node.kind === 'tool-result')
}

/** Two turns; the first loops through two tool calls before answering. */
function twoTurnFixture(): string[] {
  return [
    sessionMeta(0),
    taskStarted(1_000, 'turn-1'),
    developerMessage(1_100, '<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>'),
    userMessage(1_200, '<environment_context>\n  <cwd>/work/project</cwd>\n</environment_context>'),
    turnContext(1_300, 'turn-1'),
    userMessage(2_000, 'Please list the files'),
    reasoning(3_000, '**Planning**', 'Look at the tree'),
    customToolCall(3_500, 'call-1', 'ls -la'),
    usageRecord(3_600, 'turn-1', {
      input_tokens: 1_000, cached_input_tokens: 600, cache_write_input_tokens: 50,
      output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 1_040,
    }),
    customToolOutput(5_000, 'call-1', 'a.ts\nb.ts'),
    functionCall(6_000, 'call-2', 'read_file', '{"path":"a.ts"}'),
    usageRecord(6_100, 'turn-1', {
      input_tokens: 1_200, cached_input_tokens: 1_000, cache_write_input_tokens: 0,
      output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 1_220,
    }),
    functionOutput(7_000, 'call-2', 'export const a = 1'),
    reasoning(8_000, 'Summarizing'),
    assistantMessage(8_500, 'There are two files.'),
    usageRecord(8_600, 'turn-1', {
      input_tokens: 1_300, cached_input_tokens: 1_200, cache_write_input_tokens: 0,
      output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 1_330,
    }),
    taskComplete(9_000, 'turn-1', 'There are two files.'),
    taskStarted(20_000, 'turn-2'),
    turnContext(20_100, 'turn-2'),
    userMessage(21_000, 'Thanks, now delete b.ts'),
    assistantMessage(22_000, 'Done.'),
    taskComplete(23_000, 'turn-2', 'Done.'),
  ]
}

describe('codex adapter', () => {
  it('numbers turns and steps across task boundaries and tool loops', () => {
    const parser = feed(twoTurnFixture())
    const nodes = assistants(parser)
    expect(nodes.map(node => [node.turn, node.step])).toEqual([[1, 1], [1, 2], [1, 3], [2, 1]])
    const users = parser.snapshot().eventNodes.filter(node => node.kind === 'user')
    expect(users).toHaveLength(2)
    expect(parser.snapshot().partial).toBeNull()
    expect(parser.snapshot().runningCalls).toEqual([])
    // Every request view pairs with its assistant node.
    const requests = parser.snapshot().requests.filter(request => request.purpose === 'assistant')
    expect(requests.map(request => [request.turn, request.step, request.status]))
      .toEqual([[1, 1, 'complete'], [1, 2, 'complete'], [1, 3, 'complete'], [2, 1, 'complete']])
    expect(requests.every(request => request.resultSeq === request.startSeq)).toBe(true)
  })

  it('keeps reasoning, text, and tool-call blocks in model order', () => {
    const parser = feed(twoTurnFixture())
    const [first, , third] = assistants(parser)
    expect(first?.blocks).toEqual([
      { kind: 'reasoning', text: '**Planning**\n\nLook at the tree' },
      { kind: 'tool-call', callId: 'call-1', name: 'exec', argsRaw: 'ls -la' },
    ])
    expect(third?.blocks).toEqual([
      { kind: 'reasoning', text: 'Summarizing' },
      { kind: 'text', text: 'There are two files.' },
    ])
    expect(first?.timing).toEqual({ stepStartTime: T0 + 2_000, firstTokenTime: T0 + 3_000, completedTime: T0 + 3_500 })
    expect(first?.time).toBe(T0 + 3_500)
  })

  it('maps token_usage_record onto the open step with disjoint input counts', () => {
    const parser = feed(twoTurnFixture())
    const [first] = assistants(parser)
    expect(first?.usage).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      totalTokens: 1_040,
      cacheReadTokens: 600,
      cacheWriteTokens: 50,
      reasoningTokens: 10,
    })
    const request = parser.snapshot().requests.find(item => item.startSeq === first?.seq)
    expect(request?.usage).toEqual(first?.usage)
    expect(request?.provenance).toEqual({ provider: 'openai', model: 'gpt-test-1' })
    expect(request?.requestConfig).toEqual({ provider: 'openai', model: 'gpt-test-1', reasoningEffort: 'medium' })
  })

  it('exposes an open step as partial output with its running call', () => {
    // Stop before the `token_usage_record`: it marks the response complete, so
    // the step is only "open" while the response is still streaming.
    const lines = twoTurnFixture().slice(0, 8)
    const parser = feed(lines)
    const snapshot = parser.snapshot()
    expect(snapshot.partial).toEqual({
      turn: 1,
      step: 1,
      blocks: [
        { kind: 'reasoning', text: '**Planning**\n\nLook at the tree' },
        { kind: 'tool-call', callId: 'call-1', name: 'exec', argsRaw: 'ls -la' },
      ],
    })
    expect(assistants(parser)).toHaveLength(0)
    expect(snapshot.runningCalls.map(call => call.callId)).toEqual(['call-1'])
    // The snapshot object is stable until another line arrives.
    expect(parser.snapshot()).toBe(snapshot)
    parser.push(customToolOutput(5_000, 'call-1', 'a.ts'), MAIN)
    expect(parser.snapshot()).not.toBe(snapshot)
    expect(parser.snapshot().partial).toBeNull()
    expect(parser.snapshot().runningCalls).toEqual([])
  })

  it('pairs custom and function tool outputs with their calls', () => {
    const parser = feed(twoTurnFixture())
    const results = toolResults(parser)
    expect(results.map(result => result.callId)).toEqual(['call-1', 'call-2'])
    const [first, second] = results
    expect(first?.call).toEqual({ name: 'exec', argsRaw: 'ls -la' })
    expect(first?.callTime).toBe(T0 + 3_500)
    expect(first?.time).toBe(T0 + 5_000)
    expect(first?.content).toEqual([{ type: 'text', text: 'a.ts\nb.ts' }])
    expect(first?.isError).toBe(false)
    expect(second?.call).toEqual({ name: 'read_file', argsRaw: '{"path":"a.ts"}' })
    expect(second?.content).toEqual([{ type: 'text', text: 'export const a = 1' }])
    // Results follow the assistant node that emitted the call.
    const [assistant] = assistants(parser)
    expect(first?.seq).toBeGreaterThan(assistant?.seq ?? Infinity)
  })

  it('flags failed outputs conservatively', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'run it'),
      customToolCall(3_000, 'call-x', 'boom'),
      line('response_item', {
        type: 'custom_tool_call_output', call_id: 'call-x', status: 'failed',
        output: 'Script failed: exit 1',
      }, 4_000),
      customToolCall(5_000, 'call-y', 'fine'),
      customToolOutput(6_000, 'call-y', 'The word error appears mid-sentence'),
    ])
    expect(toolResults(parser).map(result => result.isError)).toEqual([true, false])
  })

  it('attaches the base instructions to the first request as the initial prompt', () => {
    const parser = feed(twoTurnFixture())
    const requests = parser.snapshot().requests.filter(request => request.purpose === 'assistant')
    const [first, second] = requests
    expect(first?.prompt).toEqual({
      config: { provider: 'openai', model: 'gpt-test-1', reasoningEffort: 'medium' },
      system: 'You are a test agent.',
      tools: [],
    })
    expect(first?.promptChange).toEqual({ seq: 1, time: T0, kind: 'initial' })
    expect(second?.prompt).toBeUndefined()
    expect(parser.snapshot().systemPrompts).toBeUndefined()
  })

  it('treats developer and tagged user messages as context, not prompts', () => {
    const parser = feed(twoTurnFixture())
    const contexts = parser.snapshot().eventNodes.filter(node => node.kind === 'context')
    expect(contexts.map(node => node.kind === 'context' ? [node.provenance.label, node.form] : null))
      .toEqual([['developer', 'instructions'], ['environment-context', 'snapshot']])
    expect(parser.meta().promptCount).toBe(2)
  })

  it('records compaction as a summary node and a compaction request', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'hello'),
      assistantMessage(3_000, 'hi'),
      taskComplete(4_000, 'turn-1', 'hi'),
      line('compacted', { message: 'Earlier context summarized.', replacement_history: [] }, 5_000),
      taskStarted(6_000, 'turn-2'),
      userMessage(7_000, 'continue'),
      assistantMessage(8_000, 'sure'),
      taskComplete(9_000, 'turn-2', 'sure'),
    ])
    const compaction = parser.snapshot().eventNodes.find(node => node.kind === 'compaction')
    expect(compaction).toMatchObject({ kind: 'compaction', summary: 'Earlier context summarized.', time: T0 + 5_000 })
    const request = parser.snapshot().requests.find(item => item.purpose === 'compaction')
    expect(request).toMatchObject({
      purpose: 'compaction',
      status: 'complete',
      turn: 1,
      summary: [{ type: 'text', text: 'Earlier context summarized.' }],
    })
    expect(assistants(parser).map(node => node.turn)).toEqual([1, 2])
  })

  it('attributes a usage-only response to the compaction it belongs to', () => {
    // Remote compaction runs its own usage-only response: a `token_usage_record`
    // with no open step must not overwrite the previous request's usage; the
    // `compacted` record claims it through `compaction_response_id`.
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'go'),
      assistantMessage(3_000, 'working'),
      usageRecord(4_000, 'turn-1', { input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
      taskComplete(5_000, 'turn-1', 'working'),
      line('token_usage_record', {
        thread_id: 'thread-main', turn_id: 'turn-1', response_id: 'resp-compact-1',
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }, 6_000),
      line('compacted', {
        message: '', compaction_response_id: 'resp-compact-1', replacement_history: [],
      }, 7_000),
    ])
    const requests = parser.snapshot().requests
    const normal = requests.find(item => item.purpose === 'assistant')
    const compaction = requests.find(item => item.purpose === 'compaction')
    expect(normal?.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    expect(compaction?.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })
  })

  it('keeps each request\'s usage when a stray usage-only record arrives', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'go'),
      assistantMessage(3_000, 'working'),
      usageRecord(4_000, 'turn-1', { input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
      taskComplete(5_000, 'turn-1', 'working'),
      // Unclaimed by any `compacted` record: buffered, never booked.
      line('token_usage_record', {
        thread_id: 'thread-main', turn_id: 'turn-1', response_id: 'resp-stray',
        usage: { input_tokens: 999, output_tokens: 999, total_tokens: 1_998 },
      }, 6_000),
    ])
    const requests = parser.snapshot().requests
    expect(requests.find(item => item.purpose === 'assistant')?.usage)
      .toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    expect(requests.find(item => item.purpose === 'compaction')).toBeUndefined()
  })

  it('nests a child thread under a synthetic subagent call', () => {
    const parser = createCodexParser()
    const main = [
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'review my change'),
      reasoning(3_000, 'Ask the guardian'),
      assistantMessage(3_500, 'Reviewing…'),
    ]
    for (const item of main) parser.push(item, MAIN)
    const child = [
      line('session_meta', {
        id: 'thread-child',
        timestamp: at(4_000),
        cwd: '/work/project',
        thread_source: 'subagent',
        parent_thread_id: 'thread-main',
        source: { subagent: { other: 'guardian' } },
        model_provider: 'openai',
      }, 4_000),
      taskStarted(4_100, 'child-turn'),
      userMessage(4_200, 'Review the diff'),
      customToolCall(4_500, 'child-call-1', 'git diff'),
      customToolOutput(5_000, 'child-call-1', '+++ change'),
      assistantMessage(5_500, 'Looks safe.'),
      taskComplete(6_000, 'child-turn', 'Looks safe.'),
    ]
    for (const item of child) parser.push(item, CHILD)
    parser.push(assistantMessage(7_000, 'The guardian approved.'), MAIN)
    parser.push(taskComplete(8_000, 'turn-1', 'The guardian approved.'), MAIN)

    const snapshot = parser.snapshot()
    const results = toolResults(parser)
    expect(results).toHaveLength(1)
    const [subagent] = results
    expect(subagent?.callId).toBe('subagent:thread-child')
    expect(subagent?.call?.name).toBe('subagent:guardian')
    expect(JSON.parse(subagent?.call?.argsRaw ?? '{}')).toEqual({ threadId: 'thread-child', source: 'guardian' })
    expect(subagent?.content).toEqual([{ type: 'text', text: 'Looks safe.' }])
    expect(subagent?.subCalls).toHaveLength(1)
    const [nested] = subagent?.subCalls ?? []
    expect(nested).toMatchObject({
      kind: 'tool-result',
      callId: 'child-call-1',
      parentCallId: 'subagent:thread-child',
      call: { name: 'exec', argsRaw: 'git diff' },
      content: [{ type: 'text', text: '+++ change' }],
    })
    // Child assistant text never becomes a node of the parent ledger; the
    // synthetic call is attached to the assistant step that was open when the
    // child started, so the ledger nests the thread under it.
    expect(assistants(parser).map(node => node.blocks.at(-1)))
      .toEqual([{
        kind: 'tool-call',
        callId: 'subagent:thread-child',
        name: 'subagent:guardian',
        argsRaw: JSON.stringify({ threadId: 'thread-child', source: 'guardian' }),
      }, { kind: 'text', text: 'The guardian approved.' }])
    expect(snapshot.runningCalls).toEqual([])
  })

  it('reopens a child thread when records follow its task_complete', () => {
    const parser = createCodexParser()
    parser.push(sessionMeta(0), MAIN)
    parser.push(taskStarted(1_000, 'turn-1'), MAIN)
    parser.push(userMessage(2_000, 'go'), MAIN)
    const childMeta = line('session_meta', {
      id: 'thread-child', thread_source: 'subagent', parent_thread_id: 'thread-main',
      source: { subagent: { other: 'guardian' } },
    }, 3_000)
    for (const item of [
      childMeta,
      taskStarted(3_100, 'child-turn-1'),
      assistantMessage(3_500, 'first answer'),
      taskComplete(4_000, 'child-turn-1', 'first answer'),
      // Codex resumes an existing agent with new input (core/agent/control.rs):
      // the run boundary is not the thread's end.
      taskStarted(5_000, 'child-turn-2'),
      customToolCall(5_500, 'child-call-2', 'ls -la'),
      customToolOutput(6_000, 'child-call-2', 'a.ts'),
      assistantMessage(6_500, 'second answer'),
      taskComplete(7_000, 'child-turn-2', 'second answer'),
    ]) parser.push(item, CHILD)

    const results = toolResults(parser)
    expect(results.map(result => result.callId))
      .toEqual(['subagent:thread-child', 'subagent:thread-child#2'])
    expect(results[0]?.content).toEqual([{ type: 'text', text: 'first answer' }])
    expect(results[1]?.content).toEqual([{ type: 'text', text: 'second answer' }])
    expect(results[1]?.subCalls.map(call => call.callId)).toEqual(['child-call-2'])
    const [run] = parser.subagents()
    expect(run).toMatchObject({ agentId: 'thread-child', status: 'completed', toolCalls: 1 })
  })

  it('excludes a child\'s inherited parent history below subagent_history_start_ordinal', () => {
    const parser = createCodexParser()
    parser.push(sessionMeta(0), MAIN)
    const childMeta = JSON.stringify({
      timestamp: at(0), ordinal: 0, type: 'session_meta',
      payload: {
        id: 'thread-child', thread_source: 'subagent', parent_thread_id: 'thread-main',
        source: { subagent: { other: 'guardian' } },
        subagent_history_start_ordinal: '3',
      },
    })
    const atOrdinal = (record: string, ordinal: number): string => {
      const parsed = JSON.parse(record) as Record<string, unknown>
      parsed['ordinal'] = ordinal
      return JSON.stringify(parsed)
    }
    for (const item of [
      childMeta,
      // Inherited parent records (materialized for the model, not the child's own activity):
      atOrdinal(userMessage(0, 'the parent prompt'), 1),
      atOrdinal(customToolCall(0, 'inherited-call', 'ls'), 2),
      // The child's own records start at the boundary:
      atOrdinal(customToolCall(1_000, 'own-call', 'git diff'), 3),
      atOrdinal(assistantMessage(2_000, 'own answer'), 4),
    ]) parser.push(item, CHILD)

    const [run] = parser.subagents()
    expect(run?.toolCalls).toBe(1)
    const calls = parser.snapshot().runningCalls
    expect(calls.map(call => call.callId)).toEqual(['subagent:thread-child'])
    expect(calls[0]?.subCalls.map(call => call.callId)).toEqual(['own-call'])
  })

  it('applies the ref\'s historyStartOrdinal when a child transcript is opened standalone', () => {
    // Served as a main file, the boundary still separates the parent's
    // materialized history from the child's own activity — and because the ref
    // carries it, inherited records replayed BEFORE the head's `session_meta`
    // (lineage bases come first) are skipped too.
    const ref: SessionFileRef = {
      id: 'thread-child', role: 'main', path: '/tmp/rollout-child.jsonl',
      historyStartOrdinal: 10,
    }
    const parser = createCodexParser()
    const atOrdinal = (record: string, ordinal: number): string => {
      const parsed = JSON.parse(record) as Record<string, unknown>
      parsed['ordinal'] = ordinal
      return JSON.stringify(parsed)
    }
    parser.push(atOrdinal(userMessage(0, 'inherited prompt'), 1), ref)
    parser.push(atOrdinal(line('session_meta', {
      id: 'thread-child', thread_source: 'subagent', parent_thread_id: 'thread-main',
      subagent_history_start_ordinal: '10',
    }, 0), 0), ref)
    parser.push(atOrdinal(userMessage(1_000, 'own prompt'), 11), ref)
    expect(parser.meta().promptCount).toBe(1)
    expect(parser.meta().title).toBe('own prompt')
  })

  it('uses child ownership before lineage bases replay in the parent view', () => {
    const parser = createCodexParser()
    const ref = { ...CHILD, historyStartOrdinal: 10 }
    const ordinal = (record: string, value: number) => JSON.stringify({ ...JSON.parse(record), ordinal: value })
    parser.push(ordinal(sessionMeta(0), 0), ref)
    parser.push(ordinal(customToolCall(1, 'parent-call', 'ls'), 1), ref)
    expect(parser.subagents()).toHaveLength(0)
    parser.push(ordinal(line('session_meta', { id: CHILD.id, subagent_history_start_ordinal: 10 }, 2), 9), ref)
    parser.push(ordinal(customToolCall(3, 'own-call', 'pwd'), 10), ref)
    expect(parser.subagents()).toMatchObject([{ agentId: CHILD.id, toolCalls: 1 }])
  })

  it('keeps a completed child completed when late bookkeeping records arrive', () => {
    const parser = createCodexParser()
    parser.push(sessionMeta(0), MAIN)
    parser.push(line('session_meta', {
      id: 'thread-child', thread_source: 'subagent', parent_thread_id: 'thread-main',
      source: { subagent: { other: 'guardian' } },
    }, 500), CHILD)
    parser.push(taskStarted(1_000, 'child-turn-1'), CHILD)
    parser.push(customToolCall(1_500, 'child-call-1', 'ls'), CHILD)
    parser.push(taskComplete(2_000, 'child-turn-1', 'done'), CHILD)
    // Stats and status records after `task_complete` update the finished run —
    // they must not resurrect it as `subagent:thread-child#2`.
    parser.push(line('event_msg', {
      type: 'token_count', turn_id: 'child-turn-1',
      info: { total_token_usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
    }, 2_500), CHILD)
    parser.push(line('token_usage_record', {
      thread_id: 'thread-child', turn_id: 'child-turn-1', response_id: 'resp-c1',
      usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
    }, 2_600), CHILD)
    const [run] = parser.subagents()
    expect(run).toMatchObject({ callId: 'subagent:thread-child', status: 'completed', toolCalls: 1 })
    // Only a genuinely new turn reopens the run.
    parser.push(taskStarted(3_000, 'child-turn-2'), CHILD)
    const [resumed] = parser.subagents()
    expect(resumed).toMatchObject({ callId: 'subagent:thread-child#2', status: 'running' })
  })

  it('shows a child thread as running until it completes', () => {
    const parser = createCodexParser()
    parser.push(sessionMeta(0), MAIN)
    parser.push(taskStarted(1_000, 'turn-1'), MAIN)
    parser.push(userMessage(2_000, 'go'), MAIN)
    parser.push(line('session_meta', {
      id: 'thread-child', thread_source: 'subagent', parent_thread_id: 'thread-main',
      source: { subagent: { other: 'guardian' } },
    }, 3_000), CHILD)
    parser.push(customToolCall(3_500, 'child-call-1', 'ls'), CHILD)
    const running = parser.snapshot().runningCalls
    expect(running.map(call => call.callId)).toEqual(['subagent:thread-child'])
    expect(running[0]?.subCalls.map(call => call.callId)).toEqual(['child-call-1'])
  })

  it('keeps mid-turn steering input in the same turn', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'start the work'),
      reasoning(3_000, 'Working'),
      // Steering: Codex accepts user input while the turn runs; the turn's
      // `task_complete` has not been written yet (core/session/turn.rs).
      userMessage(3_500, 'also check the tests'),
      reasoning(4_000, 'Adjusting'),
      assistantMessage(4_500, 'Done both.'),
      usageRecord(5_000, 'turn-1', { input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
      taskComplete(6_000, 'turn-1', 'Done both.'),
    ])
    const snapshot = parser.snapshot()
    const users = snapshot.eventNodes.filter(node => node.kind === 'user')
    expect(users).toHaveLength(2)
    // Both responses stay in turn 1: the steering input opened a new STEP, not a turn.
    expect(assistants(parser).map(node => [node.turn, node.step])).toEqual([[1, 1], [1, 2]])
    expect(parser.meta().promptCount).toBe(2)
    for (const user of users) {
      expect(snapshot.eventLocations.get(user.seq))
        .toEqual({ kind: 'turn', turn: { turn: 1, status: 'closed' } })
    }
  })

  it('joins a turn its turn_id names even without task_started', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'first'),
      assistantMessage(3_000, 'one'),
      taskComplete(4_000, 'turn-1', 'one'),
      // A resumed file can lose the event but still annotate the record.
      line('response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-2' },
      }, 5_000),
      assistantMessage(6_000, 'two'),
      taskComplete(7_000, 'turn-2', 'two'),
    ])
    const users = parser.snapshot().eventNodes.filter(node => node.kind === 'user')
    expect(users).toHaveLength(2)
    expect(parser.snapshot().eventLocations.get(users[1]?.seq ?? -1))
      .toEqual({ kind: 'turn', turn: { turn: 2, status: 'closed' } })
    expect(assistants(parser).map(node => node.turn)).toEqual([1, 2])
  })

  it('settles each model response at its token_usage_record', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'go'),
      assistantMessage(3_000, 'part one'),
      usageRecord(3_500, 'turn-1', { input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
      // `end_turn=false`: the turn continues with a second response — it must
      // not fold into the first step or overwrite its usage.
      assistantMessage(4_000, 'part two'),
      usageRecord(4_500, 'turn-1', { input_tokens: 20, output_tokens: 3, total_tokens: 23 }),
      taskComplete(5_000, 'turn-1', 'part two'),
    ])
    const nodes = assistants(parser)
    expect(nodes.map(node => [node.turn, node.step])).toEqual([[1, 1], [1, 2]])
    expect(nodes[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    expect(nodes[1]?.usage).toEqual({ inputTokens: 20, outputTokens: 3, totalTokens: 23 })
  })

  it('marks an aborted turn as an error', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'do something long'),
      reasoning(3_000, 'Working'),
      customToolCall(3_500, 'call-1', 'sleep 100'),
      line('event_msg', { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' }, 4_000),
    ])
    const snapshot = parser.snapshot()
    const [assistant] = assistants(parser)
    expect(assistant?.interrupted).toBe(true)
    const request = snapshot.requests.find(item => item.startSeq === assistant?.seq)
    expect(request?.status).toBe('error')
    expect(request?.error).toBe('Turn aborted (interrupted)')
    const error = snapshot.eventNodes.find(node => node.kind === 'turn-error')
    expect(error).toMatchObject({ kind: 'turn-error', turn: 1, message: 'Turn aborted (interrupted)', code: 'turn_aborted' })
    expect(snapshot.partial).toBeNull()
    // The call never received an output, so it stays visible as running.
    expect(snapshot.runningCalls.map(call => call.callId)).toEqual(['call-1'])
    const location = snapshot.eventLocations.get(assistant?.seq ?? -1)
    expect(location).toEqual({ kind: 'turn', turn: { turn: 1, status: 'closed' } })
  })

  it('falls back to token_count when no usage record covers the last step', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'hi'),
      assistantMessage(3_000, 'hello'),
      taskComplete(4_000, 'turn-1', 'hello'),
      line('event_msg', {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3, total_tokens: 13 } },
      }, 4_100),
    ])
    const [assistant] = assistants(parser)
    expect(assistant?.usage).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 0 })
  })

  it('extracts inline images from user messages and resolves them', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      line('response_item', {
        type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'What is this?' },
          { type: 'input_image', detail: 'high', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      }, 2_000),
    ])
    const user = parser.snapshot().eventNodes.find(node => node.kind === 'user')
    expect(user?.kind).toBe('user')
    const image = user?.kind === 'user' ? user.content.find(block => block.type === 'image') : undefined
    expect(image?.type).toBe('image')
    if (image?.type !== 'image') throw new Error('expected an image block')
    expect(image.attachment.mediaType).toBe('image/png')
    expect(parser.imageUrl(image.attachment)).toBe('data:image/png;base64,aGVsbG8=')
    expect([...parser.images.keys()]).toEqual([image.attachment.attachmentId])
  })

  it('reports session metadata', () => {
    const parser = feed(twoTurnFixture())
    expect(parser.meta()).toEqual({
      title: 'Please list the files',
      cwd: '/work/project',
      model: 'gpt-test-1',
      startedAt: T0,
      promptCount: 2,
    })
    expect(parser.kind).toBe('codex')
  })

  it('treats an AGENTS.md instructions block as project instructions, not a prompt', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(1_100, '# AGENTS.md instructions for /work/project\n\n<INSTRUCTIONS>\nBe brief in this repo.\n</INSTRUCTIONS>'),
      userMessage(2_000, 'Please list the files'),
      assistantMessage(3_000, 'Two files.'),
      taskComplete(4_000, 'turn-1', 'Two files.'),
    ])
    const contexts = parser.snapshot().eventNodes.filter(node => node.kind === 'context')
    expect(contexts.map(node => node.kind === 'context' ? [node.provenance.label, node.form] : null))
      .toEqual([['agents-md', 'instructions']])
    expect(parser.meta().promptCount).toBe(1)
    expect(parser.meta().title).toBe('Please list the files')
  })

  it('ignores blank, malformed, and truncated lines', () => {
    const lines = twoTurnFixture()
    const parser = createCodexParser()
    for (const item of lines) parser.push(item, MAIN)
    parser.push('', MAIN)
    parser.push('   ', MAIN)
    parser.push('{"timestamp":"2026-01-01T00:00:30.000Z","type":"response_item","payload":{"type":"mess', MAIN)
    parser.push('not json at all', MAIN)
    const before = parser.snapshot()
    parser.push(assistantMessage(30_000, 'late'), MAIN)
    expect(parser.snapshot()).not.toBe(before)
    expect(assistants(parser)).toHaveLength(4)
    expect(parser.snapshot().partial?.blocks).toEqual([{ kind: 'text', text: 'late' }])
  })
})

describe('codex durable items', () => {
  const contexts = (parser: ReturnType<typeof createCodexParser>) =>
    parser.snapshot().eventNodes.filter(node => node.kind === 'context')

  it('settles a web_search_call on arrival (self-contained durable item)', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      turnContext(1_100, 'turn-1'),
      userMessage(2_000, 'search for it'),
      line('response_item', {
        type: 'web_search_call', id: 'ws-1', status: 'completed',
        action: { type: 'search', query: 'codex rollout format' },
      }, 3_000),
      usageRecord(3_500, 'turn-1', { input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
      assistantMessage(4_000, 'found it'),
      taskComplete(5_000, 'turn-1', 'found it'),
    ])
    const [step] = assistants(parser)
    expect(step?.blocks).toEqual([{
      kind: 'tool-call',
      callId: 'ws-1',
      name: 'web_search',
      argsRaw: '{"type":"search","query":"codex rollout format"}',
    }])
    const [result] = toolResults(parser)
    expect(result?.callId).toBe('ws-1')
    expect(result?.call?.name).toBe('web_search')
    expect(result?.isError).toBe(false)
    expect(result?.content).toEqual([])
    expect(parser.snapshot().runningCalls).toEqual([])
  })

  it('completes image_generation_call with its image result', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      turnContext(1_100, 'turn-1'),
      userMessage(2_000, 'draw a cat'),
      line('response_item', {
        type: 'image_generation_call', id: 'ig-1', status: 'completed',
        revised_prompt: 'a gray tabby', result: 'aW1hZ2U=',
      }, 3_000),
      taskComplete(5_000, 'turn-1', 'done'),
    ])
    const [result] = toolResults(parser)
    expect(result?.call?.name).toBe('image_generation')
    expect(result?.content[0]?.type).toBe('image')
    const attachment = result?.content[0]?.type === 'image' ? result.content[0].attachment : undefined
    expect(attachment).toBeDefined()
    expect(parser.imageUrl(attachment!)).toContain('data:image/png')
  })

  it('pairs tool_search_call with tool_search_output', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      turnContext(1_100, 'turn-1'),
      userMessage(2_000, 'find tools'),
      line('response_item', {
        type: 'tool_search_call', id: 'ts-1', call_id: 'call-ts', execution: 'client',
        arguments: { query: 'file tools' },
      }, 3_000),
      line('response_item', {
        type: 'tool_search_output', call_id: 'call-ts', status: 'completed', execution: 'client',
        tools: [{ type: 'function', name: 'read_file' }],
      }, 4_000),
      taskComplete(5_000, 'turn-1', 'done'),
    ])
    const [result] = toolResults(parser)
    expect(result?.callId).toBe('call-ts')
    expect(result?.call?.name).toBe('tool_search')
    expect(result?.content).toEqual([{ type: 'text', text: '[{"type":"function","name":"read_file"}]' }])
  })

  it('qualifies a namespaced function_call name', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      turnContext(1_100, 'turn-1'),
      userMessage(2_000, 'open it'),
      line('response_item', {
        type: 'function_call', id: 'fc-ns', call_id: 'call-ns',
        namespace: 'codex_app', name: 'open_in_codex', arguments: '{}',
      }, 3_000),
      functionOutput(4_000, 'call-ns', 'opened'),
      taskComplete(5_000, 'turn-1', 'done'),
    ])
    const [result] = toolResults(parser)
    expect(result?.call?.name).toBe('codex_app.open_in_codex')
  })

  it('renders agent_message as relay context, never a prompt', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      turnContext(1_100, 'turn-1'),
      userMessage(2_000, 'delegate'),
      line('response_item', {
        type: 'agent_message', id: 'am-1', author: '/child/explorer', recipient: '/root',
        content: [{ type: 'input_text', text: 'the file lives in src/x.ts' }],
      }, 3_000),
      assistantMessage(4_000, 'noted'),
      taskComplete(5_000, 'turn-1', 'noted'),
    ])
    expect(parser.meta().promptCount).toBe(1)
    const nodes = contexts(parser)
    const relay = nodes.find(node => node.kind === 'context' && node.provenance.label === 'agent-message')
    expect(relay).toBeDefined()
    expect(relay?.kind === 'context' ? relay.form : null).toBe('relay')
    expect(parser.snapshot().eventNodes.filter(node => node.kind === 'user')).toHaveLength(1)
  })

  it('renders top-level inter_agent_communication the same way', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'go'),
      line('inter_agent_communication', {
        author: '/root', recipient: '/child/w1', content: 'please inspect src/', trigger_turn: true,
      }, 3_000),
      taskComplete(5_000, 'turn-1', 'done'),
    ])
    const relay = contexts(parser).find(node => node.kind === 'context' && node.provenance.label === 'agent-message')
    expect(relay).toBeDefined()
    expect(parser.meta().promptCount).toBe(1)
  })

  it('applies configuration_update effort to later requests', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      turnContext(1_100, 'turn-1'),
      userMessage(2_000, 'go'),
      line('response_item', {
        type: 'configuration_update', reasoning: { effort: 'high' },
      }, 2_500),
      reasoning(3_000, 'thinking'),
      usageRecord(3_500, 'turn-1', { input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
      taskComplete(5_000, 'turn-1', 'done'),
    ])
    const [step] = assistants(parser)
    const request = parser.snapshot().requests.find(item => item.startSeq === step?.seq)
    expect(request?.requestConfig?.reasoningEffort).toBe('high')
    expect(contexts(parser).some(node => node.kind === 'context' && node.provenance.label === 'configuration-update')).toBe(true)
  })

  it('marks thread_rolled_back as a turn-error node', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      turnContext(1_100, 'turn-1'),
      userMessage(2_000, 'first'),
      assistantMessage(3_000, 'one'),
      taskComplete(4_000, 'turn-1', 'one'),
      line('event_msg', { type: 'thread_rolled_back', num_turns: 1 }, 5_000),
    ])
    const errors = parser.snapshot().eventNodes.filter(node => node.kind === 'turn-error')
    expect(errors.map(node => node.kind === 'turn-error' ? node.code : null)).toEqual(['thread_rolled_back'])
    expect(errors[0]?.kind === 'turn-error' ? errors[0].message : '').toBe('Rolled back 1 turn')
  })

  it('applies thread_settings_applied model to later requests', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      turnContext(1_100, 'turn-1'),
      userMessage(2_000, 'go'),
      line('event_msg', {
        type: 'thread_settings_applied', thread_id: 'thread-main',
        thread_settings: { model: 'gpt-other-2', model_provider_id: 'openai', reasoning_effort: 'low' },
      }, 2_500),
      reasoning(3_000, 'thinking'),
      usageRecord(3_500, 'turn-1', { input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
      taskComplete(5_000, 'turn-1', 'done'),
    ])
    const [step] = assistants(parser)
    const request = parser.snapshot().requests.find(item => item.startSeq === step?.seq)
    expect(request?.provenance?.model).toBe('gpt-other-2')
    expect(request?.requestConfig?.reasoningEffort).toBe('low')
    expect(parser.meta().model).toBe('gpt-other-2')
  })

  it('surfaces thread_goal_updated, world_state, and retained_context as context', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'go'),
      line('world_state', { full: true, state: { agents_md: { text: 'x' }, host_skills: { body: 'y' } } }, 2_200),
      line('event_msg', {
        type: 'thread_goal_updated', threadId: 'thread-main',
        goal: { threadId: 'thread-main', objective: 'build it in one hour', status: 'active' },
      }, 2_500),
      line('retained_context', {
        type: 'verified_answer', turn_id: 'turn-1', call_id: 'call-q',
        questions: [{ question: 'which db?', answer: 'sqlite' }],
      }, 2_700),
      taskComplete(5_000, 'turn-1', 'done'),
    ])
    const labels = contexts(parser).map(node => node.kind === 'context' ? node.provenance.label : '')
    expect(labels).toEqual(expect.arrayContaining(['world-state', 'thread-goal', 'verified-answer']))
    expect(parser.meta().promptCount).toBe(1)
  })

  it('emits a compaction node for a durable context_compaction item', () => {
    const parser = feed([
      sessionMeta(0),
      taskStarted(1_000, 'turn-1'),
      userMessage(2_000, 'go'),
      line('response_item', { type: 'context_compaction', id: 'cc-1' }, 3_000),
      taskComplete(5_000, 'turn-1', 'done'),
    ])
    const nodes = parser.snapshot().eventNodes.filter(node => node.kind === 'compaction')
    expect(nodes).toHaveLength(1)
  })
})

describe('isCodexHumanPrompt', () => {
  it('accepts a person\'s prompt', () => {
    expect(isCodexHumanPrompt('Please list the files')).toBe(true)
    expect(isCodexHumanPrompt('  continue')).toBe(true)
    // An attached image rides a tag but is still the person speaking.
    expect(isCodexHumanPrompt('<image>')).toBe(true)
  })

  it('accepts tag-shaped text that is not a known injected fragment', () => {
    // The fallback is exact fragment markers, never "any XML tag" — real
    // prompts like these were being rejected as injections.
    expect(isCodexHumanPrompt('<question>Help me understand this</question>')).toBe(true)
    expect(isCodexHumanPrompt('<user_instructions>Be brief.</user_instructions>')).toBe(true)
    expect(isCodexHumanPrompt('Here is a list of bugs to fix')).toBe(true)
  })

  it('rejects the marked injected fragments', () => {
    expect(isCodexHumanPrompt('<environment_context>\n  <cwd>/work</cwd>\n</environment_context>')).toBe(false)
    expect(isCodexHumanPrompt('# AGENTS.md instructions\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>')).toBe(false)
    expect(isCodexHumanPrompt('<turn_aborted>\nstop that\n</turn_aborted>')).toBe(false)
    expect(isCodexHumanPrompt('<recommended_plugins>\nHere is a list of plugins\n</recommended_plugins>')).toBe(false)
    expect(isCodexHumanPrompt('<skill>\n<name>x</name>\nbody\n</skill>')).toBe(false)
    expect(isCodexHumanPrompt('<codex_internal_context source="goal">\nkeep going\n</codex_internal_context>')).toBe(false)
    expect(isCodexHumanPrompt('<external_memory>\nremembered\n</external_memory>')).toBe(false)
    expect(isCodexHumanPrompt('<hook_prompt hook_run_id="r-1">\nhook text\n</hook_prompt>')).toBe(false)
  })

  it('rejects guardian review relay fragments', () => {
    expect(isCodexHumanPrompt('The following is the Codex agent history for the previous window.')).toBe(false)
    expect(isCodexHumanPrompt('>>> TRANSCRIPT START')).toBe(false)
    expect(isCodexHumanPrompt('>>> APPROVAL REQUEST END')).toBe(false)
    expect(isCodexHumanPrompt('Reviewed Codex session id: 01a08ec9-447e-7422-ab3c-64550678d9')).toBe(false)
    expect(isCodexHumanPrompt('[3] user: rebase 一下到 dev 分支')).toBe(false)
  })

  it('requires both markers, not just the opening tag', () => {
    // A person pasting a half-written tag is still a person.
    expect(isCodexHumanPrompt('<environment_context>\n  <cwd>/work</cwd>')).toBe(true)
    expect(isCodexHumanPrompt('# AGENTS.md\n\nBe brief in this repo.')).toBe(true)
    expect(isCodexHumanPrompt('## AGENTS.md section')).toBe(true)
    expect(isCodexHumanPrompt('please update # AGENTS.md with the new rule')).toBe(true)
  })
})

describe('codexUserItems / codexHumanPromptText', () => {
  const userMessage = (items: unknown[], kinds?: string[]) => ({
    type: 'message', role: 'user',
    content: items.map(item => typeof item === 'string' ? { type: 'input_text', text: item } : item),
    ...(kinds === undefined ? {} : {
      internal_chat_message_metadata_passthrough: { turn_id: 't-1', content_item_kinds: kinds },
    }),
  })

  it('honours content_item_kinds over text markers', () => {
    // Annotated rollouts classify by kind, so an injected fragment whose text
    // would not match any marker is still context.
    const payload = userMessage(
      ['<mystery>injected</mystery>', 'fix the flaky test'],
      ['guardian.followup_review_reminder', 'user.text'],
    )
    const items = codexUserItems(payload)
    expect(items.map(item => item.human)).toEqual([false, true])
    expect(items[0]?.label).toBe('guardian.followup_review_reminder')
    expect(codexHumanPromptText(payload)).toBe('fix the flaky test')
  })

  it('falls back to per-item text markers on unannotated messages', () => {
    const payload = userMessage([
      '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>',
      'ship it',
    ])
    expect(codexUserItems(payload).map(item => item.human)).toEqual([false, true])
    expect(codexHumanPromptText(payload)).toBe('ship it')
  })

  it('treats an image-only message as human input with no text', () => {
    const payload = userMessage([{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }])
    expect(codexUserItems(payload).map(item => item.human)).toEqual([true])
    expect(codexHumanPromptText(payload)).toBe('')
  })

  it('returns null for a fully injected message', () => {
    const payload = userMessage(['<turn_aborted>\nstop\n</turn_aborted>'])
    expect(codexHumanPromptText(payload)).toBeNull()
  })
})

describe('codex source lines', () => {
  /** Feed a rollout the way the server's replay numbers it: 0-based, no gaps. */
  function feedNumbered(lines: readonly string[], file: SessionFileRef = MAIN) {
    const parser = createCodexParser()
    for (const [index, item] of lines.entries()) parser.push(item, file, index)
    return parser
  }

  it('resolves a prompt line to the record it folded into', () => {
    const lines = twoTurnFixture()
    const parser = feedNumbered(lines)
    const index = parser.snapshot().sourceLines
    const prompt = lines.indexOf(userMessage(2_000, 'Please list the files'))
    const target = index?.targetAt(prompt, MAIN.id)
    expect(target?.kind).toBe('seq')
    const seq = target?.kind === 'seq' ? target.seq : -1
    const node = parser.snapshot().eventNodes.find(item => item.seq === seq)
    expect(node?.kind).toBe('user')
  })

  it('binds a call and its output to the same record, in either direction', () => {
    const lines = twoTurnFixture()
    const index = feedNumbered(lines).snapshot().sourceLines
    // The call line folds into no node of its own — the tool record only exists
    // once the output lands — and the output line's node IS that record, so
    // both name the call.
    const call = lines.indexOf(customToolCall(3_500, 'call-1', 'ls -la'))
    const output = lines.indexOf(customToolOutput(5_000, 'call-1', 'a.ts\nb.ts'))
    expect(index?.targetAt(call, MAIN.id)).toEqual({ kind: 'call', callId: 'call-1' })
    expect(index?.targetAt(output, MAIN.id)).toEqual({ kind: 'call', callId: 'call-1' })
  })

  it('gives a line that opened an assistant step to that step, not to its call', () => {
    // `call-2` arrives with no step open, so its line creates the assistant
    // record first: a line resolves to the FIRST record it created, and the
    // tool row sits one row below it in the same step.
    const lines = twoTurnFixture()
    const parser = feedNumbered(lines)
    const call = lines.indexOf(functionCall(6_000, 'call-2', 'read_file', '{"path":"a.ts"}'))
    const target = parser.snapshot().sourceLines?.targetAt(call, MAIN.id)
    expect(target?.kind).toBe('seq')
    const node = parser.snapshot().eventNodes.find(item =>
      target?.kind === 'seq' && item.seq === target.seq)
    expect(node?.kind).toBe('assistant')
    // Its output line still resolves to the tool record itself.
    const output = lines.indexOf(functionOutput(7_000, 'call-2', 'export const a = 1'))
    expect(parser.snapshot().sourceLines?.targetAt(output, MAIN.id))
      .toEqual({ kind: 'call', callId: 'call-2' })
  })

  it('folds a reasoning line into the assistant record its step opened', () => {
    const lines = twoTurnFixture()
    const parser = feedNumbered(lines)
    const first = lines.indexOf(reasoning(3_000, '**Planning**', 'Look at the tree'))
    const target = parser.snapshot().sourceLines?.targetAt(first, MAIN.id)
    expect(target?.kind).toBe('seq')
    const node = parser.snapshot().eventNodes.find(item =>
      target?.kind === 'seq' && item.seq === target.seq)
    expect(node?.kind).toBe('assistant')
  })

  it('answers a skipped line with the nearest preceding record and an unread one with nothing', () => {
    const lines = twoTurnFixture()
    const index = feedNumbered(lines).snapshot().sourceLines
    const prompt = lines.indexOf(userMessage(2_000, 'Please list the files'))
    // `turn_context` (the line after the prompt in turn 2) folds into nothing.
    const context = lines.indexOf(turnContext(20_100, 'turn-2'))
    const skipped = index?.targetAt(context, MAIN.id)
    expect(skipped).toEqual(index?.targetAt(context - 1, MAIN.id))
    // Past the end of what has been folded: still unknown, never the tail.
    expect(index?.targetAt(lines.length + 10, MAIN.id)).toBeUndefined()
    expect(index?.targetAt(prompt, 'another-file')).toBeUndefined()
  })

  it('records nothing for a parser that is not told where its lines are', () => {
    const index = feed(twoTurnFixture()).snapshot().sourceLines
    expect(index?.targetAt(0, MAIN.id)).toBeUndefined()
  })

  it('keeps each file of a session on its own line numbering', () => {
    const parser = createCodexParser()
    for (const [index, item] of twoTurnFixture().entries()) parser.push(item, MAIN, index)
    const child = [
      line('session_meta', { id: 'thread-child', parent_thread_id: 'thread-main', thread_source: 'subagent' }, 30_000),
      line('response_item', {
        type: 'function_call', id: 'fc-c', call_id: 'child-call', name: 'grep', arguments: '{}',
      }, 30_100),
      line('response_item', { type: 'function_call_output', id: 'fco-c', call_id: 'child-call', output: 'hit' }, 30_200),
    ]
    for (const [index, item] of child.entries()) parser.push(item, CHILD, index)
    const index = parser.snapshot().sourceLines
    expect(index?.targetAt(1, CHILD.id)).toEqual({ kind: 'call', callId: 'child-call' })
    // Line 1 of the MAIN file is a different record entirely.
    expect(index?.targetAt(1, MAIN.id)).not.toEqual({ kind: 'call', callId: 'child-call' })
  })
})
