/**
 * OpenCode transcript emission plan — the PURE half of `OpencodeSource`.
 * Given parsed `message`/`part` rows and a per-stream cursor it decides
 * which wire lines (docs/harness-formats.md → OpenCode → Wire vocabulary)
 * come out; no I/O, no timers.
 *
 * Verified against opencode 1.18.31 (`packages/core/src/session/sql.ts`,
 * `packages/schema/src/v1/session.ts`) and a 1.18.x local store. Traps the
 * plan exists for:
 *
 *  - Everything is epoch MILLISECONDS (`time_created`/`time_updated` on the
 *    row, `time.{created,completed,start,end,compacted}` inside `data`).
 *  - Rows MUTATE: text/reasoning parts stream (`time.end` lands late), tool
 *    parts go pending→running→completed|error, an assistant's terminal
 *    facts (`time.completed`/`tokens`/`cost`/`finish`/`error`) land at step
 *    end. A part is emitted only once SETTLED; a finish only once TERMINAL.
 *  - "Writer moved on" means a later ASSISTANT message — the only kind that
 *    never overlaps (one assistant row per step, sequential). A queued
 *    prompt's user row lands while the previous assistant is still
 *    streaming (~10% of prompts in a real store), so a later message of any
 *    role is NOT evidence the step ended: the user header waits behind the
 *    open assistant, which is also how OpenCode renders it.
 *  - Emission order is strict — header, parts in `id` order, finish, then
 *    the next message — because a part that settles before an earlier
 *    sibling must WAIT: live and replay derive the same line numbering
 *    (search hits address `(file, line)`).
 *  - A part row arriving for an already-CLOSED message is an anomaly (a
 *    late write): it is appended to the stream rather than dropped, and the
 *    cursor records the append order in `appended` so replay re-emits the
 *    same ids at the same tail position — the numbering stays identical.
 *  - `SessionCompaction.prune` mutates an already-emitted completed tool
 *    part in place (`state.time.compacted`): the row stays, the output
 *    leaves the model context — reported on an `opencode.prune` sidecar
 *    line once, then remembered in `pruned`.
 *  - A user header's `parts` ride inside it (authored atomically), and the
 *    trailing user message waits one poll of patience (`trailingSeen`)
 *    because its part rows land in separate statements a few ms after the
 *    message row. User `summary.diffs` (~500 KB session diffs, not model
 *    content) is stripped at wire time.
 *  - A COMPACTION user header waits for its range to be final: OpenCode
 *    writes the `compaction` part WITHOUT `tail_start_id` and updates it
 *    ~1–2 ms AFTER the summary assistant's `time.completed`. Releasing the
 *    header early would ship `tailStartId: null` downstream (the whole
 *    surface shadows, and a later replay would disagree with live), so it
 *    waits for an ASSISTANT beyond the summary (a queued prompt can land
 *    while the summary still generates — only the next assistant proves
 *    the loop moved past the part update), an errored summary, or one
 *    tick after the summary went terminal (`compactionSeen`).
 *
 * Live and replay share the walk: replay re-runs over the current rows
 * PINNED to the cursor's emitted id sets, so it reproduces exactly what
 * live shipped (fresher row content is fine — the emitted SETS decide).
 */

import { asNumber, asString, isRecord } from '@harness-trajectory/core'
import type { OpencodeMessageRow, OpencodePartRow } from './db.ts'

/** A parsed `message` row: the row plus its V1 `data` JSON. */
export interface ParsedMessage {
  readonly row: OpencodeMessageRow
  readonly data: Record<string, unknown>
}

/** A parsed `part` row: the row plus its V1 `data` JSON. */
export interface ParsedPart {
  readonly row: OpencodePartRow
  readonly data: Record<string, unknown>
}

/** One emitted line: the JSON text, its wire time, and whether it takes a stream index. */
export interface WireLine {
  readonly line: string
  readonly time: number
  readonly kind: 'stream' | 'sidecar'
}

