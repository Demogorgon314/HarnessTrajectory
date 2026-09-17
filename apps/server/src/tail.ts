/** Byte-offset file reading with line reassembly, for initial loads and live tails. */

import { createReadStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import * as zlib from 'node:zlib'
import { splitLines } from '@harness-trajectory/core'

export interface ReadResult {
  lines: string[]
  /** Byte offset after the last complete line consumed. */
  offset: number
  /** Unterminated trailing text carried to the next read. */
  rest: string
}

/**
 * Codex compresses cold rollouts in place: `rollout-*.jsonl` becomes
 * `rollout-*.jsonl.zst`, a plain zstd stream of the whole file
 * (rollout/src/compression.rs). Compressed files are immutable — Codex
 * materializes them back to `.jsonl` before appending again — so a `.zst`
 * transcript is read whole and its cursor lives in DECODED bytes.
 */
export const COMPRESSED_SUFFIX = '.zst'

export function isCompressedTranscript(path: string): boolean {
  return path.endsWith(COMPRESSED_SUFFIX)
}

/** The `.jsonl` spelling of a transcript path (strips one `.zst`). */
export function plainTranscriptPath(path: string): string {
  return isCompressedTranscript(path) ? path.slice(0, -COMPRESSED_SUFFIX.length) : path
}

/** The `.jsonl.zst` spelling of a transcript path. */
export function compressedTranscriptPath(path: string): string {
  return isCompressedTranscript(path) ? path : `${path}${COMPRESSED_SUFFIX}`
}

/** `node:zlib` zstd landed in Node 22.15; on older builds compressed rollouts are unreadable. */
export function zstdSupported(): boolean {
  return typeof zlib.zstdDecompressSync === 'function'
}

export interface TranscriptFile {
  /** The representation that exists on disk. */
  path: string
  compressed: boolean
  /** Physical size of the file on disk. */
  size: number
  mtimeMs: number
}

/**
 * Resolve which representation of a transcript path exists. Codex resolves the
 * PLAIN file before its compressed sibling (`existing_rollout_with_metadata`),
 * which also dedups a mid-transition moment when both sit on disk.
 */
export async function resolveTranscriptFile(path: string): Promise<TranscriptFile | null> {
  const plain = plainTranscriptPath(path)
  for (const candidate of [plain, compressedTranscriptPath(plain)]) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) {
        return { path: candidate, compressed: isCompressedTranscript(candidate), size: info.size, mtimeMs: info.mtimeMs }
      }
    } catch {
      // Try the other representation.
    }
  }
  return null
}

/**
 * Decode a compressed transcript to its byte buffer. Never cached here:
 * callers hold it for the duration of one consume pass.
 */
async function decodeFile(path: string): Promise<Buffer> {
  const compressed = await readFile(path)
  return zlib.zstdDecompressSync(compressed)
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

/** Split decoded text into complete non-blank lines plus the unterminated tail. */
function splitChunk(text: string, offset: number): ReadResult {
  const split = splitLines(text)
  return {
    lines: split.lines.filter(line => line.trim() !== ''),
    offset,
    rest: split.rest,
  }
}

/**
 * Read every complete line between `from` and the end of the file (or `to`).
 * `rest` is prepended so a line split across reads reassembles.
 *
 * For `.jsonl.zst` the offsets are DECODED bytes: the file is decompressed
 * whole and the window sliced out of the result. Compressed rollouts are
 * immutable, so `from` is only ever 0 in practice.
 */
export async function readLines(
  path: string,
  from: number,
  rest = '',
  to?: number,
): Promise<ReadResult> {
  if (isCompressedTranscript(path)) {
    const decoded = await decodeFile(path)
    const end = to === undefined ? decoded.length : Math.min(to, decoded.length)
    if (end <= from) return { lines: [], offset: from, rest }
    return splitChunk(rest + decoded.subarray(from, end).toString('utf8'), end)
  }
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

/**
 * Read the decoded byte prefix of a transcript — a lineage base contributes
 * the slice `[0, endByteOffset)` of its decoded content
 * (`HistoryPosition.end_byte_offset`).
 */
export async function readDecodedPrefix(path: string, endByteOffset: number | undefined): Promise<ReadResult> {
  const resolved = await resolveTranscriptFile(path)
  if (resolved === null) return { lines: [], offset: 0, rest: '' }
  return readLines(resolved.path, 0, '', endByteOffset)
}

/** Read only the first line of a file (bounded), for identity probing. */
export async function readFirstLine(path: string, maxBytes = 256 * 1024): Promise<string> {
  if (isCompressedTranscript(path)) {
    return readFirstCompressedLine(path, maxBytes)
  }
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

/** First decoded line of a `.zst` transcript without decompressing the whole file. */
async function readFirstCompressedLine(path: string, maxBytes: number): Promise<string> {
  if (!zstdSupported()) return ''
  const decoder = zlib.createZstdDecompress()
  const stream = createReadStream(path, { end: maxBytes })
  stream.pipe(decoder)
  let text = ''
  try {
    for await (const chunk of decoder) {
      text += (chunk as Buffer).toString('utf8')
      const newline = text.indexOf('\n')
      if (newline !== -1) return text.slice(0, newline)
    }
    return text
  } catch {
    // A truncated frame set yields whatever decoded so far.
    return text.split('\n', 1)[0] ?? ''
  } finally {
    stream.destroy()
    decoder.destroy()
  }
}
