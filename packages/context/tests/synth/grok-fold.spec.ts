/**
 * Grok Build synthesizer → fold, end to end.
 *
 * Synthetic fixtures only (REAL grok wire field names, fake payloads, an epoch-
 * SECONDS envelope stamp beside the epoch-MILLISECONDS `_meta.agentTimestampMs`
 * grok actually writes). This spec proves the synthesizer's events are a valid
 * fold input: it feeds one session through `applyTimeline` and reads the
 * figures off `buildTimelineView`.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { GROK_SIDECAR_METHOD } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import { applyTimeline, buildTimelineView, createTimelineState } from '../../src/fold/fold.ts'
import type { Snapshot } from '../../src/shared/types.ts'
import { createGrokSynthesizer } from '../../src/synth/grok.ts'

const SESSION_ID = '01a09b39-a469-7073-b766-83847750b352'
const PROMPT_ID = '2215e64f-d3a3-4e66-aff6-6ba9448d26d8'
const NEXT_PROMPT_ID = 'ad5fe32a-47b5-49a5-9c1c-2f62e544d19b'

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
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

const acp = (s: number, update: Rec, meta: Rec = {}): string => envelope('session/update', s, update, meta)
const xai = (s: number, update: Rec, meta: Rec = {}): string => envelope('_x.ai/session/update', s, update, meta)

const SYSTEM_TEXT = 'You are Grok Build, a coding agent. '.repeat(20)

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk and return its contents.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the workspace.',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  },
]

const sidecar = (s: number, summary: Rec = {}): string => JSON.stringify({
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

const READ_IDENTITY: Rec = {
  kind: 'read',
  title: 'Read `/work/a.ts`',
  locations: [{ path: '/work/a.ts' }],
  rawInput: { variant: 'ReadFile', target_file: '/work/a.ts' },
  _meta: {
    'x.ai/tool': {
      version: 1, name: 'read_file', kind: 'read', namespace: 'grok_build',
      label: 'Read', read_only: true, input: { path: '/work/a.ts' },
    },
  },
}

const TURN_USAGE: Rec = {
  inputTokens: 4000, outputTokens: 200, totalTokens: 4200,
  cachedReadTokens: 3000, cacheCreationTokens: 0, reasoningTokens: 40,
  modelCalls: 2, apiDurationMs: 4000, costUsdTicks: 151_340_800,
  modelUsage: {
    'grok-4.6-build': {
      inputTokens: 4000, outputTokens: 200, totalTokens: 4200,
      cachedReadTokens: 3000, cacheCreationTokens: 0, reasoningTokens: 40,
      modelCalls: 2, costUsdTicks: 151_340_800,
    },
  },
  numTurns: 2,
}

/**
 * A two-turn session: an injected preamble, a prompt, a reasoning + text model
 * call that ends in a `read_file` tool call, its result, a closing model call
 * carrying the turn's usage, then a second prompt and response.
 */
const SESSION: string[] = [
  sidecar(0),
  acp(0, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'Environment: cwd /work, platform darwin.' },
  }),
  prompt(1, 'please read the file', 0),
  // Real records stamp both the model call (`streamStartMs`) and the running
  // context total; the FIRST total of a stream is that call's prompt size.
  thought(2, 'I should read it', { streamStartMs: ms(1.4), totalTokens: 1600 }),
  message(3, 'Reading now.', { streamStartMs: ms(1.4), totalTokens: 1700 }),
  acp(4, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read `/work/a.ts`',
    kind: 'other',
    status: 'in_progress',
    rawInput: { variant: 'ReadFile', target_file: '/work/a.ts' },
  }, { promptId: PROMPT_ID }),
  acp(5, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', ...READ_IDENTITY }, { promptId: PROMPT_ID }),
  acp(6, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'line one\nline two' } }],
    rawOutput: { type: 'ReadFile', Ok: 'line one\nline two' },
  }, { promptId: PROMPT_ID }),
  message(7, 'The file has two lines.', { streamStartMs: ms(6.5), totalTokens: 2400 }),
  xai(8, {
    sessionUpdate: 'turn_completed',
    prompt_id: PROMPT_ID,
    stop_reason: 'end_turn',
    usage: TURN_USAGE,
    elapsed_ms: 7000,
  }),
  prompt(9, 'and now the second question', 1),
  message(10, 'Here is the answer.', { promptId: NEXT_PROMPT_ID, streamStartMs: ms(9.5), totalTokens: 5000 }),
  xai(11, {
    sessionUpdate: 'turn_completed',
    prompt_id: NEXT_PROMPT_ID,
    stop_reason: 'end_turn',
    usage: {
      inputTokens: 5000, outputTokens: 80, totalTokens: 5080,
      cachedReadTokens: 4000, cacheCreationTokens: 0, reasoningTokens: 0, modelCalls: 1,
      costUsdTicks: 90_000_000,
    },
    elapsed_ms: 2000,
  }),
]

