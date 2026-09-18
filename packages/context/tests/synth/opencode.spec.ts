/**
 * OpenCode synthesizer — synthetic fixtures only.
 *
 * Records use the real `opencode.*` wire vocabulary the server's
 * OpencodeSource emits: `opencode.session` sidecar facts, `opencode.message`
 * headers (user headers carry their parts), `opencode.part` settled
 * assistant parts, `opencode.finish` terminal facts, `opencode.prune` the
 * cleared-output marker. All times are epoch ms.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import type { TimelineEvent } from '../../src/fold/event.ts'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import { applyTimeline, buildTimelineView, createTimelineState, type TimelineState } from '../../src/fold/fold.ts'
import { createOpencodeSynthesizer } from '../../src/synth/opencode.ts'
import type { InputEvent } from '../../src/synth/requestInput.ts'

type Synth = ReturnType<typeof createOpencodeSynthesizer>

const SESSION_ID = 'ses_main'
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const at = (ms: number): number => T0 + ms

const MAIN: SessionFileRef = {
  id: SESSION_ID,
  role: 'main',
  path: `opencode://sessions/${SESSION_ID}`,
}

function feed(synth: Synth, lines: readonly string[]): InputEvent[] {
  return lines.flatMap(line => [...synth.push(line)])
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
      directory: '/work/project',
      title: 'Fix the flaky spec',
      version: '1.18.31',
      model: { id: 'claude-opus', providerID: 'anthropic' },
      timeUpdated: at(5000),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
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
      agent: 'build',
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

function finishLine(id: string, msg: Record<string, unknown>, offset: number): string {
  return line({ t: 'opencode.finish', time: at(offset), id, msg })
}

function finishMsg(finish: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    modelID: 'claude-opus',
    providerID: 'anthropic',
    finish,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 10 } },
    cost: 0.01,
    time: { created: at(20), completed: at(50) },
    ...extra,
  }
}

function toolPart(callID: string, tool: string, state: Record<string, unknown>): Record<string, unknown> {
  return { type: 'tool', callID, tool, state }
}

const ofType = (events: readonly TimelineEvent[], type: string) => events.filter(e => e.type === type)

describe('opencode synthesizer', () => {
  it('ignores a stray part addressed to a user message — never a phantom assistant', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    const events = feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      // The emission plan's anomaly append: a part row that lands after its
      // (user) message closed. It must not open an assistant step.
      partLine('prt_late', 'msg_u1', { type: 'text', text: 'late text', time: { start: at(20), end: at(21) } }, 20),
      finishLine('msg_u1', { role: 'user', time: { created: at(10) } }, 30),
    ])
    expect(ofType(events, 'assistant/message')).toHaveLength(0)
    expect(ofType(events, 'step/start')).toHaveLength(0)
    expect(ofType(events, 'user/message')).toHaveLength(1)
    expect(synth.meta().running).toBe(false)
  })

  it('emits an initial request/header before the first assistant and a change on model switch', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    const events = feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      finishLine('msg_a1', finishMsg('stop'), 50),
      assistantHeader('msg_a2', 60, { modelID: 'claude-haiku' }),
      finishLine('msg_a2', finishMsg('stop', { modelID: 'claude-haiku', time: { created: at(60), completed: at(70) } }), 70),
    ])
    const headers = ofType(events, 'request/header')
    expect(headers).toHaveLength(2)
    expect(headers[0]?.data?.['reason']).toBe('initial')
    expect(headers[0]?.data?.['header']).toMatchObject({ config: { provider: 'anthropic', model: 'claude-opus' } })
    expect(headers[1]?.data?.['reason']).toBe('change')
    expect(headers[1]?.data?.['header']).toMatchObject({ config: { provider: 'anthropic', model: 'claude-haiku' } })
  })

  it('splits a human prompt and its synthetic reminder into user + inject messages', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    const events = feed(synth, [
      userMessage('msg_u1', [
        textPart('prt_u1', 'fix the bug'),
        textPart('prt_u2', '[search-mode] reminder', { synthetic: true }),
      ], 10),
    ])
    const messages = ofType(events, 'user/message')
    expect(messages).toHaveLength(2)
    expect(messages[0]?.data).toMatchObject({
      content: [{ type: 'text', text: 'fix the bug' }],
      source: { kind: 'user' },
    })
    expect(messages[1]?.data).toMatchObject({
      content: [{ type: 'text', text: '[search-mode] reminder' }],
      source: { kind: 'inject', form: 'context', name: 'synthetic', plugin: 'synthetic' },
    })
  })

  it('treats the compaction-continue message as an ordinary injection', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    const events = feed(synth, [
      userMessage('msg_i1', [
        textPart('prt_i1', 'continue', { synthetic: true, metadata: { compaction_continue: true } }),
      ], 10),
    ])
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({
      source: { kind: 'inject', form: 'context', name: 'compaction-continue', plugin: 'compaction-continue' },
    })
  })

  it('buffers an assistant message and emits it at finish with disjoint usage and stream', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    const buffered = feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', { type: 'reasoning', text: 'think', time: { start: at(22), end: at(24) } }, 22),
      partLine('prt_a2', 'msg_a1', { type: 'text', text: 'answer', time: { start: at(25), end: at(26) } }, 25),
    ])
    // Nothing of the response is emitted before the finish lands.
    expect(ofType(buffered, 'assistant/message')).toHaveLength(0)
    expect(synth.meta().running).toBe(true)

    const events = feed(synth, [finishLine('msg_a1', finishMsg('stop'), 50)])
    const message = events.find(e => e.type === 'assistant/message')
    expect(message?.data).toMatchObject({
      message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }] },
      usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 900, cacheWriteTokens: 10 },
      turn: 1,
      step: 1,
    })
    expect((message as InputEvent | undefined)?.requestInput).toMatchObject({ source: 'reported', tokens: 1010 })
    const stream = (message?.data?.['stream'] ?? []) as { chunk: { type: string }; time: number }[]
    expect(stream[0]?.chunk).toMatchObject({ type: 'text-delta' })
    expect(stream[0]?.time).toBe(at(22))
    expect(stream.map(chunk => chunk.chunk.type)).toEqual(['text-delta', 'block-start', 'block-start'])
    expect(ofType(events, 'step/end')).toHaveLength(1)
    expect(synth.meta().running).toBe(false)
    expect(synth.meta().reportedCostUsd).toBeCloseTo(0.01)
  })

  it('emits tool/call and tool/result at state times with meta and fileOps', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    const events = feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', toolPart('call_1', 'edit', {
        status: 'completed',
        input: { filePath: '/src/a.ts', oldString: 'one\ntwo', newString: 'one\nTWO\nthree' },
        output: 'applied',
        title: 'edit a.ts',
        time: { start: at(30), end: at(40) },
      }), 30),
      partLine('prt_a2', 'msg_a1', toolPart('call_2', 'grep', {
        status: 'completed',
        input: { pattern: 'needle', path: '/src' },
        output: 'a.ts:1',
        time: { start: at(41), end: at(42) },
      }), 41),
      finishLine('msg_a1', finishMsg('stop'), 50),
    ])
    const calls = ofType(events, 'tool/call')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ time: at(30) })
    expect(calls[0]?.data).toMatchObject({ callId: 'call_1', name: 'edit' })
    const results = ofType(events, 'tool/result')
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ time: at(40) })
    expect(results[0]?.data?.['meta']).toEqual({ durationMs: 10, title: 'edit a.ts' })
    expect(results[0]?.data?.['fileOps']).toEqual([
      { kind: 'write', path: '/src/a.ts', added: 3, removed: 2 },
    ])
    expect(results[1]?.data?.['fileOps']).toEqual([
      { kind: 'search', path: '/src', added: 0, removed: 0, detail: 'needle' },
    ])
  })

  it('projects the buffered message through preview() without mutating state', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', { type: 'text', text: 'partial answer', time: { start: at(22), end: at(24) } }, 22),
    ])
    const preview = synth.preview?.() ?? []
    expect(ofType(preview, 'assistant/message')).toHaveLength(1)
    const message = preview.find(e => e.type === 'assistant/message')
    expect(message?.data?.['message']).toEqual({ content: [{ type: 'text', text: 'partial answer' }] })
    // Preview is pure: a second read returns the same projection and the
    // committed stream still holds no assistant/message.
    expect(synth.preview?.()).toEqual(preview)
    const events = feed(synth, [finishLine('msg_a1', finishMsg('stop'), 50)])
    const committed = events.find(e => e.type === 'assistant/message')
    expect(preview[0]?.seq).toBe(committed?.seq)
  })

  it('flushes an open assistant with unknown input when the next header arrives', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    const events = feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', { type: 'text', text: 'partial', time: { start: at(22), end: at(24) } }, 22),
      assistantHeader('msg_a2', 30),
      finishLine('msg_a2', finishMsg('stop'), 40),
    ])
    const messages = ofType(events, 'assistant/message')
    expect(messages).toHaveLength(2)
    expect(messages[0]?.data?.['usage']).toBeUndefined()
    expect((messages[0] as InputEvent | undefined)?.requestInput).toMatchObject({ source: 'unknown' })
    expect(ofType(events, 'step/end')).toHaveLength(2)
  })

  it('registers sidecar children and enriches them on the spawn part', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    feed(synth, [
      sessionLine({
        children: [{ id: 'ses_child', title: 'Investigate auth (@explore subagent)', agent: 'explore', parentID: SESSION_ID }],
      }),
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', toolPart('call_1', 'task', {
        status: 'completed',
        input: { description: 'Investigate auth', subagent_type: 'explore' },
        output: 'done',
        metadata: { sessionId: 'ses_child', model: { modelID: 'claude-haiku' } },
        time: { start: at(30), end: at(40) },
      }), 30),
    ])
    const child = synth.meta().children.get('ses_child')
    expect(child).toMatchObject({
      key: 'ses_child',
      label: 'Investigate auth',
      agentType: 'explore',
      callId: 'call_1',
      startedAt: at(30),
      completedAt: at(40),
      model: 'claude-haiku',
    })
    expect(synth.meta().version).toBe('1.18.31')
    expect(synth.meta().label).toBe('Fix the flaky spec')
  })

  it('keeps a background spawn open (no completedAt)', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', toolPart('call_1', 'task', {
        status: 'completed',
        input: { description: 'watch', subagent_type: 'monitor' },
        output: 'launched',
        metadata: { sessionId: 'ses_child', background: true },
        time: { start: at(30), end: at(40) },
      }), 30),
    ])
    expect(synth.meta().children.get('ses_child')).toMatchObject({ callId: 'call_1' })
    expect(synth.meta().children.get('ses_child')?.completedAt).toBeUndefined()
  })

  it('shadows all but the retained tail, then replays it after the summary', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'first task')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', { type: 'text', text: 'first answer', time: { start: at(22), end: at(24) } }, 22),
      finishLine('msg_a1', finishMsg('stop'), 30),
      userMessage('msg_u2', [textPart('prt_u2', 'second task')], 40),
      assistantHeader('msg_a2', 50),
      partLine('prt_a2', 'msg_a2', { type: 'text', text: 'second answer', time: { start: at(52), end: at(54) } }, 52),
      finishLine('msg_a2', finishMsg('stop', { time: { created: at(50), completed: at(60) } }), 60),
      // The compaction trigger itself emits nothing.
      userMessage('msg_c1', [{ id: 'prt_c0', type: 'compaction', auto: true, tail_start_id: 'msg_u2' }], 70),
      assistantHeader('msg_s1', 80, { summary: true }),
      partLine('prt_s1', 'msg_s1', { type: 'text', text: 'summary of the work', time: { start: at(82), end: at(84) } }, 82),
    ])
    const events = feed(synth, [
      finishLine('msg_s1', finishMsg('stop', { summary: true, time: { created: at(80), completed: at(90) } }), 90),
    ])
    const summary = events.find(e => e.type === 'compaction/summary')
    expect(summary).toBeDefined()
    expect((summary?.data?.['shadowedSeqs'] as number[] | undefined)?.length).toBe(2)

    const summaryMessage = events.find(e => e.type === 'user/message')
    expect(summaryMessage?.data).toMatchObject({
      content: [{ type: 'text', text: 'summary of the work' }],
      source: { kind: 'plugin', form: 'compaction', plugin: 'compaction', compactionId: 'msg_c1' },
    })
    expect(summaryMessage?.surfaceOp).toEqual({
      op: 'replace',
      startSeq: (summary?.data?.['shadowedSeqs'] as number[])[0],
      endSeq: (summary?.data?.['shadowedSeqs'] as number[]).at(-1),
    })
    // The retained tail replays AFTER the summary, in order.
    const replays = events.filter(e => e.data?.['replay'] === true)
    expect(replays.map(e => e.type)).toEqual(['user/message', 'assistant/message'])
    expect(replays[0]?.data?.['content']).toEqual([{ type: 'text', text: 'second task' }])
    // The summary's cost is booked but the summary itself is never an
    // assistant/message sample — every assistant/message emitted here is a
    // replayed tail copy.
    expect(synth.meta().reportedCostUsd).toBeCloseTo(0.03)
    expect(ofType(events, 'assistant/message').every(e => e.data?.['replay'] === true)).toBe(true)
  })

  it('emits nothing for an errored summary', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'task')], 10),
      userMessage('msg_c1', [{ id: 'prt_c0', type: 'compaction', auto: true }], 20),
      assistantHeader('msg_s1', 30, { summary: true }),
    ])
    const events = feed(synth, [
      finishLine('msg_s1', finishMsg('stop', {
        summary: true,
        error: { name: 'APIError', data: { message: 'boom' } },
      }), 40),
    ])
    expect(events).toHaveLength(0)
  })

  it('compacts a completed summary even when the finish reason is absent', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'task')], 10),
      userMessage('msg_c1', [{ id: 'prt_c0', type: 'compaction', auto: true }], 20),
      assistantHeader('msg_s1', 30, { summary: true }),
      partLine('prt_s1', 'msg_s1', { type: 'text', text: 'summary of the work', time: { start: at(32), end: at(34) } }, 32),
    ])
    // A finish record is terminal by construction (time.completed landed);
    // no `finish` reason is required to land the compaction.
    const msg = finishMsg('stop', { summary: true })
    delete msg['finish']
    const events = feed(synth, [finishLine('msg_s1', msg, 40)])
    expect(events.some(e => e.type === 'compaction/summary')).toBe(true)
    expect(events.some(e => e.type === 'user/message'
      && (e.data?.['source'] as { form?: string } | undefined)?.form === 'compaction')).toBe(true)
  })

  it('emits the cleared marker for a tool part that arrived already compacted', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    const events = feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', toolPart('call_1', 'bash', {
        status: 'completed', input: { command: 'ls' }, output: 'a big output',
        time: { start: at(30), end: at(40), compacted: at(45) },
      }), 30),
      finishLine('msg_a1', finishMsg('stop'), 50),
    ])
    const result = events.find(e => e.type === 'tool/result')
    expect(result?.data?.['message']).toMatchObject({
      content: [{
        type: 'tool-result',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: '[Old tool result content cleared]' }],
      }],
    })
    // A later prune sidecar for the same call is harmless: same marker,
    // still a single in-place replace.
    const after = feed(synth, [
      line({ t: 'opencode.prune', time: at(60), id: 'prt_a1', messageID: 'msg_a1', callID: 'call_1' }),
    ])
    expect(after.find(e => e.type === 'compaction/prune')).toBeDefined()
    expect(after.find(e => e.type === 'tool/result')?.data?.['message'])
      .toMatchObject({ content: [{
        type: 'tool-result',
        content: [{ type: 'text', text: '[Old tool result content cleared]' }],
      }] })
  })

  it('replaces a pruned tool result in place with the cleared marker', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    const first = feed(synth, [
      userMessage('msg_u1', [textPart('prt_u1', 'go')], 10),
      assistantHeader('msg_a1', 20),
      partLine('prt_a1', 'msg_a1', toolPart('call_1', 'bash', {
        status: 'completed', input: { command: 'ls' }, output: 'a big output',
        time: { start: at(30), end: at(40) },
      }), 30),
      finishLine('msg_a1', finishMsg('stop'), 50),
    ])
    const resultSeq = first.find(e => e.type === 'tool/result')?.seq
    const events = feed(synth, [
      line({ t: 'opencode.prune', time: at(60), id: 'prt_a1', messageID: 'msg_a1', callID: 'call_1' }),
    ])
    const prune = events.find(e => e.type === 'compaction/prune')
    expect(prune?.data?.['shadowedSeqs']).toEqual([resultSeq])
    const copy = events.find(e => e.type === 'tool/result')
    expect(copy?.data).toMatchObject({
      replay: true,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: '[Old tool result content cleared]' }],
        }],
      },
    })
    expect(copy?.surfaceOp).toEqual({ op: 'replace', startSeq: resultSeq, endSeq: resultSeq })
  })

  it('yields nothing for malformed lines', () => {
    const synth = createOpencodeSynthesizer(MAIN)
    expect(synth.push('not json')).toEqual([])
    expect(synth.push('{"t":"opencode.part"}')).toEqual([])
    expect(synth.push('{"t":"mystery"}')).toEqual([])
  })
})

describe('opencode synthesizer → fold', () => {
  function fold(lines: readonly string[]): { view: ReturnType<typeof buildTimelineView>; state: TimelineState } {
    const synth = createOpencodeSynthesizer(MAIN)
    let state = createTimelineState()
    for (const l of lines) {
      for (const event of synth.push(l)) state = applyTimeline(state, event, DEFAULT_BOUNDS)
    }
    return { view: buildTimelineView(state, DEFAULT_BOUNDS), state }
  }

  const surfaceTexts = (state: TimelineState) => state.surface.map(node => node.text)

  const SESSION: string[] = [
    sessionLine(),
    userMessage('msg_u1', [textPart('prt_u1', 'first task')], 10),
    assistantHeader('msg_a1', 20),
    partLine('prt_a1', 'msg_a1', toolPart('call_1', 'bash', {
      status: 'completed', input: { command: 'ls' }, output: 'a really long tool output '.repeat(20),
      time: { start: at(30), end: at(40) },
    }), 30),
    finishLine('msg_a1', finishMsg('stop'), 50),
    userMessage('msg_u2', [textPart('prt_u2', 'second task')], 60),
    assistantHeader('msg_a2', 70),
    partLine('prt_a2', 'msg_a2', { type: 'text', text: 'second answer', time: { start: at(72), end: at(74) } }, 72),
    finishLine('msg_a2', finishMsg('stop', { time: { created: at(70), completed: at(80) } }), 80),
  ]

  it('folds a compaction: summary + retained tail on the surface, shadowed gone', () => {
    const before = fold(SESSION).view
    const { view, state } = fold([
      ...SESSION,
      userMessage('msg_c1', [{ id: 'prt_c0', type: 'compaction', auto: true, tail_start_id: 'msg_u2' }], 90),
      assistantHeader('msg_s1', 100, { summary: true }),
      partLine('prt_s1', 'msg_s1', { type: 'text', text: 'summary of the work', time: { start: at(102), end: at(104) } }, 102),
      finishLine('msg_s1', finishMsg('stop', { summary: true, time: { created: at(100), completed: at(110) } }), 110),
    ])
    expect(view.events.some(e => e.kind === 'compaction')).toBe(true)
    const texts = surfaceTexts(state)
    expect(texts).toContain('summary of the work')
    expect(texts).toContain('second task')
    expect(texts).toContain('second answer')
    expect(texts).not.toContain('first task')
    expect(view.current.total).toBeLessThan(before.current.total)
  })

  it('shrinks the folded context when a tool output is pruned', () => {
    const before = fold(SESSION).view
    const { view, state } = fold([
      ...SESSION,
      line({ t: 'opencode.prune', time: at(90), id: 'prt_a1', messageID: 'msg_a1', callID: 'call_1' }),
    ])
    expect(view.events.some(e => e.kind === 'prune')).toBe(true)
    expect(view.current.total).toBeLessThan(before.current.total)
    expect(surfaceTexts(state)).not.toContain('a really long tool output '.repeat(20))
  })
})
