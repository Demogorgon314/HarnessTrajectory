/**
 * Claude Code synthesizer — synthetic fixtures only.
 *
 * Every record below is hand-written with the REAL Claude Code field names and
 * fake payloads ("hello", `/tmp/a.ts`). No transcript content is copied here.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import type { ContentBlock, TimelineEvent } from '../../src/fold/event.ts'
import { createClaudeSynthesizer } from '../../src/synth/claude.ts'

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

const T0 = Date.UTC(2025, 0, 1, 12, 0, 0)
/** ISO timestamp `s` seconds into the fixture session. */
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const MAIN: SessionFileRef = { id: 'sess-1', role: 'main', path: '/tmp/sess-1.jsonl' }
const CHILD: SessionFileRef = { id: 'agent-a1', role: 'child', path: '/tmp/agent-a1.jsonl', parentId: 'sess-1' }

interface Rec { [key: string]: unknown }

function human(s: number, text: string, extra: Rec = {}): Rec {
  return {
    type: 'user', uuid: `u-${s}`, timestamp: at(s), isSidechain: false, version: '2.1.270',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  }
}

function assistantBlock(s: number, opts: {
  requestId: string
  messageId?: string
  index: number
  block: Rec
  usage?: Rec
  model?: string
  stopReason?: string | null
  extra?: Rec
}): Rec {
  return {
    type: 'assistant', uuid: `a-${s}`, timestamp: at(s), isSidechain: false, version: '2.1.270',
    requestId: opts.requestId, apiBlockIndex: opts.index,
    message: {
      id: opts.messageId ?? `msg-${opts.requestId}`,
      role: 'assistant',
      model: opts.model ?? 'claude-opus-4',
      content: [opts.block],
      stop_reason: opts.stopReason === undefined ? 'tool_use' : opts.stopReason,
      usage: opts.usage ?? usage(100, 0, 0, 20),
    },
    ...opts.extra,
  }
}

function usage(input: number, cacheRead: number, cacheWrite: number, output: number): Rec {
  return {
    input_tokens: input,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
  }
}

const thinking = (text: string): Rec => ({ type: 'thinking', thinking: text })
const textBlock = (text: string): Rec => ({ type: 'text', text })
const toolUse = (id: string, name: string, input: Rec): Rec => ({ type: 'tool_use', id, name, input })

function toolResult(s: number, opts: {
  callId: string
  content?: unknown
  toolUseResult?: unknown
  isError?: boolean
}): Rec {
  return {
    type: 'user', uuid: `r-${s}`, timestamp: at(s), isSidechain: false,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: opts.callId,
        content: opts.content ?? 'ok',
        ...(opts.isError === true ? { is_error: true } : {}),
      }],
    },
    ...(opts.toolUseResult === undefined ? {} : { toolUseResult: opts.toolUseResult }),
  }
}

function attachment(s: number, body: Rec, rendered?: string[]): Rec {
  return {
    type: 'attachment', uuid: `t-${s}`, timestamp: at(s), isSidechain: false,
    attachment: body,
    ...(rendered === undefined ? {} : { rendered: rendered.map(content => ({ content })) }),
  }
}

function systemRecord(s: number, subtype: string, extra: Rec = {}): Rec {
  return { type: 'system', uuid: `s-${s}`, timestamp: at(s), isSidechain: false, subtype, ...extra }
}

/** Feed records to a fresh synthesizer and return every event it produced. */
function run(records: readonly (Rec | string)[], file: SessionFileRef = MAIN): TimelineEvent[] {
  const synth = createClaudeSynthesizer(file)
  const events: TimelineEvent[] = []
  for (const record of records) {
    events.push(...synth.push(typeof record === 'string' ? record : JSON.stringify(record)))
  }
  return events
}

/** Feed records and return both the events and the synthesizer (for `meta()`). */
function runWithMeta(records: readonly (Rec | string)[], file: SessionFileRef = MAIN) {
  const synth = createClaudeSynthesizer(file)
  const events: TimelineEvent[] = []
  for (const record of records) {
    events.push(...synth.push(typeof record === 'string' ? record : JSON.stringify(record)))
  }
  return { events, meta: synth.meta(), synth }
}

const types = (events: readonly TimelineEvent[]): string[] => events.map(event => event.type)
const only = (events: readonly TimelineEvent[], type: string): TimelineEvent[] =>
  events.filter(event => event.type === type)
const data = (event: TimelineEvent | undefined): Rec => (event?.data ?? {}) as Rec
const first = (events: readonly TimelineEvent[], type: string): TimelineEvent | undefined =>
  events.find(event => event.type === type)

