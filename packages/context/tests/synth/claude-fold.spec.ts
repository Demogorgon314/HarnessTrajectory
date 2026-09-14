/**
 * Claude synthesizer → fold, end to end: a synthetic session is pushed through
 * `createClaudeSynthesizer` and folded with `applyTimeline`, then read back
 * through `buildTimelineView`. Synthetic fixtures only — no transcript content.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import { applyTimeline, buildTimelineView, createTimelineState } from '../../src/fold/fold.ts'
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
        preservedMessages: { allUuids: ['a-14'], uuids: ['a-14'], anchorUuid: 'a-14' },
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
    expect(view.contextWindow).toBe(200_000)
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
