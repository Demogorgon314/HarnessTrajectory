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

describe('claude adapter subagents', () => {
  const AGENT_META = { agentId: 'a1', toolUseId: 'agent-b', description: 'docs', agentType: 'Explore', model: 'sonnet' }
  const CHILD_WITH_META: SessionFileRef = { ...CHILD, id: 'main/agent-a1', agent: AGENT_META }

  function agentLaunch(callId: string, agentId: string, offsetMs: number): Extra {
    return toolResult(callId, 'Async agent launched.', offsetMs, {
      meta: { agentId, status: 'async_launched', isAsync: true, description: 'docs', resolvedModel: 'claude-sonnet-5' },
    })
  }

  it('binds a child by the tool-use id in its sidecar meta, even after the async launch receipt', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Survey the repo', 0),
      assistantLine('req-1', toolUse('agent-a', 'Agent', { prompt: 'List tests', description: 'tests' }), 1_000),
      assistantLine('req-1', toolUse('agent-b', 'Agent', { prompt: 'List docs', description: 'docs' }), 1_100, { stop: 'tool_use' }),
      agentLaunch('agent-b', 'a1', 1_200),
      agentLaunch('agent-a', 'a0', 1_300),
    ])
    // Both calls already completed (async receipts) when the child's lines arrive.
    feed(parser, [
      user('List tests', 1_500, { agentId: 'a1', isSidechain: true }), // prompt text deliberately misleading
      assistantLine('req-c1', toolUse('child-call', 'Bash', { command: 'ls docs' }), 2_000, { stop: 'tool_use' }),
    ], CHILD_WITH_META)
    let snapshot = parser.snapshot()
    // The parent ledger has no extra turn and no top-level running call from the child.
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'assistant', 'tool-result', 'tool-result'])
    expect(parser.meta().promptCount).toBe(1)
    expect(snapshot.runningCalls).toEqual([])
    const [docs, tests] = toolResults(parser)
    expect(docs?.callId).toBe('agent-b')
    // A running nested call is visible under the completed Agent result before its own result lands.
    expect(docs?.subCalls.map(call => call.callId)).toEqual(['child-call'])
    expect(docs?.subCalls[0] !== undefined && 'kind' in docs.subCalls[0]).toBe(false)
    expect(tests?.subCalls).toEqual([])

    feed(parser, [toolResult('child-call', 'README.md', 2_500)], CHILD_WITH_META)
    snapshot = parser.snapshot()
    const [docsDone] = toolResults(parser)
    expect(docsDone?.subCalls[0]).toMatchObject({ kind: 'tool-result', callId: 'child-call', parentCallId: 'agent-b' })
    expect(parser.subagents().map(run => [run.agentId, run.callId, run.status, run.toolCalls])).toEqual([
      ['a0', 'agent-a', 'running', 0],
      ['a1', 'agent-b', 'running', 1],
    ])
  })

  it('binds by the agent id from the launch receipt when no sidecar meta exists', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Go', 0),
      assistantLine('req-1', toolUse('agent-a', 'Agent', { prompt: 'One', description: 'one' }), 1_000),
      assistantLine('req-1', toolUse('agent-b', 'Agent', { prompt: 'Two', description: 'two' }), 1_100, { stop: 'tool_use' }),
      agentLaunch('agent-a', 'aa', 1_200),
      agentLaunch('agent-b', 'bb', 1_300),
    ])
    const childB: SessionFileRef = { ...CHILD, id: 'main/agent-bb', agent: { agentId: 'bb' } }
    feed(parser, [
      user('Two (edited)', 1_500, { agentId: 'bb', isSidechain: true }),
      assistantLine('req-c1', toolUse('b-call', 'Read', { file_path: '/x' }), 2_000, { stop: 'tool_use' }),
      toolResult('b-call', 'contents', 2_100),
    ], childB)
    const [one, two] = toolResults(parser)
    expect(one?.callId).toBe('agent-a')
    expect(one?.subCalls).toEqual([])
    expect(two?.callId).toBe('agent-b')
    expect(two?.subCalls.map(call => call.callId)).toEqual(['b-call'])
  })

  it('treats a fork\'s synthetic first tool result as the binding, not as a result', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Implement it', 0),
      assistantLine('req-1', toolUse('fork-call', 'Agent', { prompt: 'Do the work', subagent_type: 'fork' }), 1_000, { stop: 'tool_use' }),
    ])
    const forkFile: SessionFileRef = { ...CHILD, id: 'main/agent-ff', agent: { agentId: 'ff', isFork: true } }
    feed(parser, [
      { type: 'fork-context-ref', agentId: 'ff', parentSessionId: 'session-1', parentLastUuid: 'a-1000', contextLength: 12 },
      user('', 1_050, {
        agentId: 'ff',
        isSidechain: true,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'fork-call', content: [{ type: 'text', text: 'Fork started — processing in background' }] },
            { type: 'text', text: '<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>\n\nDo the work' },
          ],
        },
      }),
      assistantLine('req-f1', toolUse('f-call', 'Bash', { command: 'make' }), 1_500, { stop: 'tool_use' }),
    ], forkFile)
    feed(parser, [agentLaunch('fork-call', 'ff', 1_100)])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'assistant', 'tool-result'])
    const [fork] = toolResults(parser)
    // The parent's own receipt is the result; the fork's copy never reached the ledger.
    expect(fork?.content).toEqual([{ type: 'text', text: 'Async agent launched.' }])
    expect(fork?.subCalls.map(call => call.callId)).toEqual(['f-call'])
    expect(parser.subagents()[0]).toMatchObject({ agentId: 'ff', callId: 'fork-call', status: 'running', toolCalls: 1 })
  })

  it('ignores the fork point copied into a fork transcript, nested and standalone', () => {
    const forkPoint = assistantLine('req-1', toolUse('fork-call', 'Agent', { prompt: 'Do the work', subagent_type: 'fork' }), 1_000, {
      stop: 'tool_use', extra: { isSidechain: true, agentId: 'ff' },
    })
    const forkStart = user('', 1_050, {
      agentId: 'ff',
      isSidechain: true,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'fork-call', content: [{ type: 'text', text: 'Fork started' }] },
          { type: 'text', text: '<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>\n\nDo the work' },
        ],
      },
    })
    const work = [
      assistantLine('req-f1', toolUse('f-call', 'Bash', { command: 'make' }), 1_500, { stop: 'tool_use', extra: { isSidechain: true, agentId: 'ff' } }),
      { ...toolResult('f-call', 'ok', 1_600), isSidechain: true, agentId: 'ff' },
    ]

    const parent = createClaudeParser()
    feed(parent, [
      user('Implement it', 0),
      assistantLine('req-1', toolUse('fork-call', 'Agent', { prompt: 'Do the work', subagent_type: 'fork' }), 1_000, { stop: 'tool_use' }),
    ])
    const forkFile: SessionFileRef = { ...CHILD, id: 'main/agent-ff', agent: { agentId: 'ff', toolUseId: 'fork-call', isFork: true } }
    feed(parent, [
      { type: 'fork-context-ref', agentId: 'ff', parentSessionId: 'session-1', parentLastUuid: 'a-1000', contextLength: 12 },
      forkPoint, forkStart, ...work,
    ], forkFile)
    feed(parent, [toolResult('fork-call', 'Async agent launched.', 1_100, { meta: { agentId: 'ff', status: 'async_launched' } })])
    let snapshot = parent.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'assistant', 'tool-result'])
    expect(snapshot.runningCalls).toEqual([])
    const [fork] = toolResults(parent)
    expect(fork?.subCalls.map(call => call.callId)).toEqual(['f-call'])

    const alone = createClaudeParser()
    feed(alone, [
      { type: 'fork-context-ref', agentId: 'ff', parentSessionId: 'session-1', parentLastUuid: 'a-1000', contextLength: 12 },
      forkPoint, forkStart, ...work,
    ], { id: 'main/agent-ff', role: 'main', path: '/x', agent: { agentId: 'ff', toolUseId: 'fork-call', isFork: true } })
    snapshot = alone.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['context', 'assistant', 'context', 'user', 'assistant', 'tool-result'])
    expect(snapshot.runningCalls).toEqual([])
    expect(snapshot.eventLocations.get(2)).toEqual({ kind: 'session' })
  })

  it('never lets an unbound child leak into the parent ledger', () => {
    const parser = createClaudeParser()
    feed(parser, [user('Hello', 0), assistantLine('req-1', { type: 'text', text: 'Hi' }, 1_000, { stop: 'end_turn' })])
    const stray: SessionFileRef = { ...CHILD, id: 'main/agent-zz', agent: { agentId: 'zz' } }
    feed(parser, [
      user('Stray prompt', 2_000, { agentId: 'zz', isSidechain: true }),
      assistantLine('req-z1', toolUse('z-call', 'Bash', { command: 'ls' }), 2_500, { stop: 'tool_use' }),
      toolResult('z-call', 'a b', 2_600),
    ], stray)
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'assistant'])
    expect(snapshot.runningCalls).toEqual([])
    expect(snapshot.partial).toBeNull()
    expect(parser.meta().promptCount).toBe(1)
    // It is still reported so the catalog can open its transcript.
    expect(parser.subagents()).toEqual([expect.objectContaining({ agentId: 'zz', fileId: 'main/agent-zz', callId: null })])
  })

  it('tracks run status from receipts and task notifications', () => {
    const parser = createClaudeParser()
    feed(parser, [
      user('Go', 0),
      assistantLine('req-1', toolUse('agent-a', 'Agent', { prompt: 'A', description: 'a' }), 1_000),
      assistantLine('req-1', toolUse('agent-b', 'Agent', { prompt: 'B', description: 'b' }), 1_100),
      assistantLine('req-1', toolUse('agent-c', 'Agent', { prompt: 'C', description: 'c' }), 1_200, { stop: 'tool_use' }),
    ])
    expect(parser.subagents().map(run => run.status)).toEqual(['launching', 'launching', 'launching'])
    feed(parser, [
      agentLaunch('agent-a', 'aa', 1_300),
      agentLaunch('agent-b', 'bb', 1_400),
      toolResult('agent-c', 'Sync report', 5_000, { meta: { agentId: 'cc', status: 'completed' } }),
      user('<task-notification>\n<task-id>aa</task-id>\n<tool-use-id>agent-a</tool-use-id>\n<status>completed</status>\n<summary>Agent "a" finished</summary>\n</task-notification>', 6_000),
      user('<task-notification>\n<task-id>bb</task-id>\n<tool-use-id>agent-b</tool-use-id>\n<status>failed</status>\n</task-notification>', 6_500),
    ])
    const runs = parser.subagents()
    expect(runs.map(run => [run.agentId, run.status, run.endedAt])).toEqual([
      ['aa', 'completed', T0 + 6_000],
      ['bb', 'failed', T0 + 6_500],
      ['cc', 'completed', T0 + 5_000],
    ])
    expect(runs[0]).toMatchObject({ description: 'a', startedAt: T0 + 1_000, model: 'claude-sonnet-5' })
    // Notifications are context, not prompts.
    expect(parser.meta().promptCount).toBe(1)
    expect(parser.snapshot().eventNodes.filter(node => node.kind === 'context')).toHaveLength(2)
  })

  it('folds an agent transcript served on its own as a complete session', () => {
    const parser = createClaudeParser()
    const standalone: SessionFileRef = {
      id: 'main/agent-ff', role: 'main', path: '/sessions/main/subagents/agent-ff.jsonl',
      agent: { agentId: 'ff', toolUseId: 'fork-call', isFork: true, description: 'Implement it' },
    }
    feed(parser, [
      { type: 'fork-context-ref', agentId: 'ff', parentSessionId: 'session-1', parentLastUuid: 'a-1', contextLength: 12 },
      user('', 1_050, {
        agentId: 'ff',
        isSidechain: true,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'fork-call', content: [{ type: 'text', text: 'Fork started' }] },
            { type: 'text', text: '<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>\n\nDo the work' },
          ],
        },
      }),
      assistantLine('req-f1', { type: 'text', text: 'On it.' }, 1_200, { extra: { isSidechain: true, agentId: 'ff' } }),
      assistantLine('req-f1', toolUse('f-call', 'Bash', { command: 'make' }), 1_500, { stop: 'tool_use', extra: { isSidechain: true, agentId: 'ff' } }),
      { ...toolResult('f-call', 'ok', 1_600), isSidechain: true, agentId: 'ff' },
      assistantLine('req-f2', { type: 'text', text: 'Done.' }, 2_000, { stop: 'end_turn', extra: { isSidechain: true, agentId: 'ff' } }),
    ], standalone)
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual([
      'context', 'context', 'user', 'assistant', 'tool-result', 'assistant',
    ])
    expect(snapshot.eventNodes[0]).toMatchObject({ provenance: { label: 'fork-context-ref' } })
    expect(snapshot.eventNodes[1]).toMatchObject({
      provenance: { label: 'fork-context' }, content: [{ type: 'text', text: 'Fork started' }],
    })
    expect(assistants(parser).map(node => [node.turn, node.step])).toEqual([[1, 1], [1, 2]])
    expect(snapshot.runningCalls).toEqual([])
    expect(parser.meta().promptCount).toBe(1)
    expect(parser.subagents()).toEqual([])
  })
})

