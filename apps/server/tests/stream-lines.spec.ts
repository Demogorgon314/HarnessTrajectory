import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { streamLines, zstdSupported } from '../src/tail.ts'

async function collect(path: string, end?: number): Promise<string[]> {
  const lines: string[] = []
  for await (const line of streamLines(path, end)) lines.push(line)
  return lines
}

function frame(bytes: string | Buffer): Buffer {
  return zlib.zstdCompressSync(Buffer.from(bytes), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
}

describe('on-demand transcript records', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ht-stream-lines-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reassembles large records and split UTF-8, drops blank lines and an incomplete tail', async () => {
    const path = join(dir, 'session.jsonl')
    // 你 starts one byte before the 64 KiB input boundary.
    const wide = JSON.stringify({ text: 'x'.repeat(65_523) + '你💡' + 'y'.repeat(150_000) })
    await writeFile(path, `\n \n${wide}\r\n\t\n{}\n{"unfinished":`)
    expect(await collect(path)).toEqual([`${wide}\r`, '{}'])
  })

  it('pins the read boundary so appends while a consumer is paused are not replayed', async () => {
    const path = join(dir, 'session.jsonl')
    const lines = Array.from({ length: 3000 }, (_, at) => JSON.stringify({ text: `record ${at} ${'x'.repeat(100)}` }))
    await writeFile(path, lines.join('\n') + '\n')
    const reader = streamLines(path)
    const first = await reader.next()
    expect(first.value).toBe(lines[0])
    await appendFile(path, '{"text":"arrived later"}\n')
    const rest: string[] = []
    for await (const line of reader) rest.push(line)
    expect(rest).toEqual(lines.slice(1))
  })

  it('honors byte cuts without emitting a partial record', async () => {
    const path = join(dir, 'session.jsonl')
    const first = JSON.stringify({ text: '你好' })
    await writeFile(path, `${first}\n{"text":"later"}\n`)
    expect(await collect(path, Buffer.byteLength(`${first}\n`) + 5)).toEqual([first])
    expect(await collect(path, 0)).toEqual([])
  })

  it('stops after cancellation and can be closed early', async () => {
    const path = join(dir, 'session.jsonl')
    await writeFile(path, '{}\n'.repeat(50_000))
    const abort = new AbortController()
    const reader = streamLines(path, undefined, abort.signal)
    expect((await reader.next()).value).toBe('{}')
    abort.abort()
    expect((await reader.next()).done).toBe(true)
    const other = streamLines(path)
    await other.next()
    await other.return(undefined)
    expect((await other.next()).done).toBe(true)
  })

  describe.skipIf(!zstdSupported())('compressed input', () => {
    it('streams one Codex frame with a decoded-byte prefix bound', async () => {
      const path = join(dir, 'session.jsonl.zst')
      const one = JSON.stringify({ text: '你好' + 'x'.repeat(160_000) })
      const two = JSON.stringify({ text: 'second' })
      await writeFile(path, frame(`${one}\n${two}\n`))
      expect(await collect(path)).toEqual([one, two])
      expect(await collect(path, Buffer.byteLength(`${one}\n`) + 5)).toEqual([one])
    })

    it('decodes every DSH frame, reassembles UTF-8 across frames and stops at physical cuts', async () => {
      const path = join(dir, 'session.jsonl.zstd')
      const line = JSON.stringify({ text: '你💡' })
      const bytes = Buffer.from(line + '\n')
      const cut = bytes.indexOf(Buffer.from('你')) + 1
      const first = frame('{}\n')
      const second = frame(bytes.subarray(0, cut))
      const third = frame(bytes.subarray(cut))
      await writeFile(path, Buffer.concat([first, second, third]))
      expect(await collect(path)).toEqual(['{}', line])
      expect(await collect(path, first.length + second.length + third.length - 1)).toEqual(['{}'])
    })

    it('ignores a torn frame and does not inspect later frames until requested', async () => {
      const path = join(dir, 'session.jsonl.zstd')
      const first = frame('{"text":"first"}\n')
      const second = frame('{"text":"second"}\n')
      await writeFile(path, Buffer.concat([first, second.subarray(0, second.length - 2)]))
      expect(await collect(path)).toEqual(['{"text":"first"}'])
      await writeFile(path, Buffer.concat([first, Buffer.from('not a frame')]))
      const reader = streamLines(path)
      expect((await reader.next()).value).toBe('{"text":"first"}')
      await expect(reader.next()).rejects.toThrow(/magic/)
    })

    it.each(['.zst', '.zstd'])('cancels active %s decompression while the consumer is paused', async suffix => {
      const path = join(dir, `session.jsonl${suffix}`)
      await writeFile(path, frame('{}\n'.repeat(100_000)))
      const abort = new AbortController()
      const reader = streamLines(path, undefined, abort.signal)
      expect((await reader.next()).value).toBe('{}')
      abort.abort()
      expect((await reader.next()).done).toBe(true)
    })

    it('propagates a corrupt compressed payload', async () => {
      const path = join(dir, 'session.jsonl.zst')
      await writeFile(path, Buffer.from('corrupt zstd payload'))
      await expect(collect(path)).rejects.toThrow()
    })
  })
})