/**
 * What a stream remembers. Deliberately small: NO line retention (the store
 * is the buffer — a replay re-derives content), and `pending` holds rows of
 * the open tail only — a message drops out once CLOSED.
 */
export interface TranscriptCursor {
  /** Message ids whose header line went out. */
  readonly headers: Set<string>
  /** Part ids whose `opencode.part` line went out (incl. header-riding user parts). */
  readonly parts: Set<string>
  /** Assistant message ids whose `opencode.finish` line went out. */
  readonly finished: Set<string>
  /** Part ids an `opencode.prune` line already covered. */
  readonly pruned: Set<string>
  /** Anomaly-appended part ids, in append order (replayed at the stream tail). */
  readonly appended: string[]
  /** The message that was the stream's trailing row on the previous plan pass. */
  trailingSeen: string | null
  /**
   * A compaction user header whose summary landed on the previous pass —
   * the part UPDATE carrying `tail_start_id` arrives 1–2 ms after the
   * summary's `time.completed`, so the header waits one tick for it.
   */
  compactionSeen: string | null
  /**
   * The open tail: messages not yet CLOSED, in `(time_created, id)` order,
   * each with its known parts in `id` order.
   */
  readonly pending: Map<string, PendingMessage>
  /** Part rows seen before their message row (a write torn across the poll). */
  readonly orphans: Map<string, Map<string, ParsedPart>>
}

/** A message still open on the stream, with every part row known so far. */
interface PendingMessage {
  msg: ParsedMessage
  readonly parts: Map<string, ParsedPart>
}

export function emptyCursor(): TranscriptCursor {
  return {
    headers: new Set(),
    parts: new Set(),
    finished: new Set(),
    pruned: new Set(),
    appended: [],
    trailingSeen: null,
    compactionSeen: null,
    pending: new Map(),
    orphans: new Map(),
  }
}

/**
 * Rows the plan has not fully consumed: every `pending` message row (one
 * each, even when its header already went out — its parts and finish may
 * still be open), each pending part row not yet emitted, and every orphan
 * part row. The tail the emitted lines do not yet account for;
 * `countOf − openRowCount` is what the search index may treat as consumed.
 */
export function openRowCount(cursor: TranscriptCursor): number {
  let open = cursor.pending.size
  for (const entry of cursor.pending.values()) {
    for (const partId of entry.parts.keys()) {
      if (!cursor.parts.has(partId)) open += 1
    }
  }
  for (const bag of cursor.orphans.values()) open += bag.size
  return open
}

// -- row parsing -------------------------------------------------------------

/** Parse a `message` row's `data`; unparseable rows get an empty record and ride the stream harmlessly. */
export function parseMessageRow(row: OpencodeMessageRow): ParsedMessage {
  let data: unknown
  try {
    data = JSON.parse(row.data)
  } catch {
    data = undefined
  }
  return { row, data: isRecord(data) ? data : {} }
}

/** Parse a `part` row's `data`. */
export function parsePartRow(row: OpencodePartRow): ParsedPart {
  let data: unknown
  try {
    data = JSON.parse(row.data)
  } catch {
    data = undefined
  }
  return { row, data: isRecord(data) ? data : {} }
}

// -- wire lines (docs/harness-formats.md → OpenCode → Wire vocabulary) -------

/**
 * `summary.diffs` is a ~500 KB session-diff blob — storage bookkeeping, not
 * model content. Strip it from a user message's wire copy; `summary.title`/
 * `body` stay.
 */
function stripSummaryDiffs(data: Record<string, unknown>): Record<string, unknown> {
  const summary = data['summary']
  if (!isRecord(summary) || summary['diffs'] === undefined) return data
  const { diffs: _diffs, ...rest } = summary
  return { ...data, summary: rest }
}

/** The session facts sidecar (`startLine: -1`; re-sent when its content changes). */
export function sessionLine(
  session: Record<string, unknown>,
  children: readonly Record<string, unknown>[],
  time: number,
): WireLine {
  return {
    line: JSON.stringify({ t: 'opencode.session', time, session, children }),
    time,
    kind: 'sidecar',
  }
}

