/**
 * Grok Build synthesizer — synthetic fixtures only.
 *
 * Every record below is hand-written with the REAL grok wire field names
 * (`sessionUpdate`, `toolCallId`, `_meta["x.ai/tool"]`, `cachedReadTokens`,
 * `costUsdTicks`, …) and fake payloads ("hello", `/work/a.ts`). No transcript
 * content is copied here. The envelope `timestamp` is epoch SECONDS and
 * `params._meta.agentTimestampMs` is epoch MILLISECONDS, exactly as grok writes
 * them (GROK-FORMAT §C.1).
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { GROK_SIDECAR_METHOD } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import type { ContentBlock, TimelineEvent } from '../../src/fold/event.ts'
import type { GrokUsage, TurnStepUsageInput } from '../../src/synth/grok.ts'
import { apportionTurnUsage, createGrokSynthesizer } from '../../src/synth/grok.ts'

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

const SESSION_ID = '01a09b39-a469-7073-b766-83847750b352'
const CHILD_ID = '01a09b3a-1111-7000-8000-222233334444'
const PROMPT_ID = '2215e64f-d3a3-4e66-aff6-6ba9448d26d8'
const NEXT_PROMPT_ID = 'ad5fe32a-47b5-49a5-9c1c-2f62e544d19b'

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
/** Epoch MILLISECONDS `s` seconds into the fixture session. */
const ms = (s: number): number => T0 + s * 1000

const MAIN: SessionFileRef = {
  id: SESSION_ID,
  role: 'main',
  path: `/tmp/.grok/sessions/%2Fwork/${SESSION_ID}/updates.jsonl`,
}

interface Rec { [key: string]: unknown }

const envelope = (method: string, s: number, update: Rec, meta: Rec = {}): string => JSON.stringify({
  timestamp: Math.floor(ms(s) / 1000),
  method,
  params: {
    sessionId: SESSION_ID,
    update,
    _meta: { eventId: `${SESSION_ID}-${s}`, agentTimestampMs: ms(s), ...meta },
  },
})

/** ACP rail. */
const acp = (s: number, update: Rec, meta: Rec = {}): string =>
  envelope('session/update', s, update, meta)

/** xAI extension rail. */
const xai = (s: number, update: Rec, meta: Rec = {}): string =>
  envelope('_x.ai/session/update', s, update, meta)

const SYSTEM_TEXT = 'You are Grok Build, a coding agent. hello hello hello'

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
]

const sidecar = (s: number, summary: Rec = {}, rest: Rec = {}): string => JSON.stringify({
  timestamp: Math.floor(ms(s) / 1000),
  method: GROK_SIDECAR_METHOD,
  params: {
    sessionId: SESSION_ID,
    summary: {
      info: { cwd: '/work' },
      session_summary: 'Reading a file',
      created_at: '2026-01-01T12:00:00.000Z',
      current_model_id: 'grok-4.6',
      ...summary,
    },
    systemPrompt: SYSTEM_TEXT,
    toolDefinitions: TOOL_DEFINITIONS,
    ...rest,
  },
})

const prompt = (s: number, text: string, promptIndex: number): string => acp(s, {
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text },
  _meta: { modelId: 'grok-4.6', promptIndex },
})

const thought = (s: number, text: string, meta: Rec = {}): string => acp(
  s,
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
  { promptId: PROMPT_ID, ...meta },
)

const message = (s: number, text: string, meta: Rec = {}): string => acp(
  s,
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  { promptId: PROMPT_ID, ...meta },
)

const toolCall = (s: number, callId: string, update: Rec = {}, meta: Rec = {}): string => acp(s, {
  sessionUpdate: 'tool_call',
  toolCallId: callId,
  title: 'Read `/work/a.ts`',
  kind: 'other',
  status: 'in_progress',
  rawInput: { variant: 'ReadFile', target_file: '/work/a.ts' },
  ...update,
}, { promptId: PROMPT_ID, ...meta })

const toolCallUpdate = (s: number, callId: string, update: Rec, meta: Rec = {}): string =>
  acp(s, { sessionUpdate: 'tool_call_update', toolCallId: callId, ...update }, { promptId: PROMPT_ID, ...meta })

/** The canonical identity envelope, which lands on the FIRST `tool_call_update`. */
const readIdentity = (path = '/work/a.ts'): Rec => ({
  kind: 'read',
  title: `Read \`${path}\``,
  locations: [{ path }],
  rawInput: { variant: 'ReadFile', target_file: path },
  _meta: {
    'x.ai/tool': {
      version: 1,
      name: 'read_file',
      kind: 'read',
      namespace: 'grok_build',
      label: 'Read',
      read_only: true,
      input: { path },
    },
  },
})

/** Real `turn_completed.usage`: `cachedReadTokens` is PART OF `inputTokens`. */
const turnUsage = (rest: Rec = {}): Rec => ({
  inputTokens: 55_529,
  outputTokens: 717,
  totalTokens: 56_246,
  cachedReadTokens: 47_232,
  cacheCreationTokens: 0,
  reasoningTokens: 363,
  modelCalls: 3,
  apiDurationMs: 14_169,
  costUsdTicks: 151_340_800,
  modelUsage: {
    'grok-4.6-build': {
      inputTokens: 55_529, outputTokens: 717, totalTokens: 56_246, cachedReadTokens: 47_232,
      cacheCreationTokens: 0, reasoningTokens: 363, modelCalls: 3, costUsdTicks: 151_340_800,
    },
  },
  numTurns: 3,
  ...rest,
})

