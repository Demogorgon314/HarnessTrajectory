/** Reads immutable Cursor blobs and prepares a stream change before publication. */

import { createHash } from 'node:crypto'
import { cursorModelOf, cursorUserClass, isRecord, type CursorStepSpan } from '@harness-trajectory/core'
import { CursorDb } from './db.ts'
import { CursorHistory } from './history.ts'
import {
  decodeItem, decodeTurn, decodeUserPrompt,
  type CursorRoot, type CursorTurnItem, type CursorTurnSkeleton,
} from './proto.ts'
import {
  assignCursorTimes, clockMessageOf, messageLine, planTranscript,
  type CursorClockMessage, type CursorClockTurn,
} from './transcript.ts'

/** One published record; its clock stays pinned for reconnect/replay. */
export interface CursorPublishedRecord {
  blobId: string
  time: number
  span?: CursorStepSpan
  clock: CursorClockMessage
  replay?: boolean
}

export interface CursorStreamChange {
  reset: boolean
  records: CursorPublishedRecord[]
  lines: string[]
  blocked: boolean
  model?: string
}

/** A version binds the order and identity of every record in the indexed prefix. */
export function cursorPrefixVersion(ids: readonly string[], length: number): string | undefined {
  if (!Number.isInteger(length) || length < 0 || length > ids.length) return undefined
  const hash = createHash('sha256')
  for (const id of ids.slice(0, length)) hash.update(id).update('\n')
  return `cursor-v2:${hash.digest('hex')}`
}