/** A message header; authored parts ride inside for `role: 'user'` only. */
export function headerLine(msg: ParsedMessage, parts: readonly ParsedPart[]): WireLine {
  const role = asString(msg.data['role'])
  const record: Record<string, unknown> = {
    t: 'opencode.message',
    time: msg.row.time_created,
    id: msg.row.id,
    msg: role === 'user' ? stripSummaryDiffs(msg.data) : msg.data,
  }
  if (role === 'user') {
    record['parts'] = parts.map(part => ({ id: part.row.id, ...part.data }))
  }
  return { line: JSON.stringify(record), time: msg.row.time_created, kind: 'stream' }
}

/** One settled assistant part. */
export function partLine(part: ParsedPart): WireLine {
  const record = {
    t: 'opencode.part',
    time: part.row.time_created,
    id: part.row.id,
    messageID: part.row.message_id,
    part: part.data,
  }
  return { line: JSON.stringify(record), time: part.row.time_created, kind: 'stream' }
}

/** An assistant message's terminal facts (tokens, cost, finish, error, completed). */
export function finishLine(msg: ParsedMessage): WireLine {
  const time = msgTime(msg.data, 'completed') ?? msg.row.time_updated
  const record = { t: 'opencode.finish', time, id: msg.row.id, msg: msg.data }
  return { line: JSON.stringify(record), time, kind: 'stream' }
}

/** The cleared-output sidecar for a pruned tool part (`startLine: -1`). */
export function pruneLine(part: ParsedPart): WireLine {
  const time = compactedTime(part.data) ?? part.row.time_updated
  const record = {
    t: 'opencode.prune',
    time,
    id: part.row.id,
    messageID: part.row.message_id,
    callID: asString(part.data['callID']) ?? null,
  }
  return { line: JSON.stringify(record), time, kind: 'sidecar' }
}

// -- settle / close rules (docs/harness-formats.md → OpenCode) ---------------

function msgTime(msg: Record<string, unknown>, key: string): number | undefined {
  const time = isRecord(msg['time']) ? msg['time'] : undefined
  return asNumber(time?.[key])
}

/** `state.time.compacted` on a tool part — the prune marker. */
function compactedTime(part: Record<string, unknown>): number | undefined {
  const state = isRecord(part['state']) ? part['state'] : undefined
  const time = isRecord(state?.['time']) ? state['time'] : undefined
  return asNumber(time?.['compacted'])
}

/** TERMINAL: the assistant message's end facts have landed. */
export function isTerminal(msg: Record<string, unknown>): boolean {
  return msgTime(msg, 'completed') !== undefined || msg['error'] !== undefined
}

/**
 * SETTLED: a part may emit — its own terminal state, or the message is
 * TERMINAL, or a later ASSISTANT message exists (`laterAssistantExists` —
 * the only "writer moved on" signal; a queued prompt's user row lands
 * while the assistant still streams, so it must NOT settle anything). Own
 * terminal state by type: `text` settles when `time.end` lands (or no
 * `time` at all — a non-streamed block), `reasoning` on `time.end`, `tool`
 * on `status ∈ {completed, error}`; every other type (and unknown ones) is
 * settled on sight.
 */
export function isSettled(
  part: Record<string, unknown>,
  msg: Record<string, unknown>,
  laterAssistantExists: boolean,
): boolean {
  if (isTerminal(msg) || laterAssistantExists) return true
  switch (asString(part['type'])) {
    case 'text': {
      const time = part['time']
      if (!isRecord(time)) return true
      return time['end'] !== undefined
    }
    case 'reasoning': {
      const time = isRecord(part['time']) ? part['time'] : undefined
      return time?.['end'] !== undefined
    }
    case 'tool': {
      const state = isRecord(part['state']) ? part['state'] : undefined
      const status = asString(state?.['status'])
      return status === 'completed' || status === 'error'
    }
    default:
      return true
  }
}

