/**
 * Cursor transcript emission plan — the pure half of `CursorSource`.
 *
 * A newer root's field 1 is normally the previous id list plus a suffix.
 * Anything else (a shrink, a rewrite, a summary) is a full rebuild.
 *
 * Line times come from the turn chain when it has any timestamp. Otherwise
 * they fall back to phase 1: index 0 takes `createdAt`, every later line
 * takes `updatedAt`, and a time never moves backwards.
 */

import {
  asArray, asString, cursorUserClass, cursorProviderOptions, isRecord,
  type CursorSessionFacts, type CursorStepSpan, type CursorCallSpan, type CursorBlockSpan,
} from '@harness-trajectory/core'
import type { CursorTurnItem } from './proto.ts'

/** Structural clock facts for one model message. Tool ids stay opaque. */
export function clockMessageOf(message: Record<string, unknown>): CursorClockMessage {
  const role = asString(message['role'])
  const classified = cursorUserClass(message)
  const kind: CursorClockMessage['kind'] = classified === 'system' ? 'system'
    : classified === 'injection' ? 'injection'
      : classified === 'human' ? 'human'
        : role === 'assistant' ? 'assistant'
          : role === 'tool' ? 'tool'
            : 'other'
  const toolCallIds: string[] = []
  const toolResultIds: string[] = []
  if (kind === 'assistant' || kind === 'tool') {
    for (const part of asArray(message['content']) ?? []) {
      if (!isRecord(part)) continue
      const type = asString(part['type'])
      const id = asString(part['toolCallId'])
      if (id === undefined) continue
      if (kind === 'assistant' && type === 'tool-call') toolCallIds.push(id)
      else if (kind === 'tool' && type === 'tool-result') toolResultIds.push(id)
    }
  }
  if (kind === 'tool') {
    const id = asString(message['id'])
    if (id !== undefined && !toolResultIds.includes(id)) toolResultIds.push(id)
  }
  const requestId = kind === 'human' ? asString(cursorProviderOptions(message)?.['requestId']) : undefined
  return {
    kind,
    toolCallIds,
    toolResultIds,
    ...(requestId === undefined || requestId === '' ? {} : { requestId }),
  }
}

export type TranscriptPlan =
  | { action: 'append'; ids: readonly string[] }
  | { action: 'rebuild'; ids: readonly string[] }

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length > full.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== full[index]) return false
  }
  return true
}

/**
 * `append` emits `ids` (the suffix). `rebuild` emits `ids` as the whole new
 * transcript — the caller resets the stream first. An empty emitted list is
 * a prefix of everything, so the first load appends.
 */
export function planTranscript(messageIds: readonly string[], emittedIds: readonly string[]): TranscriptPlan {
  if (isPrefix(emittedIds, messageIds)) {
    return { action: 'append', ids: messageIds.slice(emittedIds.length) }
  }
  return { action: 'rebuild', ids: messageIds }
}

/**
 * Phase-1 timestamps. `startIndex` is the first new line's stream index.
 * `lastTime` is the time of the previous line, when there is one.
 */
export interface CursorClockMessage {
  /** `system` and injected `user` share the session's createdAt. */
  kind: 'system' | 'injection' | 'human' | 'assistant' | 'tool' | 'other'
  requestId?: string
  /** Assistant `tool-call` ids, opaque (a newline is significant). */
  toolCallIds: readonly string[]
  /** Tool-result ids on a `role: 'tool'` message. */
  toolResultIds: readonly string[]
}

export interface CursorClockTurn {
  requestId?: string
  /** User-prompt field 25. */
  promptTime?: number
  items: readonly CursorTurnItem[]
}

export interface CursorLineClock {
  time: number
  span?: CursorStepSpan
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value)
}

function turnsUsable(turns: readonly CursorClockTurn[]): boolean {
  for (const turn of turns) {
    if (finite(turn.promptTime)) return true
    for (const item of turn.items) {
      if (finite(item.start) || finite(item.end)) return true
    }
  }
  return false
}

function minOf(values: readonly number[]): number | undefined {
  let best: number | undefined
  for (const value of values) {
    if (!finite(value)) continue
    if (best === undefined || value < best) best = value
  }
  return best
}

