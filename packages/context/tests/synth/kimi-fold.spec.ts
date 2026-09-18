/**
 * Kimi synthesizer → fold, end to end.
 *
 * Synthetic fixtures only (real field names, fake payloads, epoch-ms times).
 * This spec proves the synthesizer's events are a valid fold input: it feeds
 * one session through `applyTimeline` and reads the figures off
 * `buildTimelineView`.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import type { TimelineEvent } from '../../src/fold/event.ts'
import { applyTimeline, buildTimelineView, createTimelineState } from '../../src/fold/fold.ts'
import type { Snapshot } from '../../src/shared/types.ts'
import { createKimiSynthesizer } from '../../src/synth/kimi.ts'

const T0 = Date.UTC(2025, 0, 1, 12, 0, 0)
const ms = (s: number): number => T0 + s * 1000

const MAIN: SessionFileRef = { id: 'session_abc', role: 'main', path: '/tmp/session_abc/agents/main/wire.jsonl' }

interface Rec { [key: string]: unknown }

const line = (s: number, type: string, rest: Rec = {}): string =>
  JSON.stringify({ type, time: ms(s), agentId: 'main', ...rest })

const SYSTEM_TEXT = 'You are Kimi, a coding agent. '.repeat(20)

const loop = (s: number, event: Rec): string => line(s, 'context.append_loop_event', { event })

const appendMessage = (s: number, text: string, origin?: Rec): string => line(s, 'context.append_message', {
  message: {
    role: 'user', content: [{ type: 'text', text }], toolCalls: [], id: `m-${s}`,
    ...(origin === undefined ? {} : { origin }),
  },
})

/** A two-turn session: a tool call with file ops, an injection, a skill, then a compaction. */
const SESSION: string[] = [
  line(0, 'metadata', { created_at: ms(0), protocol_version: '1.5' }),
  line(0, 'runtime.set_binding', { agentId: 'main', runtimeId: 'rt-1', workspaceId: 'wd-1' }),
  line(0, 'profile.bind', {
    profileName: 'agent', modelAlias: 'kimi-code/k3', thinkingEffort: 'medium',
    systemPrompt: SYSTEM_TEXT, activeToolNames: ['Read', 'Bash'], agentsMdPaths: [],
    environmentDisclosure: { cwd: '/tmp/work' }, subagents: [],
  }),
  line(1, 'turn.prompt', { promptId: 'p1', input: [{ type: 'text', text: 'please read the file' }], origin: { kind: 'user' } }),
  appendMessage(1, 'please read the file', { kind: 'user' }),
  appendMessage(1, 'remember your todo list', { kind: 'injection', variant: 'todo_list_reminder' }),
  loop(2, { type: 'step.begin', turnId: '0', step: 1, uuid: 'sb-1' }),
  line(2, 'llm.tools_snapshot', {
    hash: 'h1',
    tools: [
      { name: 'Read', description: 'read a file from disk', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'Bash', description: 'run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    ],
  }),
  line(2, 'llm.request', {
    kind: 'loop', model: 'k3', modelAlias: 'kimi-code/k3', provider: 'openai',
    maxTokens: 1_048_576, messageCount: 3, systemPromptHash: 'sp1', toolsHash: 'h1', turnStep: '0.1',
  }),
  line(5, 'usage.record', {
    model: 'kimi-code/k3', usageScope: 'turn',
    usage: { inputOther: 900, inputCacheRead: 3000, inputCacheCreation: 0, output: 200 },
  }),
  line(5, 'token_counting.measured', { length: 3, tokens: 4100 }),
  loop(6, { type: 'content.part', part: { type: 'think', think: 'I should read it' }, step: 1, turnId: '0', uuid: 'cp-1' }),
  loop(6, { type: 'tool.call', toolCallId: 'call_a', name: 'Read', args: { path: '/tmp/a.ts', offset: 1, limit: 40 }, step: 1, turnId: '0', uuid: 'tc-1' }),
  loop(7, { type: 'tool.result', toolCallId: 'call_a', parentUuid: 'tc-1', result: { output: 'line one\nline two', isError: false }, uuid: 'tr-1' }),
  loop(7, {
    type: 'step.end', finishReason: 'tool_use', messageId: 'msg-1',
    usage: { inputOther: 900, inputCacheRead: 3000, inputCacheCreation: 0, output: 200 },
    llmFirstTokenLatencyMs: 1200, llmStreamDurationMs: 2500, step: 1, turnId: '0', uuid: 'se-1',
  }),
  loop(8, { type: 'step.begin', turnId: '0', step: 2, uuid: 'sb-2' }),
  line(8, 'llm.request', {
    kind: 'loop', model: 'k3', modelAlias: 'kimi-code/k3', provider: 'openai',
    maxTokens: 1_048_576, messageCount: 5, toolsHash: 'h1', turnStep: '0.2',
  }),
  line(10, 'usage.record', {
    model: 'kimi-code/k3', usageScope: 'turn',
    usage: { inputOther: 1000, inputCacheRead: 4000, inputCacheCreation: 0, output: 80 },
  }),
  loop(11, { type: 'content.part', part: { type: 'text', text: 'the file has two lines' }, step: 2, turnId: '0', uuid: 'cp-2' }),
  loop(11, {
    type: 'step.end', finishReason: 'stop', messageId: 'msg-2',
    usage: { inputOther: 1000, inputCacheRead: 4000, inputCacheCreation: 0, output: 80 },
    llmFirstTokenLatencyMs: 800, llmStreamDurationMs: 1500, step: 2, turnId: '0', uuid: 'se-2',
  }),
  line(12, 'turn.ended', { durationMs: 11_000, reason: 'completed', turnId: 0 }),
]

function fold(lines: readonly string[]): Snapshot {
  const synth = createKimiSynthesizer(MAIN)
  let state = createTimelineState()
  for (const l of lines) {
    for (const event of synth.push(l)) state = applyTimeline(state, event, DEFAULT_BOUNDS)
  }
  return buildTimelineView(state, DEFAULT_BOUNDS)
}

describe('kimi synthesizer → fold', () => {
  it('books one request per settled step, with turn/step and usage', () => {
    const view = fold(SESSION)
    expect(view.requests).toHaveLength(2)
    const [first, second] = view.requests
    expect([first?.turn, first?.step]).toEqual([1, 1])
    expect([second?.turn, second?.step]).toEqual([1, 2])
    // The four Kimi buckets are already disjoint: prompt = inputOther +
    // inputCacheRead + inputCacheCreation.
    expect(first?.prompt).toBe(900 + 3000)
    expect(first?.cacheRead).toBe(3000)
    expect(first?.output).toBe(200)
    expect(second?.prompt).toBe(1000 + 4000)
    expect(second?.output).toBe(80)
  })

  it('prices a RECORDED system prompt and RECORDED tool schemas', () => {
    const view = fold(SESSION)
    expect(view.current.system).toBeGreaterThan(0)
    expect(view.requests[0]?.system).toBeGreaterThan(0)
    // Kimi records the prompt outright, so the fold never derives it.
    expect(view.systemDerived).toBeUndefined()
    expect(view.requests[0]?.systemDerived).toBeUndefined()
    // ... and it records the tool schemas too (unlike Codex).
    expect(view.toolsKnown).toBe(true)
    expect(view.current.tools).toBeGreaterThan(0)
  })

  it('carries the model, provider and context window through', () => {
    const view = fold(SESSION)
    expect(view.model).toBe('k3')
    expect(view.provider).toBe('kimi-for-coding')
    expect(view.contextWindow).toBeUndefined()
  })

  it('counts only human messages as human inputs', () => {
    const view = fold(SESSION)
    expect(view.humanInputs).toBe(1)
    const injects = view.events.filter(e => e.kind === 'inject')
    expect(injects.map(e => e.name)).toContain('todo_list_reminder')
    expect(view.current.user).toBeGreaterThan(0)
    expect(view.current.inject).toBeGreaterThan(0)
  })

  it('books a skill activation in the skill bucket', () => {
    const view = fold([
      ...SESSION,
      appendMessage(13, 'deploy skill body', {
        kind: 'skill_activation', skillName: 'deploy', skillPath: '/s/deploy', trigger: 'user',
      }),
    ])
    expect(view.current.skill).toBeGreaterThan(0)
    const skillEvent = view.events.find(e => e.sub === 'skill')
    expect(skillEvent?.name).toBe('deploy')
  })

  it('attributes the recorded time-to-first-token per step', () => {
    const view = fold(SESSION)
    expect(view.timing?.calls).toBe(2)
    // step 1: 1200ms of wait; step 2: 800ms. Kimi measures both itself.
    expect(view.timing?.ttftMs).toBe(2000)
    expect(view.timing?.genMs).toBeGreaterThan(0)
    expect(view.timing?.toolCalls).toBe(1)
  })

  it('books the file op from the call arguments onto the result node', () => {
    const view = fold(SESSION)
    expect(view.fileOps).toHaveLength(1)
    expect(view.fileOps?.[0]).toMatchObject({
      kind: 'read', path: '/tmp/a.ts', tool: 'Read', err: false, added: 0, removed: 0,
    })
    expect(view.fileOps?.[0]?.read).toEqual({ start: 1, count: 40 })
    expect(view.toolCalls).toBe(1)
    expect(view.current.tool).toBeGreaterThan(0)
  })

  it('logs the compaction and frees everything but the kept tail', () => {
    const compacted = [
      ...SESSION,
      appendMessage(13, 'and now the second question', { kind: 'user' }),
      line(14, 'context.apply_compaction', {
        summary: 'we read a two-line file',
        compactedCount: 4, tokensBefore: 5000, tokensAfter: 400,
        keptUserMessageCount: 1, droppedCount: 4,
      }),
    ]
    const before = fold(compacted.slice(0, -1))
    const after = fold(compacted)
    expect(after.events.some(e => e.kind === 'compaction')).toBe(true)
    expect(after.current.total).toBeLessThan(before.current.total)
    // The first turn's response and tool result are gone; the kept tail (the
    // most recent human prompt) survives, so the human tally does not change.
    expect(after.current.assistant).toBe(0)
    expect(after.current.tool).toBe(0)
    expect(after.current.user).toBeGreaterThan(0)
    expect(after.humanInputs).toBe(2)
    expect(after.current.system).toBe(before.current.system)
  })

  it('empties the live surface on context.clear', () => {
    const before = fold(SESSION)
    const after = fold([...SESSION, line(13, 'context.clear', { agentId: 'main' })])
    expect(after.events.some(e => e.kind === 'prune')).toBe(true)
    expect(after.current.assistant).toBe(0)
    expect(after.current.tool).toBe(0)
    // Everything the /clear freed is gone; what remains under `inject` is the
    // contentless marker node that claims the range (see `prune`).
    expect(after.current.inject).toBeLessThan(before.current.inject)
    expect(after.current.total).toBeLessThan(before.current.total)
    // The system prompt and tool schemas are not surface nodes: a /clear does
    // not (and must not) drop them.
    expect(after.current.system).toBe(before.current.system)
    expect(after.current.tools).toBe(before.current.tools)
  })

  it('logs the plan-mode toggles', () => {
    const view = fold([
      ...SESSION,
      line(13, 'plan_mode.enter', { id: 'plan-1' }),
      line(14, 'plan_mode.exit', { id: 'plan-1' }),
    ])
    expect(view.events.filter(e => e.kind === 'mode').map(e => e.name)).toEqual(['plan.on', 'plan.off'])
  })

  it('logs a model switch as a fold event without dropping the system prompt', () => {
    const view = fold([
      ...SESSION,
      loop(13, { type: 'step.begin', turnId: '1', step: 1, uuid: 'sb-3' }),
      line(13, 'llm.request', {
        kind: 'loop', model: 'k3-256k', modelAlias: 'kimi-code/k3-256k', provider: 'openai',
        maxTokens: 262_144, toolsHash: 'h1', turnStep: '1.1',
      }),
    ])
    const models = view.events.filter(e => e.kind === 'model')
    expect(models).toHaveLength(1)
    expect([models[0]?.from, models[0]?.to]).toEqual(['k3', 'k3-256k'])
    expect(view.current.system).toBeGreaterThan(0)
    expect(view.contextWindow).toBeUndefined()
  })

  it('keeps an interrupted step out of the priced requests but on the surface', () => {
    const view = fold([
      ...SESSION,
      appendMessage(13, 'one more thing', { kind: 'user' }),
      loop(14, { type: 'step.begin', turnId: '1', step: 1, uuid: 'sb-4' }),
      loop(15, { type: 'content.part', part: { type: 'text', text: 'starting' }, step: 1, turnId: '1', uuid: 'cp-4' }),
      line(16, 'turn.step.interrupted', { reason: 'aborted', step: 1, turnId: 1 }),
    ])
    expect(view.requests).toHaveLength(3)
    const last = view.requests.at(-1)
    // No usage was recorded for it, so it prices nothing but still shows up.
    expect(last?.output ?? 0).toBe(0)
    expect([last?.turn, last?.step]).toEqual([2, 1])
  })

  it('never throws on a malformed line and keeps the seqs strictly increasing', () => {
    const synth = createKimiSynthesizer(MAIN)
    const seqs: number[] = []
    let state = createTimelineState()
    for (const l of [...SESSION.slice(0, 6), 'not json', '{"type":', ...SESSION.slice(6)]) {
      for (const event of synth.push(l)) {
        seqs.push(event.seq)
        state = applyTimeline(state, event, DEFAULT_BOUNDS)
      }
    }
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(buildTimelineView(state, DEFAULT_BOUNDS).requests).toHaveLength(2)
  })
})

describe('kimi synthesizer → fold — swarm_mode.exit', () => {
  const swarmReminder = (s: number, text = 'swarm reminder') =>
    appendMessage(s, text, { kind: 'injection', variant: 'swarm_mode' })
  const swarmExit = (s: number) => line(s, 'swarm_mode.exit')

  function foldState(lines: readonly string[]) {
    const synth = createKimiSynthesizer(MAIN)
    let state = createTimelineState()
    const events: TimelineEvent[] = []
    for (const l of lines) {
      for (const event of synth.push(l)) {
        events.push(event)
        state = applyTimeline(state, event, DEFAULT_BOUNDS)
      }
    }
    return { state, events }
  }

  const surfaceTexts = (state: ReturnType<typeof createTimelineState>) =>
    state.surface.map(node => node.text)

  it('frees the reminder from the live surface', () => {
    const { state, events } = foldState([swarmReminder(1), swarmExit(2)])
    expect(surfaceTexts(state)).not.toContain('swarm reminder')
    expect(events.some(event => event.type === 'compaction/prune')).toBe(true)
  })

  it('removes a reminder appended after buffered assistant content without splitting billing', () => {
    const { state } = foldState([
      loop(1, { type: 'step.begin', turnId: '0', step: 1 }),
      loop(2, { type: 'content.part', part: { type: 'text', text: 'working' } }),
      swarmReminder(3), swarmExit(4),
      loop(5, { type: 'step.end', finishReason: 'stop', usage: { inputOther: 10, output: 2 } }),
    ])
    expect(surfaceTexts(state).filter(Boolean)).toEqual(['working'])
    expect(buildTimelineView(state, DEFAULT_BOUNDS).requests).toHaveLength(1)
  })

  it('keeps the reminder when a human prompt is the last message', () => {
    const { state } = foldState([
      swarmReminder(1),
      appendMessage(2, 'hi', { kind: 'user' }),
      swarmExit(3),
    ])
    expect(surfaceTexts(state)).toContain('swarm reminder')
    expect(surfaceTexts(state)).toContain('hi')
  })

  it('drops only the last reminder when two were appended', () => {
    const { state } = foldState([
      swarmReminder(1, 'reminder one'),
      swarmReminder(2, 'reminder two'),
      swarmExit(3),
    ])
    expect(surfaceTexts(state)).toContain('reminder one')
    expect(surfaceTexts(state)).not.toContain('reminder two')
  })

  it('stays gone when a later context.undo restores an anchor', () => {
    const { state } = foldState([
      appendMessage(1, 'first', { kind: 'user' }),
      swarmReminder(2),
      swarmExit(3),
      appendMessage(4, 'second', { kind: 'user' }),
      line(5, 'context.undo', { count: 1 }),
    ])
    // The undo restores the pre-'second' checkpoint; the pruned reminder must
    // not come back with it.
    expect(surfaceTexts(state)).toContain('first')
    expect(surfaceTexts(state)).not.toContain('swarm reminder')
  })
})