const turnCompleted = (s: number, promptId: string, update: Rec = {}): string => xai(s, {
  sessionUpdate: 'turn_completed',
  prompt_id: promptId,
  stop_reason: 'end_turn',
  usage: turnUsage(),
  elapsed_ms: 19_584,
  ...update,
})

/** Feed every line and collect the events, in order. */
function run(lines: readonly string[], file: SessionFileRef = MAIN): {
  events: TimelineEvent[]
  synth: ReturnType<typeof createGrokSynthesizer>
} {
  const synth = createGrokSynthesizer(file)
  const events: TimelineEvent[] = []
  for (const line of lines) events.push(...synth.push(line))
  return { events, synth }
}

const typesOf = (events: readonly TimelineEvent[]): string[] => events.map(e => e.type)
const firstOf = (events: readonly TimelineEvent[], type: string): TimelineEvent | undefined =>
  events.find(e => e.type === type)
const allOf = (events: readonly TimelineEvent[], type: string): TimelineEvent[] =>
  events.filter(e => e.type === type)
const dataOf = (event: TimelineEvent | undefined): Rec => (event?.data ?? {}) as Rec
const blocksOf = (event: TimelineEvent | undefined): ContentBlock[] => {
  const data = dataOf(event)
  const msg = data['message'] as { content?: ContentBlock[] } | undefined
  return msg?.content ?? (data['content'] as ContentBlock[] | undefined) ?? []
}
const sourceOf = (event: TimelineEvent | undefined): Rec => (dataOf(event)['source'] ?? {}) as Rec

/**
 * One complete, ordinary turn in the REAL record order: the canonical tool
 * identity arrives on the first `tool_call_update`, AFTER the `tool_call`.
 */
const TYPICAL_TURN: string[] = [
  sidecar(0),
  prompt(1, 'please read the file', 0),
  // `streamStartMs` + `totalTokens` are the per-model-call stamps every real
  // record carries: a new stream is a new model call, and the FIRST
  // `totalTokens` of a stream is that call's prompt size (20000, then 35529).
  thought(2, 'I should read it', { streamStartMs: ms(1.5), totalTokens: 20_000 }),
  message(3, 'Reading now.', { streamStartMs: ms(1.5), totalTokens: 20_400 }),
  toolCall(4, 'call-1'),
  toolCallUpdate(5, 'call-1', readIdentity()),
  toolCallUpdate(6, 'call-1', {
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'line one\nline two' } }],
    rawOutput: { type: 'ReadFile', Ok: 'line one\nline two' },
  }),
  message(7, 'The file has two lines.', { streamStartMs: ms(6.5), totalTokens: 35_529 }),
  turnCompleted(8, PROMPT_ID),
]

// -----------------------------------------------------------------------------

