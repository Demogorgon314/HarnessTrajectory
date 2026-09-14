import { describe, expect, it } from 'vitest'
import { createCodexParser } from '../src/adapters/codex.ts'
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
    const lines = twoTurnFixture().slice(0, 9)
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
      .toEqual([['developer', 'instructions'], ['environment_context', 'snapshot']])
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