/** A complete one-tool turn: prompt → thinking+tool_use response → result → text response. */
function typicalTurn(): Rec[] {
  return [
    human(0, 'hello'),
    assistantBlock(5, { requestId: 'r1', index: 0, block: thinking('hmm') }),
    assistantBlock(7, { requestId: 'r1', index: 1, block: toolUse('c1', 'Read', { file_path: '/tmp/a.ts' }) }),
    toolResult(9, {
      callId: 'c1',
      toolUseResult: { type: 'text', file: { filePath: '/tmp/a.ts', startLine: 1, numLines: 12, totalLines: 40 } },
    }),
    assistantBlock(12, {
      requestId: 'r2', index: 0, block: textBlock('done'), stopReason: 'end_turn',
      usage: usage(200, 1000, 50, 30),
    }),
    systemRecord(13, 'turn_duration', { durationMs: 13000 }),
  ]
}

// -----------------------------------------------------------------------------

describe('claude synthesizer — event sequence', () => {
  it('emits the documented order for a typical turn', () => {
    const events = run(typicalTurn())
    expect(types(events)).toEqual([
      'user/message',
      'step/start',
      'request/header',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
    ])
  })

  it('numbers seqs strictly increasing from 1', () => {
    const events = run(typicalTurn())
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1))
  })

  it('anchors step/start at the last input record and step/end at the last tool result', () => {
    const events = run(typicalTurn())
    const starts = only(events, 'step/start')
    const ends = only(events, 'step/end')
    expect(starts.map(event => event.time)).toEqual([T0 + 0, T0 + 9_000])
    expect(ends.map(event => event.time)).toEqual([T0 + 9_000, T0 + 12_000])
  })
})

describe('claude synthesizer — request grouping', () => {
  it('folds consecutive per-block records of one requestId into one assistant/message', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(5, { requestId: 'r1', index: 0, block: thinking('a') }),
      assistantBlock(6, { requestId: 'r1', index: 1, block: textBlock('b') }),
      assistantBlock(7, { requestId: 'r1', index: 2, block: toolUse('c1', 'Bash', { command: 'ls' }) }),
      toolResult(8, { callId: 'c1' }),
    ])
    const messages = only(events, 'assistant/message')
    expect(messages).toHaveLength(1)
    const message = data(messages[0]).message as { content: ContentBlock[] }
    expect(message.content.map(block => block.type)).toEqual(['reasoning', 'text', 'tool-call'])
    expect(messages[0]?.time).toBe(T0 + 7_000)
  })

  it('keeps the LAST usage of a group (output_tokens grows across block records)', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(5, { requestId: 'r1', index: 0, block: thinking('a'), usage: usage(10, 20, 30, 5) }),
      assistantBlock(6, { requestId: 'r1', index: 1, block: textBlock('b'), usage: usage(10, 20, 30, 77) }),
      human(9, 'next'),
    ])
    expect(data(first(events, 'assistant/message')).usage).toEqual({
      inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 77,
    })
  })

  it('carries the 1h share of cache_creation as its own bucket', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(5, {
        requestId: 'r1', index: 0, block: textBlock('a'), stopReason: 'end_turn',
        usage: {
          ...usage(10, 20, 30, 5),
          cache_creation: { ephemeral_1h_input_tokens: 25, ephemeral_5m_input_tokens: 5 },
        },
      }),
      human(9, 'next'),
    ])
    expect(data(first(events, 'assistant/message')).usage).toEqual({
      inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, cacheWrite1hTokens: 25, outputTokens: 5,
    })
  })

  it('omits the 1h bucket when the record carries no cache_creation breakdown', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(5, { requestId: 'r1', index: 0, block: textBlock('a'), stopReason: 'end_turn', usage: usage(10, 20, 30, 5) }),
      human(9, 'next'),
    ])
    expect(data(first(events, 'assistant/message')).usage).toEqual({
      inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 5,
    })
  })

  it('does not split a group on a non-null stop_reason', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(5, { requestId: 'r1', index: 0, block: thinking('a'), stopReason: 'tool_use' }),
      assistantBlock(6, { requestId: 'r1', index: 1, block: textBlock('b'), stopReason: 'tool_use' }),
      human(9, 'next'),
    ])
    expect(only(events, 'assistant/message')).toHaveLength(1)
  })

  it('starts a new group on a different requestId', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(5, { requestId: 'r1', index: 0, block: textBlock('a') }),
      assistantBlock(6, { requestId: 'r2', index: 0, block: textBlock('b') }),
      human(9, 'next'),
    ])
    expect(only(events, 'assistant/message')).toHaveLength(2)
    expect(only(events, 'step/start')).toHaveLength(2)
  })

  it('dedups usage when a requestId resumes after an interleaved tool result', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(5, { requestId: 'r1', index: 0, block: toolUse('c1', 'Bash', { command: 'ls' }) }),
      toolResult(6, { callId: 'c1' }),
      // Same API response resuming: the harness ran the tool eagerly.
      assistantBlock(7, { requestId: 'r1', index: 1, block: textBlock('b'), usage: usage(10, 0, 0, 40) }),
      human(9, 'next'),
    ])
    const messages = only(events, 'assistant/message')
    expect(messages).toHaveLength(2)
    expect(data(messages[0]).usage).toBeDefined()
    expect(data(messages[1]).usage).toBeUndefined()
    // The continuation keeps the original step number: it is ONE request.
    expect([data(messages[0]).step, data(messages[1]).step]).toEqual([1, 1])
    expect(only(events, 'step/start')).toHaveLength(1)
  })
})

