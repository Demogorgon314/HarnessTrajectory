import type { SessionFileRef } from '@harness-trajectory/core'
import { CHUNK_LINES, lineTime, type LineChunk } from './source.ts'

/** A captured logical transcript that can be reopened without moving its end. */
export interface StreamingLineSource {
  ref: SessionFileRef
  open(): AsyncGenerator<string, void>
  synthetic?: number
}

interface TimedLine {
  line: string
  time: number
  startLine: number
}

async function* timedLines(source: StreamingLineSource, signal?: AbortSignal): AsyncGenerator<TimedLine, void> {
  // Leading housekeeping records inherit the first timestamp, even when it
  // is far into the file. Probe and reopen instead of retaining that prefix.
  let time = Number.NEGATIVE_INFINITY
  for await (const line of source.open()) {
    if (signal?.aborted) return
    const first = lineTime(line)
    if (first !== null) {
      time = first
      break
    }
  }
  let ordinal = 0
  for await (const line of source.open()) {
    if (signal?.aborted) return
    time = lineTime(line) ?? time
    const synthetic = source.synthetic ?? 0
    yield { line, time, startLine: ordinal < synthetic ? -1 : ordinal - synthetic }
    ordinal += 1
  }
}

/** Soft UTF-16 payload limit; a single record is indivisible and may exceed it. */
const CHUNK_BYTES = 1024 * 1024

/**
 * Stable k-way merge with one lookahead record per transcript. File order and
 * source-order ties match mergeChronologically, including regressing clocks.
 * Closing the iterator closes every reader, on cancellation and errors too.
 */
export async function* mergeReplay(
  sources: readonly StreamingLineSource[], signal?: AbortSignal,
): AsyncGenerator<LineChunk> {
  const readers = sources.map(source => timedLines(source, signal))
  const heads: (TimedLine | undefined)[] = []
  let current: (LineChunk & { source: number; bytes: number }) | undefined
  try {
    for (const reader of readers) {
      if (signal?.aborted) return
      const next = await reader.next()
      heads.push(next.done ? undefined : next.value)
    }
    while (!signal?.aborted) {
      let best = -1
      for (const [at, head] of heads.entries()) {
        if (head !== undefined && (best < 0 || head.time < (heads[best]?.time ?? Infinity))) best = at
      }
      if (best < 0) break
      const head = heads[best]
      const source = sources[best]
      const reader = readers[best]
      if (head === undefined || source === undefined || reader === undefined) break
      const bytes = head.line.length * 2
      if (current !== undefined && (
        current.source !== best || (current.startLine < 0) !== (head.startLine < 0)
        || current.lines.length >= CHUNK_LINES || current.bytes + bytes > CHUNK_BYTES
      )) {
        yield { ref: current.ref, lines: current.lines, startLine: current.startLine }
        current = undefined
        continue
      }
      current ??= { ref: source.ref, source: best, lines: [], startLine: head.startLine, bytes: 0 }
      current.lines.push(head.line)
      current.bytes += bytes
      const next = await reader.next()
      heads[best] = next.done ? undefined : next.value
    }
    if (!signal?.aborted && current !== undefined) {
      yield { ref: current.ref, lines: current.lines, startLine: current.startLine }
    }
  } finally {
    await Promise.all(readers.map(reader => reader.return(undefined)))
  }
}
