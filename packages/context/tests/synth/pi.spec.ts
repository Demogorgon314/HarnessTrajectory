/**
 * pi synthesizer — synthetic fixtures only.
 *
 * Every record below is hand-written with the REAL pi wire field names
 * (`parentId`, `stopReason`, `firstKeptEntryId`, `cacheRead`, …) and fake
 * payloads. Entry `timestamp` is ISO; the nested `message.timestamp` is epoch
 * MILLISECONDS and is never read.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import type { TimelineEvent } from '../../src/fold/event.ts'
import { applyTimeline, buildTimelineView, createTimelineState, type TimelineState } from '../../src/fold/fold.ts'
import type { InputEvent } from '../../src/synth/requestInput.ts'
import { createPiSynthesizer } from '../../src/synth/pi.ts'

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const MAIN: SessionFileRef = {
  id: 'session-1',
  role: 'main',
  path: '/tmp/--work-project--/2026-01-01T12-00-00-000Z_session-1.jsonl',
}

interface Rec { [key: string]: unknown }

const header = (): Rec => ({
  type: 'session', version: 3, id: 'session-1', timestamp: at(0), cwd: '/work/project',
})

const entry = (s: number, id: string, parentId: string | null, type: string, rest: Rec = {}): Rec => ({
  type, id, parentId, timestamp: at(s), ...rest,
})

const user = (s: number, id: string, parentId: string | null, text: string): Rec =>
  entry(s, id, parentId, 'message', {
    message: { role: 'user', content: text, timestamp: T0 + s * 1000 },
  })

const system = (s: number, id: string, parentId: string | null, rest: Rec): Rec =>
  entry(s, id, parentId, 'message', {
    message: { role: 'system', timestamp: T0 + s * 1000, ...rest },
  })

const assistant = (s: number, id: string, parentId: string | null, content: Rec[], rest: Rec = {}): Rec =>
  entry(s, id, parentId, 'message', {
    message: {
      role: 'assistant', content, api: 'openai-completions', provider: 'openai', model: 'pi-test-1',
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.01 } },
      stopReason: 'stop', timestamp: T0 + s * 1000, ...rest,
    },
  })

const toolResult = (s: number, id: string, parentId: string | null, callId: string, rest: Rec = {}): Rec =>
  entry(s, id, parentId, 'message', {
    message: {
      role: 'toolResult', toolCallId: callId, toolName: 'read',
      content: [{ type: 'text', text: 'result body' }], isError: false,
      timestamp: T0 + s * 1000, ...rest,
    },
  })

function run(records: readonly Rec[]): { events: TimelineEvent[]; synth: ReturnType<typeof createPiSynthesizer> } {
  const synth = createPiSynthesizer(MAIN)
  const events: TimelineEvent[] = []
  for (const record of records) events.push(...synth.push(JSON.stringify(record)))
  return { events, synth }
}

function foldState(records: readonly Rec[]): TimelineState {
  const synth = createPiSynthesizer(MAIN)
  let state = createTimelineState()
  for (const record of records) {
    for (const event of synth.push(JSON.stringify(record))) state = applyTimeline(state, event, DEFAULT_BOUNDS)
  }
  return state
}

const typesOf = (events: readonly TimelineEvent[]): string[] => events.map(event => event.type)
const dataOf = (event: TimelineEvent | undefined): Rec => (event?.data ?? {}) as Rec

describe('pi synthesizer', () => {
  it('emits header/step/assistant/tool events in order with disjoint request input', () => {
    const { events, synth } = run([
      header(),
      system(1, 'e1', null, { content: 'You are a test agent.', toolsAdded: [{ name: 'read', description: 'r', parameters: {} }] }),
      user(2, 'e2', 'e1', 'fix the build'),
      assistant(3, 'e3', 'e2', [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a.ts' } }], { stopReason: 'toolUse' }),
      toolResult(4, 'e4', 'e3', 'call-1'),
      assistant(5, 'e5', 'e4', [{ type: 'text', text: 'done' }], { usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 28, cost: { total: 0.02 } } }),
    ])
    expect(typesOf(events)).toEqual([
      'request/header',
      'user/message',
      // The system header went out before any model was known, so the first
      // assistant message emits a `change` header carrying the route.
      'request/header',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
    ])
    expect(events.some(event => event.type === 'stream')).toBe(false)
    const assistantEvent = events.find(event => event.type === 'assistant/message') as InputEvent | undefined
    expect(assistantEvent?.requestInput).toMatchObject({ source: 'reported', tokens: 15 })
    const headerEvent = events[0]
    expect(dataOf(headerEvent)['reason']).toBe('initial')
    expect(dataOf(headerEvent)['header']).toMatchObject({
      system: 'You are a test agent.',
      tools: [{ name: 'read', description: 'r', parameters: {} }],
      config: {},
    })
    expect(synth.meta().reportedCostUsd).toBeCloseTo(0.03)
    expect(synth.meta().running).toBe(false)
  })

  it('emits a tools-less route header for sessions with no system messages', () => {
    const { events } = run([
      header(),
      user(1, 'e1', null, 'hi'),
      assistant(2, 'e2', 'e1', [{ type: 'text', text: 'hello' }]),
    ])
    const headerEvent = events.find(event => event.type === 'request/header')
    expect(dataOf(headerEvent)['reason']).toBe('initial')
    expect(dataOf(headerEvent)['header']).toMatchObject({ tools: [], config: { provider: 'openai', model: 'pi-test-1' } })
    expect(dataOf(headerEvent)['header']).not.toHaveProperty('system')
  })

  it('prunes the abandoned assistant and replays the parent on a branch', () => {
    const synth = createPiSynthesizer(MAIN)
    synth.push(JSON.stringify(header()))
    synth.push(JSON.stringify(user(1, 'a1', null, 'first prompt')))
    // The abandoned assistant leaves a tool call unanswered: its step is still
    // open when the rewind lands and must be closed before the prune.
    synth.push(JSON.stringify(assistant(2, 'b1', 'a1', [
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a.ts' } },
    ], { stopReason: 'toolUse' })))
    const events = synth.push(JSON.stringify(user(3, 'c1', 'a1', 'new branch')))
    // The rewind also re-resolves the route: the restored path carries no
    // assistant message, so the header reverts to the path's state.
    expect(typesOf(events)).toEqual([
      'step/end', 'compaction/prune', 'user/message', 'request/header', 'user/message',
    ])
    const pruned = dataOf(events[1])['shadowedSeqs']
    expect(Array.isArray(pruned) && pruned.length === 2).toBe(true)
    expect(dataOf(events[2])['replay']).toBe(true)
    const content = dataOf(events[2])['content'] as { text?: string }[] | undefined
    expect(content?.[0]?.text).toBe('first prompt')
    const branch = dataOf(events[4])['content'] as { text?: string }[] | undefined
    expect(branch?.[0]?.text).toBe('new branch')
  })

  it('compaction shadows only the pre-kept surface and replays the kept tail', () => {
    const { events } = run([
      header(),
      user(1, 'a1', null, 'old prompt'),
      user(2, 'b1', 'a1', 'keep me'),
      entry(3, 'x1', 'b1', 'compaction', {
        summary: 'summary text', firstKeptEntryId: 'b1', tokensBefore: 9_999,
      }),
    ])
    const summary = events.find(event => event.type === 'compaction/summary')
    expect(dataOf(summary)['shadowedSeqs']).toHaveLength(1)
    expect(dataOf(summary)['shadowedTokenCount']).toBe(9_999)
    const marker = events.find(event => event.type === 'user/message' && dataOf(event)['compaction'] !== undefined)
    expect(marker?.surfaceOp).toMatchObject({ op: 'replace' })
    const copies = events.filter(event => dataOf(event)['replay'] === true)
    expect(copies).toHaveLength(1)
    const kept = dataOf(copies[0])['content'] as { text?: string }[] | undefined
    expect(kept?.[0]?.text).toBe('keep me')
  })

  it('a firstKeptEntryId on an abandoned branch keeps nothing, like an unknown id', () => {
    const synth = createPiSynthesizer(MAIN)
    synth.push(JSON.stringify(header()))
    synth.push(JSON.stringify(user(1, 'a1', null, 'first prompt')))
    synth.push(JSON.stringify(assistant(2, 'b1', 'a1', [{ type: 'text', text: 'abandoned' }])))
    synth.push(JSON.stringify(user(3, 'c1', 'a1', 'new branch')))
    const events = synth.push(JSON.stringify(entry(4, 'd1', 'c1', 'compaction', {
      summary: 'all gone', firstKeptEntryId: 'b1',
    })))
    const summary = events.find(event => event.type === 'compaction/summary')
    // Live surface after the rewind: [replay of a1, c1] — both shadowed.
    expect(dataOf(summary)['shadowedSeqs']).toHaveLength(2)
    expect(events.filter(event => dataOf(event)['replay'] === true)).toHaveLength(0)
  })

  it('an unknown firstKeptEntryId shadows the whole live surface', () => {
    const { events } = run([
      header(),
      user(1, 'a1', null, 'one'),
      user(2, 'b1', 'a1', 'two'),
      entry(3, 'x1', 'b1', 'compaction', { summary: 'all gone', firstKeptEntryId: 'nope' }),
    ])
    const summary = events.find(event => event.type === 'compaction/summary')
    expect(dataOf(summary)['shadowedSeqs']).toHaveLength(2)
    expect(events.filter(event => dataOf(event)['replay'] === true)).toHaveLength(0)
  })

  it('reports read/write/edit/grep file ops on the tool result', () => {
    const resultFor = (name: string, args: Rec): Rec[] => [
      header(),
      user(1, 'a1', null, 'go'),
      assistant(2, 'b1', 'a1', [{ type: 'toolCall', id: 'c1', name, arguments: args }], { stopReason: 'toolUse' }),
      toolResult(3, 'd1', 'b1', 'c1'),
    ]
    const opsOf = (records: Rec[]): unknown => {
      const { events } = run(records)
      return dataOf(events.find(event => event.type === 'tool/result'))['fileOps']
    }
    expect(opsOf(resultFor('read', { path: '/tmp/a.ts', limit: 40 }))).toEqual([
      { kind: 'read', path: '/tmp/a.ts', added: 0, removed: 0, read: { count: 40, est: true } },
    ])
    expect(opsOf(resultFor('write', { path: '/tmp/b.ts', content: 'one\ntwo\n' }))).toEqual([
      { kind: 'write', path: '/tmp/b.ts', added: 2, removed: 0 },
    ])
    expect(opsOf(resultFor('edit', { path: '/tmp/c.ts', oldText: 'x\ny', newText: 'z' }))).toEqual([
      { kind: 'write', path: '/tmp/c.ts', added: 1, removed: 2 },
    ])
    expect(opsOf(resultFor('grep', { pattern: 'needle' }))).toEqual([
      { kind: 'search', path: 'needle', added: 0, removed: 0, pattern: true },
    ])
    expect(opsOf(resultFor('grep', { pattern: 'needle', path: '/tmp/src' }))).toEqual([
      { kind: 'search', path: '/tmp/src', added: 0, removed: 0, detail: 'needle' },
    ])
    expect(opsOf(resultFor('bash', { command: 'ls' }))).toBeUndefined()
  })

  it('folds a compaction to summary-then-kept on the live surface', () => {
    const state = foldState([
      header(),
      user(1, 'a1', null, 'old prompt'),
      user(2, 'b1', 'a1', 'keep me'),
      entry(3, 'x1', 'b1', 'compaction', { summary: 'summary text', firstKeptEntryId: 'b1' }),
      user(4, 'd1', 'x1', 'after'),
    ])
    expect(state.surface.map(node => node.text)).toEqual(['summary text', 'keep me', 'after'])
  })

  it('emits a bash execution and a custom message as context inputs', () => {
    const { events } = run([
      header(),
      user(1, 'a1', null, 'go'),
      entry(2, 'b1', 'a1', 'message', {
        message: {
          role: 'bashExecution', command: 'ls -la', output: 'a\nb', exitCode: 0,
          cancelled: false, truncated: false, timestamp: T0 + 2_000,
        },
      }),
      entry(3, 'c1', 'b1', 'custom_message', { customType: 'hook-note', content: 'injected', display: true }),
      entry(4, 'd1', 'c1', 'message', {
        message: {
          role: 'bashExecution', command: 'secret', output: 'x', exitCode: 0,
          cancelled: false, truncated: false, excludeFromContext: true, timestamp: T0 + 4_000,
        },
      }),
      entry(5, 'e1', 'd1', 'custom', { customType: 'shadow-mind-event', data: { beat: 1 } }),
      entry(6, 'f1', 'e1', 'label', { targetId: 'a1', label: 'note' }),
    ])
    const sources = events.filter(event => event.type === 'user/message').map(event => dataOf(event)['source'])
    expect(sources).toEqual([
      { kind: 'user' },
      { kind: 'bash-execution', form: 'context', name: 'bash' },
      { kind: 'custom', form: 'context', name: 'hook-note' },
    ])
  })

  it('a branch off a pre-compaction ancestor replays the ancestor path, not the compaction', () => {
    // a → b → compaction c (keeps b); d with parentId b must yield [a, b, d] —
    // pi derives context from the entry tree, not from rendered surfaces.
    const state = foldState([
      header(),
      user(1, 'a1', null, 'aaa'),
      assistant(2, 'b1', 'a1', [{ type: 'text', text: 'bbb' }]),
      entry(3, 'c1', 'b1', 'compaction', { summary: 'sum', firstKeptEntryId: 'b1' }),
      user(4, 'd1', 'b1', 'ddd'),
    ])
    expect(state.surface.map(node => node.text)).toEqual(['aaa', 'bbb', 'ddd'])
  })

  it('a second compaction re-keeps an entry through the tree, not the surface', () => {
    // a → b → c1(keep b) → c2(keep b). Kept = path entries from b up to c2:
    // [b, c1], so the surface after c2 is [c2 summary, b copy, c1 summary copy].
    const state = foldState([
      header(),
      user(1, 'a1', null, 'old'),
      user(2, 'b1', 'a1', 'keep me'),
      entry(3, 'c1', 'b1', 'compaction', { summary: 'first summary', firstKeptEntryId: 'b1' }),
      entry(4, 'c2', 'c1', 'compaction', { summary: 'second summary', firstKeptEntryId: 'b1' }),
    ])
    expect(state.surface.map(node => node.text)).toEqual(['second summary', 'keep me', 'first summary'])
  })

  it('a compaction systemMessage replaces the prompt checkpoint instead of appending', () => {
    const { events } = run([
      header(),
      system(1, 'e1', null, { content: 'base' }),
      user(2, 'a1', 'e1', 'go'),
      entry(3, 'x1', 'a1', 'compaction', {
        summary: 's', firstKeptEntryId: 'a1',
        systemMessage: { role: 'system', content: 'base' },
      }),
    ])
    const headers = events.filter(event => event.type === 'request/header')
    const last = headers.at(-1)
    // The checkpoint REPLACES the replayed prompt: 'base', never 'base\n\nbase'.
    expect(dataOf(last)['header']).toMatchObject({ system: 'base' })
  })

  it('a rewind restores the prompt and tools of the parent path', () => {
    const synth = createPiSynthesizer(MAIN)
    synth.push(JSON.stringify(header()))
    synth.push(JSON.stringify(system(1, 'e1', null, {
      content: 'base',
      toolsAdded: [{ name: 'read', description: 'r', parameters: {} }],
    })))
    synth.push(JSON.stringify(user(2, 'a1', 'e1', 'first')))
    // The abandoned branch adds a prompt section and a tool.
    synth.push(JSON.stringify(system(3, 's2', 'a1', {
      sections: { branch: 'abandoned' },
      toolsAdded: [{ name: 'write', description: 'w', parameters: {} }],
    })))
    const events = synth.push(JSON.stringify(user(4, 'b1', 'a1', 'second')))
    const headerEvent = events.find(event => event.type === 'request/header')
    expect(dataOf(headerEvent)['reason']).toBe('change')
    expect(dataOf(headerEvent)['header']).toMatchObject({
      system: 'base',
      tools: [{ name: 'read', description: 'r', parameters: {} }],
    })
  })

  it('re-resolves the route from the FULL path when branching off a compaction', () => {
    // The model_change is shadowed by the compaction's kept range, yet pi's
    // getSessionContextSettings reads the full parent path — the rebase
    // header and meta must still carry it.
    const synth = createPiSynthesizer(MAIN)
    synth.push(JSON.stringify(header()))
    synth.push(JSON.stringify(user(1, 'u1', null, 'first')))
    synth.push(JSON.stringify(entry(2, 'm1', 'u1', 'model_change', { provider: 'prov-a', modelId: 'model-a' })))
    synth.push(JSON.stringify(user(3, 'a1', 'm1', 'kept')))
    synth.push(JSON.stringify(entry(4, 'c1', 'a1', 'compaction', { summary: 's1', firstKeptEntryId: 'a1' })))
    synth.push(JSON.stringify(assistant(5, 'b2', 'c1', [{ type: 'text', text: 'two' }], { model: 'pi-test-2' })))
    const events = synth.push(JSON.stringify(user(6, 'e1', 'c1', 'branch off the compact')))
    const headerEvent = events.find(event => event.type === 'request/header')
    expect(dataOf(headerEvent)['header']).toMatchObject({
      config: { provider: 'prov-a', model: 'model-a' },
    })
    expect(synth.meta().model).toBe('model-a')
  })

  it('a widening compaction replays entries the surface no longer holds', () => {
    // a → b → c1(keep b) → d → c2(keep a): c1 shadowed a, but pi's kept range
    // for c2 is the path from a — the original emitted events replay.
    const state = foldState([
      header(),
      user(1, 'a1', null, 'aaa'),
      user(2, 'b1', 'a1', 'bbb'),
      entry(3, 'c1', 'b1', 'compaction', { summary: 'first summary', firstKeptEntryId: 'b1' }),
      user(4, 'd1', 'c1', 'ddd'),
      entry(5, 'c2', 'd1', 'compaction', { summary: 'second summary', firstKeptEntryId: 'a1' }),
    ])
    expect(state.surface.map(node => node.text)).toEqual([
      'second summary', 'aaa', 'bbb', 'first summary', 'ddd',
    ])
  })

  it('a firstKeptEntryId at a non-surface entry contributes nothing', () => {
    const { events } = run([
      header(),
      user(1, 'a1', null, 'aaa'),
      entry(2, 'm1', 'a1', 'model_change', { provider: 'prov-a', modelId: 'model-a' }),
      user(3, 'b1', 'm1', 'bbb'),
      entry(4, 'c1', 'b1', 'compaction', { summary: 'sum', firstKeptEntryId: 'm1' }),
    ])
    const summary = events.find(event => event.type === 'compaction/summary')
    expect(dataOf(summary)['shadowedSeqs']).toHaveLength(1)
    const copies = events.filter(event => dataOf(event)['replay'] === true)
    expect(copies).toHaveLength(1)
    const kept = dataOf(copies[0])['content'] as { text?: string }[] | undefined
    expect(kept?.[0]?.text).toBe('bbb')
  })

  it('an explicit parentId null restarts an empty context', () => {
    const state = foldState([
      header(),
      user(1, 'a1', null, 'one'),
      user(2, 'b1', 'a1', 'two'),
      user(3, 'c1', null, 'fresh root'),
    ])
    const texts = state.surface.map(node => node.text)
    expect(texts).not.toContain('one')
    expect(texts).not.toContain('two')
    expect(texts.at(-1)).toBe('fresh root')
  })

  it('never throws on malformed input and keeps seqs increasing', () => {
    const { events } = run([
      header(),
      ...['', 'not json', '[]', '42', '{"type":42}', '{"type":"mystery"}'].map(() => ({ type: 'noop' }) as Rec),
    ])
    const seqs = events.map(event => event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    const synth = createPiSynthesizer(MAIN)
    for (const line of ['', 'not json', '[]', '42', '{"type":42}']) {
      expect(() => synth.push(line)).not.toThrow()
    }
  })
})