describe('claude synthesizer — turn and step numbering', () => {
  it('increments the turn on every human prompt and the step per request', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', 'Bash', { command: 'ls' }) }),
      toolResult(3, { callId: 'c1' }),
      assistantBlock(4, { requestId: 'r2', index: 0, block: textBlock('a'), stopReason: 'end_turn' }),
      human(6, 'again'),
      assistantBlock(8, { requestId: 'r3', index: 0, block: textBlock('b'), stopReason: 'end_turn' }),
      systemRecord(9, 'turn_duration'),
    ])
    expect(only(events, 'assistant/message').map(event => [data(event).turn, data(event).step]))
      .toEqual([[1, 1], [1, 2], [2, 1]])
  })

  it('does not open a turn for injected user text', () => {
    const events = run([
      human(0, 'hello'),
      { ...human(1, '<command-name>/clear</command-name>'), uuid: 'inj-1' },
      assistantBlock(3, { requestId: 'r1', index: 0, block: textBlock('a'), stopReason: 'end_turn' }),
      systemRecord(4, 'turn_duration'),
    ])
    const injected = only(events, 'user/message')[1]
    expect((data(injected).source as Rec).kind).toBe('command-name')
    expect((data(injected).source as Rec).form).toBe('context')
    expect(data(first(events, 'assistant/message')).turn).toBe(1)
  })

  it('classifies an origin.kind other than human as injected', () => {
    const events = run([
      human(0, 'hello'),
      human(1, 'a task finished', { origin: { kind: 'task-notification' } }),
    ])
    const sources = only(events, 'user/message').map(event => (data(event).source as Rec).kind)
    expect(sources).toEqual(['user', 'task-notification'])
  })

  it('treats isMeta records as injected context', () => {
    const events = run([human(0, 'hello'), human(1, 'meta text', { isMeta: true })])
    expect((data(only(events, 'user/message')[1]).source as Rec).kind).toBe('meta')
  })
})

describe('claude synthesizer — the decode stream (TTFT)', () => {
  it('emits block-start chunks only, tiling from the step start by block completion', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(5, { requestId: 'r1', index: 0, block: thinking('a') }),
      assistantBlock(8, { requestId: 'r1', index: 1, block: textBlock('b') }),
      human(9, 'next'),
    ])
    expect(data(first(events, 'assistant/message')).stream).toEqual([
      { type: 'chunk', time: T0 + 0, chunk: { type: 'block-start', blockType: 'reasoning' } },
      { type: 'chunk', time: T0 + 5_000, chunk: { type: 'block-start', blockType: 'text' } },
    ])
  })

  it('never fabricates a token delta (first-token time is not recorded by this harness)', () => {
    const events = run(typicalTurn())
    for (const event of only(events, 'assistant/message')) {
      const stream = (data(event).stream ?? []) as { chunk: { type: string } }[]
      expect(stream.every(chunk => chunk.chunk.type === 'block-start')).toBe(true)
    }
  })
})

describe('claude synthesizer — tool calls and results', () => {
  it('emits assistant/message before its tool/call events (dsh order)', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', 'Bash', { command: 'ls' }) }),
      assistantBlock(3, { requestId: 'r1', index: 1, block: toolUse('c2', 'Bash', { command: 'pwd' }) }),
      toolResult(4, { callId: 'c1' }),
      toolResult(5, { callId: 'c2' }),
    ])
    expect(types(events).slice(2)).toEqual([
      'request/header', 'assistant/message', 'tool/call', 'tool/call',
      'tool/result', 'tool/result', 'step/end',
    ])
    expect(only(events, 'tool/call').map(event => data(event).callId)).toEqual(['c1', 'c2'])
    expect(data(only(events, 'tool/call')[0]).arguments).toBe('{"command":"ls"}')
  })

  it('pairs a tool/result to its call id and carries the error flag and meta', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', 'Bash', { command: 'ls' }) }),
      toolResult(4, { callId: 'c1', isError: true, toolUseResult: { stdout: '', stderr: 'boom' } }),
    ])
    const result = first(events, 'tool/result')
    const message = data(result).message as { content: ContentBlock[]; source: { callId: string } }
    expect(message.source.callId).toBe('c1')
    expect(message.content[0]?.type).toBe('tool-result')
    expect(message.content[0]?.toolCallId).toBe('c1')
    expect(message.content[0]?.isError).toBe(true)
    expect(data(result).error).toBe(true)
    expect(data(result).meta).toEqual({ stdout: '', stderr: 'boom' })
  })

  it('emits plan/mode for the plan-mode tools', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', 'ExitPlanMode', { plan: 'hi' }) }),
      toolResult(4, { callId: 'c1' }),
    ])
    expect(data(first(events, 'plan/mode')).active).toBe(false)
  })
})

