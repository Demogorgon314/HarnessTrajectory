// The fold/view builders over a realistic log — the part of dsh-context's
// `tests/host/timeline.spec.ts` that survives the port (the rest pinned the
// projection-definition contract and its zod schemas, neither of which exists
// here).

import assert from './helpers/assert.ts'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/fold/event.ts'
import { driveTimeline, row } from './helpers/drive.ts'
import {
  assistantMessage,
  compaction,
  header,
  planMode,
  requestContext,
  stepEnd,
  stepStart,
  toolCall,
  toolResult,
  userMessage,
} from './helpers/events.ts'

/** A realistic session log touching every envelope family the fold serves. */
function realLog(): TimelineEvent[] {
  return [
    header(1, {
      system: 'You are an agent.',
      tools: [{ name: 'bash', description: 'run a command' }],
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
    }),
    requestContext(2, { contextWindow: 128000 }),
    stepStart(3),
    userMessage(4, [{ type: 'text', text: 'hello there' }], { kind: 'user' }),
    assistantMessage(5, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }),
    toolCall(6, { callId: 'c1', name: 'bash' }),
    toolResult(7, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    stepEnd(8),
    assistantMessage(9, { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 8 } }),
    compaction(10, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [4] }),
    planMode(11, { active: true }),
  ]
}

describe('the fold over a realistic log', () => {
  test('the inline view carries the envelope, the collections, and the tally', () => {
    const { view } = driveTimeline(realLog())
    assert.equal(view.ok, true)
    assert.equal(view.model, 'deepseek-v4-flash')
    assert.equal(view.provider, 'deepseek')
    assert.equal(view.contextWindow, 128000)
    assert.equal(view.humanInputs, 1, 'the log\'s one user message')
    assert.ok(view.nodes.length > 0)
    assert.ok(view.requests.length > 0)
    assert.ok(view.events.length > 0)
    // The header recorded both halves of the envelope, so nothing is derived.
    assert.equal(view.systemDerived, undefined)
    assert.equal(view.toolsKnown, true)
  })

  test('maxNodes bounds the served surface nodes', () => {
    const events: TimelineEvent[] = [
      header(1, { system: 's', model: 'm', provider: 'p' }),
      userMessage(2, [{ type: 'text', text: 'one' }], { kind: 'user' }),
      userMessage(3, [{ type: 'text', text: 'two' }], { kind: 'user' }),
      userMessage(4, [{ type: 'text', text: 'three' }], { kind: 'user' }),
      userMessage(5, [{ type: 'text', text: 'four' }], { kind: 'user' }),
    ]
    const bounded = driveTimeline(events, { maxNodes: 2 })
    assert.equal(bounded.view.nodes.length, 2, 'only the newest tail is served')
    assert.deepEqual(bounded.view.nodes.map(n => n.seq), [4, 5])
    assert.equal(bounded.view.droppedNodes, 2)
    assert.equal(bounded.view.surfaceFloor, 3, 'the newest unserved live seq')

    const unbounded = driveTimeline(events).view
    assert.equal(unbounded.nodes.length, 4, 'the port\'s default bounds serve every live node')
    assert.equal(unbounded.droppedNodes, 0)
    assert.equal(row(unbounded.nodes, 0).seq, 2)
  })
})

describe('replay copies (a context render\'s kept messages, surfaced again)', () => {
  test('a replayed assistant message joins the surface but mints no request record', () => {
    const { view } = driveTimeline([
      header(1, { system: 'sys', model: 'm', provider: 'p' }),
      userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      assistantMessage(3, { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 } }),
      // The render's kept copy of that reply: same content, not a dispatch.
      assistantMessage(4, { replay: true }),
    ])
    assert.equal(view.requests.length, 1, 'only the real dispatch records a request')
    assert.equal(row(view.requests, 0).turn, 1)
    assert.equal(row(view.requests, 0).prompt, 10)
    assert.equal(view.nodes.filter(n => n.cat === 'assistant').length, 2, 'both copies live on the surface')
  })

  test('a replayed human message is not a second human input', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }, { replay: true }),
    ])
    assert.equal(view.humanInputs, 1)
    assert.equal(view.nodes.filter(n => n.cat === 'user').length, 2)
  })

  test('a replayed injection keeps its node label but does not re-list the event', () => {
    const source = { kind: 'inject', form: 'context', plugin: 'rules-loaded' } as const
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: '<rules/>' }], source),
      userMessage(2, [{ type: 'text', text: '<rules/>' }], source, { replay: true }),
    ])
    assert.equal(view.events.filter(e => e.kind === 'inject').length, 1, 'the original already earned the row')
    assert.equal(view.nodes.filter(n => n.cat === 'inject').length, 2, 'the kept copy still surfaces')
    assert.equal(row(view.nodes.filter(n => n.cat === 'inject'), 1).name, 'rules-loaded')
  })
})
