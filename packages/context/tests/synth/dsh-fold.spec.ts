/**
 * dsh synthesizer → vendored fold — synthetic fixtures only.
 *
 * The synthesizer passes dsh events through with their logged seqs, so the
 * fold sees the vocabulary it was vendored for. The records below use the
 * REAL dsh wire field names with fake payloads (times are epoch MILLISECONDS);
 * the assertions pin the end-to-end contract: system/tools accounting,
 * reported request usage, injection counting, compaction shadowing, and v0
 * first-token timing through expanded packed rows.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import { assemble } from '../../src/client/assemble.ts'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import { applyTimeline, buildTimelineView, createTimelineState } from '../../src/fold/fold.ts'
import { ContextSession } from '../../src/fold/session.ts'
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

const view = (records: readonly Rec[]): ReturnType<typeof buildTimelineView> => {
  const synth = createDshSynthesizer(MAIN)
  let state = createTimelineState()
  for (const l of records.map(line)) {
    for (const event of synth.push(l)) state = applyTimeline(state, event, DEFAULT_BOUNDS)
  }
  return buildTimelineView(state, DEFAULT_BOUNDS)
}

describe('dsh fold (v3)', () => {
  it('folds system, tools, usage, injections, and compaction shadowing', () => {
    seq = 0
    const last = view([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('system/message', 20, {
        turn: 1, step: 1,
        message: { role: 'system', content: [{ type: 'text', text: 'You are dsh.' }] },
      }, { surfaceOp: 'append' }),
      ev('request/header', 30, {
        header: {
          config: { provider: 'deepseek-official', model: 'dsh-v4' },
          tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
        },
        reason: 'initial',
      }),
      ev('request/context', 35, {
        provider: 'deepseek-official', model: 'dsh-v4', contextWindow: 1000000,
      }),
      // seq 6 — human prompt
      ev('user/message', 40, {
        content: [{ type: 'text', text: 'fix the flaky test' }],
        source: { kind: 'user' }, role: 'user', id: 'm-1',
      }, { surfaceOp: 'append' }),
      // seq 7 — injected context (plugin snapshot)
      ev('user/message', 50, {
        content: [{ type: 'text', text: 'repo map snapshot text' }],
        source: { kind: 'plugin', plugin: 'context-sync', form: 'snapshot' },
        role: 'user', id: 'm-2',
      }, { surfaceOp: 'append' }),
      // seq 8 — assistant reply with disjoint usage buckets
      ev('assistant/message', 60, {
        turn: 1, step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'dsh-v4' },
        },
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 5 },
      }),
      // seq 9 / 10 — the tool call and its result
      ev('tool/call', 70, { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }),
      ev('tool/result', 80, {
        turn: 1, step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_1' },
          content: [{
            type: 'tool-result', toolCallId: 'call_1',
            content: [{ type: 'text', text: 'a.txt\nb.txt' }], isError: false,
          }],
        },
      }, { surfaceOp: 'append' }),
      ev('step/end', 90, { turn: 1, step: 1 }),
      // seq 12 — log-only compaction summary; seq 13 — the replacement node
      ev('compaction/summary', 100, {
        summary: [{ type: 'text', text: 'the user asked to fix a flaky test' }],
        shadowedRange: { start: 6, end: 10 },
        shadowedSeqs: [6, 7, 8, 9, 10],
        shadowedTokenCount: 999,
      }),
      ev('user/message', 110, {
        content: [{ type: 'text', text: 'the user asked to fix a flaky test' }],
        source: { kind: 'plugin', plugin: 'compaction' }, role: 'user', id: 'm-3',
      }, { surfaceOp: { op: 'replace', startSeq: 6, endSeq: 10 }, sourceEventSeqs: [6, 7, 8, 9, 10] }),
      ev('turn/end', 120, { turn: 1, reason: { kind: 'completed' } }),
    ])

    expect(last.model).toBe('dsh-v4')
    expect(last.contextWindow).toBe(1000000)
    expect(last.current.system).toBeGreaterThan(0)
    expect(last.systems).toHaveLength(1)
    expect(last.toolsKnown).toBe(true)
    expect(last.current.tools).toBeGreaterThan(0)

    // One request record; reported prompt = disjoint input + cacheRead.
    expect(last.requests).toHaveLength(1)
    expect(last.requests[0]?.prompt).toBe(105)
    expect(last.requests[0]?.cacheRead).toBe(5)

    // One human input and one counted injection event.
    expect(last.humanInputs).toBe(1)
    expect(last.events.some(event => event.kind === 'inject' && event.form === 'snapshot')).toBe(true)
    expect(last.events.some(event => event.kind === 'compaction')).toBe(true)

    // The replacement shadowed seqs 6-10; the summary node survives.
    const liveSeqs = last.nodes.map(node => node.seq)
    for (const shadowed of [6, 7, 8, 9, 10]) expect(liveSeqs).not.toContain(shadowed)
    expect(liveSeqs).toContain(13)
    // tool/call (seq 9) is not a surface node — tool/result is the `tool` one.
    const archivedSeqs = last.archive.map(node => node.seq)
    for (const shadowed of [6, 7, 8, 10]) expect(archivedSeqs).toContain(shadowed)
    expect(last.archive.every(node => node.gone === 13)).toBe(true)
  })
})

describe('dsh fold (v0)', () => {
  it('folds header.system and stamps first-token time from expanded packed rows', () => {
    seq = 0
    const records: Rec[] = [
      { type: 'session', version: 0, id: 'session-1', createdAt: T0, cwd: '/work/project' },
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 10, { turn: 1, step: 1 }),
      ev('request/header', 20, {
        header: { config: { provider: 'deepseek-official', model: 'dsh-v0-model' }, system: 'You are v0.' },
      }),
      ev('user/message', 30, {
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' }, role: 'user', id: 'm-1',
      }, { surfaceOp: 'append' }),
      ev('assistant/chunk', 40, {
        turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
      }),
      // A v0 packed run: members at seqs 6-8 and times T0+50/60/65. The first stamps ttft.
      {
        type: 'reasoning-chunks', seq0: 6, time0: T0 + 50,
        data: { turn: 1, step: 1, index: 0, dt: [10, 5], texts: ['Hel', 'lo', '!'] },
      },
    ]
    // The packed row consumed seqs 6-8, so the envelope counter continues at 9.
    seq += 3
    records.push(
      ev('assistant/message', 80, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Hello!' }] },
        usage: { inputTokens: 10, outputTokens: 3 },
      }),
      ev('step/end', 90, { turn: 1, step: 1 }),
      ev('turn/end', 100, { turn: 1, reason: { kind: 'completed' } }),
    )
    const last = view(records)

    expect(last.model).toBe('dsh-v0-model')
    // header.system is the v0 system prompt.
    expect(last.current.system).toBeGreaterThan(0)
    expect(last.requests).toHaveLength(1)
    // step/start at T0+10 → first packed member at T0+50.
    expect(last.timing?.ttftMs).toBe(40)
  })
})

describe('dsh fold — image/offload', () => {
  const image = (attachmentId: string, width = 560, height = 420): Rec => ({
    type: 'image',
    attachment: { attachmentId, name: `${attachmentId}.png`, mediaType: 'image/png', bytes: 9999, width, height },
  })

  const userImage = (offsetMs: number, images: readonly Rec[]): Rec => ev('user/message', offsetMs, {
    content: [{ type: 'text', text: 'see these' }, ...images],
    source: { kind: 'user' }, role: 'user', id: `m-${offsetMs}`,
  }, { surfaceOp: 'append' })

  const offload = (offsetMs: number, seq: number, imageIndexes: readonly number[]): Rec =>
    ev('image/offload', offsetMs, { targets: [{ seq, imageIndexes }] })

  it('replays a user image node as a text placeholder and drops its image count', () => {
    seq = 0
    const before = view([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      userImage(10, [image('a'.repeat(8)), image('b'.repeat(8))]),
    ])
    expect(before.images).toBe(2)
    const node = before.nodes.find(n => n.seq === 2)
    const tokensBefore = node?.tokens ?? 0
    expect(tokensBefore).toBeGreaterThan(0)

    seq = 0
    const last = view([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      userImage(10, [image('a'.repeat(8)), image('b'.repeat(8))]),
      offload(20, 2, [0]),
    ])
    // One selected image left the surface payload; the other still counts.
    expect(last.images).toBe(1)
    // The projected copy is a fresh node just past the offload event (seq 3.5):
    // the original seq-2 node left the live surface and archives with the
    // replay seq as its `gone` boundary.
    const projected = last.nodes.find(n => n.seq === 3.5)
    expect(projected).toBeDefined()
    expect(projected?.tokens ?? 0).toBeLessThan(tokensBefore)
    expect(last.nodes.some(n => n.seq === 2)).toBe(false)
    const original = last.archive.find(n => n.seq === 2)
    expect(original?.gone).toBe(3.5)
    // A replayed copy is not a second human input and not a new inject row.
    expect(last.humanInputs).toBe(1)
    expect(last.events.filter(event => event.kind === 'inject')).toHaveLength(0)
  })

  it('keeps the pre-offload content browseable through the history layer', () => {
    seq = 0
    const context = new ContextSession('dsh')
    const push = (record: Rec) => context.push(line(record), MAIN)
    push(header())
    push(ev('turn/start', 0, { turn: 1 }))
    push(userImage(10, [image('a'.repeat(8))]))
    // A request settles while the image is still whole.
    push(ev('assistant/message', 20, {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'looking' }], id: 'a-1' },
      usage: { inputTokens: 10, outputTokens: 2 },
    }))
    push(offload(30, 2, [0]))
    // The retained content under the ORIGINAL seq is untouched — browsing
    // the request-3 surface shows the image the request was made with.
    const original = context.contentOf(MAIN.id, 2)
    expect(original?.some(block => block.type === 'image')).toBe(true)
    // The live copy (seq 4.5) projects the upstream placeholder text.
    const timeline = context.timelineOf(MAIN.id)
    const live = timeline?.nodes.find(n => n.seq === 4.5)
    expect(live).toBeDefined()
    const projected = context.contentOf(MAIN.id, 4.5)
    expect(projected?.some(block =>
      block.type === 'text' && (block.text ?? '').includes('image omitted'))).toBe(true)
    // Archive boundary: the original left the surface at the offload's seq,
    // so a request at seq 3 (pre-offload) still counts it alive.
    const archived = timeline?.archive.find(n => n.seq === 2)
    expect(archived?.gone).toBe(4.5)
    const requestSeq = 3
    expect(archived !== undefined && archived.seq < requestSeq && (archived.gone ?? 0) > requestSeq)
      .toBe(true)
  })

  it('projects images nested inside a tool result and keeps the tool label', () => {
    seq = 0
    const last = view([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 5, { turn: 1, step: 1 }),
      ev('tool/call', 10, { turn: 1, step: 1, callId: 'call_1', name: 'screenshot', arguments: '{}' }),
      ev('tool/result', 20, {
        turn: 1, step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_1' },
          content: [{
            type: 'tool-result', toolCallId: 'call_1',
            content: [{ type: 'text', text: 'captured' }, image('c'.repeat(8))],
            isError: false,
          }],
          role: 'user', id: 'r-1',
        },
      }, { surfaceOp: 'append' }),
      offload(30, 4, [0]),
    ])
    expect(last.images).toBe(0)
    const node = last.nodes.find(n => n.seq === 5.5)
    expect(node?.tool).toBe('screenshot')
    // The replay must not re-run the call's timing bookkeeping.
    expect(last.timing?.toolCalls).toBe(1)
  })

  it('applies repeated offloads to the same node in order', () => {
    seq = 0
    const last = view([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      userImage(10, [image('a'.repeat(8)), image('b'.repeat(8)), image('c'.repeat(8))]),
      offload(20, 2, [0]),
      // Indexes still count every image occurrence, already-offloaded included.
      offload(30, 2, [2]),
    ])
    expect(last.images).toBe(1)
    // Each replay replaces the previous projected copy: only the newest
    // (seq 4.5) is live.
    expect(last.nodes.map(n => n.seq)).toEqual([4.5])
    expect(last.archive.map(n => n.seq)).toEqual([2, 3.5])
  })

  it('ignores unknown, out-of-range, and already-offloaded targets', () => {
    seq = 0
    const last = view([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      userImage(10, [image('a'.repeat(8))]),
      ev('image/offload', 20, { targets: [{ seq: 99, imageIndexes: [0] }] }),
      ev('image/offload', 25, { targets: [{ seq: 2, imageIndexes: [7] }] }),
      ev('image/offload', 30, { targets: [{ seq: 2, imageIndexes: [] }] }),
      ev('image/offload', 35, { targets: [{ imageIndexes: [0] }] }),
      offload(40, 2, [0]),
      // The same occurrence cannot be offloaded twice.
      offload(45, 2, [0]),
    ])
    expect(last.images).toBe(0)
    const node = last.nodes.find(n => n.seq === 7.5)
    expect(node?.imgs).toBeUndefined()
  })

  it('lets a later compaction claim the projected copy by its original seq', () => {
    seq = 0
    const last = view([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      userImage(10, [image('a'.repeat(8))]),
      offload(20, 2, [0]),
      // The producer still names the ORIGINAL seq it shadowed; the synth
      // translates the claim onto the live replay copy.
      ev('compaction/summary', 30, {
        summary: [{ type: 'text', text: 'condensed' }],
        shadowedSeqs: [2], shadowedTokenCount: 10,
      }),
      ev('user/message', 35, {
        content: [{ type: 'text', text: 'condensed' }],
        source: { kind: 'plugin', plugin: 'compaction' }, role: 'user', id: 'cm-1',
      }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }),
    ])
    expect(last.images).toBe(0)
    expect(last.nodes.map(n => n.seq)).toEqual([5])
    expect(last.nodes[0]?.text).toBe('condensed')
    // Both the original and its projected copy are gone.
    expect(last.archive.map(n => n.seq)).toEqual([2, 3.5])
  })

  it('orders a projected copy at its surface slot in assemble, live and historical', () => {
    seq = 0
    const last = view([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      userImage(10, [image('a'.repeat(8))]),
      ev('assistant/message', 20, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'looking' }], id: 'a-1' },
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
      offload(30, 2, [0]),
    ])
    // The copy's own seq (4.5) postdates the assistant reply (3); `pos`
    // sorts it at the slot it took over — a plain seq sort would display
    // the user message after the reply.
    const live = assemble(last, null, null)
    expect(live.nodes.map(n => n.seq)).toEqual([4.5, 3])
    expect(live.nodes[0]?.pos).toBe(2)
    // The request at seq 3 predates the offload: the archived original
    // reconstructs in the same slot with its image intact.
    const past = assemble(last, null, 3)
    expect(past.nodes.map(n => n.seq)).toEqual([2])
    // And the post-offload view picks the copy at the same position.
    const after = assemble(last, null, 5)
    expect(after.nodes.map(n => n.seq)).toEqual([4.5, 3])
  })

  it('still removes a live copy whose retained payload aged out of the cache', () => {
    seq = 0
    const records: Rec[] = [
      header(),
      ev('turn/start', 0, { turn: 1 }),
      userImage(10, [image('a'.repeat(8))]),
      offload(20, 2, [0]),
    ]
    // Enough image-bearing nodes to evict seq-2's retained payload — the
    // original→live seq mapping must survive the cache bound regardless.
    for (let i = 0; i < 260; i += 1) records.push(userImage(30 + i, [image('x'.repeat(8))]))
    records.push(
      ev('compaction/summary', 400, {
        summary: [{ type: 'text', text: 'condensed' }],
        shadowedSeqs: [2], shadowedTokenCount: 10,
      }),
      ev('user/message', 410, {
        content: [{ type: 'text', text: 'condensed' }],
        source: { kind: 'plugin', plugin: 'compaction' }, role: 'user', id: 'cm-1',
      }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }),
    )
    const last = view(records)
    // The claim named the ORIGINAL seq (2); the live copy (3.5) it mapped
    // to is what had to leave the surface — no residue, no double-count.
    expect(last.nodes.some(n => n.seq === 3.5)).toBe(false)
  })

  it('ignores a target whose node a replacement already removed', () => {
    seq = 0
    const last = view([
      header(),
      ev('turn/start', 0, { turn: 1 }),
      userImage(10, [image('a'.repeat(8))]),
      // Compaction replaces the image-bearing message entirely.
      ev('compaction/summary', 20, {
        summary: [{ type: 'text', text: 'condensed' }],
        shadowedSeqs: [2], shadowedTokenCount: 10,
      }),
      ev('user/message', 25, {
        content: [{ type: 'text', text: 'condensed' }],
        source: { kind: 'plugin', plugin: 'compaction' }, role: 'user', id: 'cm-1',
      }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }),
      // The offload arrives after the node is gone — nothing replays.
      offload(30, 2, [0]),
    ])
    expect(last.images).toBe(0)
    expect(last.nodes.map(n => n.seq)).toEqual([4])
    expect(last.nodes[0]?.text).toBe('condensed')
  })
})