function fold(lines: readonly string[]): Snapshot {
  const synth = createGrokSynthesizer(MAIN)
  let state = createTimelineState()
  for (const line of lines) {
    for (const event of synth.push(line)) state = applyTimeline(state, event, DEFAULT_BOUNDS)
  }
  return buildTimelineView(state, DEFAULT_BOUNDS)
}

describe('grok synthesizer → fold', () => {
  it('books one request per settled model call, with turn/step and usage', () => {
    const view = fold(SESSION)
    expect(view.requests).toHaveLength(3)
    const [first, second, third] = view.requests
    expect([first?.turn, first?.step]).toEqual([1, 1])
    expect([second?.turn, second?.step]).toEqual([1, 2])
    expect([third?.turn, third?.step]).toEqual([2, 1])
    // The turn's usage is the SUM over its two model calls, apportioned back on
    // the stamped prompt sizes (1600 + 2400 = the wire's own 4000). `inputTokens`
    // on the wire INCLUDES the cache reads, so a call's billed prompt is its
    // stamped size again.
    expect(first?.prompt).toBe(1600)
    expect(second?.prompt).toBe(2400)
    expect((first?.cacheRead ?? 0) + (second?.cacheRead ?? 0)).toBe(3000)
    expect((first?.output ?? 0) + (second?.output ?? 0)).toBe(200)
    // The second turn made one call, so it takes the whole figure.
    expect(third?.prompt).toBe(5000)
    expect(third?.cacheRead).toBe(4000)
    expect(third?.output).toBe(80)
  })

  it('never lets one call\'s prompt read as the whole turn\'s summed input', () => {
    const view = fold(SESSION)
    const window = view.contextWindow ?? 0
    // The regression this guards: booking the turn total on one step made the
    // last request's prompt the SUM of every call, which on a real 4-call turn
    // read 792k of a 500k window.
    for (const request of view.requests) expect(request.prompt ?? 0).toBeLessThan(window)
    expect(view.requests.at(-1)?.prompt).toBe(5000)
  })

  it('prices a RECORDED system prompt and RECORDED tool schemas from the sidecar', () => {
    const view = fold(SESSION)
    expect(view.current.system).toBeGreaterThan(0)
    expect(view.requests[0]?.system).toBeGreaterThan(0)
    // The sidecar records `system_prompt.txt` outright, so nothing is derived.
    expect(view.systemDerived).toBeUndefined()
    expect(view.requests[0]?.systemDerived).toBeUndefined()
    // ... and `tool_definitions.json` makes the schema figure real.
    expect(view.toolsKnown).toBe(true)
    expect(view.current.tools).toBeGreaterThan(0)
  })

  it('derives the system prompt as a remainder when the file has no sidecar', () => {
    const view = fold(SESSION.slice(1))
    expect(view.toolsKnown).toBeUndefined()
    expect(view.systemDerived).toBe(true)
    expect(view.requests.at(-1)?.systemDerived).toBe(true)
  })

  it('carries the model, provider and assumed context window through', () => {
    const view = fold(SESSION)
    expect(view.model).toBe('grok-4.6')
    expect(view.provider).toBe('xai')
    expect(view.contextWindow).toBe(500_000)
  })

  it('takes the context window from a compaction record when one fires', () => {
    const view = fold([
      ...SESSION,
      xai(12, {
        sessionUpdate: 'auto_compact_started',
        tokens_used: 425_228, context_window: 262_144, percentage: 85, reason: 'Context window 85% full',
      }),
    ])
    expect(view.contextWindow).toBe(262_144)
  })

  it('counts only the flagged human chunks as human inputs', () => {
    const view = fold(SESSION)
    expect(view.humanInputs).toBe(2)
    const injects = view.events.filter(e => e.kind === 'inject')
    expect(injects.map(e => e.name)).toContain('preamble')
    expect(view.current.user).toBeGreaterThan(0)
    expect(view.current.inject).toBeGreaterThan(0)
  })

  it('keeps a typed slash command in the human bucket', () => {
    const view = fold([
      ...SESSION,
      acp(12, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '/statusline', _meta: { displayText: '/statusline', displayAsSkill: true } },
        _meta: { modelId: 'grok-4.6', promptIndex: 2 },
      }),
    ])
    expect(view.humanInputs).toBe(3)
    expect(view.current.skill).toBe(0)
  })

  it('attributes the first-token instant per model call', () => {
    const view = fold(SESSION)
    expect(view.timing?.calls).toBe(3)
    // `streamStartMs` opens each call and the first debounced chunk closes the
    // wait: 1.4s→2s, 6.5s→7s, 9.5s→10s = 600 + 500 + 500 ms.
    expect(view.timing?.ttftMs).toBe(1600)
    expect(view.timing?.genMs).toBeGreaterThan(0)
    expect(view.timing?.toolCalls).toBe(1)
  })

  it('books the file op reported by the tool result onto the result node', () => {
    const view = fold(SESSION)
    expect(view.fileOps).toHaveLength(1)
    expect(view.fileOps?.[0]).toMatchObject({
      kind: 'read', path: '/work/a.ts', tool: 'read_file', err: false, added: 0, removed: 0,
    })
    expect(view.toolCalls).toBe(1)
    expect(view.current.tool).toBeGreaterThan(0)
  })

  it('books a diff-reported edit with its real line delta', () => {
    const view = fold([
      ...SESSION,
      prompt(12, 'now edit it', 2),
      acp(13, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-2',
        title: 'Edit `/work/a.ts`',
        kind: 'other',
        status: 'in_progress',
        rawInput: { variant: 'EditFile' },
      }, { promptId: NEXT_PROMPT_ID }),
      acp(14, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-2',
        kind: 'edit',
        locations: [{ path: '/work/a.ts' }],
        _meta: { 'x.ai/tool': { version: 1, name: 'edit_file', kind: 'edit', label: 'Edit', input: { path: '/work/a.ts' } } },
      }, { promptId: NEXT_PROMPT_ID }),
      acp(15, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-2',
        status: 'completed',
        content: [{ type: 'diff', path: '/work/a.ts', oldText: 'one\ntwo', newText: 'one\ntwo\nthree' }],
      }, { promptId: NEXT_PROMPT_ID }),
      xai(16, { sessionUpdate: 'turn_completed', prompt_id: NEXT_PROMPT_ID, stop_reason: 'end_turn' }),
    ])
    const op = view.fileOps?.find(row => row.kind === 'write')
    expect(op).toMatchObject({ path: '/work/a.ts', tool: 'edit_file', added: 3, removed: 2, err: false })
  })

  it('marks a failed tool result on the surface and in the file activity', () => {
    const view = fold([
      ...SESSION,
      prompt(12, 'read the missing one', 2),
      acp(13, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-3',
        kind: 'read',
        locations: [{ path: '/work/missing.ts' }],
        _meta: { 'x.ai/tool': { version: 1, name: 'read_file', kind: 'read', label: 'Read', input: { path: '/work/missing.ts' } } },
      }, { promptId: NEXT_PROMPT_ID }),
      acp(14, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-3',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Error: not a file.' } }],
      }, { promptId: NEXT_PROMPT_ID }),
      xai(15, { sessionUpdate: 'turn_completed', prompt_id: NEXT_PROMPT_ID, stop_reason: 'end_turn' }),
    ])
    expect(view.fileOps?.some(row => row.err && row.path === '/work/missing.ts')).toBe(true)
  })

  it('frees the whole surface on a compaction and keeps the envelope', () => {
    const compacted = [
      ...SESSION,
      xai(12, {
        sessionUpdate: 'auto_compact_started',
        tokens_used: 5000, context_window: 500_000, percentage: 85, reason: 'Context window 85% full',
      }),
      xai(13, {
        sessionUpdate: 'auto_compact_completed',
        tokens_before: 5000, tokens_after: 400, elapsed_ms: 1500, summary_preview: 'we read a two-line file',
      }),
    ]
    const before = fold(SESSION)
    const after = fold(compacted)
    expect(after.events.some(e => e.kind === 'compaction')).toBe(true)
    expect(after.current.total).toBeLessThan(before.current.total)
    // A grok compaction keeps no tail: everything before it is gone.
    expect(after.current.assistant).toBe(0)
    expect(after.current.tool).toBe(0)
    expect(after.humanInputs).toBe(2)
    // The system prompt and tool schemas are not surface nodes and must survive.
    expect(after.current.system).toBe(before.current.system)
    expect(after.current.tools).toBe(before.current.tools)
  })

  it('logs the plan-mode toggles', () => {
    const view = fold([
      ...SESSION,
      acp(12, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-p',
        title: 'Enter plan mode',
        rawInput: {},
        _meta: { 'x.ai/tool': { version: 1, name: 'enter_plan_mode', kind: 'other', label: 'Plan', input: {} } },
      }, { promptId: NEXT_PROMPT_ID }),
      acp(13, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-q',
        title: 'Exit plan mode',
        rawInput: {},
        _meta: { 'x.ai/tool': { version: 1, name: 'exit_plan_mode', kind: 'other', label: 'Plan', input: {} } },
      }, { promptId: NEXT_PROMPT_ID }),
      xai(14, { sessionUpdate: 'turn_completed', prompt_id: NEXT_PROMPT_ID, stop_reason: 'end_turn' }),
    ])
    expect(view.events.filter(e => e.kind === 'mode').map(e => e.name)).toEqual(['plan.on', 'plan.off'])
  })

  it('logs a model switch as a fold event without dropping the system prompt', () => {
    const view = fold([
      ...SESSION,
      xai(12, { sessionUpdate: 'model_changed', model_id: 'grok-4.5', reasoning_effort: 'high' }),
    ])
    const models = view.events.filter(e => e.kind === 'model')
    expect(models).toHaveLength(1)
    expect([models[0]?.from, models[0]?.to]).toEqual(['grok-4.6', 'grok-4.5'])
    expect(view.current.system).toBeGreaterThan(0)
    expect(view.toolsKnown).toBe(true)
  })

  it('never throws on a malformed line and keeps the seqs strictly increasing', () => {
    const synth = createGrokSynthesizer(MAIN)
    const seqs: number[] = []
    let state = createTimelineState()
    const feed = [...SESSION.slice(0, 5), 'not json', '{"method":', '', ...SESSION.slice(5)]
    for (const line of feed) {
      for (const event of synth.push(line)) {
        seqs.push(event.seq)
        state = applyTimeline(state, event, DEFAULT_BOUNDS)
      }
    }
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(buildTimelineView(state, DEFAULT_BOUNDS).requests).toHaveLength(3)
  })

  it('reports grok\'s own cost rollup, skipping the turn that recorded none', () => {
    const synth = createGrokSynthesizer(MAIN)
    for (const line of SESSION) synth.push(line)
    // Both turns reported ticks: 151340800 + 90000000 over 1e10 ticks/USD.
    expect(synth.meta().reportedCostUsd).toBeCloseTo((151_340_800 + 90_000_000) / 1e10, 10)

    const partial = createGrokSynthesizer(MAIN)
    for (const line of SESSION) {
      // Strip the SECOND turn's cost: an absent figure is "unknown", never 0.
      partial.push(line.includes('"costUsdTicks":90000000') ? line.replace(',"costUsdTicks":90000000', '') : line)
    }
    expect(partial.meta().reportedCostUsd).toBeCloseTo(151_340_800 / 1e10, 10)
  })
})
