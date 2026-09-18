/**
 * The pure emission plan (`opencode/transcript.ts`): settle/close rules,
 * strict id ordering, the trailing-user patience gate, prune detection, and
 * live/replay equivalence. Rows are hand-written with the real V1 field
 * names (`role`, `time.{created,completed}`, `state.{status,input,output,
 * time.compacted}`); no fixtures.
 */

import { describe, expect, it } from 'vitest'
import type { OpencodeMessageRow, OpencodePartRow } from '../src/opencode/db.ts'
import {
  emptyCursor, isSettled, isTerminal, parseMessageRow, parsePartRow, planLines,
  type ParsedMessage, type ParsedPart, type TranscriptCursor, type WireLine,
} from '../src/opencode/transcript.ts'

const T = 1_700_000_000_000 // epoch ms

function msgRow(id: string, data: Record<string, unknown>, created: number, updated = created): OpencodeMessageRow {
  return { id, session_id: 'ses', time_created: created, time_updated: updated, data: JSON.stringify(data) }
}

function partRow(
  id: string,
  messageId: string,
  data: Record<string, unknown>,
  created: number,
  updated = created,
): OpencodePartRow {
  return { id, message_id: messageId, session_id: 'ses', time_created: created, time_updated: updated, data: JSON.stringify(data) }
}

function msg(id: string, data: Record<string, unknown>, created: number, updated = created): ParsedMessage {
  return parseMessageRow(msgRow(id, data, created, updated))
}

function part(id: string, messageId: string, data: Record<string, unknown>, created: number, updated = created): ParsedPart {
  return parsePartRow(partRow(id, messageId, data, created, updated))
}

const userData = (created: number): Record<string, unknown> => ({
  role: 'user', time: { created }, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude' },
})

const assistantData = (created: number, terminal: Partial<Record<'completed' | 'finish', unknown>> = {}): Record<string, unknown> => ({
  role: 'assistant', parentID: 'msg_user', modelID: 'claude', providerID: 'anthropic',
  time: { created, ...(terminal.completed === undefined ? {} : { completed: terminal.completed }) },
  tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
  ...(terminal.finish === undefined ? {} : { finish: terminal.finish }),
})

const textPart = (start: number, end?: number): Record<string, unknown> => ({
  type: 'text', text: 'body', time: { start, ...(end === undefined ? {} : { end }) },
})

const toolPart = (status: string, compacted?: number): Record<string, unknown> => ({
  type: 'tool', callID: 'call_1', tool: 'bash',
  state: {
    status, input: { command: 'ls' }, output: 'ok',
    time: { start: T, end: T + 5, ...(compacted === undefined ? {} : { compacted }) },
  },
})

function live(cursor: TranscriptCursor, messages: ParsedMessage[] = [], parts: ParsedPart[] = []): WireLine[] {
  return planLines({ messages, parts, cursor, mode: { kind: 'live' } }).lines
}

function replay(messages: ParsedMessage[], parts: ParsedPart[], pinned: TranscriptCursor): WireLine[] {
  return planLines({ messages, parts, cursor: emptyCursor(), mode: { kind: 'replay', pinned } }).lines
}

const kinds = (lines: readonly WireLine[]): string[] =>
  lines.map(line => (JSON.parse(line.line) as { t: string }).t)

describe('settle and terminal rules', () => {
  it('isTerminal lands on time.completed or error', () => {
    expect(isTerminal({ time: { created: T } })).toBe(false)
    expect(isTerminal({ time: { created: T, completed: T + 1 } })).toBe(true)
    expect(isTerminal({ time: { created: T }, error: { name: 'APIError' } })).toBe(true)
  })

  it('isSettled per part type', () => {
    const open = { time: { created: T } }
    // text: a time-less block is complete on sight; a timed one needs end.
    expect(isSettled({ type: 'text', text: 'x' }, open, false)).toBe(true)
    expect(isSettled({ type: 'text', text: 'x', time: { start: T } }, open, false)).toBe(false)
    expect(isSettled({ type: 'text', text: 'x', time: { start: T, end: T + 1 } }, open, false)).toBe(true)
    // reasoning needs time.end.
    expect(isSettled({ type: 'reasoning', text: 'r', time: { start: T } }, open, false)).toBe(false)
    expect(isSettled({ type: 'reasoning', text: 'r', time: { start: T, end: T + 1 } }, open, false)).toBe(true)
    // tool needs a terminal status.
    expect(isSettled(toolPart('pending'), open, false)).toBe(false)
    expect(isSettled(toolPart('running'), open, false)).toBe(false)
    expect(isSettled(toolPart('completed'), open, false)).toBe(true)
    expect(isSettled(toolPart('error'), open, false)).toBe(true)
    // every other type settles on sight.
    expect(isSettled({ type: 'step-start' }, open, false)).toBe(true)
    expect(isSettled({ type: 'mystery' }, open, false)).toBe(true)
    // a terminal message or a later ASSISTANT message settles anything.
    expect(isSettled({ type: 'reasoning', text: 'r', time: { start: T } },
      { time: { created: T, completed: T + 1 } }, false)).toBe(true)
    expect(isSettled(toolPart('pending'), open, true)).toBe(true)
  })
})