describe('claude synthesizer — attachments', () => {
  it('turns prompt_snapshot into a request/header with system text and tool schemas', () => {
    const events = run([
      attachment(0, {
        type: 'prompt_snapshot',
        systemPrompt: ['you are', 'a helper'],
        tools: [{ name: 'Read', description: 'read a file', schema: { type: 'object' } }],
        cliPrefix: 'claude',
      }),
    ])
    const header = first(events, 'request/header')
    expect(data(header).reason).toBe('initial')
    const body = data(header).header as { system: string; tools: unknown[]; config: Rec }
    expect(body.system).toBe('you are\n\na helper')
    expect(body.tools).toEqual([{ name: 'Read', description: 'read a file', parameters: { type: 'object' } }])
    expect(body.config.provider).toBe('anthropic')
  })

  it('repeats the last tool list when a later prompt_snapshot carries none', () => {
    const events = run([
      attachment(0, { type: 'prompt_snapshot', systemPrompt: ['a'], tools: [{ name: 'Read', schema: {} }] }),
      attachment(1, { type: 'prompt_snapshot', systemPrompt: ['b'] }),
    ])
    const headers = only(events, 'request/header')
    expect(headers).toHaveLength(2)
    expect(data(headers[1]).reason).toBe('change')
    expect((data(headers[1]).header as { tools: unknown[] }).tools).toHaveLength(1)
    expect((data(headers[1]).header as { system: string }).system).toBe('b')
  })

  it('turns a model attachment into a change header repeating system and tools', () => {
    const events = run([
      attachment(0, { type: 'prompt_snapshot', systemPrompt: ['sys'], tools: [{ name: 'Read', schema: {} }] }),
      attachment(1, { type: 'model', identity: { modelId: 'claude-sonnet-9', marketingName: 'S', knowledgeCutoff: 'x' }, text: 'switched' }, ['switched']),
    ])
    const headers = only(events, 'request/header')
    expect(headers).toHaveLength(2)
    const body = data(headers[1]).header as { system: string; tools: unknown[]; config: Rec }
    expect(data(headers[1]).reason).toBe('change')
    expect(body.config.model).toBe('claude-sonnet-9')
    expect(body.system).toBe('sys')
    expect(body.tools).toHaveLength(1)
    // The model attachment is NOT also an inject node.
    expect(only(events, 'user/message')).toHaveLength(0)
  })

  it('synthesizes a change header when the response model differs from the last header', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: textBlock('a'), model: 'claude-opus-4', stopReason: 'end_turn' }),
      human(4, 'again'),
      assistantBlock(6, { requestId: 'r2', index: 0, block: textBlock('b'), model: 'claude-haiku-4', stopReason: 'end_turn' }),
      systemRecord(7, 'turn_duration'),
    ])
    const headers = only(events, 'request/header')
    expect(headers.map(event => (data(event).header as { config: Rec }).config.model))
      .toEqual(['claude-opus-4', 'claude-haiku-4'])
  })

  it('does not log a switch between a routed variant and its base model id', () => {
    const { events, meta } = runWithMeta([
      attachment(0, { type: 'model', identity: { modelId: 'claude-opus-5[1m]' }, text: 'routed' }, ['routed']),
      human(1, 'hello'),
      // Responses report the BASE id; the variant marker only rides the attachment.
      assistantBlock(3, { requestId: 'r1', index: 0, block: textBlock('a'), model: 'claude-opus-5', stopReason: 'end_turn' }),
      systemRecord(4, 'turn_duration'),
    ])
    expect(only(events, 'request/header')).toHaveLength(1)
    expect(meta.model).toBe('claude-opus-5[1m]')
    expect(meta.contextWindow).toBe(1_000_000)
  })

  it('injects rendered attachment text named by type', () => {
    const events = run([
      attachment(0, { type: 'total_tokens_reminder', text: 'x' }, ['token budget note']),
    ])
    const inject = first(events, 'user/message')
    expect((data(inject).content as ContentBlock[])[0]?.text).toBe('token budget note')
    expect(data(inject).source).toEqual({ kind: 'total_tokens_reminder', form: 'context', name: 'total_tokens_reminder' })
  })

  it('names file attachments by displayPath, instructions by path, hooks by hookName', () => {
    const events = run([
      attachment(0, { type: 'file', filename: 'a.ts', displayPath: 'src/a.ts', content: { type: 'text', file: {} } }, ['file body']),
      attachment(1, { type: 'instructions', files: [{ path: 'CLAUDE.md', type: 'md', content: 'x' }] }, ['instructions body']),
      attachment(2, { type: 'hook_success', hookName: 'format', toolUseID: 'c1', content: 'hook body', hookEvent: 'PostToolUse' }),
    ])
    const sources = only(events, 'user/message').map(event => data(event).source as Rec)
    expect(sources[0]).toMatchObject({ kind: 'file', name: 'src/a.ts', plugin: 'src/a.ts' })
    expect(sources[1]).toMatchObject({ kind: 'instructions', name: 'CLAUDE.md', plugin: 'CLAUDE.md' })
    expect(sources[2]).toMatchObject({ kind: 'hook_success', name: 'format', plugin: 'format' })
    // The hook attachment carries no `rendered` array: its own `content` is the text.
    expect((data(only(events, 'user/message')[2]).content as ContentBlock[])[0]?.text).toBe('hook body')
  })

  it('maps skill attachments into the fold skill vocabulary', () => {
    const events = run([
      attachment(0, { type: 'skill_listing', content: 'catalog', skillCount: 2, isInitial: true, names: ['a', 'b'] }, ['catalog']),
      attachment(1, { type: 'invoked_skills', skills: [{ name: 'dataviz', path: '/s', content: 'x' }] }, ['skill body']),
    ])
    const sources = only(events, 'user/message').map(event => data(event).source as Rec)
    expect(sources[0]).toEqual({ kind: 'skill-catalog', form: 'context', name: 'skills' })
    expect(sources[1]).toEqual({ kind: 'skill-invocation', form: 'context', name: 'dataviz' })
  })

  it('emits plan/mode false for plan_mode_exit', () => {
    const events = run([attachment(0, { type: 'plan_mode_exit', planFilePath: '/p', planExists: true }, ['exited'])])
    expect(types(events)).toEqual(['user/message', 'plan/mode'])
    expect(data(events[1]).active).toBe(false)
  })

  it('emits nothing for an attachment with no rendered text', () => {
    expect(run([attachment(0, { type: 'batching_reminder_sent' }, [''])])).toEqual([])
    expect(run([attachment(0, { type: 'deferred_tools_record', entries: [] })])).toEqual([])
  })
})

