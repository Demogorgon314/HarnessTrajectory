/** Byte-offset file reading with line reassembly, for initial loads and live tails. */

import { open } from 'node:fs/promises'
import { splitLines } from '@harness-trajectory/core'

export interface ReadResult {
  lines: string[]
  /** Byte offset after the last complete line consumed. */
  offset: number
  /** Unterminated trailing text carried to the next read. */
  rest: string
}

/**
 * Read every complete line between `from` and the end of the file (or `to`).
 * `rest` is prepended so a line split across reads reassembles.
 */
export async function readLines(
  path: string,
  from: number,
  rest = '',
  to?: number,
): Promise<ReadResult> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    const end = to === undefined ? stat.size : Math.min(to, stat.size)
    if (end <= from) return { lines: [], offset: from, rest }
    const length = end - from
    const buffer = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, from + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const text = rest + buffer.subarray(0, filled).toString('utf8')
    const split = splitLines(text)
    return {
      lines: split.lines.filter(line => line.trim() !== ''),
      offset: from + filled,
      rest: split.rest,
    }
  } finally {
    await handle.close()
  }
}

/** Read only the first line of a file (bounded), for identity probing. */
export async function readFirstLine(path: string, maxBytes = 256 * 1024): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    return newline === -1 ? text : text.slice(0, newline)
  } finally {
    await handle.close()
  }
}
