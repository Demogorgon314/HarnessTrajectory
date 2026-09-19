/**
 * dsh synthesizer — synthetic fixtures only.
 *
 * The synthesizer is nearly a pass-through: fold-input events keep their
 * logged `seq`/`time`/`surfaceOp`, everything else drops, and v0 packed
 * stream rows expand into `assistant/chunk` events. Every record below uses
 * the REAL dsh wire field names with fake payloads; times are epoch
 * MILLISECONDS.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import type { InputEvent } from '../../src/synth/requestInput.ts'
import { createDshSynthesizer } from '../../src/synth/dsh.ts'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

const MAIN: SessionFileRef = {
  id: 'session-1',
  role: 'main',
  path: '/tmp/--work-project--/session-1/session.v3.jsonl',
}

interface Rec { [key: string]: unknown }

let seq = 0
const ev = (type: string, offsetMs: number, data: Rec = {}, rest: Rec = {}): Rec => {
  seq += 1
  return { type, seq, time: T0 + offsetMs, data, ...rest }
}
const line = (record: Rec): string => JSON.stringify(record)

const header = (): Rec => ({
  type: 'session', version: 3, id: 'session-1', createdAt: T0, cwd: '/work/project',
})

function run(records: readonly Rec[]): { events: readonly InputEvent[]; synth: ReturnType<typeof createDshSynthesizer> } {
  seq = 0
  const synth = createDshSynthesizer(MAIN)
  const events: InputEvent[] = []
  for (const record of records) events.push(...synth.push(line(record)))
  return { events, synth }
}

describe('dsh synthesizer', () => {
  it('passes fold-input events through with their logged seq, time, and surfaceOp', () => {
    const { events } = run([
      header(),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('user/message', 20, {
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' }, role: 'user', id: 'm-1',
      }, { surfaceOp: 'append' }),
      ev('system/message', 30, {
        turn: 1, step: 1,
        message: { role: 'system', content: [{ type: 'text', text: 'prompt' }] },
      }, { surfaceOp: { op: 'replace', startSeq: 7, endSeq: 9 }, sourceEventSeqs: [7] }),
    ])
    expect(events.map(event => event.type)).toEqual(['step/start', 'user/message', 'system/message'])
    expect(events.map(event => event.seq)).toEqual([1, 2, 3])
    expect(events[1]?.time).toBe(T0 + 20)
    expect(events[1]?.data).toMatchObject({ source: { kind: 'user' } })
    expect(events[2]?.surfaceOp).toEqual({ op: 'replace', startSeq: 7, endSeq: 9 })
  })

  it('emits nothing for headers, malformed lines, and types the fold has no case for', () => {
    const { events } = run([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('session/title', 5, { title: 'a title' }),
      ev('permission/preset', 10, { preset: 'default' }),
      ev('llm/retry', 15, { retryId: 'r-1', retry: 1 }),
      ev('compaction/start', 20, { compactionId: 'c-1', turn: 1 }),
      ev('agent/inbox/spliced', 25, { count: 1 }),
      ev('some/future/type', 30, {}),
    ])
    expect(events).toEqual([])
    expect(createDshSynthesizer(MAIN).push('definitely not json')).toEqual([])
    expect(createDshSynthesizer(MAIN).push('{"no":"type"}')).toEqual([])
  })

  it('expands a packed v0 run into N assistant/chunk events with cumulative times', () => {
    const synth = createDshSynthesizer(MAIN)
    const events = synth.push(JSON.stringify({
      type: 'reasoning-chunks', seq0: 20, time0: 1000,
      data: { turn: 1, step: 1, index: 0, dt: [82, 18], texts: ['Hel', 'lo', '!'] },
    }))
    expect(events).toHaveLength(3)
    expect(events.map(event => event.seq)).toEqual([20, 21, 22])
    expect(events.map(event => event.time)).toEqual([1000, 1082, 1100])
    expect(events.every(event => event.type === 'assistant/chunk')).toBe(true)
    expect(events[0]?.data?.['chunk']).toEqual({ type: 'reasoning-delta', index: 0, text: 'Hel' })
  })

  it('marks assistant/message request input as reported input plus cache buckets', () => {
    const { events } = run([
      header(),
      ev('request/header', 10, {
        header: { config: { provider: 'deepseek-official', model: 'dsh-v4' } },
      }),
      ev('assistant/message', 20, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 2 },
      }),
    ])
    const assistant = events.find(event => event.type === 'assistant/message')
    expect(assistant?.requestInput).toEqual({ source: 'reported', tokens: 107, model: 'dsh-v4' })
  })

  it('reports model, provider, context window, label, and running state', () => {
    const synth = createDshSynthesizer(MAIN)
    const feed = (records: readonly Rec[]): void => {
      for (const record of records) synth.push(line(record))
    }
    feed([
      header(),
      ev('session/title', 5, { title: 'fix the build' }),
      ev('request/context', 8, { provider: 'deepseek-official', model: 'ctx-model', contextWindow: 1000000 }),
      ev('request/header', 10, { header: { config: { provider: 'deepseek-official', model: 'dsh-v4' } } }),
    ])
    expect(synth.meta()).toMatchObject({
      model: 'dsh-v4',
      provider: 'deepseek-official',
      contextWindow: 1000000,
      label: 'fix the build',
      running: false,
    })
    feed([ev('step/start', 20, { turn: 1, step: 1 })])
    expect(synth.meta().running).toBe(true)
    feed([ev('step/end', 30, { turn: 1, step: 1 })])
    expect(synth.meta().running).toBe(false)
    feed([ev('tool/call', 40, { turn: 1, step: 1, callId: 'c-1', name: 'bash', arguments: '{}' })])
    expect(synth.meta().running).toBe(true)
  })

  it('binds a spawned child when the result text names its session id', () => {
    const { events, synth } = run([
      header(),
      ev('user/message', 5, {
        content: [{ type: 'text', text: 'delegate' }],
        source: { kind: 'user' }, role: 'user', id: 'm-1',
      }),
      ev('tool/call', 10, {
        turn: 1, step: 1, callId: 'call_sub', name: 'subagent',
        arguments: '{"description":"investigate the bug","prompt":"find it"}',
      }),
      ev('tool/result', 20, {
        turn: 1, step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_sub' },
          content: [{
            type: 'tool-result', toolCallId: 'call_sub',
            content: [{ type: 'text', text: 'started subagent child-9' }], isError: false,
          }],
        },
      }),
    ])
    const spawn = synth.meta().children.get('child-9')
    expect(spawn).toMatchObject({
      key: 'child-9',
      label: 'investigate the bug',
      callId: 'call_sub',
      startedAt: T0 + 10,
    })
    // The tool events still pass through for the fold.
    expect(events.some(event => event.type === 'tool/result')).toBe(true)
  })

  it('uses the first human prompt and the descriptor label as label fallbacks', () => {
    const { synth } = run([
      header(),
      ev('user/message', 5, {
        content: [{ type: 'text', text: 'my first prompt' }],
        source: { kind: 'user' }, role: 'user', id: 'm-1',
      }),
    ])
    expect(synth.meta().label).toBe('my first prompt')
    const child = createDshSynthesizer({ ...MAIN, id: 'child-1', role: 'child' })
    child.push(line({ type: 'session', version: 3, id: 'child-1', createdAt: T0, origin: 'subagent' }))
    child.push(line(ev('subagent/descriptor', 5, { label: 'child task' })))
    expect(child.meta().label).toBe('child task')
  })
})
