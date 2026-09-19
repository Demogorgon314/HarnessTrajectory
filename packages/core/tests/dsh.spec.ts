/**
 * dsh adapter — synthetic fixtures only.
 *
 * Every record below is hand-written with the REAL dsh wire field names
 * (`seq`, `time`, `surfaceOp`, `sourceEventSeqs`, `seq0`/`time0`/`dt`, …) and
 * fake payloads. Times are epoch MILLISECONDS everywhere — the format never
 * uses ISO strings.
 */

import { describe, expect, it } from 'vitest'
import { createDshParser } from '../src/adapters/dsh.ts'
import {
  dshFirstTokenTime, dshReplaceRange, dshSubagentIdOf, dshTextOf,
  dshUsageOf, dshUserClass, expandDshStreamRun, parseDshLine,
} from '../src/adapters/dsh-protocol.ts'
import type { SessionFileRef, SessionParser } from '../src/session.ts'
import type {
  AssistantMessageNode, AssistantRequestView, CommandNode, CompactionRequestView,
  CompactionSummaryNode, ContextMessageNode, ModelRetryNode, SteeringMessageNode,
  ToolResultNode, TurnErrorNode, TurnMaxTokensNode, UserMessageNode,
} from '../src/contract.ts'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

const MAIN: SessionFileRef = {
  id: 'session-1',
  role: 'main',
  path: '/tmp/--work-project--/session-1/session.v3.jsonl',
}

interface Extra { [key: string]: unknown }

let seq = 0
function ev(type: string, offsetMs: number, data: Extra = {}, rest: Extra = {}): Extra {
  seq += 1
  return { type, seq, time: T0 + offsetMs, data, ...rest }
}

const header = (extra: Extra = {}): Extra => ({
  type: 'session', version: 3, id: 'session-1', createdAt: T0, cwd: '/work/project', ...extra,
})

function feed(parser: SessionParser, records: readonly unknown[], file: SessionFileRef = MAIN): void {
  records.forEach((record, index) => {
    parser.push(typeof record === 'string' ? record : JSON.stringify(record), file, index)
  })
}

function fresh(): SessionParser {
  seq = 0
  return createDshParser()
}

function nodesOf(parser: SessionParser, kind: string) {
  return parser.snapshot().eventNodes.filter(node => node.kind === kind)
}

const userSource = { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Asia/Shanghai' }

function userMessage(offsetMs: number, text: string, rest: Extra = {}): Extra {
  return ev('user/message', offsetMs, {
    content: [{ type: 'text', text }],
    source: userSource,
    role: 'user',
    id: `m-${seq + 1}`,
    ...rest,
  }, { surfaceOp: 'append' })
}

function assistantMessage(offsetMs: number, content: readonly Extra[], rest: Extra = {}): Extra {
  return ev('assistant/message', offsetMs, {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'deepseek-official', model: 'dsh-v4' },
      id: `a-${seq + 1}`,
    },
    usage: { inputTokens: 1101, outputTokens: 340, cacheReadTokens: 5, reasoningTokens: 300 },
    ...rest,
  })
}

describe('parseDshLine', () => {
  it('parses the session header with optional fields', () => {
    const record = parseDshLine(JSON.stringify({
      type: 'session', version: 3, id: 's-1', createdAt: T0, cwd: '/w',
      parentSession: 'p-1', isSeeded: true, origin: 'subagent',
      delegationDepth: 1, agentPreset: 'worker',
    }))
    expect(record).toEqual({
      tag: 'header',
      header: {
        version: 3, id: 's-1', createdAt: T0, cwd: '/w', parentSession: 'p-1',
        isSeeded: true, origin: 'subagent', delegationDepth: 1, agentPreset: 'worker',
      },
    })
  })

  it('parses a bare header without the optional fields', () => {
    const record = parseDshLine(JSON.stringify({ type: 'session', version: 0, id: 's-2' }))
    expect(record).toEqual({
      tag: 'header',
      header: { version: 0, id: 's-2', createdAt: null, isSeeded: false },
    })
  })

  it('parses an event envelope and expands compressed sourceEventSeqs runs', () => {
    const record = parseDshLine(JSON.stringify({
      type: 'tool/result', seq: 9, time: 42, data: { turn: 1 },
      surfaceOp: 'append', sourceEventSeqs: [[3, 7], 9],
    }))
    expect(record).toEqual({
      tag: 'event',
      event: {
        type: 'tool/result', seq: 9, time: 42, data: { turn: 1 },
        surfaceOp: 'append', sourceEventSeqs: [3, 4, 5, 6, 7, 9],
      },
    })
  })

  it('parses a packed stream row as a run', () => {
    const record = parseDshLine(JSON.stringify({
      type: 'text-chunks', seq0: 20, time0: 100,
      data: { turn: 1, step: 1, index: 0, dt: [8, 4], texts: ['a', 'b', 'c'] },
    }))
    expect(record).toEqual({
      tag: 'run',
      run: {
        type: 'text-chunks', seq0: 20, time0: 100,
        data: { turn: 1, step: 1, index: 0, dt: [8, 4], texts: ['a', 'b', 'c'] },
      },
    })
  })

  it('returns null for blank, malformed, non-object, or type-less lines', () => {
    expect(parseDshLine('')).toBeNull()
    expect(parseDshLine('   ')).toBeNull()
    expect(parseDshLine('not json')).toBeNull()
    expect(parseDshLine('42')).toBeNull()
    expect(parseDshLine('[1,2]')).toBeNull()
    expect(parseDshLine('{"data":{}}')).toBeNull()
  })
})

