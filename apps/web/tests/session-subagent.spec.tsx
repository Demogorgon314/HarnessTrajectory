// @vitest-environment jsdom
/**
 * A subagent is titled by what it is doing, never by its bare directory id:
 * the catalog row takes the run's bound description, and the subagent view's
 * header falls back to the title its own transcript reports — a kimi child's
 * delegated prompt, stripped of its `<git-context>` prelude.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createTrajectoryDurationStore, createTrajectoryTranslate } from '@harness-trajectory/ui'
import type { SessionFileRef, SessionLiveEvent, SubagentRun } from '@harness-trajectory/core'
import { createCodexParser } from '@harness-trajectory/core'
import type { Route } from '../src/App.tsx'
import { SessionPane, subagentRows } from '../src/SessionPane.tsx'

const t = createTrajectoryTranslate('en')
const durationStore = createTrajectoryDurationStore()

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const CHILD: SessionFileRef = {
  id: 'agent-1', role: 'main', path: '/logs/wd_x/session_t/agents/agent-1/wire.jsonl',
}
const DELEGATED = '<git-context>\nWorking directory: /work\nBranch: main\n</git-context>\n\nSurvey the repo structure'

const line = (type: string, offset: number, rest: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, time: T0 + offset, agentId: 'agent-1', ...rest })

/** A kimi subagent wire: profile, the delegated prompt, one answered step. */
const LINES: readonly string[] = [
  JSON.stringify({ type: 'metadata', created_at: T0, protocol_version: '1.5' }),
  line('profile.bind', 10, {
    profileName: 'explore', modelAlias: 'kimi-code/k3', thinkingEffort: 'high',
    systemPrompt: 'You explore.', environmentDisclosure: { cwd: '/work' },
  }),
  line('turn.prompt', 100, {
    promptId: 'p1', input: [{ type: 'text', text: DELEGATED }],
    origin: { kind: 'system_trigger', name: 'subagent' },
  }),
  line('context.append_message', 110, {
    message: {
      role: 'user', content: [{ type: 'text', text: DELEGATED }], toolCalls: [],
      origin: { kind: 'system_trigger', name: 'subagent' },
    },
  }),
  line('context.append_loop_event', 200, { event: { type: 'step.begin', turnId: '0', step: 1 } }),
  line('context.append_loop_event', 300, {
    event: { type: 'content.part', part: { type: 'text', text: 'On it.' }, turnId: '0', step: 1 },
  }),
  line('context.append_loop_event', 310, {
    event: {
      type: 'step.end', finishReason: 'stop', turnId: '0', step: 1,
      usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
    },
  }),
  line('turn.ended', 400, { turnId: 0, reason: 'completed', durationMs: 100 }),
]