function parseMessage(data: Uint8Array): Record<string, unknown> | undefined {
  if (data[0] !== 0x7b) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const NODE_CACHE_LIMIT = 2048
const STORE_LIMIT = 16

export class CursorReader {
  private readonly turns = new Map<string, CursorTurnSkeleton>()
  private readonly prompts = new Map<string, { time?: number }>()
  private readonly items = new Map<string, CursorTurnItem>()

  private readonly history: CursorHistory

  constructor(readonly db: CursorDb) {
    this.history = new CursorHistory(db, id => this.readMessage(id))
  }

  readMessage(id: string): Record<string, unknown> | undefined {
    const data = this.db.readBlob(id)
    return data === undefined ? undefined : parseMessage(data)
  }

  /** Missing/invalid nodes are never cached, so a later transaction can complete a tail. */
  private node<T>(cache: Map<string, T>, id: string, decode: (bytes: Uint8Array) => T | undefined): T | undefined {
    const cached = cache.get(id)
    if (cached !== undefined) {
      cache.delete(id)
      cache.set(id, cached)
      return cached
    }
    const bytes = this.db.readBlob(id)
    const value = bytes === undefined ? undefined : decode(bytes)
    if (value === undefined) return undefined
    cache.set(id, value)
    if (cache.size > NODE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return value
  }

  private clockTurns(root: CursorRoot): CursorClockTurn[] {
    const turns: CursorClockTurn[] = []
    for (const id of root.turnIds) {
      const turn = this.node(this.turns, id, decodeTurn)
      if (turn === undefined) continue
      const prompt = turn.promptId === undefined ? undefined : this.node(this.prompts, turn.promptId, bytes => {
        const decoded = decodeUserPrompt(bytes)
        return decoded === undefined ? undefined : { ...(decoded.time === undefined ? {} : { time: decoded.time }) }
      })
      const items: CursorTurnItem[] = []
      for (const itemId of turn.itemIds) {
        const item = this.node(this.items, itemId, (bytes): CursorTurnItem | undefined => {
          const decoded = decodeItem(bytes)
          if (decoded === undefined) return undefined
          // Keep timing facts only, not potentially large reasoning/text bodies.
          const timing = {
            ...(decoded.start === undefined ? {} : { start: decoded.start }),
            ...(decoded.end === undefined ? {} : { end: decoded.end }),
          }
          return decoded.kind === 'tool'
            ? { kind: 'tool', toolCallId: decoded.toolCallId, ...timing }
            : { kind: decoded.kind, ...timing }
        })
        if (item !== undefined) items.push(item)
      }
      turns.push({
        items,
        ...(turn.requestId === undefined ? {} : { requestId: turn.requestId }),
        ...(prompt?.time === undefined ? {} : { promptTime: prompt.time }),
      })
    }
    return turns
  }

  prepare(root: CursorRoot, published: readonly CursorPublishedRecord[], createdAt: number, updatedAt: number): CursorStreamChange {
    const roots = this.history.roots(root)
    const previousClocks = new Map(published.map(record => [record.blobId, record.clock]))
    const messages = new Map<string, Record<string, unknown>>()
    const read = (id: string) => {
      const cached = messages.get(id)
      if (cached !== undefined) return cached
      const message = this.readMessage(id)
      if (message !== undefined) messages.set(id, message)
      return message
    }
    const epochs = roots.map(epoch => {
      // Put the structural boundary before the new context's system/injections.
      // The remaining model messages keep their root order.
      const summary = epoch.messageIds.find(id => {
        const clock = previousClocks.get(id)
        if (clock !== undefined) return clock.summary === true
        return cursorUserClass(read(id)) === 'summary'
      })
      return { root: epoch, ids: summary === undefined ? epoch.messageIds
        : [summary, ...epoch.messageIds.filter(id => id !== summary)] }
    })
    const ids = epochs.flatMap(epoch => epoch.ids)
    const plan = planTranscript(ids, published.map(record => record.blobId))
    const reset = plan.action === 'rebuild'
    const previous = reset ? [] : published
    const records: CursorPublishedRecord[] = []
    const lines: string[] = []
    const seen = new Set<string>()
    let offset = 0
    let model: string | undefined
    let floor = previous.at(-1)?.time ?? -Infinity
    for (const epoch of epochs) {
      if (offset + epoch.ids.length <= previous.length) {
        for (const id of epoch.ids) seen.add(id)
        offset += epoch.ids.length
        continue
      }
      const facts: CursorClockMessage[] = []
      const pending: Array<{ id: string; message: Record<string, unknown> }> = []
      for (const [local, id] of epoch.ids.entries()) {
        const known = previousClocks.get(id)
        if (offset + local < previous.length && known !== undefined) {
          facts.push(known)
          continue
        }
        const message = read(id)
        if (message === undefined) break
        pending.push({ id, message })
        facts.push(known ?? clockMessageOf(message))
      }
      const clocks = assignCursorTimes(facts, this.clockTurns(epoch.root), createdAt, updatedAt, null)
      const start = Math.max(0, previous.length - offset)
      for (const [index, item] of pending.entries()) {
        const local = start + index
        const clock = clocks[local]
        const fact = facts[local]
        if (fact === undefined) break
        const time = Math.max(floor, clock?.time ?? updatedAt)
        floor = time
        const span = clock?.span
        const replay = seen.has(item.id)
        const record = {
          blobId: item.id, clock: fact, time,
          ...(span === undefined ? {} : { span }), ...(replay ? { replay: true } : {}),
        }
        records.push(record)
        lines.push(messageLine(previous.length + records.length - 1, item.id, time, item.message, span, replay))
        if (!replay) model = cursorModelOf(item.message) ?? model
      }
      if (facts.length < epoch.ids.length) break
      for (const id of epoch.ids) seen.add(id)
      offset += epoch.ids.length
    }
    return {
      reset, records, lines,
      blocked: previous.length + records.length < ids.length,
      ...(model === undefined ? {} : { model }),
    }
  }
}

/** One owner for the read-only connection and its bounded immutable-node cache. */
export class CursorReaderPool {
  private readonly open = new Map<string, CursorReader>()

  acquire(path: string): { reader: CursorReader; fresh: boolean } | undefined {
    const existing = this.open.get(path)
    if (existing !== undefined) {
      this.open.delete(path)
      this.open.set(path, existing)
      return { reader: existing, fresh: false }
    }
    try {
      const reader = new CursorReader(new CursorDb(path))
      this.open.set(path, reader)
      if (this.open.size > STORE_LIMIT) {
        const oldest = this.open.keys().next().value
        if (oldest !== undefined) this.drop(oldest)
      }
      return { reader, fresh: true }
    } catch {
      return undefined
    }
  }

  drop(path: string): void {
    this.open.get(path)?.db.close()
    this.open.delete(path)
  }

  close(): void {
    for (const path of this.open.keys()) this.drop(path)
  }
}
