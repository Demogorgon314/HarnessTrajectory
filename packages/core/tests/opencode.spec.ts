import { describe, expect, it } from 'vitest'
import {
  createOpencodeParser, opencodeChildTitle, opencodeTextOf, opencodeUsage,
  opencodeUserClass, parseOpencodeLine,
} from '../src/adapters/opencode.ts'
import type { SessionFileRef } from '../src/session.ts'
import type {
  AssistantMessageNode, AssistantRequestView, CompactionRequestView,
  CompactionSummaryNode, ContextMessageNode, ToolResultNode, TurnErrorNode,
  UserMessageNode,
} from '../src/contract.ts'

type Parser = ReturnType<typeof createOpencodeParser>

const SESSION_ID = 'ses_main'
const CHILD_ID = 'ses_child'
const T0 = Date.parse('2026-09-13T00:00:00.000Z')

const MAIN: SessionFileRef = {
  id: SESSION_ID,
  role: 'main',
  path: `opencode://sessions/${SESSION_ID}`,
}
const CHILD: SessionFileRef = {
  id: CHILD_ID,
  role: 'child',
  path: `opencode://sessions/${SESSION_ID}/${CHILD_ID}`,
  parentId: SESSION_ID,
  agent: { agentId: CHILD_ID, agentType: 'explore' },
}

function at(offsetMs: number): number {
  return T0 + offsetMs
}

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record)
}

function sessionLine(overrides: Record<string, unknown> = {}): string {
  return line({
    t: 'opencode.session',
    time: at(0),
    session: {
      id: SESSION_ID,
      slug: 'main',
      directory: '/work/project',
      title: 'Fix the flaky spec',
      version: '1.18.31',
      model: { id: 'claude-opus', providerID: 'anthropic' },
      timeUpdated: at(5000),
      cost: 0.5,
      tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 3 },
    },
    children: [],
    ...overrides,
  })
}

function userMessage(
  id: string,
  parts: readonly Record<string, unknown>[],
  offset: number,
  msgExtra: Record<string, unknown> = {},
): string {
  return line({
    t: 'opencode.message',
    time: at(offset),
    id,
    msg: {
      role: 'user',
      time: { created: at(offset) },
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude-opus' },
      ...msgExtra,
    },
    parts,
  })
}

function textPart(id: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'text', text, ...extra }
}

function assistantHeader(
  id: string,
  offset: number,
  msgExtra: Record<string, unknown> = {},
): string {
  return line({
    t: 'opencode.message',
    time: at(offset),
    id,
    msg: {
      role: 'assistant',
      parentID: 'msg_user',
      mode: 'build',
      agent: 'build',
      path: { cwd: '/work/project', root: '/work/project' },
      modelID: 'claude-opus',
      providerID: 'anthropic',
      time: { created: at(offset) },
      ...msgExtra,
    },
  })
}

function partLine(
  id: string,
  messageID: string,
  part: Record<string, unknown>,
  offset: number,
): string {
  return line({ t: 'opencode.part', time: at(offset), id, messageID, part })
}

function finishLine(
  id: string,
  msg: Record<string, unknown>,
  offset: number,
): string {
  return line({ t: 'opencode.finish', time: at(offset), id, msg })
}

function finishMsg(finish: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    parentID: 'msg_user',
    modelID: 'claude-opus',
    providerID: 'anthropic',
    finish,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 10 } },
    cost: 0.01,
    time: { created: at(10), completed: at(50) },
    ...extra,
  }
}

function toolPart(callID: string, tool: string, state: Record<string, unknown>): Record<string, unknown> {
  return { type: 'tool', callID, tool, state }
}

function feed(parser: Parser, lines: readonly string[], file: SessionFileRef = MAIN): void {
  lines.forEach((entry, index) => { parser.push(entry, file, index) })
}

function nodeKinds(parser: Parser): string[] {
  return parser.snapshot().eventNodes.map(node => node.kind)
}