describe('claude source lines', () => {
  /** Feed a transcript the way the server's replay numbers it: 0-based, no gaps. */
  function feedNumbered(parser: SessionParser, records: readonly unknown[], file: SessionFileRef = MAIN): void {
    for (const [index, record] of records.entries()) {
      parser.push(typeof record === 'string' ? record : JSON.stringify(record), file, index)
    }
  }

  const RECORDS: readonly unknown[] = [
    user('Fix the build', 0),
    assistantLine('req-1', { type: 'thinking', thinking: 'Looking at it' }, 1_000),
    assistantLine('req-1', { type: 'text', text: 'Running the build.' }, 2_000),
    assistantLine('req-1', toolUse('call-1', 'Bash', { command: 'make' }), 3_000, { stop: 'tool_use' }),
    toolResult('call-1', 'ok', 4_000),
    assistantLine('req-2', { type: 'text', text: 'Done.' }, 5_000, { stop: 'end_turn' }),
  ]

  it('binds an assistant step to the line that opened it, not to the one that closed it', () => {
    const parser = createClaudeParser()
    feedNumbered(parser, RECORDS)
    const snapshot = parser.snapshot()
    // The step's node is only pushed when the following record closes it, but
    // its seq was allocated on line 1 — that is where the record came from.
    const target = snapshot.sourceLines?.targetAt(1, MAIN.id)
    expect(target?.kind).toBe('seq')
    const node = snapshot.eventNodes.find(item => target?.kind === 'seq' && item.seq === target.seq)
    expect(node?.kind).toBe('assistant')
    expect((node as AssistantMessageNode).step).toBe(1)
    // A further record of the same step folds into it through the fallback.
    expect(snapshot.sourceLines?.targetAt(2, MAIN.id)).toEqual(target)
  })

  it('binds the tool_use line and its tool_result line to the same tool record', () => {
    const parser = createClaudeParser()
    feedNumbered(parser, RECORDS)
    const index = parser.snapshot().sourceLines
    expect(index?.targetAt(3, MAIN.id)).toEqual({ kind: 'call', callId: 'call-1' })
    expect(index?.targetAt(4, MAIN.id)).toEqual({ kind: 'call', callId: 'call-1' })
  })

  it('gives a record that folds into several nodes to the first of them', () => {
    const parser = createClaudeParser()
    feedNumbered(parser, [
      user('Fix the build', 0),
      assistantLine('req-1', toolUse('call-1', 'Bash', { command: 'make' }), 1_000),
      assistantLine('req-1', toolUse('call-2', 'Bash', { command: 'test' }), 2_000, { stop: 'tool_use' }),
      // One record carrying both results: two tool nodes from one line.
      {
        type: 'user',
        uuid: 'r-both',
        sessionId: 'session-1',
        cwd: CWD,
        timestamp: at(3_000),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-1', content: 'first' },
            { type: 'tool_result', tool_use_id: 'call-2', content: 'second' },
          ],
        },
      },
    ])
    expect(parser.snapshot().sourceLines?.targetAt(3, MAIN.id)).toEqual({ kind: 'call', callId: 'call-1' })
  })

  it('resolves the prompt line, an unread line, and an unnumbered fold', () => {
    const parser = createClaudeParser()
    feedNumbered(parser, RECORDS)
    const snapshot = parser.snapshot()
    const target = snapshot.sourceLines?.targetAt(0, MAIN.id)
    expect(snapshot.eventNodes.find(node => target?.kind === 'seq' && node.seq === target.seq)?.kind).toBe('user')
    expect(snapshot.sourceLines?.targetAt(RECORDS.length, MAIN.id)).toBeUndefined()

    const unnumbered = createClaudeParser()
    feed(unnumbered, RECORDS)
    expect(unnumbered.snapshot().sourceLines?.targetAt(0, MAIN.id)).toBeUndefined()
  })

  it('numbers a subagent transcript on its own', () => {
    const parser = createClaudeParser()
    feedNumbered(parser, [
      user('Delegate this', 0),
      assistantLine('req-1', toolUse('call-agent', 'Task', { description: 'dig' }), 1_000, { stop: 'tool_use' }),
    ])
    feedNumbered(parser, [
      { ...user('dig', 2_000), isSidechain: true, agentId: 'a1', promptId: 'p-1' },
      {
        ...assistantLine('req-c', toolUse('call-child', 'Bash', { command: 'ls' }), 2_500, { stop: 'tool_use' }),
        isSidechain: true,
        agentId: 'a1',
      },
      { ...toolResult('call-child', 'a.ts', 3_000), isSidechain: true, agentId: 'a1' },
    ], CHILD)
    const index = parser.snapshot().sourceLines
    // A child's assistant records nest into the parent's call and push no node
    // of their own, so the child's line 1 belongs to the call it emitted.
    expect(index?.targetAt(1, CHILD.id)).toEqual({ kind: 'call', callId: 'call-child' })
    // Line 1 of the MAIN file is a record of its own: the step it opened.
    expect(index?.targetAt(1, MAIN.id)?.kind).toBe('seq')
  })
})
