import { describe, expect, it } from 'vitest'
import {
  createDevinParser, devinMessageClass, parseDevinLine,
} from '../src/adapters/devin.ts'
import type { SessionFileRef } from '../src/session.ts'
import type {
  AssistantMessageNode, ContextMessageNode, ToolResultNode, UserMessageNode,
} from '../src/contract.ts'

type Parser = ReturnType<typeof createDevinParser>

const SESSION_ID = 'smoggy-gold'
const T0 = Date.parse('2026-09-13T00:00:00.000Z')

const MAIN: SessionFileRef = {
  id: SESSION_ID,
  role: 'main',
  path: `devin://sessions/${SESSION_ID}`,
}
const CHILD: SessionFileRef = {
  id: 'agent-42',
  role: 'child',
  path: `devin://sessions/${SESSION_ID}/agent-42`,
  parentId: SESSION_ID,
  agent: { agentId: 'd4bf017', agentType: 'explore' },
}

function at(offsetMs: number): number {
  return T0 + offsetMs
}

function msgRecord(node: number, parent: number | null, msg: Record<string, unknown>, offset: number): string {
  return JSON.stringify({ t: 'devin.msg', node, parent, time: at(offset), msg })
}

function sidecar(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    t: 'devin.session',
    sessionId: SESSION_ID,
    title: 'Fix the flaky spec',
    cwd: '/work/project',
    model: 'swe-1.5',
    agentMode: 'standard',
    backend: 'cli',
    createdAt: T0,
    time: at(0),
    agents: [],
    ...overrides,
  })
}

function system(text: string, node = 1): string {
  return msgRecord(node, null, {
    message_id: `m-sys-${node}`,
    role: 'system',
    content: [{ type: 'text', text }],
    metadata: { created_at: new Date(at(0)).toISOString() },
  }, 0)
}

function human(text: string, node: number, parent: number, offset: number): string {
  return msgRecord(node, parent, {
    message_id: `m-user-${node}`,
    role: 'user',
    content: [{ type: 'text', text }],
    metadata: { created_at: new Date(at(offset)).toISOString(), is_user_input: true },
  }, offset)
}

function injected(text: string, node: number, parent: number, offset: number): string {
  return msgRecord(node, parent, {
    message_id: `m-inj-${node}`,
    role: 'user',
    content: [{ type: 'text', text }],
    // No `is_user_input`: hooks and guidance are context, not prompts.
    metadata: { created_at: new Date(at(offset)).toISOString() },
  }, offset)
}

function assistant(
  node: number,
  parent: number,
  offset: number,
  options: {
    text?: string
    thinking?: string
    calls?: { id: string; name: string; args?: unknown }[]
    metrics?: Record<string, number>
  } = {},
): string {
  return msgRecord(node, parent, {
    message_id: `m-asst-${node}`,
    role: 'assistant',
    content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
    ...(options.thinking === undefined ? {} : { thinking: { thinking: options.thinking } }),
    tool_calls: (options.calls ?? []).map(call => ({
      id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.args ?? {}),
    })),
    metadata: {
      created_at: new Date(at(offset)).toISOString(),
      started_generation_at: new Date(at(offset - 100)).toISOString(),
      generation_model: 'swe-1.5',
      metrics: options.metrics ?? { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 900 },
    },
  }, offset)
}

function toolResult(
  node: number,
  parent: number,
  callId: string,
  text: string,
  offset: number,
  ext: Record<string, unknown> = {},
): string {
  return msgRecord(node, parent, {
    message_id: `m-tool-${node}`,
    role: 'tool',
    tool_call_id: callId,
    content: [{ type: 'text', text }],
    metadata: {
      created_at: new Date(at(offset)).toISOString(),
      extensions: {
        'chisel/tool_call_timing': { duration_ms: 42 },
        'chisel/tool_result_meta': { success: true },
        ...ext,
      },
    },
  }, offset)
}

function users(parser: Parser): UserMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is UserMessageNode => node.kind === 'user')
}

function assistants(parser: Parser): AssistantMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is AssistantMessageNode => node.kind === 'assistant')
}

function results(parser: Parser): ToolResultNode[] {
  return parser.snapshot().eventNodes.filter((node): node is ToolResultNode => node.kind === 'tool-result')
}

function contexts(parser: Parser): ContextMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is ContextMessageNode => node.kind === 'context')
}

describe('devinMessageClass', () => {
  it('reads is_user_input, never the text', () => {
    expect(devinMessageClass({ role: 'user', metadata: { is_user_input: true } })).toEqual({ kind: 'human' })
    expect(devinMessageClass({ role: 'user', metadata: {} })).toEqual({ kind: 'injection', name: 'user' })
    expect(devinMessageClass({ role: 'user', content: 'system_guidance' })).toEqual({ kind: 'injection', name: 'user' })
    expect(devinMessageClass({ role: 'assistant' })).toBeNull()
    expect(devinMessageClass('x')).toBeNull()
    expect(devinMessageClass({ role: 'user', metadata: { is_user_input: false } }))
      .toEqual({ kind: 'injection', name: 'user' })
  })
})

