/**
 * Cursor protobuf root and transcript plan. Roots are hand-encoded; no store I/O.
 */

import { describe, expect, it } from 'vitest'
import { parseMetaValue } from '../src/cursor/db.ts'
import { decodeItem, decodeRoot, decodeTurn, decodeUserPrompt } from '../src/cursor/proto.ts'
import {
  assignCursorTimes, assignTimes, cursorSessionModel, messageLine, planTranscript, sessionLine,
  type CursorClockMessage, type CursorClockTurn,
} from '../src/cursor/transcript.ts'

function varint(value: number): Uint8Array {
  const bytes: number[] = []
  let rest = value
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest & 0x7f)
  return Uint8Array.from(bytes)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function key(field: number, wire: number): Uint8Array {
  return varint(field * 8 + wire)
}

function bytesField(field: number, data: Uint8Array): Uint8Array {
  return concat(key(field, 2), varint(data.length), data)
}

function strField(field: number, text: string): Uint8Array {
  return bytesField(field, new TextEncoder().encode(text))
}

function varField(field: number, value: number): Uint8Array {
  return concat(key(field, 0), varint(value))
}

function idBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes[31] = n
  return bytes
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A usage bucket whose encoded message is exactly 32 bytes (a blob-id lookalike). */
function bucket32(): Uint8Array {
  const body = concat(
    strField(1, 'ab'),
    strField(2, 'x'.repeat(22)),
    varField(3, 1),
    varField(4, 1),
  )
  if (body.length !== 32) throw new Error(`bucket length ${body.length}`)
  return body
}

describe('decodeRoot', () => {
  it('reads message ids, usage buckets, and session facts', () => {
    const first = idBytes(1)
    const second = idBytes(2)
    const bucket = bucket32()
    const usage = concat(
      varField(1, 22_201),
      varField(2, 256_000),
      bytesField(3, bytesField(3, bucket)),
    )
    const root = concat(
      bytesField(1, first),
      bytesField(1, second),
      bytesField(5, usage),
      strField(9, 'file:///work/project'),
      strField(18, '.cursor/rules/a.mdc'),
      bytesField(21, concat(strField(1, '/work/project'), strField(2, 'main'))),
      strField(22, 'cli'),
      varField(26, 1_700_000_000_000),
      strField(27, 'Asia/Shanghai'),
    )
    expect(decodeRoot(root)).toEqual({
      messageIds: [hex(first), hex(second)],
      ruleFiles: ['.cursor/rules/a.mdc'],
      usage: {
        used: 22_201,
        window: 256_000,
        buckets: [{ key: 'ab', label: 'x'.repeat(22), tokens: 1, chars: 1 }],
      },
      workspaceUri: 'file:///work/project',
      repo: '/work/project',
      branch: 'main',
      client: 'cli',
      createdAt: 1_700_000_000_000,
      timezone: 'Asia/Shanghai',
      turnIds: [],
    })
  })

  it('distinguishes a valid empty root from malformed input', () => {
    expect(decodeRoot(new Uint8Array())).toEqual({ messageIds: [], ruleFiles: [], turnIds: [] })
    expect(decodeRoot(Uint8Array.of(0x80))).toBeUndefined()
    expect(decodeRoot(Uint8Array.of(0x0a, 0x05, 0x01))).toBeUndefined()
    expect(decodeRoot(bytesField(1, Uint8Array.of(1)))).toBeUndefined()
  })

  it('decodes every field-8 turn, including a 32-byte-nested tool id', () => {
    const chainId = idBytes(7)
    const promptId = idBytes(8)
    const thinkId = idBytes(9)
    const toolId = idBytes(10)
    const callId = 'call-1\nfc_1'
    const prompt = concat(strField(1, 'Fix it'), varField(25, 5_000), varField(26, 5_100))
    const thinking = bytesField(3, concat(strField(1, 'hmm'), varField(3, 5_200), varField(4, 5_400)))
    const toolBody = concat(strField(57, callId), varField(59, 5_500), varField(60, 5_900))
    const tool = bytesField(2, toolBody)
    expect(toolBody.length).not.toBe(32)
    const turn = concat(
      bytesField(1, promptId),
      bytesField(2, thinkId),
      bytesField(2, toolId),
      strField(3, 'req-1'),
      strField(9, 'Shell'),
    )
    const chain = bytesField(1, turn)
    const root = concat(bytesField(8, chainId), bytesField(8, idBytes(11)))
    expect(decodeRoot(root)?.turnIds).toEqual([hex(chainId), hex(idBytes(11))])
    expect(decodeTurn(chain)).toEqual({
      requestId: 'req-1',
      promptId: hex(promptId),
      itemIds: [hex(thinkId), hex(toolId)],
      toolNames: ['Shell'],
    })
    expect(decodeUserPrompt(prompt)).toEqual({ text: 'Fix it', time: 5_000, end: 5_100 })
    expect(decodeItem(thinking)).toEqual({ kind: 'thinking', text: 'hmm', start: 5_200, end: 5_400 })
    expect(decodeItem(tool)).toEqual({ kind: 'tool', toolCallId: callId, start: 5_500, end: 5_900 })
    expect(decodeTurn(Uint8Array.of(0x80))).toBeUndefined()
    expect(decodeItem(Uint8Array.of(0x0a, 0x01, 0x01))).toBeUndefined()
  })
})

