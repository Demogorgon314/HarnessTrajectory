/** Byte-offset file reading with line reassembly, for initial loads and live tails. */

import { createReadStream } from 'node:fs'
import { open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
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
 * consume reader decodes the whole file and its cursor lives in DECODED
 * bytes. Replay uses streamLines to decode incrementally to the same cut.
 */
export const COMPRESSED_SUFFIX = '.zst'

export function isCompressedTranscript(path: string): boolean {
  return path.endsWith(COMPRESSED_SUFFIX)
}

/**
 * DeepSeek Harness's session log is a DIFFERENT container: `session[.vN].jsonl.zstd`
 * holds CONCATENATED zstd frames — one checksummed frame per flush batch — and
 * the file keeps growing while the session runs
 * (session-persistence-jsonl/src/zstd.ts). `zstdDecompressSync` on the whole
 * buffer decodes only the FIRST frame, so reads go through `scanZstdFrames`
 * and decode frame by frame. The cursor lives in PHYSICAL bytes at a frame
 * boundary: a torn final frame (a flush in flight, or a crash) is left
 * unconsumed and retried once its bytes complete.
 */
export const DSH_COMPRESSED_SUFFIX = '.zstd'

export function isDshFrameTranscript(path: string): boolean {
  return path.endsWith(DSH_COMPRESSED_SUFFIX)
}

const ZSTD_MAGIC = 0xFD2FB528

function zstdHeaderBytes(descriptor: number): number {
  if ((descriptor & 0x18) !== 0) throw new Error('corrupt Zstandard session log: reserved frame-header bit')
  const sizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag
  return (singleSegment ? 0 : 1) + dictionaryBytes + sizeBytes
}

function zstdBlockBytes(header: number): number {
  const type = (header >>> 1) & 0x03
  if (type === 0x03) throw new Error('corrupt Zstandard session log: reserved block type')
  return type === 0x01 ? 1 : header >>> 3
}

/** Byte range occupied by one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
}

/**
 * Locate complete frames without decompressing their blocks, so a reader can
 * consume appended data while the writer's last frame is still torn. A frame
 * that fails structural validation throws; EOF inside the final frame simply
 * stops the scan (its start is the next unconsumed byte).
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const checksum = (descriptor & 0x04) !== 0
    const remainingHeaderBytes = zstdHeaderBytes(descriptor)
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const payloadBytes = zstdBlockBytes(blockHeader)
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
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
 *
 * For `.jsonl.zstd` the offsets are PHYSICAL bytes like a plain file's, except
 * they only ever sit on frame boundaries: the window's complete frames decode
 * in order and a torn tail stays unconsumed.
 */
export async function readLines(
  path: string,
  from: number,
  rest = '',
  to?: number,
): Promise<ReadResult> {
  if (isDshFrameTranscript(path)) {
    return readFrameLines(path, from, rest, to)
  }
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
 * Read one appended-frame window of a `.jsonl.zstd` dsh log: complete frames
 * in `[from, end)` decode in file order and their decoded text feeds the same
 * line splitter a plain read uses. The returned offset stops at the last
 * complete frame's end — a torn or absent frame consumes nothing, so a
 * progress-checking caller can tell a torn tail apart from new data.
 */
async function readFrameLines(
  path: string,
  from: number,
  rest: string,
  to?: number,
): Promise<ReadResult> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    const end = to === undefined ? stat.size : Math.min(to, stat.size)
    if (end <= from) return { lines: [], offset: from, rest }
    const buffer = Buffer.allocUnsafe(end - from)
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, from + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const window = buffer.subarray(0, filled)
    let text = rest
    let consumed = 0
    for (const frame of scanZstdFrames(window)) {
      text += zlib.zstdDecompressSync(window.subarray(frame.start, frame.end)).toString('utf8')
      consumed = frame.end
    }
    const split = splitLines(text)
    return {
      lines: split.lines.filter(line => line.trim() !== ''),
      offset: from + consumed,
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

/**
 * Find complete frames using only headers and positional reads. A frame may
 * span the whole file; skipping block payloads keeps compressed input bounded.
 */
async function* frameRanges(handle: FileHandle, end: number, signal?: AbortSignal): AsyncGenerator<ZstdFrameRange> {
  const header = Buffer.allocUnsafe(5)
  const read = async (at: number, length: number): Promise<boolean> => {
    if (at + length > end || signal?.aborted) return false
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(header, filled, length - filled, at + filled)
      if (bytesRead === 0 || signal?.aborted) return false
      filled += bytesRead
    }
    return true
  }
  let at = 0
  while (await read(at, 4)) {
    const start = at
    if (header.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error('corrupt Zstandard session log: invalid frame magic')
    if (!await read(at + 4, 1)) return
    const descriptor = header.readUInt8(0)
    at += 5 + zstdHeaderBytes(descriptor)
    for (;;) {
      if (!await read(at, 3)) return
      const block = header.readUIntLE(0, 3)
      at += 3 + zstdBlockBytes(block)
      if (at > end) return
      if ((block & 1) !== 0) break
    }
    if ((descriptor & 0x04) !== 0) at += 4
    if (at > end) return
    yield { start, end: at }
  }
}

const REPLAY_READ_BYTES = 64 * 1024

async function* physicalChunks(
  handle: FileHandle, start: number, end: number, signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  let at = start
  while (at < end && !signal?.aborted) {
    const bytes = Buffer.allocUnsafe(Math.min(REPLAY_READ_BYTES, end - at))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, at)
    if (bytesRead === 0 || signal?.aborted) return
    at += bytesRead
    yield bytes.subarray(0, bytesRead)
  }
}

/** A bounded physical window, optionally decoded through one zstd frame. */
async function* byteChunks(
  handle: FileHandle, start: number, end: number, compressed: boolean, signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  if (start >= end || signal?.aborted) return
  // Frame decoders borrow the descriptor. Destroying a FileHandle read stream
  // closes its handle even with autoClose:false, breaking the next frame.
  const input = Readable.from(physicalChunks(handle, start, end, signal), {
    objectMode: false, highWaterMark: REPLAY_READ_BYTES,
  })
  const decoder = compressed ? zlib.createZstdDecompress({ chunkSize: REPLAY_READ_BYTES }) : undefined
  const pumping = decoder === undefined ? undefined : pipeline(input, decoder, signal === undefined ? {} : { signal })
  // The iterator observes pipeline errors; attach immediately to avoid an
  // unhandled rejection while the downstream consumer is paused on a line.
  void pumping?.catch(() => {})
  try {
    for await (const chunk of decoder ?? input) {
      if (signal?.aborted) return
      yield chunk as Buffer
    }
    await pumping
  } finally {
    input.destroy()
    decoder?.destroy()
    await pumping?.catch(() => {})
  }
}

/**
 * Replay complete non-blank records on demand. `end` is decoded bytes for
 * Codex `.zst`, physical bytes otherwise. DSH emits only complete frames.
 * Memory is bounded by stream buffers, the codec window, and the longest
 * record; an unterminated last record is never emitted.
 */
export async function* streamLines(path: string, end?: number, signal?: AbortSignal): AsyncGenerator<string> {
  if (end === 0 || signal?.aborted) return
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const compressed = isCompressedTranscript(path)
    const physicalEnd = compressed ? size : Math.min(end ?? size, size)
    const frames = isDshFrameTranscript(path)
      ? frameRanges(handle, physicalEnd, signal)
      : [{ start: 0, end: physicalEnd }]
    const decoder = new StringDecoder('utf8')
    let rest = ''
    let decoded = 0
    for await (const frame of frames) {
      for await (const bytes of byteChunks(handle, frame.start, frame.end, compressed || isDshFrameTranscript(path), signal)) {
        const remaining = compressed && end !== undefined ? Math.max(0, end - decoded) : bytes.length
        const slice = bytes.subarray(0, remaining)
        decoded += slice.length
        const split = splitLines(rest + decoder.write(slice))
        rest = split.rest
        for (const line of split.lines) {
          if (signal?.aborted) return
          if (line.trim() !== '') yield line
        }
        if (compressed && end !== undefined && decoded >= end) return
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error
  } finally {
    await handle.close()
  }
}

/** Read only the first line of a file (bounded), for identity probing. */
export async function readFirstLine(path: string, maxBytes = 256 * 1024): Promise<string> {
  if (isCompressedTranscript(path) || isDshFrameTranscript(path)) {
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