function maxOf(values: readonly number[]): number | undefined {
  let best: number | undefined
  for (const value of values) {
    if (!finite(value)) continue
    if (best === undefined || value > best) best = value
  }
  return best
}

/**
 * Per-message clocks. Unusable turn chains (none, or no timestamp on any
 * of them) fall back to {@link assignTimes}. Every returned time is
 * monotonic and at least `lastTime`.
 */
export function assignCursorTimes(
  messages: readonly CursorClockMessage[],
  turns: readonly CursorClockTurn[],
  createdAt: number,
  updatedAt: number,
  lastTime: number | null,
): CursorLineClock[] {
  if (!turnsUsable(turns)) {
    return assignTimes(0, messages.length, createdAt, updatedAt, lastTime).map(time => ({ time }))
  }
  const clocks: CursorLineClock[] = []
  let floor = lastTime ?? Number.NEGATIVE_INFINITY
  let turnIndex = -1
  let itemCursor = 0
  let lastRequest: string | undefined
  const raise = (raw: number): number => {
    const time = Math.max(raw, floor)
    floor = time
    return time
  }
  const turn = (): CursorClockTurn | undefined => turnIndex >= 0 ? turns[turnIndex] : undefined
  for (const message of messages) {
    if (message.kind === 'system' || message.kind === 'injection') {
      clocks.push({ time: raise(createdAt) })
      continue
    }
    if (message.kind === 'human') {
      const requestId = message.requestId
      const same = requestId !== undefined && requestId !== '' && requestId === lastRequest && turnIndex >= 0
      if (!same && requestId !== undefined && requestId !== '') {
        const found = turns.findIndex((candidate, index) =>
          index >= Math.max(0, turnIndex) && candidate.requestId === requestId)
        if (found >= 0) {
          turnIndex = found
          itemCursor = 0
        } else {
          lastRequest = requestId
          clocks.push({ time: raise(floor === Number.NEGATIVE_INFINITY ? createdAt : floor) })
          continue
        }
      }
      lastRequest = requestId
      const current = turn()
      const prompt = current?.promptTime
      const nextItem = current?.items.find(item => finite(item.start))
      const nextStart = nextItem !== undefined && finite(nextItem.start) ? nextItem.start : undefined
      const sameTurn = same
      const raw = sameTurn
        ? (finite(nextStart) && (!finite(prompt) || nextStart >= prompt) ? nextStart : prompt)
        : prompt
      clocks.push({ time: raise(finite(raw) ? raw : (floor === Number.NEGATIVE_INFINITY ? createdAt : floor)) })
      continue
    }
    if (message.kind === 'assistant') {
      const current = turn()
      const items = current?.items ?? []
      const wanted = new Set(message.toolCallIds)
      const taken: CursorTurnItem[] = []
      if (wanted.size > 0) {
        let seen = 0
        for (let index = itemCursor; index < items.length; index += 1) {
          const item = items[index]
          if (item === undefined) continue
          taken.push(item)
          if (item.kind === 'tool' && wanted.has(item.toolCallId)) seen += 1
          if (seen >= wanted.size) {
            itemCursor = index + 1
            break
          }
        }
      } else {
        for (let index = itemCursor; index < items.length; index += 1) {
          const item = items[index]
          if (item === undefined) continue
          if (item.kind === 'thinking' || item.kind === 'text') {
            taken.push(item)
            itemCursor = index + 1
            break
          }
        }
      }
      const toolStarts = taken.filter(item => item.kind === 'tool' && wanted.has(item.toolCallId) && finite(item.start)).map(item => item.start).filter(finite)
      const after = taken.filter(item => (item.kind === 'thinking' || item.kind === 'text') && finite(item.start) && item.start >= (floor === Number.NEGATIVE_INFINITY ? Number.NEGATIVE_INFINITY : floor))
      const fallbackStart = after.find(item => finite(item.start))?.start
      const raw = toolStarts.length > 0 ? minOf(toolStarts) : fallbackStart
      const start = finite(raw) ? raw : (floor === Number.NEGATIVE_INFINITY ? createdAt : floor)
      const ends = taken.map(item => item.end).filter(finite)
      const end = maxOf(ends) ?? start
      const calls: CursorCallSpan[] = []
      const blocks: CursorBlockSpan[] = []
      for (const item of taken) {
        if (!finite(item.start) && !finite(item.end)) continue
        const blockStart = finite(item.start) ? item.start : start
        const blockEnd = finite(item.end) ? item.end : blockStart
        if (item.kind === 'tool' && wanted.has(item.toolCallId)) {
          calls.push({ id: item.toolCallId, start: blockStart, end: blockEnd })
          blocks.push({ kind: 'tool-call', start: blockStart, end: blockEnd })
        } else if (item.kind === 'thinking') {
          blocks.push({ kind: 'reasoning', start: blockStart, end: blockEnd })
        } else if (item.kind === 'text') {
          blocks.push({ kind: 'text', start: blockStart, end: blockEnd })
        }
      }
      const span: CursorStepSpan | undefined = calls.length > 0 || blocks.length > 0
        ? { start, end: Math.max(end, start), calls, blocks }
        : undefined
      clocks.push({
        time: raise(start),
        ...(span === undefined ? {} : { span }),
      })
      continue
    }
    if (message.kind === 'tool') {
      const current = turn()
      const match = current?.items.find(item =>
        item.kind === 'tool' && message.toolResultIds.includes(item.toolCallId))
      const raw = match !== undefined && finite(match.end) ? match.end : undefined
      clocks.push({ time: raise(finite(raw) ? raw : (floor === Number.NEGATIVE_INFINITY ? createdAt : floor)) })
      continue
    }
    clocks.push({ time: raise(floor === Number.NEGATIVE_INFINITY ? createdAt : floor) })
  }
  return clocks
}

