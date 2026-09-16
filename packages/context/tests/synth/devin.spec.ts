/**
 * Devin CLI synthesizer — synthetic fixtures only.
 *
 * Records use the real `devin.*` wire vocabulary the server's DevinSource
 * emits: `devin.session` sidecar facts, `devin.msg` chat_message nodes (ISO
 * `metadata.created_at`/`started_generation_at`, `is_user_input` for human vs
 * injected, `metrics.*` per-call usage), `devin.tool` ACP state rows.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import type { TimelineEvent } from '../../src/fold/event.ts'
import { createDevinSynthesizer } from '../../src/synth/devin.ts'

type Synth = ReturnType<typeof createDevinSynthesizer>

const SESSION_ID = 'smoggy-gold'
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const ms = (s: number): number => T0 + s * 1000

const MAIN: SessionFileRef = {
  id: SESSION_ID,
  role: 'main',
  path: `devin://sessions/${SESSION_ID}`,
}

function feed(synth: Synth, lines: string[]): TimelineEvent[] {
  return lines.flatMap(line => [...synth.push(line)])
}

function msg(node: number, message: Record<string, unknown>, s: number): string {
  return JSON.stringify({ t: 'devin.msg', node, parent: null, time: ms(s), msg: message })
}

const iso = (s: number): string => new Date(ms(s)).toISOString()

const systemMsg = (text: string) => (node: number, s: number) => msg(node, {
  message_id: `sys-${node}`,
  role: 'system',
  content: [{ type: 'text', text }],
  metadata: { created_at: iso(s) },
}, s)

const humanMsg = (text: string) => (node: number, s: number) => msg(node, {
  message_id: `u-${node}`,
  role: 'user',
  content: [{ type: 'text', text }],
  metadata: { created_at: iso(s), is_user_input: true },
}, s)

const injectMsg = (text: string) => (node: number, s: number) => msg(node, {
  message_id: `i-${node}`,
  role: 'user',
  content: [{ type: 'text', text }],
  metadata: { created_at: iso(s) },
}, s)

const assistantMsg = (opts: {
  text?: string
  thinking?: string
  calls?: { id: string; name: string; args?: unknown }[]
  metrics?: Record<string, number>
}) => (node: number, s: number) => msg(node, {
  message_id: `a-${node}`,
  role: 'assistant',
  content: opts.text === undefined ? [] : [{ type: 'text', text: opts.text }],
  ...(opts.thinking === undefined ? {} : { thinking: { thinking: opts.thinking } }),
  tool_calls: (opts.calls ?? []).map(call => ({
    id: call.id, name: call.name, arguments: JSON.stringify(call.args ?? {}),
  })),
  metadata: {
    created_at: iso(s),
    started_generation_at: iso(s - 1),
    generation_model: 'swe-1.5',
    metrics: opts.metrics ?? { input_tokens: 500, output_tokens: 80, ttft_ms: 120 },
  },
}, s)

const toolMsg = (callId: string, text: string, ext: Record<string, unknown> = {}) =>
  (node: number, s: number) => msg(node, {
    message_id: `t-${node}`,
    role: 'tool',
    tool_call_id: callId,
    content: [{ type: 'text', text }],
    metadata: {
      created_at: iso(s),
      extensions: {
        'chisel/tool_call_timing': { duration_ms: 77 },
        'chisel/tool_result_meta': { success: true },
        ...ext,
      },
    },
  }, s)

const summaryMsg = (text: string, mid = '') => (node: number, s: number) => msg(node, {
  message_id: `sum-${node}${mid}`,
  role: 'system',
  content: [{ type: 'text', text }],
  metadata: {
    created_at: iso(s),
    extensions: { 'devin-rs/summary': { source: 'async_file_compactor' } },
  },
}, s)

const sysInjectMsg = (text: string, ext: string) => (node: number, s: number) => msg(node, {
  message_id: `si-${node}`,
  role: 'system',
  content: [{ type: 'text', text }],
  metadata: {
    created_at: iso(s),
    extensions: { [ext]: {} },
  },
}, s)

const sidecar = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  t: 'devin.session',
  sessionId: SESSION_ID,
  title: 'Ship the feature',
  cwd: '/work/project',
  model: 'swe-1.5',
  agentMode: 'standard',
  createdAt: T0,
  time: ms(0),
  agents: [],
  ...overrides,
})

describe('devin synthesizer', () => {
  it('emits header, user, assistant, tool call/result in fold order', () => {
    const synth = createDevinSynthesizer(MAIN)
    const events = feed(synth, [
      sidecar(),
      systemMsg('You are Devin.')(1, 0),
      humanMsg('fix the spec')(2, 1),
      assistantMsg({ thinking: 'hmm', text: 'looking', calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] })(3, 2),
      toolMsg('c1', 'file body')(4, 3),
      assistantMsg({ text: 'done' })(5, 4),
    ])
    const types = events.map(event => event.type)
    expect(types).toEqual([
      'request/header',
      'user/message',
      'step/start', 'assistant/message', 'tool/call', 'step/end',
      'tool/result',
      'step/start', 'assistant/message', 'step/end',
    ])
    const header = events[0]
    expect(header?.data?.['header']).toMatchObject({
      system: 'You are Devin.',
      config: { provider: 'cognition', model: 'swe-1.5' },
    })
    const user = events[1]
    expect(user?.data?.['source']).toEqual({ kind: 'user' })
    const step = events[3]
    expect(step?.type).toBe('assistant/message')
    expect(step?.data?.['usage']).toMatchObject({ inputTokens: 500, outputTokens: 80 })
    const content = (step?.data?.['message'] as { content: { type: string }[] }).content
    expect(content.map(block => block.type)).toEqual(['reasoning', 'text', 'tool-call'])
    const result = events[6]
    expect(result?.data?.['meta']).toMatchObject({ durationMs: 77 })
    expect(synth.meta().model).toBe('swe-1.5')
    expect(synth.meta().provider).toBe('cognition')
    expect(synth.meta().running).toBe(false)
  })

  it('marks injected user records as non-human context', () => {
    const synth = createDevinSynthesizer(MAIN)
    const events = feed(synth, [
      humanMsg('real question')(1, 0),
      injectMsg('system_guidance: keep going')(2, 1),
    ])
    const users = events.filter(event => event.type === 'user/message')
    expect(users).toHaveLength(2)
    expect(users[0]?.data?.['source']).toEqual({ kind: 'user' })
    expect(users[1]?.data?.['source']).toMatchObject({ kind: 'inject' })
  })

  it('reports running while a tool call is open', () => {
    const synth = createDevinSynthesizer(MAIN)
    feed(synth, [
      humanMsg('go')(1, 0),
      assistantMsg({ calls: [{ id: 'c1', name: 'shell' }] })(2, 1),
    ])
    expect(synth.meta().running).toBe(true)
    feed(synth, [toolMsg('c1', 'ok')(3, 2)])
    expect(synth.meta().running).toBe(false)
  })

  it('registers a spawned child via subagent/* extensions + sidecar fileId', () => {
    const synth = createDevinSynthesizer(MAIN)
    feed(synth, [
      sidecar({ agents: [{ id: 'd4bf017', fileId: 'agent-90' }] }),
      humanMsg('delegate')(1, 0),
      assistantMsg({ calls: [{ id: 'spawn-1', name: 'run_subagent', args: { task: 'survey the repo', title: 'Survey' } }] })(2, 1),
      toolMsg('spawn-1', 'done', {
        'subagent/agent_id': 'd4bf017',
        'subagent/chain_node_id': 90,
        'subagent/profile_name': 'explore',
      })(3, 2),
    ])
    const child = synth.meta().children.get('agent-90')
    expect(child?.label).toBe('Survey')
    expect(child?.callId).toBe('spawn-1')
    expect(child?.agentType).toBe('explore')
  })

  it('a devin-rs/summary system node shadows the live surface as a compaction', () => {
    const synth = createDevinSynthesizer(MAIN)
    const events = feed(synth, [
      systemMsg('You are Devin.')(1, 0),
      humanMsg('turn one')(2, 1),
      assistantMsg({ text: 'working', calls: [{ id: 'c1', name: 'shell' }] })(3, 2),
      toolMsg('c1', 'long output')(4, 3),
      summaryMsg('You are continuing work from a previous conversation thread.')(5, 4),
      humanMsg('turn two')(6, 5),
      assistantMsg({ text: 'ok' })(7, 6),
    ])
    const compaction = events.find(event => event.type === 'compaction/summary')
    expect(compaction).toBeDefined()
    // user + assistant + tool-result nodes are shadowed; the header seq is not
    // a surface node and survives.
    const shadowed = compaction?.data?.['shadowedSeqs'] as number[]
    expect(shadowed).toHaveLength(3)
    const summary = events[events.indexOf(compaction!) + 1]
    expect(summary?.type).toBe('user/message')
    expect(summary?.data?.['source']).toEqual({ kind: 'plugin', form: 'compaction', plugin: 'compaction' })
    expect(summary?.['surfaceOp']).toEqual({ op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] })
    // The summary text must not leak into the system header.
    const headers = events.filter(event => event.type === 'request/header')
    expect(headers).toHaveLength(1)
    expect((headers[0]?.data?.['header'] as { system: string }).system).toBe('You are Devin.')
    // Life continues: post-compaction messages are surface nodes again.
    const users = events.filter(event => event.type === 'user/message')
    expect(users).toHaveLength(3) // turn one + summary + turn two
  })

  it('a summary node with an empty surface still emits the compaction marker', () => {
    const synth = createDevinSynthesizer(MAIN)
    const events = feed(synth, [
      summaryMsg('continuing')(1, 0),
      humanMsg('hi')(2, 1),
    ])
    const compaction = events.find(event => event.type === 'compaction/summary')
    expect(compaction?.data?.['shadowedSeqs']).toEqual([])
    const summary = events[events.indexOf(compaction!) + 1]
    expect(summary?.['surfaceOp']).toBeUndefined()
  })

  it('accumulates system segments into the header', () => {
    const synth = createDevinSynthesizer(MAIN)
    const events = feed(synth, [
      systemMsg('Part one.')(1, 0),
      systemMsg('Part two.')(2, 0),
      humanMsg('hi')(3, 1),
    ])
    const headers = events.filter(event => event.type === 'request/header')
    expect(headers).toHaveLength(2)
    expect((headers[1]?.data?.['header'] as { system: string }).system).toBe('Part one.\n\nPart two.')
    expect(headers[1]?.data?.['reason']).toBe('change')
  })

  it('routes extension-bearing system nodes to injected context, and a new prefix run replaces the header', () => {
    const synth = createDevinSynthesizer(MAIN)
    const events = feed(synth, [
      systemMsg('Prefix v1 part one.')(1, 0),
      systemMsg('Prefix v1 part two.')(2, 0),
      sysInjectMsg('<rules>v1</rules>', 'agent-ext/rules-loaded')(3, 1),
      humanMsg('hi')(4, 2),
      assistantMsg({ text: 'ok' })(5, 3),
      // A later render rewrites the prefix and re-injects the rules block.
      systemMsg('Prefix v2.')(6, 4),
      sysInjectMsg('<rules>v2</rules>', 'agent-ext/rules-loaded')(7, 5),
    ])
    const headers = events.filter(event => event.type === 'request/header')
    expect(headers).toHaveLength(3)
    expect((headers[1]?.data?.['header'] as { system: string }).system)
      .toBe('Prefix v1 part one.\n\nPrefix v1 part two.')
    expect((headers[2]?.data?.['header'] as { system: string }).system).toBe('Prefix v2.')
    const users = events.filter(event => event.type === 'user/message')
    expect(users).toHaveLength(3)
    expect(users[0]?.data?.['source']).toMatchObject({ kind: 'inject', name: 'agent-ext/rules-loaded', plugin: 'rules-loaded' })
    // The second injection replaces the first — it must not double-count.
    expect(users[2]?.['surfaceOp']).toMatchObject({
      op: 'replace',
      startSeq: users[0]?.['seq'],
      endSeq: users[0]?.['seq'],
    })
  })

  it('keeps render copies alive across the claim: replays re-enter the surface and escape the shadow', () => {
    const synth = createDevinSynthesizer(MAIN)
    const events = feed(synth, [
      systemMsg('You are Devin.')(1, 0),
      humanMsg('first task')(2, 1),
      assistantMsg({ text: 'working' })(3, 2),
      summaryMsg('summary one.')(5, 4),
      // Kept copy of 'first task' in the next render — same message_id (u-2),
      // so the source re-emits it past the summary boundary.
      humanMsg('first task')(2, 5),
      assistantMsg({ text: 'post' })(6, 6),
      summaryMsg('summary two.')(8, 7),
      assistantMsg({ text: 'later' })(9, 8),
    ])
    const compactions = events.filter(event => event.type === 'compaction/summary')
    expect(compactions).toHaveLength(2)
    // The second claim shadows the live originals but not the kept copy.
    const claim2 = compactions[1]?.data?.['shadowedSeqs'] as number[]
    const users = events.filter(event => event.type === 'user/message')
    const keptCopy = users.find(
      event => (event.data?.['content'] as { text?: string }[] | undefined)?.[0]?.text === 'first task'
        && event.seq > (compactions[0]?.seq ?? 0),
    )
    expect(keptCopy).toBeDefined()
    expect(claim2).not.toContain(keptCopy?.seq)
    // A replay is not a new turn: 'later' still sits in turn 1 — the replayed
    // human input must not bump the counter.
    const later = events.filter(event => event.type === 'assistant/message').at(-1)
    expect(later?.data?.['turn']).toBe(1)
    expect(keptCopy?.data?.['source']).toMatchObject({ kind: 'user' })
    // The replay marker rides the envelope so the fold surfaces the copy
    // without minting a request record or a second human input.
    expect(keptCopy?.data?.['replay']).toBe(true)
  })

  it('marks every replayed copy — user, assistant, tool, inject — with data.replay', () => {
    const synth = createDevinSynthesizer(MAIN)
    const events = feed(synth, [
      systemMsg('You are Devin.')(1, 0),
      sysInjectMsg('<rules>v1</rules>', 'agent-ext/rules-loaded')(2, 1),
      humanMsg('task')(3, 2),
      assistantMsg({ text: 'working', calls: [{ id: 'c-1', name: 'exec', args: '{}' }] })(4, 3),
      toolMsg('c-1', 'done')(5, 4),
      // The next render's chain keeps all four — the copies are the summary
      // node's ancestors, so they arrive BEFORE it with the same message_ids
      // (a copy reuses its original's node number).
      sysInjectMsg('<rules>v1</rules>', 'agent-ext/rules-loaded')(2, 5),
      humanMsg('task')(3, 6),
      assistantMsg({ text: 'working', calls: [{ id: 'c-1', name: 'exec', args: '{}' }] })(4, 7),
      toolMsg('c-1', 'done')(5, 8),
      summaryMsg('summary.')(7, 9),
      assistantMsg({ text: 'post' })(8, 10),
    ])
    const replays = events.filter(event => event.data?.['replay'] === true)
    // The kept inject + kept human + kept assistant + kept tool result.
    expect(replays.map(event => event.type)).toEqual([
      'user/message', 'user/message', 'assistant/message', 'tool/result',
    ])
    // The replayed inject REPLACES the original block (the render supersedes
    // it), so its surfaceOp points at the first copy — not appended alongside.
    const injectReplay = replays[0]
    expect(injectReplay?.['surfaceOp']).toMatchObject({ op: 'replace' })
    // And the claim the summary arms exempts all four copies — they are the
    // incoming render's surface, not the outgoing one's.
    const claim = events.find(event => event.type === 'compaction/summary')?.data?.['shadowedSeqs'] as number[]
    for (const event of replays) expect(claim).not.toContain(event.seq)
  })

  it('never throws on malformed lines', () => {
    const synth = createDevinSynthesizer(MAIN)
    expect(synth.push('')).toEqual([])
    expect(synth.push('{oops')).toEqual([])
    expect(synth.push('{"t":"devin.msg"}')).toEqual([])
    expect(synth.push(JSON.stringify({ t: 'devin.msg', msg: { role: 'alien' } }))).toEqual([])
    expect(synth.meta().running).toBe(false)
  })
})