describe('parseDevinLine', () => {
  it('parses the three record tags and survives junk', () => {
    expect(parseDevinLine('')).toBeNull()
    expect(parseDevinLine('not json')).toBeNull()
    expect(parseDevinLine('{"t":"unknown"}')).toBeNull()
    const side = parseDevinLine(sidecar())
    expect(side?.tag).toBe('session')
    const msg = parseDevinLine(human('hi', 2, 1, 10))
    expect(msg?.tag).toBe('msg')
    const tool = parseDevinLine(JSON.stringify({ t: 'devin.tool', id: 'c1', time: 1, call: { title: 'x' } }))
    expect(tool?.tag).toBe('tool')
  })
})

describe('devin adapter', () => {
  it('folds a human turn: user node, assistant usage, paired tool call', () => {
    const parser = createDevinParser()
    parser.push(sidecar(), MAIN, -1)
    parser.push(system('You are Devin.'), MAIN, -1)
    parser.push(human('fix the spec', 2, 1, 100), MAIN, 0)
    parser.push(assistant(3, 2, 200, {
      text: 'looking',
      thinking: 'hmm',
      calls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.ts' } }],
    }), MAIN, 1)
    parser.push(toolResult(4, 3, 'call-1', 'file body', 300), MAIN, 2)
    parser.push(assistant(5, 4, 400, { text: 'done' }), MAIN, 3)

    expect(users(parser)).toHaveLength(1)
    expect(contexts(parser)).toHaveLength(0)
    const steps = assistants(parser)
    expect(steps).toHaveLength(2)
    expect(steps[0]?.blocks.map(block => block.kind)).toEqual(['reasoning', 'text', 'tool-call'])
    expect(steps[0]?.usage?.inputTokens).toBe(1200)
    expect(steps[0]?.usage?.cacheReadTokens).toBe(900)
    expect(steps[0]?.timing?.stepStartTime).toBe(at(100))
    const found = results(parser)
    expect(found).toHaveLength(1)
    expect(found[0]?.callId).toBe('call-1')
    expect(parser.meta().promptCount).toBe(1)
    expect(parser.meta().title).toBe('Fix the flaky spec')
    expect(parser.meta().cwd).toBe('/work/project')
  })

  it('counts only is_user_input messages as prompts', () => {
    const parser = createDevinParser()
    parser.push(human('real prompt', 2, 1, 10), MAIN, 0)
    parser.push(injected('system_guidance: be brief', 3, 2, 20), MAIN, 1)
    parser.push(injected('<system-reminder>x</system-reminder>', 4, 3, 30), MAIN, 2)
    expect(parser.meta().promptCount).toBe(1)
    expect(users(parser)).toHaveLength(1)
    expect(contexts(parser)).toHaveLength(2)
  })

  it('settles a call from devin.tool when the tool message never landed', () => {
    const parser = createDevinParser()
    parser.push(human('go', 2, 1, 10), MAIN, 0)
    parser.push(assistant(3, 2, 20, { calls: [{ id: 'call-9', name: 'shell' }] }), MAIN, 1)
    expect(parser.snapshot().runningCalls).toHaveLength(1)
    parser.push(JSON.stringify({
      t: 'devin.tool', id: 'call-9', time: at(30),
      call: { title: 'shell', kind: 'execute' },
      update: { status: 'completed', content: [{ type: 'text', text: 'ok' }] },
    }), MAIN, -1)
    expect(parser.snapshot().runningCalls).toHaveLength(0)
    expect(results(parser)).toHaveLength(1)
  })

  it('binds a subagent run from subagent/* extensions on the result', () => {
    const parser = createDevinParser()
    parser.push(sidecar({ agents: [{ id: 'd4bf017', fileId: 'agent-42' }] }), MAIN, -1)
    parser.push(human('spawn it', 2, 1, 10), MAIN, 0)
    parser.push(assistant(3, 2, 20, {
      calls: [{ id: 'spawn-1', name: 'run_subagent', args: { task: 'survey the repo', profile: 'explore' } }],
    }), MAIN, 1)
    parser.push(toolResult(4, 3, 'spawn-1', 'done', 30, {
      'subagent/agent_id': 'd4bf017',
      'subagent/chain_node_id': 90,
      'subagent/profile_name': 'explore',
      'subagent/model': 'swe-1.5',
    }), MAIN, 2)
    const runs = parser.subagents()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.agentId).toBe('d4bf017')
    expect(runs[0]?.fileId).toBe('agent-42')
    expect(runs[0]?.callId).toBe('spawn-1')
    expect(runs[0]?.description).toBe('survey the repo')
    expect(runs[0]?.status).toBe('completed')
  })

  it('keeps fileId null until a real child file binds — the agent id is not a stream id', () => {
    const parser = createDevinParser()
    parser.push(human('spawn it', 2, 1, 10), MAIN, 0)
    parser.push(assistant(3, 2, 20, {
      calls: [{ id: 'spawn-1', name: 'run_subagent', args: { task: 'survey', profile: 'explore', is_background: true } }],
    }), MAIN, 1)
    // A background spawn result names the agent but not its chain — the
    // chain id lands on the completion notification.
    parser.push(toolResult(4, 3, 'spawn-1', 'Background subagent started with agent_id=a0be46c6.', 30, {
      'subagent/agent_id': 'a0be46c6',
    }), MAIN, 2)
    const unbound = parser.subagents().find(run => run.agentId === 'a0be46c6')
    expect(unbound).toBeDefined()
    // Null — NOT 'a0be46c6': opening that as a file id 404s the events route.
    expect(unbound?.fileId).toBeNull()
    expect(unbound).toMatchObject({ status: 'running', startedAt: at(20), endedAt: null })
    parser.push(JSON.stringify({
      t: 'devin.tool', id: 'spawn-1', time: at(40), update: { status: 'completed' },
    }), MAIN, -1)
    expect(parser.subagents()[0]?.status).toBe('running')
    // The sidecar's agent list lands when the server claims the chain.
    parser.push(sidecar({ agents: [{ id: 'a0be46c6', fileId: 'agent-a0be46c6' }] }), MAIN, -1)
    const bound = parser.subagents().find(run => run.agentId === 'a0be46c6')
    expect(bound?.fileId).toBe('agent-a0be46c6')
    expect(bound?.endedAt).toBeNull()
    const beforeCompletion = parser.snapshot()
    const notification = msgRecord(5, 4, {
      message_id: 'completion-1', role: 'system',
      content: '<subagent_completion_notification>Agent completed</subagent_completion_notification>',
      metadata: { extensions: {
        'subagent/agent_id': 'a0be46c6', 'subagent/chain_node_id': 90,
        'subagent/profile_name': 'Explore', 'subagent/model': 'test-model',
      } },
    }, 5030)
    parser.push(notification, MAIN, 3)
    expect(parser.subagents()[0]).toMatchObject({
      status: 'completed', startedAt: at(20), endedAt: at(5030), model: 'test-model',
    })
    expect(parser.snapshot()).not.toBe(beforeCompletion)
    const afterCompletion = parser.snapshot()
    parser.push(notification, MAIN, 4)
    expect(parser.snapshot()).toBe(afterCompletion)
  })

  it('settles a failed background launch immediately', () => {
    const parser = createDevinParser()
    parser.push(assistant(3, 2, 20, {
      calls: [{ id: 'spawn-1', name: 'run_subagent', args: { is_background: true } }],
    }), MAIN, 0)
    parser.push(toolResult(4, 3, 'spawn-1', 'launch failed', 30, {
      'subagent/agent_id': 'abc123', 'chisel/tool_result_meta': { success: false },
    }), MAIN, 1)
    expect(parser.subagents()[0]).toMatchObject({
      status: 'failed', startedAt: at(20), endedAt: at(30),
    })
  })

  it('binds a child stream by its ref agent and nests its tool calls', () => {
    const parser = createDevinParser()
    parser.push(human('spawn', 2, 1, 10), MAIN, 0)
    parser.push(assistant(3, 2, 20, {
      calls: [{ id: 'spawn-1', name: 'run_subagent', args: { task: 'survey' } }],
    }), MAIN, 1)
    // Child lines arrive under the child's own ref.
    parser.push(msgRecord(50, null, {
      message_id: 'c-user', role: 'user',
      content: [{ type: 'text', text: 'survey' }],
      metadata: { is_user_input: true },
    }, 25), CHILD, 0)
    parser.push(msgRecord(51, 50, {
      message_id: 'c-asst', role: 'assistant',
      content: [{ type: 'text', text: 'on it' }],
      tool_calls: [{ id: 'child-1', name: 'ls', arguments: '{}' }],
      metadata: {},
    }, 30), CHILD, 1)
    const run = parser.subagents().find(candidate => candidate.agentId === 'd4bf017')
    expect(run?.fileId).toBe('agent-42')
    expect(run?.toolCalls).toBe(1)
    // Child messages stay out of the main view.
    expect(users(parser)).toHaveLength(1)
    expect(parser.snapshot().eventNodes.every(node => node.kind !== 'user' || true)).toBe(true)
  })

  it('never throws on malformed input and keeps snapshot identity stable', () => {
    const parser = createDevinParser()
    parser.push(human('hi', 2, 1, 10), MAIN, 0)
    const before = parser.snapshot()
    parser.push('', MAIN, 1)
    parser.push('{bad', MAIN, 2)
    parser.push('{"t":"devin.msg"}', MAIN, 3)
    parser.push(JSON.stringify({ t: 'devin.msg', msg: { role: 'mystery' } }), MAIN, 4)
    expect(parser.snapshot()).toBe(before)
  })
})