export function assignTimes(
  startIndex: number,
  count: number,
  createdAt: number,
  updatedAt: number,
  lastTime: number | null,
): number[] {
  const times: number[] = []
  let floor = lastTime ?? Number.NEGATIVE_INFINITY
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset
    const base = index === 0 ? createdAt : Math.max(createdAt, updatedAt)
    const time = Math.max(base, floor)
    times.push(time)
    floor = time
  }
  return times
}

/** Reasoning model wins; `lastUsedModel: "default"` is not a model id. */
export function cursorSessionModel(seen: string | undefined, lastUsed: string | undefined): string | undefined {
  if (seen !== undefined && seen !== '') return seen
  if (lastUsed !== undefined && lastUsed !== '' && lastUsed !== 'default') return lastUsed
  return undefined
}

function defined(facts: CursorSessionFacts): Record<string, unknown> {
  return {
    agentId: facts.agentId,
    ...(facts.title === undefined ? {} : { title: facts.title }),
    ...(facts.cwd === undefined ? {} : { cwd: facts.cwd }),
    ...(facts.workspaceUri === undefined ? {} : { workspaceUri: facts.workspaceUri }),
    ...(facts.repoPath === undefined ? {} : { repoPath: facts.repoPath }),
    ...(facts.branch === undefined ? {} : { branch: facts.branch }),
    ...(facts.client === undefined ? {} : { client: facts.client }),
    ...(facts.mode === undefined ? {} : { mode: facts.mode }),
    ...(facts.approvalMode === undefined ? {} : { approvalMode: facts.approvalMode }),
    ...(facts.model === undefined ? {} : { model: facts.model }),
    ...(facts.createdAt === undefined ? {} : { createdAt: facts.createdAt }),
    ...(facts.updatedAt === undefined ? {} : { updatedAt: facts.updatedAt }),
    ...(facts.usage === undefined ? {} : { usage: facts.usage }),
  }
}

/** Sidecar line. `startLine` is -1; search never indexes it. */
export function sessionLine(facts: CursorSessionFacts, time: number): string {
  return JSON.stringify({ type: 'cursor.session', time, ...defined(facts) })
}

/** One model message. `index` is the 0-based stream index (the search line). */
export function messageLine(
  index: number,
  blobId: string,
  time: number,
  message: unknown,
  span?: CursorStepSpan,
): string {
  return JSON.stringify({
    type: 'cursor.message',
    index,
    blobId,
    time,
    message,
    ...(span === undefined ? {} : { span }),
  })
}