describe('parseMetaValue', () => {
  it('accepts hex-encoded JSON and plain JSON, and rejects garbage', () => {
    const json = JSON.stringify({ agentId: 'a', latestRootBlobId: 'b', name: 'New Agent' })
    expect(parseMetaValue(Buffer.from(json, 'utf8').toString('hex'))).toMatchObject({ name: 'New Agent' })
    expect(parseMetaValue(json)).toMatchObject({ agentId: 'a' })
    expect(parseMetaValue('zzzz')).toBeUndefined()
    expect(parseMetaValue('7b')).toBeUndefined()
    expect(parseMetaValue('')).toBeUndefined()
  })
})

describe('planTranscript', () => {
  it('appends a suffix and rebuilds a shrink or a rewrite', () => {
    expect(planTranscript(['a', 'b', 'c'], ['a', 'b'])).toEqual({ action: 'append', ids: ['c'] })
    expect(planTranscript(['a', 'b'], [])).toEqual({ action: 'append', ids: ['a', 'b'] })
    expect(planTranscript(['a'], ['a', 'b'])).toEqual({ action: 'rebuild', ids: ['a'] })
    expect(planTranscript(['b', 'a'], ['a'])).toEqual({ action: 'rebuild', ids: ['b', 'a'] })
  })
})

describe('assignCursorTimes', () => {
  const callId = 'call-1\nfc_1'
  const human: CursorClockMessage = { kind: 'human', requestId: 'req-1', toolCallIds: [], toolResultIds: [] }
  const humanAgain: CursorClockMessage = { kind: 'human', requestId: 'req-1', toolCallIds: [], toolResultIds: [] }
  const assistant: CursorClockMessage = { kind: 'assistant', toolCallIds: [callId], toolResultIds: [] }
  const tool: CursorClockMessage = { kind: 'tool', toolCallIds: [], toolResultIds: [callId] }
  const system: CursorClockMessage = { kind: 'system', toolCallIds: [], toolResultIds: [] }
  const injected: CursorClockMessage = { kind: 'injection', toolCallIds: [], toolResultIds: [] }
  const turns: CursorClockTurn[] = [{
    requestId: 'req-1',
    promptTime: 5_000,
    items: [
      { kind: 'thinking', start: 5_200, end: 5_400 },
      { kind: 'tool', toolCallId: callId, start: 5_500, end: 5_900 },
    ],
  }]

  it('stamps each role from the chain and keeps a shared request monotonic', () => {
    const clocks = assignCursorTimes(
      [system, injected, human, humanAgain, assistant, tool],
      turns,
      1_000,
      9_000,
      null,
    )
    expect(clocks.map(clock => clock.time)).toEqual([1_000, 1_000, 5_000, 5_200, 5_500, 5_900])
    expect(clocks[4]?.span).toMatchObject({
      start: 5_500,
      end: 5_900,
      calls: [{ id: callId, start: 5_500, end: 5_900 }],
    })
  })

  it('falls back to phase-1 stamps when the chain has no timestamps', () => {
    const clocks = assignCursorTimes(
      [system, human],
      [{ requestId: 'req-1', items: [] }],
      1_000,
      9_000,
      null,
    )
    expect(clocks).toEqual([{ time: 1_000 }, { time: 9_000 }])
    expect(clocks.every(clock => clock.span === undefined)).toBe(true)
  })

  it('does not move backwards across an append floor', () => {
    const clocks = assignCursorTimes([assistant, tool], turns, 1_000, 9_000, 8_000)
    expect(clocks.map(clock => clock.time)).toEqual([8_000, 8_000])
  })
})

describe('assignTimes / session facts', () => {
  it('stamps index 0 with createdAt and never moves a time backwards', () => {
    expect(assignTimes(0, 3, 100, 50, null)).toEqual([100, 100, 100])
    expect(assignTimes(2, 2, 100, 400, 250)).toEqual([400, 400])
    expect(assignTimes(1, 1, 100, 80, 250)).toEqual([250])
  })

  it('ignores lastUsedModel default and omits unset sidecar fields', () => {
    expect(cursorSessionModel('grok-4.7-high', 'default')).toBe('grok-4.7-high')
    expect(cursorSessionModel(undefined, 'default')).toBeUndefined()
    expect(cursorSessionModel(undefined, 'claude-fable-5-1')).toBe('claude-fable-5-1')
    const line = JSON.parse(sessionLine({ agentId: 'agent-1', title: 'T', createdAt: 5 }, 9)) as Record<string, unknown>
    expect(line).toEqual({ type: 'cursor.session', time: 9, agentId: 'agent-1', title: 'T', createdAt: 5 })
    const message = JSON.parse(messageLine(0, 'blob', 5, { role: 'system', content: 'hi' })) as { index: number }
    expect(message.index).toBe(0)
  })
})