describe('expandDshStreamRun', () => {
  it('expands a reasoning run to cumulative-time chunk events', () => {
    const events = expandDshStreamRun({
      type: 'reasoning-chunks', seq0: 20, time0: 1000,
      data: { turn: 1, step: 1, index: 0, dt: [82, 18, 1], texts: ['The', ' user', ' wants', ' an'] },
    })
    expect(events.map(event => event.seq)).toEqual([20, 21, 22, 23])
    expect(events.map(event => event.time)).toEqual([1000, 1082, 1100, 1101])
    expect(events.every(event => event.type === 'assistant/chunk')).toBe(true)
    expect(events[0]?.data['chunk']).toEqual({ type: 'reasoning-delta', index: 0, text: 'The' })
    expect(events[0]?.data['turn']).toBe(1)
  })

  it('puts the call name only on the first tool-call member', () => {
    const events = expandDshStreamRun({
      type: 'tool-call-chunks', seq0: 30, time0: 2000,
      data: { turn: 1, step: 1, index: 1, dt: [4], id: 'call_9', name: 'bash', args: ['{"command"', ':"ls"}'] },
    })
    expect(events.map(event => event.seq)).toEqual([30, 31])
    expect(events.map(event => event.time)).toEqual([2000, 2004])
    expect(events[0]?.data['chunk']).toEqual({
      type: 'tool-call-delta', index: 1, id: 'call_9', name: 'bash', argumentsDelta: '{"command"',
    })
    expect(events[1]?.data['chunk']).toEqual({
      type: 'tool-call-delta', index: 1, id: 'call_9', argumentsDelta: ':"ls"}',
    })
  })

  it('serves embedded v2 records with fields at top level and no seqs', () => {
    const events = expandDshStreamRun({
      type: 'text-chunks', time0: 500, index: 2, dt: [7], texts: ['x', 'y'],
    })
    expect(events.map(event => event.seq)).toEqual([0, 1])
    expect(events.map(event => event.time)).toEqual([500, 507])
  })
})