/** Whether every part row currently known for `pending` has emitted. */
function allPartsEmitted(cursor: TranscriptCursor, pending: PendingMessage): boolean {
  for (const id of pending.parts.keys()) {
    if (!cursor.parts.has(id)) return false
  }
  return true
}

/**
 * CLOSED: header out, every KNOWN part out, and — for an assistant — the
 * finish went out OR a later ASSISTANT message exists (`laterAssistantExists`:
 * a crashed assistant closes when the next assistant appears; its finish may
 * never land. A queued user row does not close anything).
 */
function isClosed(
  cursor: TranscriptCursor,
  pending: PendingMessage,
  laterAssistantExists: boolean,
): boolean {
  if (!cursor.headers.has(pending.msg.row.id)) return false
  if (!allPartsEmitted(cursor, pending)) return false
  if (asString(pending.msg.data['role']) !== 'assistant') return true
  return cursor.finished.has(pending.msg.row.id) || laterAssistantExists
}

// -- the plan -----------------------------------------------------------------

export interface PlanInput {
  /** Message rows that are new or moved since the last pass (all rows for a full materialize). */
  readonly messages: readonly ParsedMessage[]
  /** Part rows that are new or moved (all rows for a full materialize). */
  readonly parts: readonly ParsedPart[]
  readonly cursor: TranscriptCursor
  readonly mode: { readonly kind: 'live' } | { readonly kind: 'replay'; readonly pinned: TranscriptCursor }
}

export interface PlanOutput {
  /** Lines in emission order; `kind: 'sidecar'` rides `startLine: -1`. */
  readonly lines: WireLine[]
}

/**
 * Merge the changed rows into the cursor's open tail, then walk it emitting
 * whatever newly qualifies. Live mode advances the cursor; replay emits the
 * lines the pinned cursor's id sets name, over the rows as they are now.
 */
export function planLines(input: PlanInput): PlanOutput {
  return input.mode.kind === 'replay'
    ? replayLines(input.messages, input.parts, input.mode.pinned)
    : liveLines(input.messages, input.parts, input.cursor)
}

/** Sort a pending map's keys into `(time_created, id)` order when an insert broke it. */
function resortPending(pending: Map<string, PendingMessage>): void {
  const entries = [...pending.entries()].sort((a, b) =>
    a[1].msg.row.time_created - b[1].msg.row.time_created
    || (a[1].msg.row.id < b[1].msg.row.id ? -1 : a[1].msg.row.id > b[1].msg.row.id ? 1 : 0))
  pending.clear()
  for (const [key, value] of entries) pending.set(key, value)
}

/** Insert/refresh a message row in the open tail (sorted position kept). */
function upsertMessage(cursor: TranscriptCursor, msg: ParsedMessage): PendingMessage | null {
  const id = msg.row.id
  const existing = cursor.pending.get(id)
  if (existing !== undefined) {
    // Fresher data wins (terminal facts land on the same row); position stays.
    existing.msg = msg
    return existing
  }
  if (cursor.headers.has(id)) return null
  const entry: PendingMessage = { msg, parts: new Map() }
  const orphans = cursor.orphans.get(id)
  if (orphans !== undefined) {
    for (const [partId, part] of orphans) entry.parts.set(partId, part)
    cursor.orphans.delete(id)
  }
  cursor.pending.set(id, entry)
  // Rows virtually always arrive in `(time_created, id)` order; a torn
  // write can deliver an older row late — keep the tail sorted.
  const keys = [...cursor.pending.keys()]
  const prev = keys.length >= 2 ? cursor.pending.get(keys[keys.length - 2] ?? '') : undefined
  if (prev !== undefined && (
    prev.msg.row.time_created > msg.row.time_created
    || (prev.msg.row.time_created === msg.row.time_created && prev.msg.row.id > msg.row.id)
  )) {
    resortPending(cursor.pending)
  }
  return entry
}