describe('claude synthesizer — compaction', () => {
  const boundary = (s: number, preserved: string[], extra: Rec = {}): Rec =>
    systemRecord(s, 'compact_boundary', {
      uuid: 'boundary-1',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 150_000,
        postTokens: 20_000,
        durationMs: 4200,
        cumulativeDroppedTokens: 90_000,
        preservedMessages: { allUuids: preserved, uuids: preserved, anchorUuid: preserved[0] ?? '' },
        preservedSegment: { anchorUuid: '', headUuid: '', tailUuid: '' },
        ...(extra as Rec),
      },
    })

  function compactionFixture(preserved: string[]): Rec[] {
    return [
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: textBlock('a'), stopReason: 'end_turn' }),
      human(4, 'again'),
      assistantBlock(6, { requestId: 'r2', index: 0, block: textBlock('b'), stopReason: 'end_turn' }),
      boundary(8, preserved),
      { ...human(9, 'summary of the session'), uuid: 'summary-1', isCompactSummary: true },
    ]
  }

  it('shadows every live node whose uuid is not preserved, then replaces the range', () => {
    const events = run(compactionFixture(['a-6']))
    const summary = first(events, 'compaction/summary')
    // Live surface nodes: u-0 (seq 1), a-2 assistant (seq 4), u-4 (seq 7), a-6 assistant (seq 9).
    // Only a-6 is preserved, so the first three are shadowed.
    expect(data(summary).shadowedSeqs).toEqual([1, 4, 6])
    expect(data(summary).shadowedTokenCount).toBe(130_000)

    const replacement = events[events.length - 1]
    expect(replacement?.type).toBe('user/message')
    expect(replacement?.surfaceOp).toEqual({ op: 'replace', startSeq: 1, endSeq: 6 })
    expect(data(replacement).source).toEqual({
      kind: 'plugin', form: 'compaction', plugin: 'compaction', compactionId: 'boundary-1',
    })
    expect(data(replacement).compaction).toEqual({
      trigger: 'auto', preTokens: 150_000, postTokens: 20_000, durationMs: 4200,
    })
  })

  it('places compaction/summary immediately before its replacement', () => {
    const events = run(compactionFixture([]))
    expect(types(events).slice(-2)).toEqual(['compaction/summary', 'user/message'])
  })

  it('falls back to cumulativeDroppedTokens when pre/post do not shrink', () => {
    const records = compactionFixture(['a-6'])
    records[4] = systemRecord(8, 'compact_boundary', {
      uuid: 'boundary-1',
      compactMetadata: {
        cumulativeDroppedTokens: 4321,
        preservedMessages: { allUuids: ['a-6'], uuids: ['a-6'], anchorUuid: 'a-6' },
      },
    })
    const events = run(records)
    expect(data(first(events, 'compaction/summary')).shadowedTokenCount).toBe(4321)
  })

  it('omits the surfaceOp when nothing was shadowed', () => {
    const events = run([
      boundary(0, []),
      { ...human(1, 'summary'), uuid: 'summary-1', isCompactSummary: true },
    ])
    expect(events[events.length - 1]?.surfaceOp).toBeUndefined()
  })
})

