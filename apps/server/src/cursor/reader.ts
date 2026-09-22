/** Reads immutable Cursor blobs and prepares a stream change before publication. */

import { createHash } from 'node:crypto'
import { cursorModelOf, isRecord, type CursorStepSpan } from '@harness-trajectory/core'
import { CursorDb } from './db.ts'
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
  return `cursor-v1:${hash.digest('hex')}`
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

  constructor(readonly db: CursorDb) {}

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
    const plan = planTranscript(root.messageIds, published.map(record => record.blobId))
    const reset = plan.action === 'rebuild'
    const previous = reset ? [] : published
    const pending: Array<{ blobId: string; message: Record<string, unknown>; clock: CursorClockMessage }> = []
    let model: string | undefined
    for (const blobId of plan.ids) {
      const message = this.readMessage(blobId)
      if (message === undefined) break
      pending.push({ blobId, message, clock: clockMessageOf(message) })
      model = cursorModelOf(message) ?? model
    }
    const clocks = pending.length === 0 ? [] : assignCursorTimes(
      [...previous.map(record => record.clock), ...pending.map(record => record.clock)],
      this.clockTurns(root), createdAt, updatedAt, null,
    )
    const records: CursorPublishedRecord[] = []
    const lines: string[] = []
    let floor = previous.at(-1)?.time ?? -Infinity
    for (const [offset, record] of pending.entries()) {
      const index = previous.length + offset
      const clock = clocks[index]
      const time = Math.max(floor, clock?.time ?? updatedAt)
      floor = time
      const span = clock?.span
      records.push({ blobId: record.blobId, clock: record.clock, time, ...(span === undefined ? {} : { span }) })
      lines.push(messageLine(index, record.blobId, time, record.message, span))
    }
    return {
      reset, records, lines,
      blocked: previous.length + records.length < root.messageIds.length,
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