describe('parseOpencodeLine', () => {
  it('parses every wire tag', () => {
    expect(parseOpencodeLine(sessionLine())?.tag).toBe('session')
    expect(parseOpencodeLine(userMessage('msg_u1', [textPart('prt_1', 'hi')], 10))?.tag).toBe('message')
    expect(parseOpencodeLine(partLine('prt_2', 'msg_a1', textPart('prt_2', 'x'), 20))?.tag).toBe('part')
    expect(parseOpencodeLine(finishLine('msg_a1', finishMsg('stop'), 30))?.tag).toBe('finish')
    expect(parseOpencodeLine(line({
      t: 'opencode.prune', time: at(40), id: 'prt_9', messageID: 'msg_a1', callID: 'call_9',
    }))).toMatchObject({ tag: 'prune', id: 'prt_9', messageID: 'msg_a1', callID: 'call_9' })
  })

  it('exposes message parts only on user headers', () => {
    const record = parseOpencodeLine(userMessage('msg_u1', [textPart('prt_1', 'hi')], 10))
    expect(record).toMatchObject({ tag: 'message', id: 'msg_u1' })
    if (record?.tag !== 'message') return
    expect(record.parts).toHaveLength(1)
    const header = parseOpencodeLine(assistantHeader('msg_a1', 20))
    if (header?.tag !== 'message') return
    expect(header.parts).toHaveLength(0)
  })

  it('returns null for malformed input', () => {
    expect(parseOpencodeLine('')).toBeNull()
    expect(parseOpencodeLine('not json')).toBeNull()
    expect(parseOpencodeLine('{"t":"nope"}')).toBeNull()
    expect(parseOpencodeLine('{"t":"opencode.part","id":"prt_1"}')).toBeNull()
  })
})

describe('opencodeUserClass', () => {
  const msg = { role: 'user' }

  it('is human when any text part is non-synthetic, even with a synthetic reminder appended', () => {
    const parts = [
      textPart('prt_1', 'fix the bug'),
      textPart('prt_2', '[search-mode] reminder', { synthetic: true }),
    ]
    expect(opencodeUserClass(msg, parts)).toEqual({ kind: 'human' })
  })

  it('is an injection when every text part is synthetic', () => {
    const parts = [textPart('prt_1', 'continue', { synthetic: true, metadata: { compaction_continue: true } })]
    expect(opencodeUserClass(msg, parts)).toEqual({ kind: 'injection', name: 'compaction-continue' })
  })

  it('is compaction when the message carries a compaction part', () => {
    const parts = [
      { id: 'prt_1', type: 'compaction', auto: true, tail_start_id: 'msg_x' },
      textPart('prt_2', 'summarize', { synthetic: true }),
    ]
    expect(opencodeUserClass(msg, parts)).toEqual({ kind: 'compaction' })
  })

  it('is human when only file parts exist', () => {
    const parts = [{ id: 'prt_1', type: 'file', mime: 'text/plain', url: 'file:///tmp/a.txt', filename: 'a.txt' }]
    expect(opencodeUserClass(msg, parts)).toEqual({ kind: 'human' })
  })
})

describe('opencodeUsage', () => {
  it('maps disjoint buckets: output gains reasoning, total falls back to the sum', () => {
    expect(opencodeUsage({
      input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 10 }, total: 1035,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      reasoningTokens: 5,
      cacheReadTokens: 900,
      cacheWriteTokens: 10,
      totalTokens: 1035,
    })
    expect(opencodeUsage({
      input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 10 },
    })).toMatchObject({ outputTokens: 25, totalTokens: 1035 })
  })

  it('is undefined without any bucket', () => {
    expect(opencodeUsage(undefined)).toBeUndefined()
    expect(opencodeUsage({})).toBeUndefined()
  })
})

describe('opencodeTextOf / opencodeChildTitle', () => {
  it('joins non-synthetic text parts only', () => {
    expect(opencodeTextOf([
      textPart('p1', 'a'),
      textPart('p2', 'b', { synthetic: true }),
      textPart('p3', 'c'),
    ])).toBe('a\nc')
  })

  it('strips subagent suffix and background prefix from child titles', () => {
    expect(opencodeChildTitle('Investigate auth bug (@explore subagent)')).toBe('Investigate auth bug')
    expect(opencodeChildTitle('Background: Run the suite')).toBe('Run the suite')
  })
})