describe('claude synthesizer — file ops', () => {
  function opsOf(tool: string, input: Rec, toolUseResult: unknown): unknown {
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', tool, input) }),
      toolResult(4, { callId: 'c1', toolUseResult }),
    ])
    return data(first(events, 'tool/result')).fileOps
  }

  it('Read → a read op with the exact reported window', () => {
    expect(opsOf('Read', { file_path: '/tmp/a.ts' }, {
      type: 'text', file: { filePath: '/tmp/a.ts', content: 'x', startLine: 3, numLines: 12, totalLines: 40 },
    })).toEqual([{ kind: 'read', path: '/tmp/a.ts', added: 0, removed: 0, read: { start: 3, count: 12 } }])
  })

  it('Read of an image → a read op with no window', () => {
    expect(opsOf('Read', { file_path: '/tmp/a.png' }, {
      type: 'image',
      file: { type: 'image', base64: 'x', dimensions: { displayWidth: 100, displayHeight: 200, originalWidth: 1, originalHeight: 2 } },
    })).toEqual([{ kind: 'read', path: '/tmp/a.png', added: 0, removed: 0 }])
  })

  it('Edit → a write op counted off the structuredPatch hunks', () => {
    expect(opsOf('Edit', { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' }, {
      filePath: '/tmp/a.ts',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-gone', '+one', '+two'] }],
      userModified: false,
    })).toEqual([{ kind: 'write', path: '/tmp/a.ts', added: 2, removed: 1 }])
  })

  it('MultiEdit → a write op from the edit strings when no patch is recorded', () => {
    expect(opsOf('MultiEdit', {
      file_path: '/tmp/a.ts',
      edits: [{ old_string: 'a\nb', new_string: 'c\nd\ne' }, { old_string: 'x', new_string: 'y' }],
    }, { filePath: '/tmp/a.ts' })).toEqual([{ kind: 'write', path: '/tmp/a.ts', added: 4, removed: 3 }])
  })

  it('Write → a write op counting the written content', () => {
    expect(opsOf('Write', { file_path: '/tmp/a.ts', content: 'l1\nl2\n' }, { type: 'create', filePath: '/tmp/a.ts', content: 'l1\nl2\n', structuredPatch: [] }))
      .toEqual([{ kind: 'write', path: '/tmp/a.ts', added: 2, removed: 0 }])
  })

  it('NotebookEdit → a write op on the notebook path', () => {
    expect(opsOf('NotebookEdit', { notebook_path: '/tmp/a.ipynb', new_source: 'print(1)', edit_mode: 'replace' }, {}))
      .toEqual([{ kind: 'write', path: '/tmp/a.ipynb', added: 1, removed: 0 }])
  })

  it('Grep with a path → a search op plus one row per matched file', () => {
    expect(opsOf('Grep', { pattern: 'foo', path: '/tmp' }, { mode: 'files_with_matches', numFiles: 2, filenames: ['/tmp/a.ts', '/tmp/b.ts'] }))
      .toEqual([
        { kind: 'search', path: '/tmp', added: 0, removed: 0, detail: 'foo' },
        { kind: 'search', path: '/tmp/a.ts', added: 0, removed: 0, detail: 'foo' },
        { kind: 'search', path: '/tmp/b.ts', added: 0, removed: 0, detail: 'foo' },
      ])
  })

  it('Glob without a path → a pattern-marked search op', () => {
    expect(opsOf('Glob', { pattern: '**/*.ts' }, { filenames: [], numFiles: 0 }))
      .toEqual([{ kind: 'search', path: '**/*.ts', added: 0, removed: 0, pattern: true, detail: '**/*.ts' }])
  })

  it('Bash with a bashEditDiff → one write op per changed file', () => {
    expect(opsOf('Bash', { command: 'sed -i s/a/b/ /tmp/a.ts' }, {
      stdout: '', stderr: '', interrupted: false, isImage: false,
      bashEditDiff: {
        changedFiles: ['/tmp/a.ts'],
        moreFiles: 0,
        files: [{
          filePath: '/tmp/a.ts',
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }],
        }],
      },
    })).toEqual([{ kind: 'write', path: '/tmp/a.ts', added: 2, removed: 1 }])
  })

  it('Bash without a bashEditDiff and MCP tools produce no ops', () => {
    expect(opsOf('Bash', { command: 'ls' }, { stdout: 'a', stderr: '', interrupted: false, isImage: false }))
      .toBeUndefined()
    expect(opsOf('mcp__server__read_file', { file_path: '/tmp/a.ts' }, { file: { filePath: '/tmp/a.ts' } }))
      .toBeUndefined()
  })
})