describe('shared readers', () => {
  it('reads both replace spellings and rejects hostile ops', () => {
    expect(dshReplaceRange({ op: 'replace', startSeq: 7, endSeq: 7 })).toEqual({ start: 7, end: 7 })
    expect(dshReplaceRange({ op: 'replace', start: 4, end: 8 })).toEqual({ start: 4, end: 8 })
    expect(dshReplaceRange('append')).toBeNull()
    expect(dshReplaceRange({ op: 'append' })).toBeNull()
    expect(dshReplaceRange({ op: 'replace', startSeq: 'x', endSeq: 7 })).toBeNull()
    expect(dshReplaceRange(null)).toBeNull()
  })

  it('classifies user messages structurally', () => {
    const human = { data: { source: { kind: 'user' } } }
    const injected = { data: { source: { kind: 'skill-catalog', form: 'catalog' } } }
    const compaction = {
      data: { source: { kind: 'plugin' } },
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 9 },
    }
    expect(dshUserClass(human)).toBe('human')
    expect(dshUserClass(injected)).toBe('injection')
    expect(dshUserClass(compaction)).toBe('compaction')
    expect(dshUserClass({ data: {} })).toBe('injection')
  })

  it('joins text blocks and reads disjoint usage buckets', () => {
    expect(dshTextOf([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'x' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(dshTextOf('plain')).toBe('plain')
    expect(dshUsageOf({
      inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 30,
    })).toEqual({
      inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 30,
    })
    expect(dshUsageOf({})).toBeUndefined()
    expect(dshUsageOf('x')).toBeUndefined()
  })

  it('finds the first token instant inside an embedded stream', () => {
    const stream = [
      { type: 'chunk', time: 80, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'reasoning-chunks', time0: 82, index: 0, dt: [10], texts: ['', 'tok'] },
      { type: 'chunk', time: 999, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ]
    // The block-start is not a token; the run's first NONEMPTY member lands at time0 + dt[0].
    expect(dshFirstTokenTime(stream)).toBe(92)
    expect(dshFirstTokenTime([{ type: 'chunk', time: 5, chunk: { type: 'usage', usage: {} } }])).toBeUndefined()
    expect(dshFirstTokenTime('nope')).toBeUndefined()
  })

  it('binds a continuable subagent result text', () => {
    expect(dshSubagentIdOf('started subagent abc-123')).toBe('abc-123')
    expect(dshSubagentIdOf('started background subagent job j-1')).toBeUndefined()
    expect(dshSubagentIdOf('some output')).toBeUndefined()
  })
})

describe('dsh adapter — v3 session', () => {
  function v3Session(): unknown[] {
    seq = 0
    return [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('system/message', 20, {
        turn: 1, step: 1,
        message: { role: 'system', source: { kind: 'plugin' }, content: [] },
      }, { surfaceOp: 'append' }),
      userMessage(30, 'Fix the build'),
      ev('system/message', 40, {
        turn: 1, step: 1,
        message: { role: 'system', content: [{ type: 'text', text: 'You are dsh.' }] },
      }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] }),
      ev('request/header', 50, {
        header: {
          config: { provider: 'deepseek-official', model: 'dsh-v4', reasoningEffort: 'max', maxTokens: 256000 },
          tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
        },
        reason: 'initial',
      }),
      ev('request/context', 55, {
        provider: 'deepseek-official', model: 'dsh-v4', contextWindow: 1000000,
      }),
      ev('session/title', 60, { title: 'Fix the build', source: { kind: 'provider' } }),
      assistantMessage(100, [
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"pwd"}' },
      ], {
        stream: [
          { type: 'chunk', time: T0 + 80, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
          { type: 'reasoning-chunks', time0: T0 + 82, index: 0, dt: [10], texts: ['think', 'ing'] },
          { type: 'chunk', time: T0 + 95, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
        ],
      }),
      ev('tool/call', 110, { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"pwd"}' }),
      ev('tool/result', 120, {
        turn: 1, step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_1' },
          content: [{
            type: 'tool-result', toolCallId: 'call_1',
            content: [{ type: 'text', text: '/work/project' }], isError: false,
          }],
          role: 'user', id: 'r-1',
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [10] }),
      ev('step/end', 130, { turn: 1, step: 1 }),
      ev('step/start', 140, { turn: 1, step: 2 }),
      ev('request/header', 145, {
        header: {
          config: { provider: 'deepseek-official', model: 'dsh-v4', reasoningEffort: 'max', maxTokens: 256000 },
          tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
        },
        reason: 'series',
      }),
      ev('assistant/message', 160, {
        turn: 1, step: 2,
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'dsh-v4' }, id: 'a-2',
        },
        usage: { inputTokens: 1200, outputTokens: 3 },
      }),
      ev('step/end', 170, { turn: 1, step: 2 }),
      ev('turn/end', 180, { turn: 1, reason: { kind: 'completed' } }),
    ]
  }

  it('folds a full turn into nodes, requests, prompt state, and locations', () => {
    const parser = fresh()
    feed(parser, v3Session())
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual([
      'user', 'assistant', 'tool-result', 'assistant',
    ])
    const user = snapshot.eventNodes[0] as UserMessageNode
    expect(user.content).toEqual([{ type: 'text', text: 'Fix the build' }])

    const first = snapshot.eventNodes[1] as AssistantMessageNode
    expect(first.blocks).toEqual([
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'tool-call', callId: 'call_1', name: 'bash', argsRaw: '{"command":"pwd"}' },
    ])
    expect(first.usage).toEqual({
      inputTokens: 1101, outputTokens: 340, cacheReadTokens: 5, reasoningTokens: 300,
    })
    expect(first.provenance).toEqual({ provider: 'deepseek-official', model: 'dsh-v4' })
    expect(first.timing).toEqual({
      stepStartTime: T0 + 10,
      firstTokenTime: T0 + 82,
      completedTime: T0 + 100,
    })
    expect(first.requestConfig).toMatchObject({
      provider: 'deepseek-official', model: 'dsh-v4', reasoningEffort: 'max', maxTokens: 256000,
    })

    const result = snapshot.eventNodes[2] as ToolResultNode
    expect(result.callId).toBe('call_1')
    expect(result.call).toEqual({ name: 'bash', argsRaw: '{"command":"pwd"}' })
    expect(result.content).toEqual([{ type: 'text', text: '/work/project' }])
    expect(result.isError).toBe(false)

    expect(snapshot.requests).toHaveLength(2)
    const request = snapshot.requests[0] as AssistantRequestView
    expect(request.status).toBe('complete')
    expect(request.turn).toBe(1)
    expect(request.step).toBe(1)
    expect(request.usage?.inputTokens).toBe(1101)
    expect(request.resultSeq).toBe(first.seq)
    expect(request.prompt?.system).toBe('You are dsh.')
    expect(request.prompt?.tools).toEqual([
      { name: 'bash', description: 'run a command', parameters: { type: 'object' } },
    ])
    expect(request.prompt?.config.model).toBe('dsh-v4')
    expect(request.promptChange?.kind).toBe('initial')
    // The prompt snapshot carries over with no change marker.
    const second = snapshot.requests[1] as AssistantRequestView
    expect(second.step).toBe(2)
    expect(second.prompt?.system).toBe('You are dsh.')
    expect(second.promptChange).toBeUndefined()

    expect(snapshot.systemPrompts).toEqual([
      expect.objectContaining({ text: 'You are dsh.', update: false }),
    ])
    expect(snapshot.callSchemas.get('call_1')?.name).toBe('bash')

    const userLocation = snapshot.eventLocations.get(user.seq)
    expect(userLocation).toEqual({ kind: 'step', turn: { turn: 1, status: 'closed' }, step: { step: 1 } })
    const secondLocation = snapshot.eventLocations.get((snapshot.eventNodes[3] as AssistantMessageNode).seq)
    expect(secondLocation).toEqual({ kind: 'step', turn: { turn: 1, status: 'closed' }, step: { step: 2 } })

    expect(snapshot.partial).toBeNull()
    expect(snapshot.runningCalls).toEqual([])
    expect(parser.meta()).toEqual({
      title: 'Fix the build',
      cwd: '/work/project',
      model: 'dsh-v4',
      startedAt: T0,
      promptCount: 1,
    })
  })

  it('marks a second human message inside the open turn as steering', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      userMessage(20, 'first prompt'),
      ev('step/end', 30, { turn: 1, step: 1 }),
      userMessage(40, 'while you are at it'),
    ])
    const kinds = parser.snapshot().eventNodes.map(node => node.kind)
    expect(kinds).toEqual(['user', 'steering'])
    const steering = nodesOf(parser, 'steering')[0] as SteeringMessageNode
    expect(steering.content).toEqual([{ type: 'text', text: 'while you are at it' }])
    expect(parser.meta().promptCount).toBe(1)
  })

  it('folds an injected user message into a context node', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('user/message', 20, {
        content: [{ type: 'text', text: '## Skills\n- reviewer' }],
        source: { kind: 'skill-catalog', form: 'catalog' },
        role: 'user', id: 'inj-1',
      }, { surfaceOp: 'append' }),
    ])
    const node = nodesOf(parser, 'context')[0] as ContextMessageNode
    expect(node.form).toBe('catalog')
    expect(node.provenance).toEqual({ role: 'inject', label: 'skill-catalog' })
    expect(parser.meta().promptCount).toBe(0)
  })

  it('folds the compaction lifecycle into one request and one summary node', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      userMessage(20, 'do some work'),
      assistantMessage(30, [{ type: 'text', text: 'working on it' }]),
      ev('step/end', 40, { turn: 1, step: 1 }),
      ev('compaction/start', 50, { compactionId: 'c-1', turn: 1 }),
      ev('compaction/summary', 60, {
        compactionId: 'c-1',
        summary: [{ type: 'text', text: 'summary of prior work' }],
        shadowedRange: { start: 2, end: 6 },
        shadowedSeqs: [2, 4, 6],
        shadowedTokenCount: 1234,
        provider: 'deepseek-official', model: 'dsh-v4',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      ev('user/message', 70, {
        content: [{ type: 'text', text: 'summary of prior work' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-compaction' },
        role: 'user', id: 'cm-1',
      }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 6 } }),
      ev('compaction/end', 80, { compactionId: 'c-1', turn: 1 }),
    ])
    const requests = parser.snapshot().requests
    expect(requests).toHaveLength(2)
    const compactRequest = requests.find(request => request.purpose === 'compaction') as CompactionRequestView
    expect(compactRequest.status).toBe('complete')
    expect(compactRequest.turn).toBe(1)
    expect(compactRequest.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
    expect(compactRequest.provenance).toEqual({ provider: 'deepseek-official', model: 'dsh-v4' })
    expect(compactRequest.summary).toEqual([{ type: 'text', text: 'summary of prior work' }])
    const node = nodesOf(parser, 'compaction')[0] as CompactionSummaryNode
    expect(node.summary).toBe('summary of prior work')
    expect(node.shadowedItemCount).toBe(3)
    expect(node.shadowedTokenCount).toBe(1234)
    expect(compactRequest.replacementSeq).toBe(node.seq)
    expect(compactRequest.resultSeq).toBe(node.seq)
    // The compaction produced no assistant request.
    expect(requests.filter(request => request.purpose === 'assistant')).toHaveLength(1)
  })

  it('flips a running request and emits turn-error on turn/end error', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('turn/end', 20, {
        turn: 1,
        reason: { kind: 'error', error: { message: 'rate limited', code: 'rate_limit' } },
      }),
    ])
    const node = nodesOf(parser, 'turn-error')[0] as TurnErrorNode
    expect(node.message).toBe('rate limited')
    expect(node.code).toBe('rate_limit')
    const request = parser.snapshot().requests[0] as AssistantRequestView
    expect(request.status).toBe('error')
    expect(request.error).toBe('rate limited')
    expect(request.errorCode).toBe('rate_limit')
  })

  it('emits turn-max-tokens on a max-tokens end reason', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('turn/end', 20, { turn: 1, reason: { kind: 'max-tokens' } }),
    ])
    const node = nodesOf(parser, 'turn-max-tokens')[0] as TurnMaxTokensNode
    expect(node.turn).toBe(1)
    const request = parser.snapshot().requests[0] as AssistantRequestView
    expect(request.status).toBe('error')
    expect(request.error).toBe('max-tokens')
  })

  it('emits scheduled and started model-retry nodes and books retry facts on the request', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('llm/retry', 20, {
        retryId: 'r-1', turn: 1, step: 1, provider: 'deepseek-official',
        mode: 'normal', policyKey: 'p', retry: 1, maxRetries: 3, delayMs: 500,
        failure: { message: 'rate limited', code: '429', status: 429 },
      }),
      ev('llm/retry-started', 30, { retryId: 'r-1', turn: 1, step: 1, retry: 1 }),
    ])
    const retries = nodesOf(parser, 'model-retry') as ModelRetryNode[]
    expect(retries).toHaveLength(2)
    expect(retries[0]).toMatchObject({
      retryState: 'scheduled', provider: 'deepseek-official', retry: 1,
      maxRetries: 3, delayMs: 500, failure: { message: 'rate limited', code: '429', status: 429 },
    })
    expect(retries[1]).toMatchObject({ retryState: 'started', retry: 1, maxRetries: 3, delayMs: 500 })
    const request = parser.snapshot().requests[0] as AssistantRequestView
    expect(request.retry).toBe(1)
    expect(request.maxRetries).toBe(3)
    expect(request.retryDelayMs).toBe(500)
  })

  it('folds command/run + command/done into one command node with an outcome', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('command/run', 10, { commandId: 'cmd-1', name: 'reload', args: '{"target":"web"}' }),
      ev('command/done', 20, { commandId: 'cmd-1', kind: 'success', text: 'reloaded', sourceEventSeq: 2 }),
    ])
    const commands = nodesOf(parser, 'command') as CommandNode[]
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      commandId: 'cmd-1', name: 'reload', args: '{"target":"web"}',
      outcome: { kind: 'success', text: 'reloaded', sourceEventSeq: 2 },
    })
  })

  it('keeps image attachments and resolves them to blobref URLs', () => {
    const parser = fresh()
    const sha = 'ab'.repeat(32)
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('user/message', 20, {
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', attachment: { attachmentId: sha, mediaType: 'image/png', bytes: 4321, width: 10, height: 20 } },
        ],
        source: userSource,
        role: 'user', id: 'img-1',
      }, { surfaceOp: 'append' }),
    ])
    const user = nodesOf(parser, 'user')[0] as UserMessageNode
    const image = user.content[1]
    expect(image?.type).toBe('image')
    if (image?.type !== 'image') return
    expect(image.attachment.attachmentId).toBe(sha)
    expect(image.attachment.mediaType).toBe('image/png')
    expect(parser.imageUrl(image.attachment)).toBe(`blobref:image/png;${sha}`)
  })

  it('leaves the snapshot untouched by ignored records', () => {
    const parser = fresh()
    feed(parser, [header(), ev('turn/start', 0, { turn: 1 }), userMessage(10, 'hi')])
    const before = parser.snapshot()
    feed(parser, [
      ev('permission/preset', 20, { preset: 'default' }),
      ev('agent/inbox/spliced', 30, { count: 2 }),
      ev('a/future/type', 40, { whatever: true }),
      'not json at all',
      '{"type":"event/without-data"}',
    ])
    expect(parser.snapshot()).toBe(before)
  })
})

