import { describe, expect, it } from 'vitest'
import { createClaudeParser } from '../src/adapters/claude.ts'
import type { SessionFileRef, SessionParser } from '../src/session.ts'
import type { AssistantMessageNode, ToolResultNode } from '../src/contract.ts'

const MAIN: SessionFileRef = { id: 'main', role: 'main', path: '/sessions/main.jsonl' }
const CHILD: SessionFileRef = { id: 'agent-1', role: 'child', path: '/sessions/agent-1.jsonl', parentId: 'main' }

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString()
}

const CWD = '/repo/example'

interface Extra { [key: string]: unknown }

function user(text: string, offsetMs: number, extra: Extra = {}): Extra {
  return {
    type: 'user',
    uuid: `u-${offsetMs}`,
    sessionId: 'session-1',
    cwd: CWD,
    timestamp: at(offsetMs),
    message: { role: 'user', content: text },
    ...extra,
  }
}

function assistantLine(
  requestId: string,
  block: Extra,
  offsetMs: number,
  options: { stop?: string | null; usage?: Extra; effort?: string; extra?: Extra } = {},
): Extra {
  return {
    type: 'assistant',
    uuid: `a-${offsetMs}`,
    sessionId: 'session-1',
    cwd: CWD,
    timestamp: at(offsetMs),
    requestId,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    message: {
      id: `msg_${requestId}`,
      model: 'claude-test-1',
      role: 'assistant',
      type: 'message',
      content: [block],
      stop_reason: options.stop ?? null,
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    },
    ...options.extra,
  }
}

function toolUse(id: string, name: string, input: Extra): Extra {
  return { type: 'tool_use', id, name, input }
}

function toolResult(
  id: string,
  content: unknown,
  offsetMs: number,
  options: { isError?: boolean; meta?: unknown } = {},
): Extra {
  return {
    type: 'user',
    uuid: `r-${offsetMs}`,
    sessionId: 'session-1',
    cwd: CWD,
    timestamp: at(offsetMs),
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        content,
        ...(options.isError === undefined ? {} : { is_error: options.isError }),
      }],
    },
    ...(options.meta === undefined ? {} : { toolUseResult: options.meta }),
  }
}

function feed(parser: SessionParser, records: readonly unknown[], file: SessionFileRef = MAIN): void {
  for (const record of records) {
    parser.push(typeof record === 'string' ? record : JSON.stringify(record), file)
  }
}

function assistants(parser: SessionParser): AssistantMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is AssistantMessageNode => node.kind === 'assistant')
}

function toolResults(parser: SessionParser): ToolResultNode[] {
  return parser.snapshot().eventNodes.filter((node): node is ToolResultNode => node.kind === 'tool-result')
}