describe('claude synthesizer — images', () => {
  it('prices a tool-result image at ceil(w*h/750)', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', 'Read', { file_path: '/tmp/a.png' }) }),
      toolResult(4, {
        callId: 'c1',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }],
        toolUseResult: {
          type: 'image',
          file: { type: 'image', base64: 'AAA', dimensions: { displayWidth: 300, displayHeight: 200, originalWidth: 900, originalHeight: 600 } },
        },
      }),
    ])
    const message = data(first(events, 'tool/result')).message as { content: ContentBlock[] }
    const image = message.content[0]?.content?.[0]
    expect(image).toEqual({ type: 'image', attachment: { width: 300, height: 200 }, tokens: 80 })
  })

  it('leaves a dimensionless image unpriced', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', 'Bash', { command: 'ls' }) }),
      toolResult(4, { callId: 'c1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }),
    ])
    const message = data(first(events, 'tool/result')).message as { content: ContentBlock[] }
    expect(message.content[0]?.content?.[0]).toEqual({ type: 'image' })
  })
})

describe('claude synthesizer — context window', () => {
  it('leaves an unrecorded window unknown', () => {
    const events = run(typicalTurn())
    const contexts = only(events, 'request/context')
    expect(contexts).toHaveLength(0)
  })

  it('does not infer a 1M window from a large prompt', () => {
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: textBlock('a'), usage: usage(10, 0, 0, 5), stopReason: 'end_turn' }),
      human(4, 'again'),
      assistantBlock(6, { requestId: 'r2', index: 0, block: textBlock('b'), usage: usage(100_000, 150_000, 0, 5), stopReason: 'end_turn' }),
      human(8, 'third'),
    ])
    expect(only(events, 'request/context')).toEqual([])
  })

  it('reads the 1M marker off the model id', () => {
    const { events, meta } = runWithMeta([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: textBlock('a'), model: 'claude-opus-5[1m]', stopReason: 'end_turn' }),
      systemRecord(3, 'turn_duration'),
    ])
    expect(data(first(events, 'request/context')).contextWindow).toBe(1_000_000)
    expect(meta.contextWindow).toBe(1_000_000)
  })
})

describe('claude synthesizer — meta', () => {
  it('records children from the Agent call and its agentId result', () => {
    const { meta } = runWithMeta([
      human(0, 'hello'),
      assistantBlock(2, {
        requestId: 'r1', index: 0,
        block: toolUse('c1', 'Agent', { description: 'check the docs', subagent_type: 'Explore', prompt: 'p', model: 'sonnet' }),
      }),
      toolResult(9, {
        callId: 'c1',
        toolUseResult: { agentId: 'a1', description: 'check the docs', resolvedModel: 'claude-sonnet-4', status: 'completed', isAsync: false },
      }),
    ])
    expect([...meta.children.values()]).toEqual([{
      key: 'a1',
      label: 'check the docs',
      agentType: 'Explore',
      model: 'claude-sonnet-4',
      callId: 'c1',
      startedAt: T0 + 2_000,
      completedAt: T0 + 9_000,
    }])
  })

  it('reports cost-state, version, model and provider', () => {
    const { meta } = runWithMeta([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: textBlock('a'), model: 'claude-opus-4', stopReason: 'end_turn' }),
      { type: 'cost-state', sessionId: 's', totalCostUSD: 1.25, totalDuration: 1, startTime: 0, modelUsage: {}, hasUnknownModelCost: false },
      { type: 'cost-state', sessionId: 's', totalCostUSD: 2.5, totalDuration: 2, startTime: 0, modelUsage: {}, hasUnknownModelCost: false },
    ])
    expect(meta.reportedCostUsd).toBe(2.5)
    expect(meta.version).toBe('2.1.270')
    expect(meta.model).toBe('claude-opus-4')
    expect(meta.provider).toBe('anthropic')
  })

  it('labels a main file with the ai-title, else the first human prompt', () => {
    expect(runWithMeta([human(0, 'first prompt here')]).meta.label).toBe('first prompt here')
    expect(runWithMeta([
      human(0, 'first prompt here'),
      { type: 'ai-title', aiTitle: 'Nice Title', sessionId: 's' },
    ]).meta.label).toBe('Nice Title')
  })

  it('labels a child file with its own first prompt and ignores ai-title order', () => {
    const child = runWithMeta([
      { ...human(0, 'do the child task'), isSidechain: true },
      { type: 'ai-title', aiTitle: 'Parent Title', sessionId: 's' },
    ], CHILD)
    expect(child.meta.label).toBe('do the child task')
  })

  it('reports running while a group is open or a call is unanswered', () => {
    const synth = createClaudeSynthesizer(MAIN)
    synth.push(JSON.stringify(human(0, 'hello')))
    expect(synth.meta().running).toBe(false)
    synth.push(JSON.stringify(assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', 'Bash', { command: 'ls' }) })))
    expect(synth.meta().running).toBe(true)
    synth.push(JSON.stringify(toolResult(4, { callId: 'c1' })))
    expect(synth.meta().running).toBe(false)
  })
})

