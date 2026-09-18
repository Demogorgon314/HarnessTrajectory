/**
 * Claude synthesizer → fold, end to end: a synthetic session is pushed through
 * `createClaudeSynthesizer` and folded with `applyTimeline`, then read back
 * through `buildTimelineView`. Synthetic fixtures only — no transcript content.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import { applyTimeline, buildTimelineView, createTimelineState, type TimelineState } from '../../src/fold/fold.ts'
import type { Snapshot } from '../../src/shared/types.ts'
import { createClaudeSynthesizer } from '../../src/synth/claude.ts'

const T0 = Date.UTC(2025, 0, 1, 12, 0, 0)
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
const MAIN: SessionFileRef = { id: 'sess-1', role: 'main', path: '/tmp/sess-1.jsonl' }

interface Rec { [key: string]: unknown }

function fold(records: readonly Rec[], file: SessionFileRef = MAIN): Snapshot {
  const synth = createClaudeSynthesizer(file)
  let state = createTimelineState()
  for (const record of records) {
    for (const event of synth.push(JSON.stringify(record))) {
      state = applyTimeline(state, event, DEFAULT_BOUNDS)
    }
  }
  return buildTimelineView(state, DEFAULT_BOUNDS)
}

function foldState(records: readonly Rec[], file: SessionFileRef = MAIN): TimelineState {
  const synth = createClaudeSynthesizer(file)
  let state = createTimelineState()
  for (const record of records) {
    for (const event of synth.push(JSON.stringify(record))) {
      state = applyTimeline(state, event, DEFAULT_BOUNDS)
    }
  }
  return state
}

function human(s: number, text: string, extra: Rec = {}): Rec {
  return {
    type: 'user', uuid: `u-${s}`, timestamp: at(s), version: '2.1.270',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  }
}

function assistantBlock(s: number, opts: {
  requestId: string; index: number; block: Rec; usage?: Rec; model?: string; stopReason?: string | null
}): Rec {
  return {
    type: 'assistant', uuid: `a-${s}`, timestamp: at(s), version: '2.1.270',
    requestId: opts.requestId, apiBlockIndex: opts.index,
    message: {
      id: `msg-${opts.requestId}`, role: 'assistant', model: opts.model ?? 'claude-opus-4',
      content: [opts.block], stop_reason: opts.stopReason ?? 'tool_use',
      usage: opts.usage ?? {
        input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20,
      },
    },
  }
}

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number): Rec => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
})

function toolResult(s: number, callId: string, toolUseResult?: unknown): Rec {
  return {
    type: 'user', uuid: `r-${s}`, timestamp: at(s),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'ok' }] },
    ...(toolUseResult === undefined ? {} : { toolUseResult }),
  }
}

function attachment(s: number, body: Rec, rendered?: string[]): Rec {
  return {
    type: 'attachment', uuid: `t-${s}`, timestamp: at(s), attachment: body,
    ...(rendered === undefined ? {} : { rendered: rendered.map(content => ({ content })) }),
  }
}

const promptSnapshot = (s: number): Rec => attachment(s, {
  type: 'prompt_snapshot',
  systemPrompt: ['you are a helper', 'follow the rules'],
  tools: [
    { name: 'Read', description: 'read a file', schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
    { name: 'Bash', description: 'run a command', schema: { type: 'object', properties: { command: { type: 'string' } } } },
  ],
})

/** A two-turn session with a header, one injection, one file read and a compaction. */
function session(): Rec[] {
  return [
    promptSnapshot(0),
    human(1, 'please read the file'),
    attachment(2, { type: 'file', filename: 'a.ts', displayPath: 'src/a.ts' }, ['the file body']),
    assistantBlock(4, {
      requestId: 'r1', index: 0, block: { type: 'thinking', thinking: 'let me look' },
      usage: usage(500, 2_000, 100, 40),
    }),
    assistantBlock(6, {
      requestId: 'r1', index: 1,
      block: { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      usage: usage(500, 2_000, 100, 90),
    }),
    toolResult(8, 'c1', {
      type: 'text',
      file: { filePath: '/tmp/a.ts', content: 'hello', startLine: 1, numLines: 12, totalLines: 40 },
    }),
    assistantBlock(10, {
      requestId: 'r2', index: 0, block: { type: 'text', text: 'done' },
      usage: usage(600, 3_000, 0, 25), stopReason: 'end_turn',
    }),
    { type: 'system', uuid: 's-11', timestamp: at(11), subtype: 'turn_duration', durationMs: 11_000 },
    human(12, 'now compact'),
    assistantBlock(14, {
      requestId: 'r3', index: 0, block: { type: 'text', text: 'ok' },
      usage: usage(700, 4_000, 0, 10), stopReason: 'end_turn',
    }),
    {
      type: 'system', uuid: 'boundary-1', timestamp: at(16), subtype: 'compact_boundary',
      compactMetadata: {
        trigger: 'auto', preTokens: 120_000, postTokens: 30_000, durationMs: 3_000,
        cumulativeDroppedTokens: 90_000,
        // Prefix-preserving (anchor = boundary uuid): kept nodes precede the summary.
        preservedSegment: { headUuid: 'a-14', tailUuid: 'a-14', anchorUuid: 'boundary-1' },
      },
    },
    { ...human(17, 'summary of the session so far'), uuid: 'summary-1', isCompactSummary: true },
  ]
}

describe('claude synthesizer → fold', () => {
  const view = fold(session())

  it('books one request per API response', () => {
    expect(view.requests).toHaveLength(3)
  })

  it('stamps turn and step on every request record', () => {
    expect(view.requests.map(record => [record.turn, record.step])).toEqual([[1, 1], [1, 2], [2, 1]])
  })

  it('carries the provider figures: prompt, cacheRead and output', () => {
    expect(view.requests.map(record => [record.prompt, record.cacheRead, record.output])).toEqual([
      [2_600, 2_000, 90],
      [3_600, 3_000, 25],
      [4_700, 4_000, 10],
    ])
  })

  it('counts one human input per genuine prompt (injections excluded)', () => {
    expect(view.humanInputs).toBe(2)
  })

  it('names the inject events after the attachment identity', () => {
    const injects = view.events.filter(event => event.kind === 'inject')
    // The compaction summary is itself an injection (source kind 'plugin').
    expect(injects.map(event => event.name)).toEqual(['src/a.ts', 'compaction'])
    expect(injects[0]?.form).toBe('context')
    expect(injects[1]?.form).toBe('compaction')
  })

  it('logs one compaction event carrying the shadowed nodes and token count', () => {
    const compactions = view.events.filter(event => event.kind === 'compaction')
    expect(compactions).toHaveLength(1)
    // Shadowed: prompt, file injection, response 1, tool result, response 2,
    // prompt 2 — everything but the preserved `a-14` response.
    expect(compactions[0]?.count).toBe(6)
    expect(compactions[0]?.tokens).toBeGreaterThan(0)
  })

  it('removes the shadowed nodes from the live surface', () => {
    // Only the last assistant message was preserved; the compaction summary
    // replaces everything before it and lands as an inject node.
    expect(view.nodes.map(node => node.cat)).toEqual(['assistant', 'inject'])
    expect(view.archive.every(node => typeof node.gone === 'number')).toBe(true)
  })

  it('derives the file-activity log from data.fileOps', () => {
    expect(view.fileOps).toEqual([
      expect.objectContaining({ kind: 'read', path: '/tmp/a.ts', tool: 'Read', err: false, read: { start: 1, count: 12 } }),
    ])
  })

  it('prices the header epoch and marks the system prompt as known', () => {
    expect(view.systemDerived).toBeUndefined()
    expect(view.toolsKnown).toBe(true)
    expect(view.current.tools).toBeGreaterThan(0)
    expect(view.systems?.length).toBe(1)
  })

  it('reports the route the synthesizer inferred', () => {
    expect(view.model).toBe('claude-opus-4')
    expect(view.provider).toBe('anthropic')
    expect(view.contextWindow).toBeUndefined()
  })

  it('books one completed tool call and its timing', () => {
    expect(view.timing?.calls).toBe(3)
    expect(view.timing?.toolCalls).toBe(1)
    expect(view.timing?.wallMs).toBeGreaterThan(0)
    // The harness records no first-token time, so TTFT stays unattributed
    // rather than fabricated (see the TTFT note); the block-framed stream
    // still prices the whole model window as generation.
    expect(view.timing?.ttftMs).toBe(0)
    expect(view.timing?.genMs).toBeGreaterThan(0)
    expect(view.timing?.genMs).toBeLessThanOrEqual(view.timing?.wallMs ?? 0)
  })
})

describe('claude synthesizer → fold, without a prompt_snapshot', () => {
  it('falls back to the derived system remainder', () => {
    const view = fold([
      human(0, 'hello'),
      assistantBlock(2, {
        requestId: 'r1', index: 0, block: { type: 'text', text: 'hi' },
        usage: usage(5_000, 0, 0, 10), stopReason: 'end_turn',
      }),
      { type: 'system', uuid: 's-3', timestamp: at(3), subtype: 'turn_duration' },
    ])
    expect(view.systemDerived).toBe(true)
    expect(view.toolsKnown).toBeUndefined()
    expect(view.requests[0]?.systemDerived).toBe(true)
    expect(view.requests[0]?.system).toBeGreaterThan(4_000)
    expect(view.current.tools).toBe(0)
  })
})

describe('claude synthesizer → fold, model switch', () => {
  it('logs a model event when a model attachment changes the route', () => {
    const view = fold([
      promptSnapshot(0),
      human(1, 'hello'),
      assistantBlock(3, {
        requestId: 'r1', index: 0, block: { type: 'text', text: 'a' },
        model: 'claude-opus-4', stopReason: 'end_turn',
      }),
      attachment(5, { type: 'model', identity: { modelId: 'claude-sonnet-9' }, text: 'switched' }, ['switched']),
      human(6, 'again'),
      assistantBlock(8, {
        requestId: 'r2', index: 0, block: { type: 'text', text: 'b' },
        model: 'claude-sonnet-9', stopReason: 'end_turn',
      }),
      { type: 'system', uuid: 's-9', timestamp: at(9), subtype: 'turn_duration' },
    ])
    const models = view.events.filter(event => event.kind === 'model')
    expect(models).toHaveLength(1)
    expect([models[0]?.from, models[0]?.to]).toEqual(['claude-opus-4', 'claude-sonnet-9'])
    expect(view.model).toBe('claude-sonnet-9')
  })
})

describe('claude synthesizer → fold, compaction ordering', () => {
  const segmentBoundary = (s: number, anchor: string, extra: Rec = {}): Rec => ({
    type: 'system', uuid: 'b', timestamp: at(s), subtype: 'compact_boundary', parentUuid: null,
    compactMetadata: {
      trigger: 'auto', preTokens: 5_000,
      preservedSegment: { headUuid: 'u2', tailUuid: 'u3', anchorUuid: anchor },
      ...extra,
    },
  })

  const chained = (): Rec[] => [
    { ...human(0, 'discard'), uuid: 'u1', parentUuid: null },
    { ...human(1, 'keep me'), uuid: 'u2', parentUuid: 'u1' },
    { ...human(2, 'keep too'), uuid: 'u3', parentUuid: 'u2' },
  ]

  it('suffix-preserving (anchor = summary): surface is summary, kept, then the next record', () => {
    const state = foldState([
      ...chained(),
      segmentBoundary(3, 'summary'),
      { ...human(4, 'summary text'), uuid: 'summary', parentUuid: 'b', isCompactSummary: true },
      { ...human(5, 'after'), uuid: 'u4', parentUuid: 'u3' },
    ])
    expect(state.surface.map(node => node.text)).toEqual(['summary text', 'keep me', 'keep too', 'after'])
  })

  it('prefix-preserving (anchor = boundary): kept nodes precede the summary', () => {
    const state = foldState([
      ...chained(),
      segmentBoundary(3, 'b'),
      { ...human(4, 'summary text'), uuid: 'summary', parentUuid: 'b', isCompactSummary: true },
      { ...human(5, 'after'), uuid: 'u4', parentUuid: 'u3' },
    ])
    expect(state.surface.map(node => node.text)).toEqual(['keep me', 'keep too', 'summary text', 'after'])
  })

  it('the legacy preservedMessages.allUuids contract still applies', () => {
    const state = foldState([
      ...chained(),
      {
        type: 'system', uuid: 'b', timestamp: at(3), subtype: 'compact_boundary', parentUuid: null,
        compactMetadata: {
          trigger: 'auto', preTokens: 5_000,
          preservedMessages: { allUuids: ['u2', 'u3'], uuids: ['u2', 'u3'], anchorUuid: 'u3' },
        },
      },
      { ...human(4, 'summary text'), uuid: 'summary', parentUuid: 'b', isCompactSummary: true },
    ])
    expect(state.surface.map(node => node.text)).toEqual(['keep me', 'keep too', 'summary text'])
  })

  it('snip_boundary drops the listed uuids from the live surface', () => {
    const state = foldState([
      ...chained(),
      {
        type: 'system', uuid: 'b', timestamp: at(3), subtype: 'snip_boundary', parentUuid: 'u3',
        snipMetadata: { removedUuids: ['u2'] },
      },
      { ...human(4, 'after'), uuid: 'u4', parentUuid: 'u3' },
    ])
    const texts = state.surface.map(node => node.text)
    expect(texts).toContain('discard')
    expect(texts).toContain('keep too')
    expect(texts).not.toContain('keep me')
    expect(texts[texts.length - 1]).toBe('after')
  })

  it('retains each ancestor checkpoint after a snip, including across later appends', () => {
    const state = foldState([
      ...chained(),
      { type: 'system', uuid: 'snip', parentUuid: 'u3', subtype: 'snip_boundary', snipMetadata: { removedUuids: ['u2'] } },
      { ...human(4, 'continue'), uuid: 'u4', parentUuid: 'u3' },
      { ...human(5, 'new branch'), uuid: 'u5', parentUuid: 'u1' },
    ])
    expect(state.surface.map(node => node.text).filter(Boolean)).toEqual(['discard', 'new branch'])
  })

  it('resolves a parent inside a snipped gap to the surviving prefix', () => {
    const state = foldState([
      ...chained(),
      { type: 'system', uuid: 'snip', parentUuid: 'u3', subtype: 'snip_boundary', snipMetadata: { removedUuids: ['u2'] } },
      { ...human(4, 'new branch'), uuid: 'u4', parentUuid: 'u2' },
    ])
    expect(state.surface.map(node => node.text).filter(Boolean)).toEqual(['discard', 'new branch'])
  })

  it('keeps a microcompacted result removed when an older branch is restored', () => {
    const state = foldState([
      { ...human(0, 'hello'), uuid: 'u1', parentUuid: null },
      { ...assistantBlock(2, { requestId: 'r1', index: 0, block: { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } } }), parentUuid: 'u1' },
      { ...toolResult(4, 'c1'), uuid: 'result', parentUuid: 'a-2' },
      { ...human(5, 'later'), uuid: 'u2', parentUuid: 'result' },
      { type: 'system', uuid: 'micro', parentUuid: 'u2', subtype: 'microcompact_boundary', microcompactMetadata: { compactedToolIds: ['c1'] } },
      { ...human(6, 'new branch'), uuid: 'u3', parentUuid: 'result' },
    ])
    const texts = state.surface.map(node => node.text).filter(Boolean)
    expect(texts).not.toContain('ok')
    expect(texts).not.toContain('later')
    expect(texts).toContain('hello')
    expect(texts.at(-1)).toBe('new branch')
  })

  it('microcompact_boundary drops the compacted tool result from the live surface', () => {
    const state = foldState([
      human(0, 'hello'),
      assistantBlock(2, {
        requestId: 'r1', index: 0,
        block: { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      }),
      { ...toolResult(4, 'c1'), uuid: 'r-4', parentUuid: 'a-2' },
      {
        type: 'system', uuid: 'b', timestamp: at(5), subtype: 'microcompact_boundary', parentUuid: 'r-4',
        microcompactMetadata: {
          trigger: 'auto', preTokens: 2_000, tokensSaved: 500,
          compactedToolIds: ['c1'], clearedAttachmentUUIDs: [],
        },
      },
    ])
    const texts = state.surface.map(node => node.text)
    expect(texts).toContain('hello')
    expect(texts).not.toContain('ok')
  })
})