describe('dsh adapter — request prompt state', () => {
  const sysMsg = (offsetMs: number, text: string, rest: Extra = {}): Extra => ev('system/message', offsetMs, {
    turn: 1, step: 1,
    message: { role: 'system', content: [{ type: 'text', text }] },
  }, rest)

  const reqHeader = (offsetMs: number, reason: string, model = 'dsh-v4', tools: Extra[] = [
    { name: 'bash', description: 'run a command', parameters: { type: 'object' } },
  ]): Extra => ev('request/header', offsetMs, {
    header: { config: { provider: 'deepseek-official', model }, tools },
    reason,
  })

  it('applies the header to the CURRENT request and inherits it into a header-less step', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      sysMsg(20, 'You are dsh.', { surfaceOp: 'append' }),
      reqHeader(30, 'initial'),
      ev('assistant/message', 40, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'first' }], id: 'a-1' },
        usage: { inputTokens: 10, outputTokens: 1 },
      }),
      ev('step/end', 50, { turn: 1, step: 1 }),
      // Step 2 logs NO request/header — it inherits the effective snapshot.
      ev('step/start', 60, { turn: 1, step: 2 }),
      ev('assistant/message', 70, {
        turn: 1, step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: 'second' }], id: 'a-2' },
        usage: { inputTokens: 20, outputTokens: 1 },
      }),
      ev('step/end', 80, { turn: 1, step: 2 }),
      ev('turn/end', 90, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const [first, second] = parser.snapshot().requests as AssistantRequestView[]
    expect(first?.prompt?.system).toBe('You are dsh.')
    expect(first?.prompt?.tools.map(tool => tool.name)).toEqual(['bash'])
    expect(first?.prompt?.config.model).toBe('dsh-v4')
    expect(first?.promptChange?.kind).toBe('initial')
    expect(second?.prompt?.system).toBe('You are dsh.')
    expect(second?.prompt?.tools.map(tool => tool.name)).toEqual(['bash'])
    expect(second?.prompt?.config.model).toBe('dsh-v4')
    expect(second?.promptChange).toBeUndefined()
    // The first request's own header carries the snapshot — not a step behind.
    expect(first?.requestConfig?.model).toBe('dsh-v4')
  })

  it('re-states a resumed session header without a change, then reports the next diff', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      sysMsg(15, 'You are dsh.', { surfaceOp: 'append' }),
      // A resumed session's first header only re-states the effective state.
      reqHeader(20, 'resume'),
      ev('assistant/message', 30, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], id: 'a-1' },
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
      ev('step/end', 40, { turn: 1, step: 1 }),
      ev('step/start', 50, { turn: 1, step: 2 }),
      reqHeader(55, 'change', 'dsh-v4', [
        { name: 'bash', description: 'run a command', parameters: { type: 'object' } },
        { name: 'edit', description: 'edit a file', parameters: { type: 'object' } },
      ]),
      ev('assistant/message', 60, {
        turn: 1, step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], id: 'a-2' },
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
    ])
    const [first, second] = parser.snapshot().requests as AssistantRequestView[]
    expect(first?.promptChange).toBeUndefined()
    expect(first?.prompt?.system).toBe('You are dsh.')
    expect(second?.promptChange?.kind).toBe('tools')
    expect(second?.promptChange?.previous?.tools.map(tool => tool.name)).toEqual(['bash'])
  })

  it('suppresses a header change for an in-history system update but reports a replacement', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      sysMsg(15, 'Prompt A.', { surfaceOp: 'append' }),
      reqHeader(20, 'initial'),
      ev('assistant/message', 30, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], id: 'a-1' },
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
      ev('step/end', 40, { turn: 1, step: 1 }),
      // The update node is appended while Prompt A survives — the card at its
      // own position already presents the change.
      ev('step/start', 50, { turn: 1, step: 2 }),
      sysMsg(55, 'Prompt B.', { surfaceOp: 'append' }),
      reqHeader(60, 'series'),
      ev('assistant/message', 65, {
        turn: 1, step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], id: 'a-2' },
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
      ev('step/end', 70, { turn: 1, step: 2 }),
      // A REPLACE swaps the effective prompt — the next header reports it,
      // anchored at the replacing event.
      ev('step/start', 80, { turn: 1, step: 3 }),
      ev('system/message', 85, {
        turn: 1, step: 3,
        message: { role: 'system', content: [{ type: 'text', text: 'Prompt C.' }] },
      }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 8 } }),
      reqHeader(90, 'change'),
      ev('assistant/message', 95, {
        turn: 1, step: 3,
        message: { role: 'assistant', content: [{ type: 'text', text: 'c' }], id: 'a-3' },
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
    ])
    const [, second, third] = parser.snapshot().requests as AssistantRequestView[]
    // The in-history update presented itself — the header stays silent.
    expect(second?.prompt?.system).toBe('Prompt B.')
    expect(second?.promptChange).toBeUndefined()
    expect(third?.prompt?.system).toBe('Prompt C.')
    expect(third?.promptChange?.kind).toBe('system')
    expect(third?.promptChange?.previous?.system).toBe('Prompt B.')
    // The change anchors at the replacing system event, not the header.
    const prompts = parser.snapshot().systemPrompts ?? []
    expect(prompts.map(node => node.text)).toEqual(['Prompt A.', 'Prompt B.', 'Prompt C.'])
    const updateNode = prompts.find(node => node.text === 'Prompt B.')
    expect(updateNode?.update).toBe(true)
    expect(third?.promptChange?.time).toBe(T0 + 85)
  })

  it('moves the in-flight request prompt when a system update lands without a header', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      sysMsg(15, 'Prompt A.', { surfaceOp: 'append' }),
      reqHeader(20, 'initial'),
      ev('assistant/message', 30, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], id: 'a-1' },
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
      ev('step/end', 40, { turn: 1, step: 1 }),
      // An in-history append does not bump contentGeneration, so this step
      // legitimately logs no request/header — the open request must still
      // run under the updated prompt.
      ev('step/start', 50, { turn: 1, step: 2 }),
      sysMsg(55, 'Prompt B.', { surfaceOp: 'append' }),
      ev('assistant/message', 60, {
        turn: 1, step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], id: 'a-2' },
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
      ev('step/end', 70, { turn: 1, step: 2 }),
      ev('turn/end', 80, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const [first, second] = parser.snapshot().requests as AssistantRequestView[]
    expect(first?.prompt?.system).toBe('Prompt A.')
    expect(second?.prompt?.system).toBe('Prompt B.')
    // The silent update is not a header-reported change.
    expect(second?.promptChange).toBeUndefined()
  })

  it('clears the prompt when an empty node replaces its own', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      sysMsg(15, 'Prompt A.', { surfaceOp: 'append' }),
      reqHeader(20, 'initial'),
      ev('step/end', 30, { turn: 1, step: 1 }),
      ev('step/start', 40, { turn: 1, step: 2 }),
      // Empty replacement removes the prompt node — next header reports it.
      ev('system/message', 45, {
        turn: 1, step: 2,
        message: { role: 'system', content: [] },
      }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }),
      reqHeader(50, 'change'),
      ev('assistant/message', 55, {
        turn: 1, step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], id: 'a-2' },
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
    ])
    const second = parser.snapshot().requests[1] as AssistantRequestView
    expect(second?.prompt?.system).toBe('')
    expect(second?.promptChange?.kind).toBe('system')
    expect(second?.promptChange?.previous?.system).toBe('Prompt A.')
    expect(second?.promptChange?.time).toBe(T0 + 45)
  })
})