/**
 * A transcript normally ENDS on the last block record of its last response —
 * no record follows to close the group — so an open group alone must not read
 * as "running" or every finished subagent pulses forever in the Agent Network.
 */
describe('claude synthesizer — running at end of file', () => {
  it('settles when the final block carries end_turn', () => {
    const { meta } = runWithMeta([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: textBlock('done'), stopReason: 'end_turn' }),
    ])
    expect(meta.running).toBe(false)
  })

  it('stays running when the final block is an unanswered tool_use', () => {
    const { meta } = runWithMeta([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', 'Bash', { command: 'ls' }), stopReason: 'tool_use' }),
    ])
    expect(meta.running).toBe(true)
  })

  it('settles once that tool call is answered and nothing follows', () => {
    const { meta } = runWithMeta([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: toolUse('c1', 'Bash', { command: 'ls' }), stopReason: 'tool_use' }),
      toolResult(4, { callId: 'c1' }),
    ])
    expect(meta.running).toBe(false)
  })

  it('stays running mid-response (stop_reason null)', () => {
    const { meta } = runWithMeta([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: thinking('still going'), stopReason: null }),
    ])
    expect(meta.running).toBe(true)
  })

  it('settles on a trailing turn_duration or cost-state record', () => {
    const tail = [
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: thinking('mid'), stopReason: null }),
    ]
    expect(runWithMeta([...tail, systemRecord(3, 'turn_duration')]).meta.running).toBe(false)
    const costed = runWithMeta([
      ...tail,
      { type: 'cost-state', sessionId: 's', totalCostUSD: 0.5, modelUsage: {}, hasUnknownModelCost: false },
    ])
    expect(costed.meta.running).toBe(false)
    // cost-state also flushes the response the transcript would otherwise end on.
    expect(types(costed.events)).toContain('assistant/message')
  })

  it('a settled group is still emitted whole when a later record closes it', () => {
    // `stop_reason` drives liveness only — it must never terminate the group.
    const events = run([
      human(0, 'hello'),
      assistantBlock(2, { requestId: 'r1', index: 0, block: thinking('a'), stopReason: 'tool_use' }),
      assistantBlock(3, { requestId: 'r1', index: 1, block: textBlock('b'), stopReason: 'end_turn' }),
      systemRecord(4, 'turn_duration'),
    ])
    expect(only(events, 'assistant/message')).toHaveLength(1)
  })
})

describe('claude synthesizer — robustness', () => {
  it('emits nothing for malformed or unknown lines and never throws', () => {
    const synth = createClaudeSynthesizer(MAIN)
    for (const line of ['', '   ', 'not json', '{', '[]', 'null', '"text"', '{"no":"type"}', '{"type":"mode","mode":"x"}']) {
      expect(synth.push(line)).toEqual([])
    }
    expect(synth.meta()).toMatchObject({ running: false })
  })

  it('tolerates an assistant record with no message and a user record with no content', () => {
    const events = run([
      { type: 'assistant', uuid: 'a', timestamp: at(1), requestId: 'r1' },
      { type: 'user', uuid: 'u', timestamp: at(2) },
    ])
    expect(types(events)).toEqual(['step/start', 'assistant/message', 'step/end', 'user/message'])
    expect((data(first(events, 'assistant/message')).message as { content: unknown[] }).content).toEqual([])
  })

  it('skips isSidechain records inside a MAIN transcript but keeps them in a child file', () => {
    const sidechain = [
      { ...human(0, 'child prompt'), isSidechain: true },
      { ...assistantBlock(2, { requestId: 'r1', index: 0, block: textBlock('a'), stopReason: 'end_turn' }), isSidechain: true },
      { ...systemRecord(3, 'turn_duration'), isSidechain: true },
    ]
    expect(run(sidechain, MAIN)).toEqual([])
    expect(types(run(sidechain, CHILD))).toContain('assistant/message')
  })

  it('falls back to the last seen time when a record has no timestamp', () => {
    const events = run([
      human(0, 'hello'),
      { type: 'assistant', uuid: 'a', requestId: 'r1', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'a' }], model: 'claude-opus-4' } },
      human(5, 'again'),
    ])
    expect(first(events, 'assistant/message')?.time).toBe(T0 + 0)
  })
})