describe('planLines — live', () => {
  it('emits header → parts → finish for a terminal assistant', () => {
    const cursor = emptyCursor()
    const lines = live(cursor,
      [msg('msg_a', assistantData(T, { completed: T + 9, finish: 'stop' }), T)],
      [part('prt_1', 'msg_a', textPart(T, T + 4), T)])
    expect(kinds(lines)).toEqual(['opencode.message', 'opencode.part', 'opencode.finish'])
    expect(lines.every(line => line.kind === 'stream')).toBe(true)
  })

  it('a settled part waits for its unsettled predecessors (strict id order)', () => {
    const cursor = emptyCursor()
    const open = msg('msg_a', assistantData(T), T)
    const pending = part('prt_1', 'msg_a', toolPart('pending'), T)
    const done = part('prt_2', 'msg_a', toolPart('completed'), T)
    // prt_2 is settled but prt_1 is not: nothing past the header emits.
    const first = live(cursor, [open], [pending, done])
    expect(kinds(first)).toEqual(['opencode.message'])
    // prt_1 completes: both emit, in id order.
    const settledP1 = part('prt_1', 'msg_a', toolPart('completed'), T, T + 50)
    const second = live(cursor, [], [settledP1])
    expect(kinds(second)).toEqual(['opencode.part', 'opencode.part'])
    expect((JSON.parse(second[0]!.line) as { id: string }).id).toBe('prt_1')
    expect((JSON.parse(second[1]!.line) as { id: string }).id).toBe('prt_2')
  })

  it('a trailing user message waits one tick for its parts', () => {
    const cursor = emptyCursor()
    const prompt = msg('msg_u', userData(T), T)
    const p = part('prt_u1', 'msg_u', { type: 'text', text: 'do it' }, T)
    // First sighting as the trailing row: header held back.
    expect(live(cursor, [prompt], [p])).toEqual([])
    // The patience pass (no new rows) releases it — header carries the parts.
    const second = live(cursor)
    expect(kinds(second)).toEqual(['opencode.message'])
    const header = JSON.parse(second[0]!.line) as { parts: { id: string }[] }
    expect(header.parts.map(part => part.id)).toEqual(['prt_u1'])
    expect(cursor.parts.has('prt_u1')).toBe(true)
  })

  it('a trailing user message emits early when a later message exists', () => {
    const cursor = emptyCursor()
    const lines = live(cursor,
      [msg('msg_u', userData(T), T), msg('msg_a', assistantData(T + 1), T + 1)],
      [part('prt_u1', 'msg_u', { type: 'text', text: 'go' }, T)])
    expect(kinds(lines)).toEqual(['opencode.message', 'opencode.message'])
  })

  it('a crashed assistant closes when the next ASSISTANT message appears — no finish', () => {
    const cursor = emptyCursor()
    // A queued user row lands while msg_a streams — it must NOT settle or
    // close anything. Only the next ASSISTANT row proves the writer moved on.
    const queued = live(cursor,
      [msg('msg_a', assistantData(T), T), msg('msg_u2', userData(T + 10), T + 10)],
      [
        part('prt_1', 'msg_a', textPart(T), T),
        part('prt_u2', 'msg_u2', { type: 'text', text: 'again' }, T + 10),
      ])
    expect(kinds(queued)).toEqual(['opencode.message'])
    expect(cursor.headers.has('msg_u2')).toBe(false)
    // The user's next prompt produces a new assistant message: msg_a's
    // streaming text settles and it closes with no finish; msg_u2's header
    // releases on the later row and msg_a2 emits its own block.
    const second = live(cursor,
      [msg('msg_a2', assistantData(T + 20, { completed: T + 29, finish: 'stop' }), T + 20)],
      [part('prt_a2', 'msg_a2', textPart(T + 21, T + 25), T + 21)])
    expect(kinds(second)).toEqual([
      'opencode.part', 'opencode.message', 'opencode.message',
      'opencode.part', 'opencode.finish',
    ])
    expect((JSON.parse(second[1]!.line) as { id: string }).id).toBe('msg_u2')
    expect((JSON.parse(second[2]!.line) as { id: string }).id).toBe('msg_a2')
    expect(cursor.finished.has('msg_a')).toBe(false)
    expect(live(cursor)).toEqual([])
  })

  it('a queued user prompt waits behind a streaming assistant; its finish still ships', () => {
    const cursor = emptyCursor()
    // msg_u2's row lands BEFORE msg_a completes (the prompt path writes the
    // user row, then joins the running loop) — real store behavior.
    const first = live(cursor,
      [msg('msg_a', assistantData(T), T), msg('msg_u2', userData(T + 10), T + 10)],
      [
        part('prt_1', 'msg_a', textPart(T), T),
        part('prt_2', 'msg_a', toolPart('running'), T + 1),
        part('prt_u2', 'msg_u2', { type: 'text', text: 'queued' }, T + 10),
      ])
    // Nothing settles off the queued user row: header only.
    expect(kinds(first)).toEqual(['opencode.message'])
    // Parts settle and terminal facts land: part, part, finish, THEN the
    // queued user header (msg_u2 was the trailing row last pass, so the
    // patience gate releases it in the same walk).
    const second = live(cursor,
      [msg('msg_a', assistantData(T, { completed: T + 20, finish: 'stop' }), T, T + 20)],
      [
        part('prt_1', 'msg_a', textPart(T, T + 15), T, T + 20),
        part('prt_2', 'msg_a', toolPart('completed'), T + 1, T + 20),
      ])
    expect(kinds(second)).toEqual([
      'opencode.part', 'opencode.part', 'opencode.finish', 'opencode.message',
    ])
    const finish = JSON.parse(second[2]!.line) as { t: string; msg: { tokens: { input: number } } }
    expect(finish.msg.tokens.input).toBe(10)
  })

  it('a compaction user header waits for tail_start_id, then ships with it', () => {
    const cursor = emptyCursor()
    // Pass 1: the summary assistant is not terminal — nothing emits.
    const first = live(cursor,
      [msg('msg_c', userData(T), T), msg('msg_s', assistantData(T + 10), T + 10)],
      [
        part('prt_c0', 'msg_c', { type: 'compaction', auto: true }, T),
        part('prt_s1', 'msg_s', textPart(T + 11, T + 15), T + 11),
      ])
    expect(first).toEqual([])
    // Pass 2: the summary goes terminal but the part UPDATE carrying
    // tail_start_id (which lands ~1–2 ms later in the real store) has not
    // arrived — arms compactionSeen, still nothing.
    const second = live(cursor,
      [msg('msg_s', assistantData(T + 10, { completed: T + 19, finish: 'stop' }), T + 10, T + 19)],
      [])
    expect(second).toEqual([])
    expect(cursor.compactionSeen).toBe('msg_c')
    // Pass 3: the update lands — the header ships WITH tail_start_id,
    // then the summary's own header/part/finish right behind it.
    const third = live(cursor, [], [
      part('prt_c0', 'msg_c', { type: 'compaction', auto: true, tail_start_id: 'msg_u0' }, T, T + 20),
    ])
    expect(kinds(third)).toEqual([
      'opencode.message', 'opencode.message', 'opencode.part', 'opencode.finish',
    ])
    const header = JSON.parse(third[0]!.line) as {
      id: string
      parts: { type: string; tail_start_id?: string }[]
    }
    expect(header.id).toBe('msg_c')
    expect(header.parts[0]?.tail_start_id).toBe('msg_u0')
  })

  it('a compaction user header releases when the summary errored', () => {
    const cursor = emptyCursor()
    // An errored summary never updates the part — nothing will compact, so
    // the header ships in the same pass.
    const lines = live(cursor,
      [msg('msg_c', userData(T), T),
        msg('msg_s', {
          ...assistantData(T + 10, { completed: T + 19 }),
          error: { name: 'APIError', data: { message: 'boom' } },
        }, T + 10)],
      [
        part('prt_c0', 'msg_c', { type: 'compaction', auto: true }, T),
        part('prt_s1', 'msg_s', textPart(T + 11, T + 15), T + 11),
      ])
    expect(kinds(lines)).toEqual([
      'opencode.message', 'opencode.message', 'opencode.part', 'opencode.finish',
    ])
    expect((JSON.parse(lines[0]!.line) as { id: string }).id).toBe('msg_c')
  })

  it('a compaction user header ignores a queued prompt and waits for the summary', () => {
    const cursor = emptyCursor()
    // A prompt queued while the summary is still generating lands a user
    // row beyond it — that proves nothing about `tail_start_id`; only an
    // assistant beyond the summary (or the patience tick) releases.
    const first = live(cursor,
      [msg('msg_c', userData(T), T),
        msg('msg_s', assistantData(T + 10), T + 10),
        msg('msg_u2', userData(T + 20), T + 20)],
      [
        part('prt_c0', 'msg_c', { type: 'compaction', auto: true }, T),
        part('prt_s1', 'msg_s', textPart(T + 11, T + 15), T + 11),
        part('prt_u2', 'msg_u2', { type: 'text', text: 'queued' }, T + 20),
      ])
    expect(first).toEqual([])
    // Pass 2: the summary goes terminal — arms compactionSeen, still waits.
    const second = live(cursor,
      [msg('msg_s', assistantData(T + 10, { completed: T + 19, finish: 'stop' }), T + 10, T + 19)],
      [])
    expect(second).toEqual([])
    expect(cursor.compactionSeen).toBe('msg_c')
    // Pass 3: the part update lands — the compaction header ships WITH
    // tail_start_id, then the summary block, then the queued user header.
    const third = live(cursor, [], [
      part('prt_c0', 'msg_c', { type: 'compaction', auto: true, tail_start_id: 'msg_u0' }, T, T + 20),
    ])
    expect(kinds(third)).toEqual([
      'opencode.message', 'opencode.message', 'opencode.part', 'opencode.finish',
      'opencode.message',
    ])
    const header = JSON.parse(third[0]!.line) as {
      id: string
      parts: { type: string; tail_start_id?: string }[]
    }
    expect(header.id).toBe('msg_c')
    expect(header.parts[0]?.tail_start_id).toBe('msg_u0')
    expect((JSON.parse(third[4]!.line) as { id: string }).id).toBe('msg_u2')
  })

  it('a compaction user header releases when an assistant exists beyond the summary', () => {
    const cursor = emptyCursor()
    // The continue message and the next assistant are already there — the
    // loop provably moved past the part update, so the range is final.
    const first = live(cursor,
      [msg('msg_c', userData(T), T),
        msg('msg_s', assistantData(T + 10, { completed: T + 19, finish: 'stop' }), T + 10),
        msg('msg_u2', userData(T + 20), T + 20),
        msg('msg_a2', assistantData(T + 30, { completed: T + 39, finish: 'stop' }), T + 30)],
      [
        part('prt_c0', 'msg_c', { type: 'compaction', auto: true, tail_start_id: 'msg_u0' }, T),
        part('prt_s1', 'msg_s', textPart(T + 11, T + 15), T + 11),
        part('prt_u2', 'msg_u2', { type: 'text', text: 'continue', synthetic: true }, T + 20),
        part('prt_a2', 'msg_a2', textPart(T + 31, T + 35), T + 31),
      ])
    expect(kinds(first)).toEqual([
      'opencode.message', 'opencode.message', 'opencode.part', 'opencode.finish',
      'opencode.message', 'opencode.message', 'opencode.part', 'opencode.finish',
    ])
    const header = JSON.parse(first[0]!.line) as {
      id: string
      parts: { type: string; tail_start_id?: string }[]
    }
    expect(header.id).toBe('msg_c')
    expect(header.parts[0]?.tail_start_id).toBe('msg_u0')
  })

  it('a finish waits for its own parts even when terminal', () => {
    const cursor = emptyCursor()
    // Terminal message, but its tool part is still pending: settle comes
    // from TERMINAL(msg), so the part emits too — finish follows it.
    const lines = live(cursor,
      [msg('msg_a', assistantData(T, { completed: T + 9, finish: 'stop' }), T)],
      [part('prt_1', 'msg_a', toolPart('running'), T)])
    expect(kinds(lines)).toEqual(['opencode.message', 'opencode.part', 'opencode.finish'])
  })

  it('a part arriving for an already-closed message appends rather than dropping', () => {
    const cursor = emptyCursor()
    live(cursor,
      [msg('msg_a', assistantData(T, { completed: T + 9, finish: 'stop' }), T),
        msg('msg_u', userData(T + 10), T + 10)],
      [part('prt_u', 'msg_u', { type: 'text', text: 'x' }, T + 10)])
    // Drain the trailing user header, then msg_a is fully closed.
    live(cursor)
    // A late part row for the closed message still emits — an append.
    const late = live(cursor, [], [part('prt_late', 'msg_a', textPart(T, T + 1), T + 1, T + 20)])
    expect(kinds(late)).toEqual(['opencode.part'])
    expect((JSON.parse(late[0]!.line) as { id: string }).id).toBe('prt_late')
  })

  it('a pruned tool part yields one opencode.prune sidecar, once', () => {
    const cursor = emptyCursor()
    live(cursor,
      [msg('msg_a', assistantData(T), T), msg('msg_u', userData(T + 10), T + 10)],
      [
        part('prt_1', 'msg_a', toolPart('completed'), T),
        part('prt_u', 'msg_u', { type: 'text', text: 'x' }, T + 10),
      ])
    // Drain the trailing user header first so only the prune comes out.
    live(cursor)
    // The row mutates in place: state.time.compacted lands on the emitted part.
    const compacted = part('prt_1', 'msg_a', toolPart('completed', T + 500), T, T + 500)
    const first = live(cursor, [], [compacted])
    expect(kinds(first)).toEqual(['opencode.prune'])
    expect(first[0]!.kind).toBe('sidecar')
    expect((JSON.parse(first[0]!.line) as { callID: string }).callID).toBe('call_1')
    // Remembered: the same row seen again does not re-send.
    expect(live(cursor, [], [compacted])).toEqual([])
  })
})

