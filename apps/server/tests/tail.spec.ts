import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLines, utf8IncompleteTail } from '../src/tail.ts'

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