describe('grok synthesizer', () => {
  it('emits the documented event sequence for one ordinary turn', () => {
    const { events } = run(TYPICAL_TURN)
    expect(typesOf(events)).toEqual([
      'request/header',
      'request/context',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'step/end',
      'tool/result',
      'step/start',
      'assistant/message',
      'step/end',
    ])
  })

  it('keeps the seqs strictly increasing and never throws on malformed input', () => {
    const { events } = run([
      '',
      'not json',
      '{"method":',
      '{"timestamp":1,"method":"session/update","params":"nope"}',
      ...TYPICAL_TURN,
      JSON.stringify({ timestamp: 1, method: 'session/update', params: { update: { sessionUpdate: 'who_knows' } } }),
    ])
    const seqs = events.map(e => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('carries the sidecar system prompt and tool schemas in ONE initial header', () => {
    const { events } = run(TYPICAL_TURN)
    const headers = allOf(events, 'request/header')
    expect(headers).toHaveLength(1)
    const header = dataOf(headers[0])['header'] as Rec
    expect(header['system']).toBe(SYSTEM_TEXT)
    expect(header['tools']).toEqual(TOOL_DEFINITIONS)
    expect(header['config']).toEqual({ model: 'grok-4.6', provider: 'xai' })
    expect(dataOf(headers[0])['reason']).toBe('initial')
  })

  it('folds without a sidecar and assumes the 500k window at the first human prompt', () => {
    const { events, synth } = run(TYPICAL_TURN.slice(1))
    expect(allOf(events, 'request/header')).toHaveLength(0)
    const context = firstOf(events, 'request/context')
    expect(dataOf(context)).toEqual({ contextWindow: 500_000, model: 'grok-4.6', provider: 'xai' })
    // The assumed window lands with (not before) the first prompt.
    expect(typesOf(events).indexOf('request/context')).toBeLessThan(typesOf(events).indexOf('user/message'))
    expect(synth.meta().contextWindow).toBe(500_000)
  })

  it('re-emits request/context when a compaction reports the real window', () => {
    const { events, synth } = run([
      ...TYPICAL_TURN,
      xai(9, {
        sessionUpdate: 'auto_compact_started',
        tokens_used: 425_228, context_window: 262_144, percentage: 85, reason: 'Context window 85% full',
      }),
    ])
    const windows = allOf(events, 'request/context').map(e => dataOf(e)['contextWindow'])
    expect(windows).toEqual([500_000, 262_144])
    expect(synth.meta().contextWindow).toBe(262_144)
  })

  it('does not repeat request/context when nothing changed', () => {
    const { events } = run([...TYPICAL_TURN, prompt(9, 'again', 1)])
    expect(allOf(events, 'request/context')).toHaveLength(1)
  })

  it('opens one assistant/message per model call with turn and step numbers', () => {
    const { events } = run(TYPICAL_TURN)
    const assistants = allOf(events, 'assistant/message')
    expect(assistants).toHaveLength(2)
    expect([dataOf(assistants[0])['turn'], dataOf(assistants[0])['step']]).toEqual([1, 1])
    expect([dataOf(assistants[1])['turn'], dataOf(assistants[1])['step']]).toEqual([1, 2])
    // Chunks are debounced BLOCKS: one reasoning block, one text block, then
    // the tool call that sealed the step.
    expect(blocksOf(assistants[0]).map(b => b.type)).toEqual(['reasoning', 'text', 'tool-call'])
    expect(blocksOf(assistants[0])[0]?.text).toBe('I should read it')
    expect(blocksOf(assistants[1])).toEqual([{ type: 'text', text: 'The file has two lines.' }])
  })

  it('concatenates consecutive chunks of a kind into one block, in file order', () => {
    const { events } = run([
      prompt(1, 'hi', 0),
      thought(2, 'first '),
      thought(3, 'second'),
      message(4, 'answer '),
      message(5, 'tail'),
      turnCompleted(6, PROMPT_ID, { usage: undefined }),
    ])
    const blocks = blocksOf(firstOf(events, 'assistant/message'))
    expect(blocks).toEqual([
      { type: 'reasoning', text: 'first second' },
      { type: 'text', text: 'answer tail' },
    ])
  })

  it('reports the CANONICAL tool name on tool/call, not the display title', () => {
    const { events } = run(TYPICAL_TURN)
    const call = firstOf(events, 'tool/call')
    expect(dataOf(call)['name']).toBe('read_file')
    // The normalized `x.ai/tool.input` wins over the internal `rawInput` shape.
    expect(dataOf(call)['arguments']).toBe(JSON.stringify({ path: '/work/a.ts' }))
    expect(dataOf(call)['callId']).toBe('call-1')
    // ... and the assistant block that announced it agrees.
    const block = blocksOf(allOf(events, 'assistant/message')[0]).find(b => b.type === 'tool-call')
    expect(block?.name).toBe('read_file')
  })

  it('emits the tool/call before its tool/result even when the announcement was lost', () => {
    const { events } = run([
      prompt(1, 'hi', 0),
      // A truncated head: the terminal update is the FIRST record of this call.
      toolCallUpdate(2, 'call-x', {
        ...readIdentity(),
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      }),
      turnCompleted(3, PROMPT_ID, { usage: undefined }),
    ])
    const order = typesOf(events)
    expect(order.indexOf('tool/call')).toBeLessThan(order.indexOf('tool/result'))
  })

  it('flags a failed tool result and still books its read against the file it named', () => {
    const { events } = run([
      prompt(1, 'hi', 0),
      toolCall(2, 'call-e'),
      toolCallUpdate(3, 'call-e', readIdentity('/work/missing')),
      toolCallUpdate(4, 'call-e', {
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Error: not a file.' } }],
        rawOutput: { type: 'ReadFile', IsADirectory: 'Error: not a file.' },
      }),
      turnCompleted(5, PROMPT_ID, { usage: undefined }),
    ])
    const result = firstOf(events, 'tool/result')
    expect(dataOf(result)['error']).toBe(true)
    const inner = blocksOf(result)[0]
    expect(inner?.isError).toBe(true)
    expect(inner?.content?.[0]?.text).toBe('Error: not a file.')
    // A failed read still names the file it tried: the row is booked and the
    // fold marks it errored (no diff block, so no write is invented).
    expect(dataOf(result)['fileOps']).toEqual([{ kind: 'read', path: '/work/missing' }])
  })

  it('derives read file ops from kind + locations', () => {
    const { events } = run(TYPICAL_TURN)
    expect(dataOf(firstOf(events, 'tool/result'))['fileOps']).toEqual([
      { kind: 'read', path: '/work/a.ts' },
    ])
  })

  it('derives write file ops with real line deltas from diff content blocks', () => {
    const { events } = run([
      prompt(1, 'edit it', 0),
      toolCall(2, 'call-w', { title: 'Edit `/work/a.ts`' }),
      toolCallUpdate(3, 'call-w', {
        kind: 'edit',
        locations: [{ path: '/work/a.ts' }],
        _meta: { 'x.ai/tool': { version: 1, name: 'edit_file', kind: 'edit', label: 'Edit', input: { path: '/work/a.ts' } } },
      }),
      toolCallUpdate(4, 'call-w', {
        status: 'completed',
        content: [{
          type: 'diff',
          path: '/work/a.ts',
          oldText: 'one\ntwo',
          newText: 'one\ntwo\nthree',
          _meta: { old_line: 1, new_line: 1 },
        }],
      }),
      turnCompleted(5, PROMPT_ID, { usage: undefined }),
    ])
    const result = firstOf(events, 'tool/result')
    expect(dataOf(result)['fileOps']).toEqual([
      { kind: 'write', path: '/work/a.ts', added: 3, removed: 2 },
    ])
    expect(blocksOf(result)[0]?.content?.[0]?.text).toBe('--- /work/a.ts\none\ntwo → one\ntwo\nthree')
  })

  it('books no file op for an execute or search call', () => {
    const { events } = run([
      prompt(1, 'run it', 0),
      toolCall(2, 'call-b', { title: 'Execute ...' }),
      toolCallUpdate(3, 'call-b', {
        kind: 'execute',
        locations: [{ path: '/work' }],
        _meta: { 'x.ai/tool': { version: 1, name: 'bash', kind: 'execute', label: 'Execute', input: { command: 'ls' } } },
      }),
      toolCallUpdate(4, 'call-b', {
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'a.ts' } }],
      }),
      turnCompleted(5, PROMPT_ID, { usage: undefined }),
    ])
    expect(dataOf(firstOf(events, 'tool/result'))['fileOps']).toBeUndefined()
  })

  it('apportions the turn usage across its model calls on the stamped prompt sizes', () => {
    const { events } = run(TYPICAL_TURN)
    const [first, last] = allOf(events, 'assistant/message')
    // The turn reports the SUM over its calls; the stamps say the two calls
    // went out with 20000 and 35529 tokens of prompt (= the wire inputTokens).
    expect(dataOf(first)['usage']).toEqual({
      inputTokens: 20_000 - 17_011,
      cacheReadTokens: 17_011,
      cacheWriteTokens: 0,
      // Output follows the characters each call emitted (49 of 72 here).
      outputTokens: 487,
    })
    expect(dataOf(last)['usage']).toEqual({
      inputTokens: 35_529 - 30_221,
      cacheReadTokens: 30_221,
      cacheWriteTokens: 0,
      outputTokens: 230,
    })
    // Current Context reads the LAST call's prompt, not the turn's sum.
    const prompt = (event: TimelineEvent | undefined): number => {
      const usage = dataOf(event)['usage'] as Record<string, number>
      return usage['inputTokens']! + usage['cacheReadTokens']! + usage['cacheWriteTokens']!
    }
    expect(prompt(last)).toBe(35_529)
  })

  it('keeps the apportioned shares summing to the turn usage in every field', () => {
    const { events } = run(TYPICAL_TURN)
    const usages = allOf(events, 'assistant/message')
      .map(e => dataOf(e)['usage'] as Record<string, number>)
    const sum = (field: string): number => usages.reduce((total, u) => total + (u[field] ?? 0), 0)
    // The cached share is a SUBSET of the wire input, so the buckets are
    // disjoint — and the cost rollup is bit-for-bit the turn's own figure.
    expect(sum('inputTokens')).toBe(55_529 - 47_232)
    expect(sum('cacheReadTokens')).toBe(47_232)
    expect(sum('cacheWriteTokens')).toBe(0)
    expect(sum('outputTokens')).toBe(717)
  })

  it('books nothing for a turn the transcript never terminated', () => {
    // No `turn_completed`: a new prompt releases the abandoned turn's events,
    // and no usage is invented for a request no record ever billed.
    const { events } = run([...TYPICAL_TURN.slice(0, -1), prompt(9, 'never mind', 1)])
    const usages = allOf(events, 'assistant/message').map(e => dataOf(e)['usage'])
    expect(usages).toEqual([undefined, undefined])
    // ... and the events still reach the fold, in order.
    expect(typesOf(events).filter(t => t === 'assistant/message')).toHaveLength(2)
    expect(events.map(e => e.seq)).toEqual([...events.map(e => e.seq)].sort((a, b) => a - b))
  })

  it('clamps the uncached input at zero and never adds the reasoning subset', () => {
    const { events } = run([
      prompt(1, 'hi', 0),
      message(2, 'ok'),
      turnCompleted(3, PROMPT_ID, {
        usage: {
          inputTokens: 100, cachedReadTokens: 90, cacheCreationTokens: 40,
          outputTokens: 60, reasoningTokens: 50, totalTokens: 160,
        },
      }),
    ])
    expect(dataOf(firstOf(events, 'assistant/message'))['usage']).toEqual({
      inputTokens: 0, cacheReadTokens: 90, cacheWriteTokens: 40, outputTokens: 60,
    })
  })

  it('books the usage onto the turn\'s calls even when it ended on a tool result', () => {
    const { events } = run([
      prompt(1, 'hi', 0),
      toolCall(2, 'call-1'),
      toolCallUpdate(3, 'call-1', {
        ...readIdentity(),
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      }),
      turnCompleted(4, PROMPT_ID),
    ])
    // The call had already folded when the terminator landed; because the turn
    // is buffered, its usage still reaches the request record it belongs to.
    const assistants = allOf(events, 'assistant/message')
    expect(assistants).toHaveLength(1)
    expect(dataOf(assistants[0])['usage']).toEqual({
      inputTokens: 55_529 - 47_232, cacheReadTokens: 47_232, cacheWriteTokens: 0, outputTokens: 717,
    })
  })

  it('books a usage-only assistant/message when the turn settled no model call at all', () => {
    const { events } = run([
      prompt(1, 'hi', 0),
      turnCompleted(2, PROMPT_ID),
    ])
    const assistants = allOf(events, 'assistant/message')
    expect(assistants).toHaveLength(1)
    expect(blocksOf(assistants[0])).toEqual([])
    expect(dataOf(assistants[0])['usage']).toBeDefined()
  })

  it('sums reportedCostUsd over the turns that reported ticks, skipping the ones that did not', () => {
    const { synth } = run([
      sidecar(0),
      prompt(1, 'one', 0),
      message(2, 'a'),
      turnCompleted(3, PROMPT_ID),
      prompt(4, 'two', 1),
      message(5, 'b', { promptId: NEXT_PROMPT_ID }),
      // An ABSENT `costUsdTicks` is "unknown", never "free": this turn adds 0.
      xai(6, {
        sessionUpdate: 'turn_completed',
        prompt_id: NEXT_PROMPT_ID,
        stop_reason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedReadTokens: 0, cacheCreationTokens: 0 },
      }),
    ])
    expect(synth.meta().reportedCostUsd).toBeCloseTo(151_340_800 / 1e10, 10)
  })

  it('leaves reportedCostUsd absent when no turn reported a trustworthy figure', () => {
    const { synth } = run([
      prompt(1, 'one', 0),
      message(2, 'a'),
      turnCompleted(3, PROMPT_ID, { usage: turnUsage({ usageIsIncomplete: true }) }),
    ])
    expect(synth.meta().reportedCostUsd).toBeUndefined()
    expect(synth.meta().version).toBeUndefined()
  })

  it('classifies human, slash, interjection and injected chunks structurally', () => {
    const { events } = run([
      acp(1, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'environment preamble' },
      }),
      acp(2, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '/statusline', _meta: { displayText: '/statusline', displayAsSkill: true } },
        _meta: { modelId: 'grok-4.6', promptIndex: 0 },
      }),
      acp(3, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '<frame>steer</frame>', _meta: { interjection: true, displayText: 'steer' } },
      }),
      acp(4, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'relayed', _meta: { hostTurn: true } },
      }),
    ])
    const users = allOf(events, 'user/message')
    expect(users).toHaveLength(4)
    expect(sourceOf(users[0])).toEqual({ kind: 'preamble', form: 'context' })
    // A typed slash command is a HUMAN prompt, so it stays in the user bucket.
    expect(sourceOf(users[1])).toEqual({ kind: 'user' })
    expect(blocksOf(users[1])).toEqual([{ type: 'text', text: '/statusline' }])
    // An interjection is human too, and shows the TYPED text, not the frame.
    expect(sourceOf(users[2])).toEqual({ kind: 'user' })
    expect(blocksOf(users[2])).toEqual([{ type: 'text', text: 'steer' }])
    expect(sourceOf(users[3])).toEqual({ kind: 'host-turn', form: 'relay' })
  })

  it('opens a new turn per prompt but not for an interjection', () => {
    const { events } = run([
      prompt(1, 'first', 0),
      message(2, 'a'),
      acp(3, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'wait', _meta: { interjection: true } },
      }),
      message(4, 'b'),
      prompt(5, 'second', 1),
      message(6, 'c'),
      turnCompleted(7, PROMPT_ID, { usage: undefined }),
    ])
    const turns = allOf(events, 'assistant/message').map(e => [dataOf(e)['turn'], dataOf(e)['step']])
    expect(turns).toEqual([[1, 1], [1, 2], [2, 1]])
  })

  it('attributes a recorded first-token instant through the embedded stream', () => {
    const { events } = run(TYPICAL_TURN)
    const first = allOf(events, 'assistant/message')[0]
    const stream = dataOf(first)['stream'] as { time: number; chunk: { type: string } }[]
    // `streamStartMs` opened the call at 1.5s; the first thought landed at 2s.
    expect(firstOf(events, 'step/start')?.time).toBe(ms(1.5))
    expect(stream[0]?.chunk.type).toBe('text-delta')
    expect(stream[0]?.time).toBe(ms(2))
    expect(stream.slice(1).map(c => c.chunk.type)).toEqual(['block-start', 'block-start', 'block-start'])
  })

  it('invents no stream for a step that produced no chunk', () => {
    const { events } = run([
      prompt(1, 'hi', 0),
      toolCall(2, 'call-1'),
      toolCallUpdate(3, 'call-1', { ...readIdentity(), status: 'completed', content: [] }),
      turnCompleted(4, PROMPT_ID, { usage: undefined }),
    ])
    expect(dataOf(firstOf(events, 'assistant/message'))['stream']).toBeUndefined()
  })

  it('opens no step for an empty chunk and so invents no request', () => {
    const { events } = run([
      sidecar(0),
      prompt(1, 'hi', 0),
      // An empty debounced block is not a response; the turn terminator finds
      // no open step and (with no usage) books nothing.
      acp(2, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }, { promptId: PROMPT_ID }),
      turnCompleted(3, PROMPT_ID, { usage: undefined }),
    ])
    expect(typesOf(events)).toEqual(['request/header', 'request/context', 'user/message'])
  })

  it('shadows every live seq on a compaction and claims the range with the summary', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      xai(9, {
        sessionUpdate: 'auto_compact_started',
        tokens_used: 425_228, context_window: 500_000, percentage: 85, reason: 'Context window 85% full',
      }),
      xai(10, {
        sessionUpdate: 'auto_compact_completed',
        tokens_before: 425_228, tokens_after: 7762, elapsed_ms: 150_802, summary_preview: 'we read a file',
      }),
    ])
    const summary = firstOf(events, 'compaction/summary')
    const surfaces = events.filter(e => ['user/message', 'assistant/message', 'tool/result'].includes(e.type))
    const before = surfaces.filter(e => e.seq < (summary?.seq ?? 0)).map(e => e.seq)
    expect(dataOf(summary)['shadowedSeqs']).toEqual(before)
    expect(dataOf(summary)['shadowedTokenCount']).toBe(425_228)
    const marker = events.filter(e => e.type === 'user/message').at(-1)
    expect(blocksOf(marker)).toEqual([{ type: 'text', text: 'we read a file' }])
    expect(sourceOf(marker)).toEqual({ kind: 'plugin', form: 'compaction', plugin: 'compaction' })
    expect(marker?.surfaceOp).toEqual({
      op: 'replace',
      startSeq: Math.min(...before),
      endSeq: Math.max(...before),
    })
  })

  it('does not double the compaction when the checkpoint marker follows the pair', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      xai(9, { sessionUpdate: 'auto_compact_started', tokens_used: 100, context_window: 500_000, percentage: 85, reason: 'x' }),
      xai(10, { sessionUpdate: 'auto_compact_completed', tokens_before: 100, tokens_after: 10, elapsed_ms: 5, summary_preview: null }),
      xai(11, {
        sessionUpdate: 'compaction_checkpoint',
        checkpoint_id: '71f70582-90c1-4e5f-8834-9b526a45f0e5',
        prompt_index_at_compaction: 0,
        checkpoint_file: 'compaction_checkpoints/71f70582.json',
        schema_version: 1,
        created_at: '2026-01-01T12:00:11.000Z',
      }),
    ])
    expect(allOf(events, 'compaction/summary')).toHaveLength(1)
  })

  it('claims the surface from a bare compaction_checkpoint (a manual /compact)', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      xai(9, {
        sessionUpdate: 'compaction_checkpoint',
        checkpoint_id: 'c1', prompt_index_at_compaction: 0,
        checkpoint_file: 'compaction_checkpoints/c1.json', schema_version: 1,
        created_at: '2026-01-01T12:00:09.000Z',
      }),
    ])
    expect(allOf(events, 'compaction/summary')).toHaveLength(1)
    expect(blocksOf(events.filter(e => e.type === 'user/message').at(-1))).toEqual([])
  })

  it('claims nothing when the compaction failed or was cancelled', () => {
    const { events } = run([
      ...TYPICAL_TURN,
      xai(9, { sessionUpdate: 'auto_compact_started', tokens_used: 100, context_window: 500_000, percentage: 85, reason: 'x' }),
      xai(10, { sessionUpdate: 'auto_compact_failed', error: 'summarizer unavailable' }),
      xai(11, { sessionUpdate: 'auto_compact_cancelled', reason: 'user_cancelled' }),
    ])
    expect(allOf(events, 'compaction/summary')).toHaveLength(0)
  })

  it('logs the plan-mode tool calls as plan/mode toggles', () => {
    const { events } = run([
      prompt(1, 'plan it', 0),
      toolCall(2, 'call-p', {
        title: 'Enter plan mode',
        rawInput: {},
        _meta: { 'x.ai/tool': { version: 1, name: 'enter_plan_mode', kind: 'other', label: 'Plan', input: {} } },
      }),
      toolCall(3, 'call-q', {
        title: 'Exit plan mode',
        rawInput: {},
        _meta: { 'x.ai/tool': { version: 1, name: 'exit_plan_mode', kind: 'other', label: 'Plan', input: {} } },
      }),
      turnCompleted(4, PROMPT_ID, { usage: undefined }),
    ])
    expect(allOf(events, 'plan/mode').map(e => dataOf(e)['active'])).toEqual([true, false])
  })

  it('records a spawned subagent and binds it to the task call of the same turn', () => {
    const { synth } = run([
      prompt(1, 'spawn one', 0),
      toolCall(2, 'call-t', {
        title: 'Spawn subagent',
        rawInput: { variant: 'Task' },
        _meta: {
          'x.ai/tool': {
            version: 1, name: 'spawn_subagent', kind: 'other', label: 'Task',
            input: { prompt: 'go', description: 'survey the repo', subagent_type: 'explore' },
          },
        },
      }),
      xai(3, {
        sessionUpdate: 'subagent_spawned',
        subagent_id: CHILD_ID,
        parent_session_id: SESSION_ID,
        child_session_id: CHILD_ID,
        subagent_type: 'explore',
        description: 'survey the repo',
      }),
      xai(4, {
        sessionUpdate: 'subagent_finished',
        subagent_id: CHILD_ID,
        status: 'completed',
        tool_calls: 3, turns: 1, duration_ms: 2000, tokens_used: 40, will_wake: false,
      }),
    ])
    const child = synth.meta().children.get(CHILD_ID)
    expect(child).toMatchObject({
      key: CHILD_ID,
      label: 'survey the repo',
      agentType: 'explore',
      callId: 'call-t',
      startedAt: ms(3),
      completedAt: ms(4),
    })
  })

  it('disambiguates two spawns in one turn by their description', () => {
    const task = (s: number, callId: string, description: string): string => acp(s, {
      sessionUpdate: 'tool_call',
      toolCallId: callId,
      title: 'Task',
      rawInput: {},
      _meta: {
        'x.ai/tool': {
          version: 1, name: 'task', kind: 'other', label: 'Task',
          input: { prompt: 'go', description, subagent_type: 'general-purpose' },
        },
      },
    }, { promptId: PROMPT_ID })
    const { synth } = run([
      prompt(1, 'spawn two', 0),
      task(2, 'call-a', 'first job'),
      task(3, 'call-b', 'second job'),
      xai(4, {
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'child-b', parent_session_id: SESSION_ID, child_session_id: 'child-b',
        subagent_type: 'general-purpose', description: 'second job',
      }),
      xai(5, {
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'child-a', parent_session_id: SESSION_ID, child_session_id: 'child-a',
        subagent_type: 'general-purpose', description: 'first job',
      }),
    ])
    expect(synth.meta().children.get('child-b')?.callId).toBe('call-b')
    expect(synth.meta().children.get('child-a')?.callId).toBe('call-a')
  })

  it('reports running while a step or tool call is open, and quiet once both settle', () => {
    const synth = createGrokSynthesizer(MAIN)
    const feed = (line: string): void => { synth.push(line) }
    feed(sidecar(0))
    expect(synth.meta().running).toBe(false)
    feed(prompt(1, 'hi', 0))
    expect(synth.meta().running).toBe(false)
    feed(thought(2, 'thinking'))
    expect(synth.meta().running).toBe(true)
    feed(toolCall(3, 'call-1'))
    expect(synth.meta().running).toBe(true)
    feed(toolCallUpdate(4, 'call-1', {
      ...readIdentity(), status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    }))
    // The tool settled, but the TURN has not: its step is still buffered
    // waiting for the usage, which is open work (unit trap 7).
    expect(synth.meta().running).toBe(true)
    feed(message(5, 'done'))
    expect(synth.meta().running).toBe(true)
    feed(turnCompleted(6, PROMPT_ID))
    expect(synth.meta().running).toBe(false)
  })

  it('labels the file from summary.json, and from the first prompt without one', () => {
    expect(run(TYPICAL_TURN).synth.meta().label).toBe('Reading a file')
    expect(run(TYPICAL_TURN.slice(1)).synth.meta().label).toBe('please read the file')
    // A later sidecar replaces the title without creating a node.
    const { events, synth } = run([...TYPICAL_TURN, sidecar(9, { session_summary: 'A newer title' })])
    expect(synth.meta().label).toBe('A newer title')
    expect(allOf(events, 'request/header')).toHaveLength(1)
    // ... and `session_summary_generated` does the same on the wire.
    expect(run([
      ...TYPICAL_TURN,
      xai(9, { sessionUpdate: 'session_summary_generated', session_summary: 'Generated title' }),
    ]).synth.meta().label).toBe('Generated title')
  })

  it('reports the CATALOG model id so models.dev can price it', () => {
    // models.dev publishes `xai/grok-4.6`, never the `-build` billing spelling.
    const { synth } = run([
      sidecar(0, { current_model_id: 'grok-4.6-build' }),
      prompt(1, 'hi', 0),
    ])
    expect(synth.meta().model).toBe('grok-4.6')
    expect(synth.meta().provider).toBe('xai')
  })

  it('logs a model switch as a change header that repeats the system prompt', () => {
    const { events, synth } = run([
      ...TYPICAL_TURN,
      xai(9, { sessionUpdate: 'model_changed', model_id: 'grok-4.5', reasoning_effort: 'high' }),
    ])
    const headers = allOf(events, 'request/header')
    expect(headers).toHaveLength(2)
    expect(dataOf(headers[1])['reason']).toBe('change')
    const header = dataOf(headers[1])['header'] as Rec
    expect(header['system']).toBe(SYSTEM_TEXT)
    expect(header['config']).toEqual({ model: 'grok-4.5', provider: 'xai' })
    expect(synth.meta().model).toBe('grok-4.5')
  })

  it('takes a model_auto_switched target as the new model', () => {
    const { synth } = run([
      ...TYPICAL_TURN,
      xai(9, {
        sessionUpdate: 'model_auto_switched',
        previous_model_id: 'grok-4.6', new_model_id: 'grok-4.5', reason: 'rate limit',
      }),
    ])
    expect(synth.meta().model).toBe('grok-4.5')
  })

  it('ignores the records that are session notices rather than model context', () => {
    const { events } = run([
      sidecar(0),
      prompt(1, 'hi', 0),
      xai(2, { sessionUpdate: 'hook_execution', event_name: 'user_prompt_submit', tool_name: 'bash', runs: [] }),
      xai(2, { sessionUpdate: 'retry_state', type: 'retrying', error_type: 'context_length', message: 'too long' }),
      xai(2, { sessionUpdate: 'rewind_marker', target_prompt_index: 0, created_at: '2026-01-01T12:00:02.000Z' }),
      xai(2, { sessionUpdate: 'session_recap', summary: 'so far', auto: true }),
      xai(2, { sessionUpdate: 'task_backgrounded', tool_call_id: 'x', task_id: 't', command: 'sleep 1', cwd: '/work', output_file: '/tmp/o' }),
      acp(2, { sessionUpdate: 'plan', entries: [{ content: 'do it', priority: 'medium', status: 'pending' }] }),
      xai(2, { sessionUpdate: 'a_tag_from_the_future', whatever: true }),
    ])
    expect(typesOf(events)).toEqual(['request/header', 'request/context', 'user/message'])
  })

  it('folds a legacy envelope that carries no method key', () => {
    const { events } = run([
      JSON.stringify({
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'legacy prompt' },
          _meta: { modelId: 'grok-4.6', promptIndex: 0 },
        },
      }),
    ])
    expect(blocksOf(firstOf(events, 'user/message'))).toEqual([{ type: 'text', text: 'legacy prompt' }])
  })

  it('prefers a response_completed usage for its own call and apportions the rest', () => {
    const { events } = run([
      ...TYPICAL_TURN.slice(0, -1),
      // `ResponseUsage` is snake_case on the wire and its `input_tokens` is
      // already the UNCACHED share (unlike `PromptUsage.inputTokens`).
      xai(7.5, {
        sessionUpdate: 'response_completed',
        message_id: 'msg-1',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 30_000,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 40,
        },
      }),
      turnCompleted(8, PROMPT_ID),
    ])
    const [first, last] = allOf(events, 'assistant/message')
    // The record landed while the LAST call was open, so that call keeps its
    // own figure and the first call takes what is left of the turn.
    expect(dataOf(last)['usage']).toEqual({
      inputTokens: 1000, cacheReadTokens: 30_000, cacheWriteTokens: 0, outputTokens: 200,
    })
    const other = dataOf(first)['usage'] as Record<string, number>
    expect(other['cacheReadTokens']).toBe(47_232 - 30_000)
    expect(other['outputTokens']).toBe(717 - 200)
    expect((other['inputTokens'] ?? 0) + 1000).toBe(55_529 - 47_232)
  })

  it('folds a child transcript as a complete session of its own', () => {
    const CHILD: SessionFileRef = {
      id: CHILD_ID,
      role: 'child',
      path: `/tmp/.grok/sessions/%2Fwork/${CHILD_ID}/updates.jsonl`,
      parentId: SESSION_ID,
    }
    const { events, synth } = run(TYPICAL_TURN, CHILD)
    expect(allOf(events, 'assistant/message')).toHaveLength(2)
    expect(synth.meta().label).toBe('Reading a file')
    expect(synth.meta().children.size).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// The token algebra, on its own
// -----------------------------------------------------------------------------

const TURN: GrokUsage = {
  inputTokens: 8297, cacheReadTokens: 47_232, cacheWriteTokens: 0, outputTokens: 717,
}

const step = (over: Partial<TurnStepUsageInput> = {}): TurnStepUsageInput => ({
  stream: undefined, prompt: undefined, chars: 100, exact: undefined, ...over,
})

const totalOf = (shares: readonly (GrokUsage | undefined)[], field: keyof GrokUsage): number =>
  shares.reduce((sum, share) => sum + (share?.[field] ?? 0), 0)

describe('apportionTurnUsage', () => {
  it('sums to the turn usage in every field, whatever the weights', () => {
    const shares = apportionTurnUsage([
      step({ stream: 1, prompt: 195_856, chars: 7 }),
      step({ stream: 2, prompt: 197_724, chars: 1301 }),
      step({ stream: 3, prompt: 198_828, chars: 44 }),
      step({ stream: 4, prompt: 199_227, chars: 903 }),
    ], { inputTokens: 100_000, cacheReadTokens: 691_923, cacheWriteTokens: 0, outputTokens: 4211 })
    expect(totalOf(shares, 'inputTokens')).toBe(100_000)
    expect(totalOf(shares, 'cacheReadTokens')).toBe(691_923)
    expect(totalOf(shares, 'cacheWriteTokens')).toBe(0)
    expect(totalOf(shares, 'outputTokens')).toBe(4211)
    // Each call's billed prompt tracks the size it actually went out with, so
    // the LAST one — the Current Context reading — stays a single call's prompt.
    const promptOf = (share: GrokUsage | undefined): number =>
      (share?.inputTokens ?? 0) + (share?.cacheReadTokens ?? 0) + (share?.cacheWriteTokens ?? 0)
    // 199299 against a stamped 199227: the turn's own total is 0.04% off the
    // sum of the stamps, and that rounding rides along proportionally.
    expect(promptOf(shares.at(-1))).toBeGreaterThan(199_000)
    expect(promptOf(shares.at(-1))).toBeLessThan(199_500)
    expect(promptOf(shares[0])).toBeLessThan(promptOf(shares.at(-1) as GrokUsage))
  })

  it('splits evenly when the transcript stamped no prompt size', () => {
    const shares = apportionTurnUsage([step({ stream: 1 }), step({ stream: 2 })], TURN)
    expect(shares[0]?.cacheReadTokens).toBe(23_616)
    expect(shares[1]?.cacheReadTokens).toBe(23_616)
    expect(totalOf(shares, 'inputTokens')).toBe(TURN.inputTokens)
  })

  it('gives an unstamped call the average of the stamped ones', () => {
    const shares = apportionTurnUsage([
      step({ stream: 1, prompt: 100 }),
      step({ stream: 2 }),
      step({ stream: 3, prompt: 300 }),
    ], { inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 30 })
    // weights 100, 200 (the average), 300.
    expect(shares.map(share => share?.inputTokens)).toEqual([83, 166, 251])
    expect(totalOf(shares, 'inputTokens')).toBe(500)
  })

  it('treats consecutive steps of one stream as ONE request', () => {
    // A model call that resumed chunking after a tool call folds as two steps;
    // only one of them is a request, so only one carries usage.
    const shares = apportionTurnUsage([
      step({ stream: 7, prompt: 4000, chars: 10 }),
      step({ stream: 7, prompt: 4000, chars: 90 }),
      step({ stream: 8, prompt: 6000, chars: 100 }),
    ], { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 })
    expect(shares[0]).toBeUndefined()
    expect(shares[1]?.inputTokens).toBe(4000)
    expect(shares[2]?.inputTokens).toBe(6000)
    // The group's own characters decide its output share: 100 of 200.
    expect(shares[1]?.outputTokens).toBe(100)
  })

  it('clamps a call whose cached share swallows its whole prompt', () => {
    const shares = apportionTurnUsage([
      step({ stream: 1, prompt: 10 }),
      step({ stream: 2, prompt: 990 }),
    ], { inputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 10 })
    expect(shares.every(share => (share?.inputTokens ?? 0) >= 0)).toBe(true)
    expect(totalOf(shares, 'inputTokens')).toBe(0)
    expect(totalOf(shares, 'cacheReadTokens')).toBe(1000)
  })

  it('keeps an exact per-call usage and apportions only the remainder', () => {
    const exact: GrokUsage = {
      inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 50,
    }
    const shares = apportionTurnUsage([
      step({ stream: 1, prompt: 3000, exact }),
      step({ stream: 2, prompt: 5000 }),
    ], { inputTokens: 3000, cacheReadTokens: 5000, cacheWriteTokens: 0, outputTokens: 150 })
    expect(shares[0]).toEqual(exact)
    expect(shares[1]).toEqual({
      inputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 0, outputTokens: 100,
    })
  })

  it('returns nothing for a turn that settled no step', () => {
    expect(apportionTurnUsage([], TURN)).toEqual([])
  })
})