describe('claude adapter', () => {
  it('numbers turns and steps across prompts and tool loops', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Fix the build', 0),
      assistantLine('req-1', { type: 'thinking', thinking: 'Looking at it' }, 1_000),
      assistantLine('req-1', { type: 'text', text: 'Running the build.' }, 2_000),
      assistantLine('req-1', toolUse('call-1', 'Bash', { command: 'make' }), 3_000, { stop: 'tool_use' }),
      toolResult('call-1', 'ok', 4_000),
      assistantLine('req-2', { type: 'text', text: 'Done.' }, 5_000, { stop: 'end_turn' }),
      { type: 'system', subtype: 'turn_duration', durationMs: 5_000, timestamp: at(5_100), uuid: 's1' },
      user('Now add a test', 10_000),
      assistantLine('req-3', { type: 'text', text: 'Added.' }, 11_000, { stop: 'end_turn' }),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual([
      'user', 'assistant', 'tool-result', 'assistant', 'user', 'assistant',
    ])
    expect(snapshot.eventNodes.map(node => node.seq)).toEqual([1, 2, 3, 4, 5, 6])
    const steps = assistants(parser).map(node => [node.turn, node.step])
    expect(steps).toEqual([[1, 1], [1, 2], [2, 1]])
    expect(snapshot.partial).toBeNull()
    expect(snapshot.runningCalls).toEqual([])
    expect(snapshot.requests.map(request => request.status)).toEqual(['complete', 'complete', 'complete'])
    expect(snapshot.eventLocations.get(1)).toEqual({ kind: 'turn', turn: { turn: 1, status: 'closed' } })
    expect(snapshot.eventLocations.get(4)).toEqual({ kind: 'turn', turn: { turn: 1, status: 'closed' } })
    expect(snapshot.eventLocations.get(5)).toEqual({ kind: 'turn', turn: { turn: 2, status: 'open' } })
    expect(parser.meta().promptCount).toBe(2)
  })

  it('groups per-block lines of one request and maps usage, provenance, and timing', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Explain', 0),
      assistantLine('req-1', { type: 'thinking', thinking: 'hmm' }, 700),
      assistantLine('req-1', { type: 'text', text: 'Because.' }, 1_500),
      assistantLine('req-1', { type: 'text', text: 'And more.' }, 2_500, {
        stop: 'end_turn',
        effort: 'high',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 4_000,
          output_tokens: 42,
          output_tokens_details: { thinking_tokens: 7 },
        },
      }),
    ])
    const [node] = assistants(parser)
    expect(node).toBeDefined()
    expect(node?.blocks).toEqual([
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'text', text: 'Because.' },
      { kind: 'text', text: 'And more.' },
    ])
    expect(node?.messageId).toBe('msg_req-1')
    expect(node?.usage).toEqual({
      inputTokens: 2,
      outputTokens: 42,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 300,
      reasoningTokens: 7,
    })
    expect(node?.provenance).toEqual({ provider: 'anthropic', model: 'claude-test-1' })
    expect(node?.requestConfig).toEqual({ provider: 'anthropic', model: 'claude-test-1', reasoningEffort: 'high' })
    expect(node?.time).toBe(T0 + 2_500)
    expect(node?.timing).toEqual({ stepStartTime: T0, firstTokenTime: T0 + 700, completedTime: T0 + 2_500 })
    const [request] = parser.snapshot().requests
    expect(request).toMatchObject({
      purpose: 'assistant',
      turn: 1,
      step: 1,
      startedAt: T0,
      completedAt: T0 + 2_500,
      status: 'complete',
      resultSeq: node?.seq,
      usage: { outputTokens: 42 },
    })
  })

  it('exposes the open request as partial, then tracks running calls until results arrive', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Check disk', 0),
      assistantLine('req-1', { type: 'thinking', thinking: 'checking' }, 1_000),
    ])
    let snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user'])
    expect(snapshot.partial).toEqual({ turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'checking' }] })
    expect(snapshot.requests).toHaveLength(1)
    expect(snapshot.requests[0]).toMatchObject({ status: 'running', completedAt: null, turn: 1, step: 1 })

    feed(parser, [
      assistantLine('req-1', toolUse('call-1', 'Bash', { command: 'df -h' }), 2_000, { stop: 'tool_use' }),
    ])
    snapshot = parser.snapshot()
    expect(snapshot.partial).toBeNull()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'assistant'])
    expect(snapshot.runningCalls).toHaveLength(1)
    expect(snapshot.runningCalls[0]).toMatchObject({
      callId: 'call-1', name: 'Bash', argsRaw: '{"command":"df -h"}', turn: 1, step: 1, time: T0 + 2_000,
    })
    expect(snapshot.requests[0]?.status).toBe('complete')

    feed(parser, [toolResult('call-1', 'No space left', 3_000, { isError: true, meta: { exitCode: 1 } })])
    snapshot = parser.snapshot()
    expect(snapshot.runningCalls).toEqual([])
    const [result] = toolResults(parser)
    expect(result).toMatchObject({
      callId: 'call-1',
      call: { name: 'Bash', argsRaw: '{"command":"df -h"}' },
      callTime: T0 + 2_000,
      time: T0 + 3_000,
      isError: true,
      meta: { exitCode: 1 },
      content: [{ type: 'text', text: 'No space left' }],
    })
    // The next request measures its wait from the tool result.
    feed(parser, [assistantLine('req-2', { type: 'text', text: 'Disk is full.' }, 4_000, { stop: 'end_turn' })])
    expect(assistants(parser)[1]?.timing?.stepStartTime).toBe(T0 + 3_000)
  })

  it('finalizes an open request when a different record arrives', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Hello', 0),
      assistantLine('req-1', { type: 'text', text: 'Hi' }, 1_000),
      user('Bye', 2_000),
    ])
    expect(parser.snapshot().eventNodes.map(node => node.kind)).toEqual(['user', 'assistant', 'user'])
    expect(parser.snapshot().partial).toBeNull()
    expect(assistants(parser)[0]?.turn).toBe(1)
  })

  it('turns an API error record into a turn error with an errored request', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Hello', 0),
      assistantLine('req-1', { type: 'text', text: 'API Error: overloaded' }, 1_000, {
        extra: { isApiErrorMessage: true },
      }),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes[1]).toMatchObject({ kind: 'turn-error', turn: 1, step: 1, message: 'API Error: overloaded' })
    expect(snapshot.requests[0]).toMatchObject({ status: 'error', error: 'API Error: overloaded' })
    expect(snapshot.partial).toBeNull()
  })

  it('nests subagent tool calls from a child transcript under the matching Agent call', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Survey the repo', 0),
      assistantLine('req-1', toolUse('agent-a', 'Agent', { prompt: 'List tests', description: 'tests' }), 1_000),
      assistantLine('req-1', toolUse('agent-b', 'Agent', { prompt: 'List docs', description: 'docs' }), 1_100, {
        stop: 'tool_use',
      }),
    ])
    feed(parser, [
      user('List docs', 1_500),
      assistantLine('req-c1', toolUse('child-call', 'Bash', { command: 'ls docs' }), 2_000, { stop: 'tool_use' }),
      toolResult('child-call', 'README.md', 2_500),
      assistantLine('req-c2', { type: 'text', text: 'One doc.' }, 3_000, { stop: 'end_turn' }),
    ], CHILD)
    let snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'assistant'])
    expect(snapshot.partial).toBeNull()
    expect(snapshot.runningCalls.map(call => call.callId)).toEqual(['agent-a', 'agent-b'])
    expect(snapshot.runningCalls[0]?.subCalls).toEqual([])
    const nested = snapshot.runningCalls[1]?.subCalls ?? []
    expect(nested).toHaveLength(1)
    expect(nested[0]).toMatchObject({
      kind: 'tool-result',
      callId: 'child-call',
      parentCallId: 'agent-b',
      call: { name: 'Bash', argsRaw: '{"command":"ls docs"}' },
      content: [{ type: 'text', text: 'README.md' }],
    })

    feed(parser, [
      toolResult('agent-b', 'Found one doc.', 4_000),
      toolResult('agent-a', 'Found two tests.', 4_100),
    ])
    snapshot = parser.snapshot()
    expect(snapshot.runningCalls).toEqual([])
    const results = toolResults(parser)
    expect(results.map(result => result.callId)).toEqual(['agent-b', 'agent-a'])
    expect(results[0]?.subCalls).toHaveLength(1)
    expect(results[0]?.subCalls[0]).toMatchObject({ callId: 'child-call', parentCallId: 'agent-b' })
    expect(results[1]?.subCalls).toEqual([])
  })

  it('nests isSidechain records in the main transcript the same way', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Survey', 0),
      assistantLine('req-1', toolUse('agent-a', 'Task', { prompt: 'Count files' }), 1_000, { stop: 'tool_use' }),
      user('Count files', 1_500, { isSidechain: true }),
      assistantLine('req-s1', toolUse('side-call', 'Bash', { command: 'ls | wc -l' }), 2_000, {
        stop: 'tool_use',
        extra: { isSidechain: true },
      }),
      { ...toolResult('side-call', '12', 2_500), isSidechain: true },
      toolResult('agent-a', '12 files', 3_000),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'assistant', 'tool-result'])
    const [agent] = toolResults(parser)
    expect(agent?.callId).toBe('agent-a')
    expect(agent?.subCalls.map(call => call.callId)).toEqual(['side-call'])
  })

  it('represents a compaction summary as a compaction request and node', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Long task', 0),
      assistantLine('req-1', { type: 'text', text: 'Working.' }, 1_000, { stop: 'end_turn' }),
      user('This session is being continued from a previous conversation. Summary: did things.', 2_000, {
        isCompactSummary: true,
      }),
      assistantLine('req-2', { type: 'text', text: 'Continuing.' }, 3_000, { stop: 'end_turn' }),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'assistant', 'compaction', 'assistant'])
    const compaction = snapshot.requests.find(request => request.purpose === 'compaction')
    expect(compaction).toMatchObject({ status: 'complete', turn: 1, step: 0, startedAt: T0 + 2_000 })
    expect(snapshot.eventNodes[2]).toMatchObject({ kind: 'compaction', summary: expect.stringContaining('Summary') })
    expect(assistants(parser).map(node => [node.turn, node.step])).toEqual([[1, 1], [1, 2]])
    expect(parser.meta().promptCount).toBe(1)
  })

  it('stores base64 images and resolves them through imageUrl', () => {
    const parser = createClaudeParser()
    const data = 'bm90IHJlYWxseSBhIHBuZw=='
    feed(parser, [
      user('', 0, {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          ],
        },
      }),
    ])
    const [node] = parser.snapshot().eventNodes
    expect(node?.kind).toBe('user')
    const content = node?.kind === 'user' ? node.content : []
    expect(content[0]).toEqual({ type: 'text', text: 'What is this?' })
    const image = content[1]
    expect(image?.type).toBe('image')
    if (image?.type !== 'image') throw new Error('expected an image block')
    expect(image.attachment.mediaType).toBe('image/png')
    expect(parser.imageUrl(image.attachment)).toBe(`data:image/png;base64,${data}`)
  })

  it('emits context nodes for meta prompts and non-empty attachments only', () => {
    const parser = createClaudeParser()
    feed(parser, [
      { type: 'attachment', timestamp: at(0), uuid: 'att-0', attachment: { type: 'hook_success', hookName: 'SessionStart', content: '' } },
      user('<command-name>/model</command-name>', 100, { isMeta: true }),
      user('Real prompt', 200),
      { type: 'attachment', timestamp: at(300), uuid: 'att-1', attachment: { type: 'hook_success', hookName: 'UserPromptSubmit', content: 'Remember the style guide.' } },
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['context', 'user', 'context'])
    expect(snapshot.eventNodes[0]).toMatchObject({ provenance: { role: 'inject', label: 'meta' }, form: 'notice' })
    expect(snapshot.eventNodes[2]).toMatchObject({
      provenance: { role: 'inject', label: 'UserPromptSubmit' },
      content: [{ type: 'text', text: 'Remember the style guide.' }],
    })
    expect(snapshot.eventLocations.get(1)).toEqual({ kind: 'session' })
    expect(parser.meta().promptCount).toBe(1)
  })

  it('reports session meta from the transcript', () => {
    const parser = createClaudeParser()
    feed(parser, [
      { type: 'mode', mode: 'normal', sessionId: 'session-1' },
      user('First prompt that is fairly descriptive', 500),
      assistantLine('req-1', { type: 'text', text: 'Sure.' }, 1_000, { stop: 'end_turn' }),
    ])
    expect(parser.meta()).toEqual({
      title: 'First prompt that is fairly descriptive',
      cwd: CWD,
      model: 'claude-test-1',
      startedAt: T0 + 500,
      promptCount: 1,
    })
    feed(parser, [{ type: 'ai-title', aiTitle: 'Descriptive Session', sessionId: 'session-1' }])
    expect(parser.meta().title).toBe('Descriptive Session')
  })

  it('tolerates blank and truncated trailing lines', () => {
    const parser = createClaudeParser()
    feed(parser, [user('Hi', 0)])
    const before = parser.snapshot()
    feed(parser, ['', '   ', '{"type":"assistant","message":{"content":[{"type":"te'])
    expect(parser.snapshot()).toBe(before)
    feed(parser, [assistantLine('req-1', { type: 'text', text: 'Hello' }, 1_000, { stop: 'end_turn' })])
    expect(parser.snapshot().eventNodes).toHaveLength(2)
  })

  it('keeps the snapshot reference stable until something changes', () => {
    const parser = createClaudeParser()
    feed(parser, [user('Hi', 0)])
    const first = parser.snapshot()
    expect(parser.snapshot()).toBe(first)
    feed(parser, [{ type: 'permission-mode', permissionMode: 'auto', sessionId: 'session-1' }])
    expect(parser.snapshot()).toBe(first)
    feed(parser, [assistantLine('req-1', { type: 'text', text: 'Hello' }, 1_000)])
    expect(parser.snapshot()).not.toBe(first)
  })
})