describe('createOpencodeParser', () => {
  it('folds a full turn: user → header → parts → finish tool-calls → second header → finish stop', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      sessionLine(),
      userMessage('msg_u1', [textPart('prt_u1', 'fix the flaky spec')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', { type: 'reasoning', text: 'think', time: { start: at(22), end: at(24) } }, 22),
      partLine('prt_a2', 'msg_a1', { type: 'text', text: 'running the tool', time: { start: at(25), end: at(26) } }, 25),
      partLine('prt_a3', 'msg_a1', toolPart('call_1', 'bash', {
        status: 'completed',
        input: { command: 'pnpm test' },
        output: 'all green',
        title: 'run tests',
        metadata: { foo: 1 },
        time: { start: at(30), end: at(40) },
      }), 30),
      finishLine('msg_a1', finishMsg('tool-calls', { time: { created: at(20), completed: at(50) } }), 50),
      assistantHeader('msg_a2', 60),
      partLine('prt_b1', 'msg_a2', { type: 'text', text: 'done', time: { start: at(62), end: at(64) } }, 62),
      finishLine('msg_a2', finishMsg('stop', { time: { created: at(60), completed: at(70) } }), 70),
    ])

    const snapshot = parser.snapshot()
    const user = snapshot.eventNodes.find((node): node is UserMessageNode => node.kind === 'user')
    expect(user?.content).toEqual([{ type: 'text', text: 'fix the flaky spec' }])

    const assistants = snapshot.eventNodes.filter((node): node is AssistantMessageNode => node.kind === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0]?.blocks.map(block => block.kind)).toEqual(['reasoning', 'text', 'tool-call'])
    expect(assistants[0]?.timing).toEqual({ stepStartTime: at(20), firstTokenTime: at(22), completedTime: at(50) })
    expect(assistants[0]?.usage).toMatchObject({ inputTokens: 100, outputTokens: 25, reasoningTokens: 5 })

    const result = snapshot.eventNodes.find((node): node is ToolResultNode => node.kind === 'tool-result')
    expect(result).toMatchObject({
      callId: 'call_1',
      isError: false,
      content: [{ type: 'text', text: 'all green' }],
      meta: { title: 'run tests', durationMs: 10, metadata: { foo: 1 } },
    })

    const requests = snapshot.requests.filter((view): view is AssistantRequestView => view.purpose === 'assistant')
    expect(requests).toHaveLength(2)
    expect(requests.every(view => view.status === 'complete')).toBe(true)
    expect(requests[0]?.requestConfig).toEqual({ provider: 'anthropic', model: 'claude-opus' })

    // The turn closed on 'stop': every node in turn 1 reports a closed location.
    const location = snapshot.eventLocations.get(assistants[0]!.seq)
    expect(location).toEqual({ kind: 'turn', turn: { turn: 1, status: 'closed' } })

    expect(parser.meta()).toMatchObject({
      title: 'Fix the flaky spec',
      cwd: '/work/project',
      model: 'claude-opus',
      promptCount: 1,
    })
  })

  it('keeps the turn open across a tool-calls finish until a non-tool-calls finish', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      finishLine('msg_a1', finishMsg('tool-calls'), 30),
    ])
    const assistant = parser.snapshot().eventNodes.find(node => node.kind === 'assistant')
    expect(parser.snapshot().eventLocations.get(assistant!.seq))
      .toEqual({ kind: 'turn', turn: { turn: 1, status: 'open' } })
    feed(parser, [
      assistantHeader('msg_a2', 40),
      finishLine('msg_a2', finishMsg('stop'), 50),
    ])
    expect(parser.snapshot().eventLocations.get(assistant!.seq))
      .toEqual({ kind: 'turn', turn: { turn: 1, status: 'closed' } })
  })

  it('folds an error finish into a request error plus a turn-error node', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      finishLine('msg_a1', finishMsg('stop', {
        error: { name: 'APIError', data: { message: 'provider exploded' } },
      }), 30),
    ])
    const snapshot = parser.snapshot()
    const request = snapshot.requests.find((view): view is AssistantRequestView => view.purpose === 'assistant')
    expect(request).toMatchObject({ status: 'error', error: 'provider exploded', errorCode: 'APIError' })
    const turnError = snapshot.eventNodes.find((node): node is TurnErrorNode => node.kind === 'turn-error')
    expect(turnError).toMatchObject({ message: 'provider exploded', code: 'APIError' })
  })

  it('marks MessageAbortedError as interrupted without a turn-error node', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      finishLine('msg_a1', finishMsg('stop', {
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      }), 30),
    ])
    const assistant = parser.snapshot().eventNodes
      .find((node): node is AssistantMessageNode => node.kind === 'assistant')
    expect(assistant?.interrupted).toBe(true)
    expect(nodeKinds(parser)).not.toContain('turn-error')
  })

  it('binds a task tool part to a subagent run via state.metadata.sessionId', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', toolPart('call_1', 'task', {
        status: 'completed',
        input: { description: 'explore the repo', subagent_type: 'explore' },
        output: 'found it',
        title: 'explore the repo',
        metadata: { sessionId: CHILD_ID, model: { modelID: 'claude-haiku' } },
        time: { start: at(30), end: at(40) },
      }), 30),
    ])
    expect(parser.subagents()).toEqual([expect.objectContaining({
      agentId: CHILD_ID,
      fileId: CHILD_ID,
      callId: 'call_1',
      description: 'explore the repo',
      agentType: 'explore',
      model: 'claude-haiku',
      status: 'completed',
      startedAt: at(30),
    })])
  })

  it('keeps a background spawn running until the child stream finishes', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', toolPart('call_1', 'task', {
        status: 'completed',
        input: { description: 'watch the suite', subagent_type: 'monitor' },
        output: 'launched',
        metadata: { sessionId: CHILD_ID, background: true },
        time: { start: at(30), end: at(40) },
      }), 30),
      finishLine('msg_a1', finishMsg('stop'), 50),
    ])
    expect(parser.subagents()[0]).toMatchObject({ status: 'running' })

    feed(parser, [
      partLine('prt_c1', 'msg_ca', toolPart('call_c1', 'bash', {
        status: 'completed', input: { command: 'ls' }, output: 'ok',
        time: { start: at(60), end: at(65) },
      }), 60),
      finishLine('msg_ca', finishMsg('stop'), 70),
    ], CHILD)

    const run = parser.subagents().find(candidate => candidate.agentId === CHILD_ID)
    expect(run).toMatchObject({ status: 'completed', toolCalls: 1, endedAt: at(70) })
  })

  it('folds a compaction sequence into a compaction request and summary node, not an assistant step', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      userMessage('msg_u1', [textPart('prt_u1', 'work on stuff')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', { type: 'text', text: 'working', time: { start: at(22), end: at(24) } }, 22),
      finishLine('msg_a1', finishMsg('stop'), 30),
      userMessage('msg_c1', [
        { id: 'prt_c0', type: 'compaction', auto: true, tail_start_id: 'msg_u1' },
      ], 40),
      assistantHeader('msg_s1', 50, { summary: true }),
      partLine('prt_s1', 'msg_s1', { type: 'text', text: 'summary of the work', time: { start: at(52), end: at(54) } }, 52),
      finishLine('msg_s1', finishMsg('stop', { summary: true, time: { created: at(50), completed: at(60) } }), 60),
    ])
    const snapshot = parser.snapshot()
    const compaction = snapshot.requests.find((view): view is CompactionRequestView => view.purpose === 'compaction')
    expect(compaction).toMatchObject({
      status: 'complete',
      summary: [{ type: 'text', text: 'summary of the work' }],
    })
    const node = snapshot.eventNodes.find((event): event is CompactionSummaryNode => event.kind === 'compaction')
    expect(node).toMatchObject({ summary: 'summary of the work', shadowedTokenCount: null })
    // The summary message is not an assistant step: only msg_a1 folded one.
    expect(snapshot.eventNodes.filter(event => event.kind === 'assistant')).toHaveLength(1)
    expect(snapshot.requests.filter(view => view.purpose === 'assistant')).toHaveLength(1)
  })

  it('flushes a still-open assistant as incomplete when the next header arrives', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', { type: 'text', text: 'partial', time: { start: at(22), end: at(24) } }, 22),
      assistantHeader('msg_a2', 30),
      finishLine('msg_a2', finishMsg('stop'), 40),
    ])
    const requests = parser.snapshot().requests
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ status: 'error', error: 'incomplete' })
    expect(requests[1]).toMatchObject({ status: 'complete' })
  })

  it('folds a synthetic injection user message into a context node only', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      userMessage('msg_i1', [
        textPart('prt_i1', 'resume after compaction', { synthetic: true, metadata: { compaction_continue: true } }),
      ], 10),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes).toHaveLength(1)
    const context = snapshot.eventNodes[0] as ContextMessageNode
    expect(context).toMatchObject({
      kind: 'context',
      provenance: { role: 'inject', label: 'compaction-continue' },
    })
    expect(parser.meta().promptCount).toBe(0)
  })

  it('resolves transcript lines through snapshot().sourceLines', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      sessionLine(),
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', toolPart('call_1', 'bash', {
        status: 'completed', input: { command: 'ls' }, output: 'ok',
        time: { start: at(30), end: at(40) },
      }), 30),
      finishLine('msg_a1', finishMsg('stop'), 50),
    ])
    const snapshot = parser.snapshot()
    const assistant = snapshot.eventNodes.find((node): node is AssistantMessageNode => node.kind === 'assistant')
    // The header line resolves to the assistant record it opened.
    expect(snapshot.sourceLines?.targetAt(2)).toEqual({ kind: 'seq', seq: assistant!.seq })
    // The tool part line resolves to the call.
    expect(snapshot.sourceLines?.targetAt(3)).toEqual({ kind: 'call', callId: 'call_1' })
  })

  it('ignores a stray part addressed to a user message — never a phantom assistant', () => {
    const parser = createOpencodeParser()
    feed(parser, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      // The emission plan's anomaly append: a part row that lands after its
      // (user) message closed. It must not open an assistant step.
      partLine('prt_late', 'msg_u1', { type: 'text', text: 'late text', time: { start: at(20), end: at(21) } }, 20),
      finishLine('msg_u1', { role: 'user', time: { created: at(10) } }, 30),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes).toHaveLength(1)
    expect(snapshot.eventNodes[0]?.kind).toBe('user')
    expect(snapshot.requests.filter(request => request.purpose === 'assistant')).toHaveLength(0)
  })
})