describe('dsh adapter — ptc dispatch', () => {
  const runCodeCall = (offsetMs: number): Extra => ev('tool/call', offsetMs, {
    turn: 1, step: 1, callId: 'call_root', name: 'run_code',
    arguments: '{"description":"gather data","code":"await bash("ls")"}',
  })

  const toolResult = (offsetMs: number, callId: string, text: string): Extra => ev('tool/result', offsetMs, {
    turn: 1, step: 1,
    message: {
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result', toolCallId: callId,
        content: [{ type: 'text', text }], isError: false,
      }],
      role: 'user', id: `r-${callId}`,
    },
  }, { surfaceOp: 'append' })

  it('nests ptc-dispatch calls under the run_code result instead of surfacing them', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      userMessage(15, 'run it'),
      runCodeCall(20),
      ev('tool/ptc-dispatch-start', 30, {
        turn: 1, step: 1,
        rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:ptc:0',
        name: 'bash', arguments: { command: 'ls' },
      }),
      ev('tool/ptc-dispatch', 40, {
        turn: 1, step: 1,
        rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:ptc:0',
        name: 'bash', arguments: { command: 'ls' },
        isError: false,
        content: [{ type: 'text', text: 'a.txt' }],
      }),
      toolResult(50, 'call_root', 'done'),
    ])
    const snapshot = parser.snapshot()
    // Only the parent's result surfaces; the sub-call nests inside it.
    const results = snapshot.eventNodes.filter(node => node.kind === 'tool-result') as ToolResultNode[]
    expect(results).toHaveLength(1)
    const root = results[0]
    expect(root?.callId).toBe('call_root')
    expect(root?.subCalls).toHaveLength(1)
    const sub = root?.subCalls[0]
    expect(sub?.callId).toBe('call_root:ptc:0')
    expect(sub?.parentCallId).toBe('call_root')
    if (sub !== undefined && 'kind' in sub && sub.kind === 'tool-result') {
      expect(sub.call).toEqual({ name: 'bash', argsRaw: '{"command":"ls"}' })
      expect(sub.content).toEqual([{ type: 'text', text: 'a.txt' }])
      expect(sub.isError).toBe(false)
    } else {
      expect.unreachable('sub-call should be a completed tool-result')
    }
  })

  it('nests a settle whose start was missed, and keeps legacy code-dispatch working', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      runCodeCall(20),
      // No dispatch-start: the settle's own payload reconstructs the call.
      ev('tool/ptc-dispatch', 30, {
        turn: 1, step: 1,
        rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:ptc:0',
        name: 'read', arguments: { path: '/f.ts' },
        isError: true,
        content: [{ type: 'text', text: 'denied' }],
        error: { name: 'PermissionDenied', code: 'denied' },
      }),
      // Legacy spellings.
      ev('tool/code-dispatch-start', 35, {
        turn: 1, step: 1,
        rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:code:1',
        name: 'bash', arguments: { command: 'pwd' },
      }),
      ev('tool/code-dispatch', 40, {
        turn: 1, step: 1,
        rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:code:1',
        name: 'bash', arguments: { command: 'pwd' },
        isError: false,
        content: [{ type: 'text', text: '/work' }],
      }),
      toolResult(50, 'call_root', 'done'),
    ])
    const root = nodesOf(parser, 'tool-result')[0] as ToolResultNode
    expect(root.subCalls).toHaveLength(2)
    const missed = root.subCalls.find(block => block.callId === 'call_root:ptc:0')
    const legacy = root.subCalls.find(block => block.callId === 'call_root:code:1')
    expect(missed !== undefined && 'kind' in missed && missed.kind === 'tool-result').toBe(true)
    if (missed !== undefined && 'kind' in missed && missed.kind === 'tool-result') {
      expect(missed.isError).toBe(true)
      expect(missed.error).toEqual({ name: 'PermissionDenied', code: 'denied' })
    }
    expect(legacy !== undefined && 'kind' in legacy && legacy.kind === 'tool-result').toBe(true)
  })

  it('keeps concurrent sub-calls in submission order and does not double-count a second settle', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      runCodeCall(20),
      ev('tool/ptc-dispatch-start', 25, {
        rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:ptc:0',
        name: 'bash', arguments: { command: 'a' },
      }),
      ev('tool/ptc-dispatch-start', 26, {
        rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:ptc:1',
        name: 'bash', arguments: { command: 'b' },
      }),
      // Out-of-order settlement: the second sub finishes first.
      ev('tool/ptc-dispatch', 30, {
        rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:ptc:1',
        name: 'bash', arguments: { command: 'b' },
        isError: false, content: [{ type: 'text', text: 'b out' }],
      }),
      ev('tool/ptc-dispatch', 35, {
        rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:ptc:0',
        name: 'bash', arguments: { command: 'a' },
        isError: false, content: [{ type: 'text', text: 'a out' }],
      }),
      toolResult(40, 'call_root', 'done'),
    ])
    const root = nodesOf(parser, 'tool-result')[0] as ToolResultNode
    // Sorted by call time — submission order, not settlement order.
    expect(root.subCalls.map(block => block.callId)).toEqual(['call_root:ptc:0', 'call_root:ptc:1'])
  })

  it('invalidates the snapshot so a live sub-call start is visible', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      runCodeCall(20),
    ])
    const before = parser.snapshot()
    const rootBefore = before.runningCalls.find(call => call.callId === 'call_root')
    expect(rootBefore?.subCalls).toHaveLength(0)

    feed(parser, [ev('tool/ptc-dispatch-start', 30, {
      turn: 1, step: 1,
      rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:ptc:0',
      name: 'bash', arguments: { command: 'ls' },
    })])
    const after = parser.snapshot()
    // Registering the sub-call touched the assembler — the UI's identity
    // check sees the change instead of rendering a stale running parent.
    expect(after).not.toBe(before)
    const root = after.runningCalls.find(call => call.callId === 'call_root')
    expect(root?.subCalls).toHaveLength(1)
    const sub = root?.subCalls[0]
    expect(sub?.callId).toBe('call_root:ptc:0')
    expect(sub !== undefined && !('kind' in sub) && sub.name === 'bash').toBe(true)
  })
})