describe('planLines — replay equivalence', () => {
  it('live in three batches then replay once produces identical lines', () => {
    const cursor = emptyCursor()
    const m1 = msg('msg_u1', userData(T), T)
    const m2 = msg('msg_a1', assistantData(T + 10), T + 10)
    // msg_a1's terminal facts land on the SAME row in batch 2 (fresher data).
    const m2done = msg('msg_a1', assistantData(T + 10, { completed: T + 19, finish: 'tool-calls' }), T + 10, T + 40)
    const m3 = msg('msg_a2', assistantData(T + 20, { completed: T + 29, finish: 'stop' }), T + 20)
    const m4 = msg('msg_u2', userData(T + 30), T + 30)
    const pU1 = part('prt_u1', 'msg_u1', { type: 'text', text: 'first' }, T)
    const p1 = part('prt_1', 'msg_a1', toolPart('completed'), T + 11)
    const p2 = part('prt_2', 'msg_a1', textPart(T + 12, T + 15), T + 12)
    const p3 = part('prt_3', 'msg_a2', textPart(T + 21, T + 25), T + 21)
    const pU2 = part('prt_u2', 'msg_u2', { type: 'text', text: 'second' }, T + 30)

    const liveLines = [
      // Batch 1: prompt + open assistant step, one settled part.
      ...live(cursor, [m1, m2], [pU1, p1]),
      // Batch 2: msg_a1 turns terminal and a second step completes.
      ...live(cursor, [m2done, m3], [p2, p3]),
      // Batch 3: a trailing prompt (released by the patience pass).
      ...live(cursor, [m4], [pU2]),
      ...live(cursor),
    ]

    const allMessages = [m1, m2done, m3, m4]
    const allParts = [pU1, p1, p2, p3, pU2]
    const replayed = replay(allMessages, allParts, cursor)
    // Replay re-derives lines from the CURRENT rows — msg_a1's header
    // legitimately carries its terminal facts now ("fresher is fine"). What
    // must be identical is the emitted sequence: same record kinds and ids
    // in the same order (the stream's line numbering).
    const shape = (line: WireLine): string => {
      const record = JSON.parse(line.line) as { t: string; id: string }
      return `${record.t}:${record.id}`
    }
    expect(replayed.map(shape)).toEqual(liveLines.map(shape))
    expect(replayed.map(line => line.time)).toEqual(liveLines.map(line => line.time))
    expect(replayed.length).toBeGreaterThan(0)
  })

  it('replay does not mutate the pinned cursor', () => {
    const cursor = emptyCursor()
    const m = msg('msg_a', assistantData(T, { completed: T + 9, finish: 'stop' }), T)
    const p = part('prt_1', 'msg_a', textPart(T, T + 1), T)
    live(cursor, [m], [p])
    const snapshot = {
      headers: new Set(cursor.headers),
      parts: new Set(cursor.parts),
      finished: new Set(cursor.finished),
      pruned: new Set(cursor.pruned),
      trailingSeen: cursor.trailingSeen,
      pending: cursor.pending.size,
    }
    replay([m], [p], cursor)
    expect(cursor.headers).toEqual(snapshot.headers)
    expect(cursor.parts).toEqual(snapshot.parts)
    expect(cursor.finished).toEqual(snapshot.finished)
    expect(cursor.pruned).toEqual(snapshot.pruned)
    expect(cursor.trailingSeen).toBe(snapshot.trailingSeen)
    expect(cursor.pending.size).toBe(snapshot.pending)
  })

  it('replay emits a pinned prune sidecar for each pruned part', () => {
    const cursor = emptyCursor()
    const m = msg('msg_a', assistantData(T), T)
    const u = msg('msg_u', userData(T + 10), T + 10)
    const p = part('prt_1', 'msg_a', toolPart('completed'), T)
    const pu = part('prt_u', 'msg_u', { type: 'text', text: 'x' }, T + 10)
    const liveStream = [...live(cursor, [m, u], [p, pu]), ...live(cursor)]
    const compacted = part('prt_1', 'msg_a', toolPart('completed', T + 500), T, T + 500)
    live(cursor, [], [compacted])
    const replayed = replay([m, u], [compacted, pu], cursor)
    const prunes = replayed.filter(line => line.kind === 'sidecar')
    expect(prunes).toHaveLength(1)
    expect(kinds(prunes)).toEqual(['opencode.prune'])
    // The same stream lines come out — replay re-derives them from the
    // current rows (the pruned part's fresher content is fine), so compare
    // record identity, not bytes.
    const shape = (line: WireLine): string => {
      const record = JSON.parse(line.line) as { t: string; id: string }
      return `${record.t}:${record.id}`
    }
    expect(replayed.filter(line => line.kind === 'stream').map(shape))
      .toEqual(liveStream.map(shape))
  })

  it('replay re-emits an anomaly append at the stream tail — numbering identical', () => {
    const cursor = emptyCursor()
    const m = msg('msg_a', assistantData(T, { completed: T + 9, finish: 'stop' }), T)
    const u = msg('msg_u', userData(T + 10), T + 10)
    const p = part('prt_1', 'msg_a', textPart(T, T + 1), T)
    const pu = part('prt_u', 'msg_u', { type: 'text', text: 'x' }, T + 10)
    const late = part('prt_late', 'msg_a',
      { type: 'text', text: 'late', time: { start: T + 2, end: T + 3 } }, T + 2, T + 30)
    const liveStream = [
      ...live(cursor, [m, u], [p, pu]),
      ...live(cursor),               // release the trailing user header
      ...live(cursor, [], [late]),   // anomaly append at the tail
    ]
    expect(kinds(liveStream)).toEqual([
      'opencode.message', 'opencode.part', 'opencode.finish',
      'opencode.message', 'opencode.part',
    ])
    expect(cursor.appended).toEqual(['prt_late'])
    const replayed = replay([m, u], [p, pu, late], cursor)
    const shape = (line: WireLine): string => {
      const record = JSON.parse(line.line) as { t: string; id: string }
      return `${record.t}:${record.id}`
    }
    expect(replayed.map(shape)).toEqual(liveStream.map(shape))
    // The appended part does NOT leak back into its message's block.
    expect(replayed.at(-1)?.line).toContain('prt_late')
  })
})
