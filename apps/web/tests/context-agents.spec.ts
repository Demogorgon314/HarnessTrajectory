// The Agent Network's row mapping (apps/web/src/ContextPane.tsx): which name
// and which liveness each folded transcript ends up wearing, and the stats the
// node donut reads.

import { describe, expect, test } from 'vitest'
import type { SessionFileRef, SessionSummary } from '@harness-trajectory/core'
import type { AgentSpawn, ContextTimeline, SynthMeta } from '@harness-trajectory/context'
import { agentNodeInputsOf, type AgentFoldReader } from '../src/ContextPane.tsx'

const MAIN = 'sess-1'
const CHILD = 'sess-1/agent-a1b2'

function file(id: string, role: 'main' | 'child', parentId?: string): SessionFileRef {
  return { id, role, path: `/logs/${id}.jsonl`, ...(parentId === undefined ? {} : { parentId }) }
}

function meta(over: Partial<SynthMeta> = {}): SynthMeta {
  return { running: false, children: new Map<string, AgentSpawn>(), ...over }
}

function timeline(over: Partial<ContextTimeline> = {}): ContextTimeline {
  return {
    ok: true,
    contextWindow: 1000,
    current: { system: 0, tools: 0, user: 100, inject: 0, skill: 0, assistant: 0, tool: 0, total: 100 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  } as ContextTimeline
}

/** A fold double: whatever the caller wants each file to report. */
function reader(
  timelines: Record<string, ContextTimeline | null>,
  metas: Record<string, SynthMeta | null>,
): AgentFoldReader {
  return {
    timelineOf: id => timelines[id] ?? null,
    metaOf: id => metas[id] ?? null,
  }
}

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: MAIN,
    kind: 'claude',
    title: 'Port the Context tab',
    cwd: '/repo',
    model: 'claude-opus-5',
    startedAt: 1000,
    updatedAt: 2000,
    bytes: 10,
    live: false,
    childCount: 1,
    promptCount: 2,
    ...over,
  }
}

const CTX = { kind: 'claude' as const, sessionId: MAIN }

describe('agentNodeInputsOf — naming', () => {
  test('the main node takes the server title over the synthesizer label', () => {
    const [main] = agentNodeInputsOf(
      [file(MAIN, 'main')],
      reader({}, { [MAIN]: meta({ label: 'first prompt of the session' }) }),
      summary(),
      CTX,
    )
    expect(main?.label).toBe('Port the Context tab')
  })

  test('without a listing row the main node falls back to the synthesizer label, then the id', () => {
    const [withLabel] = agentNodeInputsOf(
      [file(MAIN, 'main')], reader({}, { [MAIN]: meta({ label: 'first prompt' }) }), null, CTX,
    )
    expect(withLabel?.label).toBe('first prompt')
    const [bare] = agentNodeInputsOf([file(MAIN, 'main')], reader({}, {}), null, CTX)
    expect(bare?.label).toBe(MAIN)
  })

  test('an empty server title does not blank the caption', () => {
    const [main] = agentNodeInputsOf(
      [file(MAIN, 'main')],
      reader({}, { [MAIN]: meta({ label: 'first prompt' }) }),
      summary({ title: '' }),
      CTX,
    )
    expect(main?.label).toBe('first prompt')
  })

  test('a child takes the parent spawn description first, then its own label, then its id', () => {
    const spawn: AgentSpawn = { key: 'a1b2', label: 'Explore the repo', agentType: 'Explore' }
    const parentMeta = meta({ children: new Map([['a1b2', spawn]]) })
    const files = [file(MAIN, 'main'), file(CHILD, 'child', MAIN)]

    const fromParent = agentNodeInputsOf(
      files, reader({}, { [MAIN]: parentMeta, [CHILD]: meta({ label: 'You are the Explore agent…' }) }), summary(), CTX,
    )
    expect(fromParent[1]?.label).toBe('Explore the repo')
    expect(fromParent[1]?.badge).toBe('Explore')

    const fromSelf = agentNodeInputsOf(
      files, reader({}, { [CHILD]: meta({ label: 'You are the Explore agent' }) }), summary(), CTX,
    )
    expect(fromSelf[1]?.label).toBe('You are the Explore agent')

    const bare = agentNodeInputsOf(files, reader({}, {}), summary(), CTX)
    expect(bare[1]?.label).toBe(CHILD)
  })

  test('long captions trim to one readable line', () => {
    const long = 'x'.repeat(200)
    const [main] = agentNodeInputsOf([file(MAIN, 'main')], reader({}, {}), summary({ title: long }), CTX)
    expect(main?.label.length).toBe(80)
    expect(main?.label.endsWith('…')).toBe(true)
  })
})

