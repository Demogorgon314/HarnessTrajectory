import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compressedTranscriptPath, plainTranscriptPath, readDecodedPrefix, readFirstLine, readLines,
  resolveTranscriptFile, utf8IncompleteTail, zstdSupported,
} from '../src/tail.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('utf8IncompleteTail', () => {
  it('is zero for empty, ASCII, and a complete multi-byte character', () => {
    expect(utf8IncompleteTail(Buffer.alloc(0))).toBe(0)
    expect(utf8IncompleteTail(Buffer.from('abc\n'))).toBe(0)
    expect(utf8IncompleteTail(Buffer.from('你好'))).toBe(0)
    // 4-byte: U+1F4A9
    expect(utf8IncompleteTail(Buffer.from('💩'))).toBe(0)
  })

  it('counts a split 2-, 3-, or 4-byte sequence at the end', () => {
    const two = Buffer.from('é') // C3 A9
    expect(utf8IncompleteTail(two.subarray(0, 1))).toBe(1)
    const three = Buffer.from('你') // E4 BD A0
    expect(utf8IncompleteTail(three.subarray(0, 1))).toBe(1)
    expect(utf8IncompleteTail(three.subarray(0, 2))).toBe(2)
    const four = Buffer.from('💩') // F0 9F 92 A9
    expect(utf8IncompleteTail(four.subarray(0, 1))).toBe(1)
    expect(utf8IncompleteTail(four.subarray(0, 2))).toBe(2)
    expect(utf8IncompleteTail(four.subarray(0, 3))).toBe(3)
  })

  it('does not hold an invalid lead byte', () => {
    expect(utf8IncompleteTail(Buffer.from([0xFF]))).toBe(0)
  })
})

describe('readLines', () => {
  it('reassembles a JSONL record split on a multi-byte character', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-tail-'))
    dirs.push(dir)
    const path = join(dir, 'session.jsonl')
    const record = JSON.stringify({ type: 'user', text: '你好世界' })
    const body = `${record}\n`
    await writeFile(path, body)
    const bytes = Buffer.from(body)
    const ni = bytes.indexOf(Buffer.from('你'))
    expect(ni).toBeGreaterThan(0)
    // Cut after the first byte of 你 (E4 BD A0), as an 8 MB chunk would.
    const splitAt = ni + 1
    const first = await readLines(path, 0, '', splitAt)
    expect(first.lines).toEqual([])
    expect(first.rest.includes('\uFFFD')).toBe(false)
    expect(first.offset).toBe(splitAt - 1)
    const second = await readLines(path, first.offset, first.rest)
    expect(second.lines).toEqual([record])
    expect(JSON.parse(second.lines[0] ?? '')).toMatchObject({ text: '你好世界' })
  })

  it('still returns complete lines that sit entirely before the cut', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-tail-'))
    dirs.push(dir)
    const path = join(dir, 'session.jsonl')
    const firstLine = JSON.stringify({ n: 0, text: 'ascii only' })
    const secondLine = JSON.stringify({ n: 1, text: '后面还有' })
    await writeFile(path, `${firstLine}\n${secondLine}\n`)
    const bytes = Buffer.from(`${firstLine}\n${secondLine}\n`)
    const han = bytes.indexOf(Buffer.from('后'))
    const first = await readLines(path, 0, '', han + 1)
    expect(first.lines).toEqual([firstLine])
    const rest = await readLines(path, first.offset, first.rest)
    expect(rest.lines).toEqual([secondLine])
  })
})

describe.skipIf(!zstdSupported())('compressed transcripts (.jsonl.zst)', () => {
  async function zst(dir: string, name: string, body: string): Promise<string> {
    const path = join(dir, `${name}.zst`)
    await writeFile(path, zlib.zstdCompressSync(Buffer.from(body, 'utf8')))
    return path
  }

  it('reads decoded lines with decoded-byte offsets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-tail-'))
    dirs.push(dir)
    const one = JSON.stringify({ n: 0, text: '你好' })
    const two = JSON.stringify({ n: 1 })
    const path = await zst(dir, 'rollout.jsonl', `${one}\n${two}\n`)
    const all = await readLines(path, 0)
    expect(all.lines).toEqual([one, two])
    expect(all.offset).toBe(Buffer.byteLength(`${one}\n${two}\n`))
    // A `to` bound is a decoded-byte offset: only the prefix is sliced out.
    const cut = Buffer.byteLength(`${one}\n`)
    const prefix = await readLines(path, 0, '', cut)
    expect(prefix.lines).toEqual([one])
    expect(prefix.offset).toBe(cut)
    const rest = await readLines(path, prefix.offset, prefix.rest)
    expect(rest.lines).toEqual([two])
  })

  it('readFirstLine returns the decoded first record without a full decode error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-tail-'))
    dirs.push(dir)
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } })
    const path = await zst(dir, 'rollout.jsonl', `${meta}\n${JSON.stringify({ n: 1 })}\n`)
    expect(await readFirstLine(path)).toBe(meta)
  })

  it('readDecodedPrefix honours the byte cut on either representation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-tail-'))
    dirs.push(dir)
    const one = JSON.stringify({ n: 0 })
    const two = JSON.stringify({ n: 1 })
    const three = JSON.stringify({ n: 2 })
    const cut = Buffer.byteLength(`${one}\n${two}\n`)
    const path = await zst(dir, 'base.jsonl', `${one}\n${two}\n${three}\n`)
    // The canonical plain spelling resolves to the `.zst` on disk.
    const slice = await readDecodedPrefix(plainTranscriptPath(path), cut)
    expect(slice.lines).toEqual([one, two])
    expect(slice.offset).toBe(cut)
  })

  it('resolveTranscriptFile prefers the plain sibling when both exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-tail-'))
    dirs.push(dir)
    const plain = join(dir, 'rollout.jsonl')
    await writeFile(plain, '{}\n')
    const compressed = await zst(dir, 'rollout.jsonl', '{}\n')
    const resolved = await resolveTranscriptFile(compressed)
    expect(resolved?.path).toBe(plain)
    expect(resolved?.compressed).toBe(false)
    expect(compressedTranscriptPath(plain)).toBe(compressed)
    expect(plainTranscriptPath(compressed)).toBe(plain)
  })
})