describe('dsh adapter — v0 session', () => {
  it('reads header.system, packed stream rows, and start/end replace ops', () => {
    const parser = fresh()
    const records: unknown[] = [
      header({ version: 0 }),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('request/header', 20, {
        header: {
          system: 'You are old dsh.',
          config: { provider: 'deepseek-official', model: 'dsh-v3' },
          tools: [{ name: 'bash', description: 'run', parameters: {} }],
        },
        reason: 'initial',
      }),
      userMessage(30, 'list files'),
      ev('assistant/chunk', 40, {
        turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
      }),
      // Packed reasoning run: members at T0+100, +182, +200.
      {
        type: 'reasoning-chunks', seq0: 100, time0: T0 + 100,
        data: { turn: 1, step: 1, index: 0, dt: [82, 18], texts: ['Hel', 'lo', '!'] },
      },
      // Packed tool-call run standing in for the call's argument stream.
      {
        type: 'tool-call-chunks', seq0: 110, time0: T0 + 300,
        data: { turn: 1, step: 1, index: 1, dt: [4], id: 'call_9', name: 'bash', args: ['{"command"', ':"ls"}'] },
      },
    ]
    feed(parser, records)
    const mid = parser.snapshot()
    expect(mid.partial?.blocks).toEqual([
      { kind: 'reasoning', text: 'Hello!' },
      { kind: 'tool-call', callId: 'call_9', name: 'bash', argsRaw: '{"command":"ls"}' },
    ])
    feed(parser, [
      ev('assistant/message', 400, {
        turn: 1, step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Hello!' },
            { type: 'tool-call', id: 'call_9', name: 'bash', arguments: '{"command":"ls"}' },
          ],
          source: { kind: 'model', provider: 'deepseek-official', model: 'dsh-v3' },
          id: 'a-1',
        },
        usage: { inputTokens: 50, outputTokens: 10 },
      }),
      ev('step/end', 410, { turn: 1, step: 1 }),
      ev('user/message', 420, {
        content: [{ type: 'text', text: 'compacted summary' }],
        source: { kind: 'plugin' },
        role: 'user', id: 'cm-0',
      }, { surfaceOp: { op: 'replace', start: 4, end: 8 } }),
      ev('turn/end', 430, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.systemPrompts).toEqual([
      expect.objectContaining({ text: 'You are old dsh.', update: false }),
    ])
    const request = snapshot.requests[0] as AssistantRequestView
    expect(request.prompt?.system).toBe('You are old dsh.')
    expect(request.promptChange?.kind).toBe('initial')
    const assistant = snapshot.eventNodes.find(node => node.kind === 'assistant') as AssistantMessageNode
    // The first packed member's time is the step's first token.
    expect(assistant.timing?.firstTokenTime).toBe(T0 + 100)
    expect(assistant.timing?.stepStartTime).toBe(T0 + 10)
    // The v0 start/end replace spelling classifies the message as a compaction.
    const compaction = snapshot.eventNodes.find(node => node.kind === 'compaction') as CompactionSummaryNode
    expect(compaction.shadowedItemCount).toBe(5)
    expect(snapshot.partial).toBeNull()
  })
})