/** An EventSource the spec drives by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()
  onerror: ((event: Event) => void) | null = null

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    // nothing to release in the fake
  }

  emit(event: SessionLiveEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(new MessageEvent(event.type, { data: JSON.stringify(event) }))
    }
  }
}

function run(
  agentId: string,
  extra: Partial<SubagentRun> = {},
): SubagentRun {
  return {
    agentId, fileId: agentId, callId: null, description: null, agentType: null, model: null,
    status: 'running', startedAt: null, endedAt: null, lastTime: null, toolCalls: 0, ...extra,
  }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('subagentRows titles', () => {
  test('keeps Codex agent names in the parent catalog and the standalone child view', () => {
    const file: SessionFileRef = { id: 'child', role: 'child', parentId: 'parent', path: '/tmp/child.jsonl' }
    const header = JSON.stringify({ type: 'session_meta', timestamp: new Date(T0).toISOString(), payload: {
      id: file.id, parent_thread_id: 'parent', agent_path: '/root/review',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
    } })
    const parent = createCodexParser()
    parent.push(header, file)
    expect(subagentRows(parent.subagents(), [])[0]?.title).toBe('/root/review')
    const standalone = createCodexParser()
    standalone.push(header, { ...file, role: 'main' })
    expect(standalone.meta().title).toBe('/root/review')
    expect(subagentRows([], [{ file, bytes: 10, updatedAt: T0 }], { fileId: file.id, title: standalone.meta().title })[0]?.title)
      .toBe('/root/review')
  })
  test('a bound run titles the row by its description', () => {
    const rows = subagentRows(
      [run('agent-1', { callId: 'c1', description: 'Survey the repo', agentType: 'explore', status: 'completed' })],
      [{ file: { id: 'agent-1', role: 'child', path: '/x/wire.jsonl' }, updatedAt: 200, bytes: 10 }],
    )
    expect(rows[0]).toMatchObject({ title: 'Survey the repo', agentType: 'explore', fileId: 'agent-1' })
  })

  test('an unbound run falls back to the short agent id', () => {
    expect(subagentRows([run('agent-12')], [])[0]?.title).toBe('12')
  })

  test('an unbound run keeps a null fileId — no invented stream id', () => {
    const rows = subagentRows([run('a0be46c6', { fileId: null, callId: 'c1' })], [])
    expect(rows[0]?.fileId).toBeNull()
  })

  test('an unbound run opens once its child file is announced', () => {
    const rows = subagentRows(
      [run('a0be46c6', { fileId: null, callId: 'c1' })],
      [{
        file: {
          id: 'agent-a0be46c6', role: 'child', path: 'devin://sessions/x/agent-a0be46c6',
          agent: { agentId: 'a0be46c6' },
        },
        updatedAt: 200, bytes: 10,
      }],
    )
    expect(rows[0]?.fileId).toBe('agent-a0be46c6')
  })

  test('a child file without a run uses sidecar description, not the directory id', () => {
    const rows = subagentRows(
      [],
      [{
        file: {
          id: 'agent-1', role: 'child', path: '/x/wire.jsonl',
          agent: { agentId: 'agent-1', description: 'Survey the repo', agentType: 'explore' },
        },
        updatedAt: 200, bytes: 10,
      }],
    )
    expect(rows[0]).toMatchObject({ title: 'Survey the repo', agentType: 'explore', fileId: 'agent-1' })
  })

  test('the open child falls back to its own transcript title', () => {
    const rows = subagentRows(
      [],
      [{ file: { id: 'agent-1', role: 'child', path: '/x/wire.jsonl' }, updatedAt: 200, bytes: 10 }],
      { fileId: 'agent-1', title: 'Survey the repo structure' },
    )
    expect(rows[0]?.title).toBe('Survey the repo structure')
  })

  test('a child view titles every sibling from the server-provided descriptions', () => {
    // The child-view parser folds only the selected stream, so no parent
    // run_subagent calls exist — every row is a catalog row and its title is
    // the child ref's `agent.description` (the spawn call's title).
    const child = (id: string, description: string) => ({
      file: {
        id, role: 'child' as const, path: `devin://sessions/x/${id}`,
        agent: { agentId: id.slice('agent-'.length), description, agentType: 'Explore' },
      },
      updatedAt: 200, bytes: 10,
    })
    const rows = subagentRows(
      [],
      [
        child('agent-10d29d86', 'Review context devin synth + fold'),
        child('agent-a0be46c6', 'Review new replay/heal/routing code'),
        child('agent-d644a097', 'Review core devin adapter'),
      ],
      { fileId: 'agent-a0be46c6', title: 'a0be46c6 own transcript title' },
    )
    expect(rows.map(row => row.title)).toEqual([
      'Review context devin synth + fold',
      'Review new replay/heal/routing code',
      'Review core devin adapter',
    ])
  })
})

describe('SessionPane subagent view title', () => {
  test('a kimi child view is titled by its delegated prompt, not its directory id', () => {
    const route: Route = { kind: 'kimi', id: 'session_t', file: 'agent-1' }
    render(
      <SessionPane
        route={route}
        summary={null}
        onNavigate={() => {}}
        t={t}
        locale="en"
        durationStore={durationStore}
      />,
    )
    const source = FakeEventSource.instances.at(-1)
    expect(source?.url).toContain('file=agent-1')
    act(() => {
      source?.emit({ type: 'file', file: CHILD })
      source?.emit({ type: 'lines', file: CHILD, lines: LINES, startLine: 0 })
      source?.emit({ type: 'ready' })
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Survey the repo structure')
  })
})
