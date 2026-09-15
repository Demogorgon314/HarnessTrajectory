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