describe('dsh adapter — subagents', () => {
  const CHILD: SessionFileRef = {
    id: 'child-1',
    role: 'child',
    path: '/tmp/--work-project--/child-1/session.v3.jsonl',
    parentId: 'session-1',
    agent: { agentId: 'child-1', description: 'investigate the bug', agentType: 'worker', model: 'dsh-v4' },
  }

  it('binds a continuable background run from the parent result and tallies the child file', () => {
    const parser = fresh()
    feed(parser, [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      userMessage(20, 'delegate this'),
      ev('tool/call', 30, {
        turn: 1, step: 1, callId: 'call_sub',
        name: 'subagent',
        arguments: '{"description":"investigate the bug","prompt":"find it","run_in_background":true}',
      }),
      ev('tool/result', 40, {
        turn: 1, step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_sub' },
          content: [{
            type: 'tool-result', toolCallId: 'call_sub',
            content: [{ type: 'text', text: 'started subagent child-1' }], isError: false,
          }],
          role: 'user', id: 'r-sub',
        },
      }),
    ])
    feed(parser, [
      { type: 'session', version: 3, id: 'child-1', createdAt: T0 + 45, origin: 'subagent', parentSession: 'session-1' },
      { type: 'subagent/descriptor', seq: 2, time: T0 + 46, data: { version: 1, mode: 'continuable', provider: 'deepseek-official', label: 'investigate the bug' } },
      { type: 'turn/start', seq: 3, time: T0 + 50, data: { turn: 1 } },
      { type: 'step/start', seq: 4, time: T0 + 55, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 5, time: T0 + 60, data: { turn: 1, step: 1, callId: 'cc-1', name: 'read', arguments: '{}' } },
      { type: 'tool/result', seq: 6, time: T0 + 70, data: { turn: 1, step: 1, message: { source: { callId: 'cc-1' }, content: [{ type: 'tool-result', toolCallId: 'cc-1', content: [], isError: false }] } } },
      { type: 'step/end', seq: 7, time: T0 + 80, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 8, time: T0 + 90, data: { turn: 1, reason: { kind: 'completed' } } },
    ], CHILD)
    const runs = parser.subagents()
    expect(runs).toHaveLength(1)
    const run = runs[0]
    expect(run?.agentId).toBe('child-1')
    expect(run?.fileId).toBe('child-1')
    expect(run?.callId).toBe('call_sub')
    expect(run?.description).toBe('investigate the bug')
    expect(run?.agentType).toBe('worker')
    expect(run?.model).toBe('dsh-v4')
    expect(run?.status).toBe('completed')
    expect(run?.startedAt).toBe(T0 + 30)
    expect(run?.endedAt).toBe(T0 + 90)
    expect(run?.toolCalls).toBe(1)
  })

  const childRecords = (endKind: string): unknown[] => [
    { type: 'session', version: 3, id: 'child-1', createdAt: T0 + 45, origin: 'subagent', parentSession: 'session-1' },
    { type: 'turn/start', seq: 2, time: T0 + 50, data: { turn: 1 } },
    { type: 'step/start', seq: 3, time: T0 + 55, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 4, time: T0 + 60, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: T0 + 90, data: { turn: 1, reason: { kind: endKind } } },
  ]

  const parentBind = (): unknown[] => [
    header(),
    ev('turn/start', 0, { turn: 1 }),
    ev('step/start', 10, { turn: 1, step: 1 }),
    ev('tool/call', 30, {
      turn: 1, step: 1, callId: 'call_sub',
      name: 'subagent',
      arguments: '{"description":"investigate the bug","prompt":"find it","run_in_background":true}',
    }),
    ev('tool/result', 40, {
      turn: 1, step: 1,
      message: {
        source: { kind: 'tool', callId: 'call_sub' },
        content: [{
          type: 'tool-result', toolCallId: 'call_sub',
          content: [{ type: 'text', text: 'started subagent child-1' }], isError: false,
        }],
        role: 'user', id: 'r-sub',
      },
    }),
  ]

  it('keeps a child-published terminal status when the parent binding arrives late', () => {
    const parser = fresh()
    // Child stream completes BEFORE the parent's `started subagent` result binds.
    feed(parser, childRecords('completed'), CHILD)
    expect(parser.subagents()[0]?.status).toBe('completed')
    expect(parser.subagents()[0]?.endedAt).toBe(T0 + 90)
    feed(parser, parentBind())
    const run = parser.subagents()[0]
    // Identity attaches; the terminal status and endedAt do not regress.
    expect(run?.callId).toBe('call_sub')
    expect(run?.description).toBe('investigate the bug')
    expect(run?.status).toBe('completed')
    expect(run?.endedAt).toBe(T0 + 90)
  })

  it('keeps a child-published failure terminal too, and reopens only on a new turn/start', () => {
    const parser = fresh()
    feed(parser, parentBind())
    feed(parser, childRecords('error'), CHILD)
    const run = parser.subagents()[0]
    expect(run?.status).toBe('failed')
    expect(run?.endedAt).toBe(T0 + 90)
    // A new child turn reopens the run and clears the terminal instant.
    feed(parser, [
      { type: 'turn/start', seq: 6, time: T0 + 100, data: { turn: 2 } },
    ], CHILD)
    expect(parser.subagents()[0]?.status).toBe('running')
    expect(parser.subagents()[0]?.endedAt).toBeNull()
  })
})