describe('agentNodeInputsOf — liveness', () => {
  test('the main node follows the server live flag over the synthesizer', () => {
    const files = [file(MAIN, 'main')]
    const stillOpen = agentNodeInputsOf(files, reader({}, { [MAIN]: meta({ running: true }) }), summary({ live: false }), CTX)
    expect(stillOpen[0]?.running, 'the server says the session is idle').toBe(false)
    expect(stillOpen[0]?.completed).toBe(true)
    const live = agentNodeInputsOf(files, reader({}, { [MAIN]: meta({ running: false }) }), summary({ live: true }), CTX)
    expect(live[0]?.running).toBe(true)
    expect(live[0]?.completed).toBe(false)
  })

  test('without a listing row the main node falls back to the synthesizer', () => {
    const [main] = agentNodeInputsOf(
      [file(MAIN, 'main')], reader({}, { [MAIN]: meta({ running: true }) }), null, CTX,
    )
    expect(main?.running).toBe(true)
  })

  test("a spawn that already completed ends the child whatever its own fold believes", () => {
    const spawn: AgentSpawn = { key: 'a1b2', label: 'Explore', startedAt: 100, completedAt: 900 }
    const files = [file(MAIN, 'main'), file(CHILD, 'child', MAIN)]
    const rows = agentNodeInputsOf(
      files,
      reader({}, { [MAIN]: meta({ children: new Map([['a1b2', spawn]]) }), [CHILD]: meta({ running: true }) }),
      summary(),
      CTX,
    )
    expect(rows[1]?.running).toBe(false)
    expect(rows[1]?.completed).toBe(true)
    // With no requests of its own, the node still gets the spawn's duration.
    expect(rows[1]?.durationMs).toBe(800)
  })

  test('an unfinished spawn leaves the child on its own fold', () => {
    const spawn: AgentSpawn = { key: 'a1b2', label: 'Explore', startedAt: 100 }
    const files = [file(MAIN, 'main'), file(CHILD, 'child', MAIN)]
    const rows = agentNodeInputsOf(
      files,
      reader({}, { [MAIN]: meta({ children: new Map([['a1b2', spawn]]) }), [CHILD]: meta({ running: true }) }),
      summary(),
      CTX,
    )
    expect(rows[1]?.running).toBe(true)
    expect(rows[1]?.completed).toBe(false)
  })

  test('a file nothing has reported on is neither running nor done', () => {
    const [row] = agentNodeInputsOf([file(CHILD, 'child', MAIN)], reader({}, {}), null, CTX)
    expect(row?.running).toBe(false)
    expect(row?.completed, 'silence is not an ending').toBe(false)
  })
})

describe('agentNodeInputsOf — stats', () => {
  test('requests, billed tokens, duration, lineage and the occupancy head', () => {
    const requests = [
      { seq: 1, time: 1_000, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 100, prompt: 500, output: 20 },
      { seq: 2, time: 4_000, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 200, prompt: 700, output: 30 },
      // A usage-less request still counts as a request, never as billed tokens.
      { seq: 3, time: 5_000, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 300 },
    ]
    const rows = agentNodeInputsOf(
      [file(MAIN, 'main'), file(CHILD, 'child', MAIN)],
      reader({ [CHILD]: timeline({ requests }) }, {}),
      summary(),
      CTX,
    )
    const child = rows[1]
    expect(child?.parentId).toBe(MAIN)
    expect(child?.subagent).toBe(true)
    expect(child?.requests).toBe(3)
    expect(child?.billed).toBe(1250)
    expect(child?.durationMs).toBe(4000)
    expect(child?.updatedAt).toBe(5000)
    expect(child?.head).not.toBeNull()
    // The main file folded nothing: no head, no billing, no duration.
    expect(rows[0]?.head).toBe(null)
    expect(rows[0]?.billed).toBe(null)
    expect(rows[0]?.durationMs).toBe(null)
    expect(rows[0]?.subagent).toBe(false)
  })
})