/**
 * Fold changed rows into the cursor: pending upserts, orphan stashes,
 * prune detections (an already-emitted part gaining `state.time.compacted`)
 * and anomaly appends (a part for an already-CLOSED message — emitted, not
 * dropped). Returns the sidecar/append lines this merge produced.
 */
function noteRows(
  messages: readonly ParsedMessage[],
  parts: readonly ParsedPart[],
  cursor: TranscriptCursor,
): WireLine[] {
  const lines: WireLine[] = []
  for (const msg of messages) upsertMessage(cursor, msg)
  for (const part of parts) {
    const parent = cursor.pending.get(part.row.message_id)
    if (parent !== undefined) {
      parent.parts.set(part.row.id, part)
    } else if (cursor.headers.has(part.row.message_id)) {
      if (!cursor.parts.has(part.row.id)) {
        // Anomaly: a part row for a message that already closed. Emit it as
        // an append — ordering purity yields to never dropping content. The
        // id is remembered in append order so replay puts it at the tail too.
        cursor.parts.add(part.row.id)
        cursor.appended.push(part.row.id)
        lines.push(partLine(part))
      }
    } else {
      const bag = cursor.orphans.get(part.row.message_id)
      if (bag === undefined) cursor.orphans.set(part.row.message_id, new Map([[part.row.id, part]]))
      else bag.set(part.row.id, part)
    }
    // Prune: only a part whose line already went out gets a sidecar — a row
    // born compacted simply carries the marker inside its own part data.
    if (
      cursor.parts.has(part.row.id)
      && !cursor.pruned.has(part.row.id)
      && compactedTime(part.data) !== undefined
    ) {
      cursor.pruned.add(part.row.id)
      lines.push(pruneLine(part))
    }
  }
  return lines
}

/** The live walk: merge, emit what newly qualifies, record the trailing message. */
function liveLines(
  messages: readonly ParsedMessage[],
  parts: readonly ParsedPart[],
  cursor: TranscriptCursor,
): PlanOutput {
  const lines = noteRows(messages, parts, cursor)
  const pending = [...cursor.pending.entries()]
  // Suffix flag: a later ASSISTANT message exists after index i. Queued user
  // prompts write their row while the previous assistant is still streaming
  // (opencode's prompt path inserts the user row before joining the loop),
  // so only a later assistant proves the writer moved on — a later row of
  // any role (`laterExists`) is used ONLY for the user-header patience gate,
  // where a later row means the prompt's parts are complete.
  const laterAssistant: boolean[] = new Array<boolean>(pending.length).fill(false)
  let assistantSeen = false
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    laterAssistant[i] = assistantSeen
    if (asString(pending[i]?.[1].msg.data['role']) === 'assistant') assistantSeen = true
  }
  for (const [index, [id, entry]] of pending.entries()) {
    const laterExists = index + 1 < pending.length
    const laterAssistantExists = laterAssistant[index] ?? false
    const msg = entry.msg
    const role = asString(msg.data['role'])
    if (!cursor.headers.has(id)) {
      if (role === 'user') {
        const compaction = [...entry.parts.values()].some(part => part.data['type'] === 'compaction')
        if (compaction) {
          // The compaction part is written WITHOUT `tail_start_id` and
          // updated with it ~1–2 ms AFTER the summary assistant's
          // `time.completed` — release the header only once the range is
          // final. A queued prompt can land while the summary is still
          // generating, so only an ASSISTANT beyond the summary proves the
          // loop moved past the part update (queued user rows in between
          // are skipped when locating the summary). Ready means: the
          // summary errored (the part never updates — nothing compacts),
          // a later assistant exists beyond the summary, or one patience
          // tick after the summary went terminal (`compactionSeen` covers
          // the 1–2 ms window). Waiting also lets `noteRows` refresh the
          // inline part to its final `tail_start_id`.
          const summaryIdx = pending.findIndex(
            (pair, i) => i > index && asString(pair[1].msg.data['role']) === 'assistant',
          )
          if (summaryIdx === -1) break
          const summary = pending[summaryIdx]?.[1].msg.data
          const summaryErrored = summary !== undefined && summary['error'] !== undefined
          const summaryTerminal = summary !== undefined && isTerminal(summary)
          const ready = summaryErrored
            || (laterAssistant[summaryIdx] ?? false)
            || (summaryTerminal && cursor.compactionSeen === id)
          if (!ready) {
            if (summaryTerminal) cursor.compactionSeen = id
            break
          }
        } else {
          // Patience gate: a prompt's part rows land in separate statements a
          // few ms after the message row — wait one poll (or a later message)
          // so the header carries them all. Only a PARTED trailing message
          // earns the wait; an empty one waits for a later message.
          const ready = laterExists
            || (entry.parts.size > 0 && cursor.trailingSeen === id)
          if (!ready) break
        }
        for (const partId of entry.parts.keys()) cursor.parts.add(partId)
      }
      cursor.headers.add(id)
      lines.push(headerLine(msg, [...entry.parts.values()]))
    }
    if (role === 'assistant') {
      // Strict id order: a settled part waits for its unsettled predecessors.
      for (const [partId, part] of entry.parts) {
        if (cursor.parts.has(partId)) continue
        if (!isSettled(part.data, msg.data, laterAssistantExists)) break
        cursor.parts.add(partId)
        lines.push(partLine(part))
      }
      if (!cursor.finished.has(id) && isTerminal(msg.data) && allPartsEmitted(cursor, entry)) {
        cursor.finished.add(id)
        lines.push(finishLine(msg))
      }
    }
    if (!isClosed(cursor, entry, laterAssistantExists)) break
    cursor.pending.delete(id)
  }
  // Whatever sits at the tail of the open list is the trailing message the
  // next pass's patience gate compares against.
  const last = [...cursor.pending.keys()].at(-1)
  cursor.trailingSeen = last ?? null
  return { lines }
}

