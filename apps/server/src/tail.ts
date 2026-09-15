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
 * How many trailing bytes of `buffer` are an incomplete UTF-8 sequence.
 *
 * `Buffer.toString('utf8')` replaces a split multi-byte character with U+FFFD
 * on both sides of a chunk boundary, which would silently corrupt a JSONL
 * record. Callers that know more bytes follow (`to` is short of the file)
 * withhold these bytes so the next read can decode the character whole.
 */
export function utf8IncompleteTail(buffer: Uint8Array): number {
  const n = buffer.length
  if (n === 0) return 0
  let index = n - 1
  let cont = 0
  while (index >= 0 && cont < 3 && ((buffer[index] ?? 0) & 0xC0) === 0x80) {
    cont += 1
    index -= 1
  }
  if (index < 0) return n
  const lead = buffer[index] ?? 0
  const need = lead < 0x80 ? 0
    : (lead & 0xE0) === 0xC0 ? 1
    : (lead & 0xF0) === 0xE0 ? 2
    : (lead & 0xF8) === 0xF0 ? 3
    : 0
  if (need === 0) return 0
  return cont < need ? cont + 1 : 0
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
    const slice = buffer.subarray(0, filled)
    // A chunk that is not the current end of the file must not decode a
    // character that continues in the next slice. At EOF, replacement is fine.
    const hold = end < stat.size ? utf8IncompleteTail(slice) : 0
    const usable = hold > 0 && hold < filled ? filled - hold : filled
    const text = rest + slice.subarray(0, usable).toString('utf8')
    const split = splitLines(text)
    return {
      lines: split.lines.filter(line => line.trim() !== ''),
      offset: from + usable,
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
