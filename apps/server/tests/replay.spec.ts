import { describe, expect, it } from 'vitest'
import { mergeReplay, type StreamingLineSource } from '../src/replay.ts'
import { lineTimes, mergeChronologically, type LineChunk, type LineSource } from '../src/source.ts'

const T0 = Date.parse('2026-09-14T10:00:00Z')
const ref = (id: string) => ({ id, path: `/${id}`, role: 'main' as const })
const record = (at: number) => JSON.stringify({ timestamp: T0 + at, type: 'user', text: `prompt ${at}` })

async function collect(sources: readonly StreamingLineSource[]): Promise<LineChunk[]> {
  const chunks: LineChunk[] = []
  for await (const chunk of mergeReplay(sources)) chunks.push(chunk)
  return chunks
}

describe('streaming chronological replay', () => {
  it('preserves timestamp inheritance, file order, ties, synthetic records, and line addresses', async () => {
    const rows = [
      ['{}', record(10), '{}', record(30), record(5), record(40)],
      [record(10), record(20), '{}', record(40)],
      ['{}', '{}'],
      [],
      [record(0), ...Array.from({ length: 900 }, (_, at) => record(at))],
    ]
    const sources: LineSource[] = rows.map((lines, at) => ({
      ref: ref(String(at)), lines, times: lineTimes(lines), ...(at === 4 ? { synthetic: 1 } : {}),
    }))
    const streamed = await collect(sources.map(source => ({
      ref: source.ref,
      ...(source.synthetic === undefined ? {} : { synthetic: source.synthetic }),
      async *open() { yield* source.lines },
    })))
    expect(streamed).toEqual([...mergeChronologically(sources)])
  })

  it('reads only lookahead and one chunk before yielding, then releases every reader', async () => {
    let active = 0
    let read = 0
    const sources = [0, 1_000_000].map(offset => ({
      ref: ref(String(offset)),
      async *open() {
        active += 1
        try {
          for (let at = 0; ; at += 1) {
            if (++read > 1000) throw new Error('consumer has not requested the rest of this transcript')
            yield record(offset + at)
          }
        } finally { active -= 1 }
      },
    }))
    for await (const chunk of mergeReplay(sources)) {
      expect(chunk.startLine).toBe(0)
      expect(chunk.lines.length).toBeGreaterThan(0)
      expect(active).toBe(2)
      break
    }
    expect(read).toBeLessThan(1000)
    expect(active).toBe(0)
  })

  it('reopens a long untimestamped prefix without changing its chronological position', async () => {
    let opens = 0
    let closed = 0
    const sources = [{
      ref: ref('late'),
      async *open() {
        opens += 1
        try {
          for (let at = 0; at < 2000; at += 1) yield JSON.stringify({ type: 'mode', text: 'x'.repeat(1024) })
          yield record(20)
        } finally { closed += 1 }
      },
    }, {
      ref: ref('early'),
      async *open() { yield record(10) },
    }]
    const replay = mergeReplay(sources)
    const first = await replay.next()
    expect(first.value?.ref.id).toBe('early')
    await replay.return(undefined)
    expect(opens).toBe(2)
    expect(closed).toBe(opens)
  })

  it('bounds batches of wide records while allowing an indivisible oversized record', async () => {
    const lines = [record(0), ...Array.from({ length: 25 }, (_, at) => JSON.stringify({
      timestamp: T0 + at + 1, text: 'x'.repeat(100_000),
    })), JSON.stringify({ timestamp: T0 + 30, text: 'y'.repeat(1_000_000) })]
    const chunks = await collect([{ ref: ref('wide'), async *open() { yield* lines } }])
    expect(chunks.flatMap(chunk => chunk.lines)).toEqual(lines)
    let line = 0
    for (const chunk of chunks) {
      expect(chunk.startLine).toBe(line)
      if (chunk.lines.length > 1) expect(chunk.lines.join('').length * 2).toBeLessThanOrEqual(1024 * 1024)
      line += chunk.lines.length
    }
  })

  it('closes other readers when one transcript fails', async () => {
    let active = 0
    const sources = ['ok', 'bad'].map(id => ({
      ref: ref(id),
      async *open() {
        active += 1
        try {
          yield record(0)
          if (id === 'bad') throw new Error('unreadable transcript')
          yield record(10)
        } finally { active -= 1 }
      },
    }))
    await expect(collect(sources)).rejects.toThrow('unreadable transcript')
    expect(active).toBe(0)
  })

  it('cancels while probing a timestamp and closes the probe', async () => {
    const abort = new AbortController()
    let closed = false
    const sources = [{
      ref: ref('probe'),
      async *open() {
        try { yield '{}'; abort.abort(); yield '{}' } finally { closed = true }
      },
    }]
    const chunks: LineChunk[] = []
    for await (const chunk of mergeReplay(sources, abort.signal)) chunks.push(chunk)
    expect(chunks).toEqual([])
    expect(closed).toBe(true)
  })
})