/**
 * The replay walk: same order, but membership in the pinned id sets decides
 * every line — headers iff in `headers`, parts iff in `parts`, finishes iff
 * in `finished`, one sidecar per pinned `pruned` part. Gates and settle
 * rules do not re-run: the cursor already lived through them. Parts the
 * live walk appended as anomalies (in `appended`) are skipped inside their
 * message's block and re-emitted at the stream tail in append order — the
 * same position live gave them, so replay numbering matches exactly.
 */
function replayLines(
  messages: readonly ParsedMessage[],
  parts: readonly ParsedPart[],
  pinned: TranscriptCursor,
): PlanOutput {
  const lines: WireLine[] = []
  const partsByMessage = new Map<string, ParsedPart[]>()
  const partsById = new Map<string, ParsedPart>()
  for (const part of parts) {
    partsById.set(part.row.id, part)
    const list = partsByMessage.get(part.row.message_id)
    if (list === undefined) partsByMessage.set(part.row.message_id, [part])
    else list.push(part)
  }
  const appended = new Set(pinned.appended)
  for (const msg of messages) {
    const id = msg.row.id
    if (!pinned.headers.has(id)) continue
    const msgParts = partsByMessage.get(id) ?? []
    lines.push(headerLine(msg, msgParts.filter(
      part => pinned.parts.has(part.row.id) && !appended.has(part.row.id))))
    if (asString(msg.data['role']) === 'assistant') {
      for (const part of msgParts) {
        if (!pinned.parts.has(part.row.id) || appended.has(part.row.id)) continue
        lines.push(partLine(part))
      }
      if (pinned.finished.has(id)) lines.push(finishLine(msg))
    }
  }
  for (const id of pinned.appended) {
    const part = partsById.get(id)
    if (part === undefined) continue
    lines.push(partLine(part))
  }
  for (const part of parts) {
    if (!pinned.pruned.has(part.row.id)) continue
    lines.push(pruneLine(part))
  }
  return { lines }
}
