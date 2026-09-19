// @vitest-environment jsdom
/**
 * The record anchor a content-search hit carries (`?line=N`, `Route.line`)
 * travelling from the address into the open trajectory: the pane folds the
 * streamed lines, resolves the line to its record, and scrolls to it — without
 * ever reopening the stream.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createTrajectoryDurationStore, createTrajectoryTranslate } from '@harness-trajectory/ui'
import type { SessionFileRef, SessionLiveEvent } from '@harness-trajectory/core'
import type { Route } from '../src/App.tsx'
import { SessionPane } from '../src/SessionPane.tsx'

const t = createTrajectoryTranslate('en')
const durationStore = createTrajectoryDurationStore()

const MAIN: SessionFileRef = { id: 'main-1', role: 'main', path: '/logs/main-1.jsonl' }
const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const iso = (offset: number) => new Date(T0 + offset).toISOString()

/** A claude transcript: prompt, a Bash call, its result, the answer. */
const LINES: readonly string[] = [
  {
    type: 'user', uuid: 'u-0', sessionId: 'main-1', cwd: '/work', timestamp: iso(0),
    message: { role: 'user', content: 'Fix the build' },
  },
  {
    type: 'assistant', uuid: 'a-1', sessionId: 'main-1', timestamp: iso(1_000), requestId: 'req-1',
    message: {
      id: 'msg-1', role: 'assistant', model: 'claude-test',
      content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'make' } }],
      stop_reason: 'tool_use',
    },
  },
  {
    type: 'user', uuid: 'r-2', sessionId: 'main-1', cwd: '/work', timestamp: iso(2_000),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'built' }] },
  },
  {
    type: 'assistant', uuid: 'a-3', sessionId: 'main-1', timestamp: iso(3_000), requestId: 'req-2',
    message: {
      id: 'msg-2', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'All green.' }],
      stop_reason: 'end_turn',
    },
  },
].map(record => JSON.stringify(record))

/** An EventSource the spec drives by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()
  onerror: ((event: Event) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
  }

  emit(event: SessionLiveEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(new MessageEvent(event.type, { data: JSON.stringify(event) }))
    }
  }
}

function open(route: Route) {
  return render(
    <SessionPane
      route={route}
      summary={null}
      onNavigate={() => {}}
      t={t}
      locale="en"
      durationStore={durationStore}
    />,
  )
}

/** Replay the whole transcript into the newest stream, as the server would. */
function replay(): void {
  const source = FakeEventSource.instances.at(-1)
  act(() => {
    source?.emit({ type: 'file', file: MAIN })
    source?.emit({ type: 'lines', file: MAIN, lines: LINES, startLine: 0 })
    source?.emit({ type: 'ready' })
  })
}

function selectedRows(): (string | null)[] {
  return screen.getAllByRole('row')
    .filter(row => row.getAttribute('aria-selected') === 'true')
    .map(row => row.textContent)
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SessionPane record anchor', () => {
  test('Chat resolves streamed search hits and switching views keeps the same stream', () => {
    const route: Route = { kind: 'claude', id: 'main-1', tab: 'chat', line: 2 }
    const navigate = vi.fn()
    const props = { summary: null, onNavigate: navigate, t, locale: 'en' as const, durationStore }
    const view = render(<SessionPane {...props} route={route} />)
    replay()
    expect(view.container.querySelector('[data-selected]')?.textContent).toContain('Bash')
    expect(view.container.querySelector<HTMLDetailsElement>('[data-call-id="call-1"]')?.open).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))
    expect(navigate).toHaveBeenLastCalledWith({ kind: 'claude', id: 'main-1', line: 2 })
    view.rerender(<SessionPane {...props} route={{ kind: 'claude', id: 'main-1', line: 2 }} />)
    expect(selectedRows().join()).toMatch(/Bash/)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.closed).toBe(false)
  })
  test('an address without an anchor selects nothing', () => {
    open({ kind: 'claude', id: 'main-1' })
    replay()
    expect(selectedRows()).toEqual([])
  })

  test('an anchored address opens the record that line folded into', () => {
    open({ kind: 'claude', id: 'main-1', line: 2 })
    replay()
    // Line 2 is the tool RESULT record, which folds into the call's row.
    expect(selectedRows().join()).toMatch(/Bash/)
  })

  test('the anchor waits for the record and then lands on it', () => {
    open({ kind: 'claude', id: 'main-1', line: 0 })
    // Nothing folded yet: the request is held rather than dropped.
    expect(screen.queryAllByRole('row')).toHaveLength(0)
    replay()
    expect(selectedRows().join()).toMatch(/Fix the build/)
  })

  test('moving the anchor inside an open session never reopens the stream', () => {
    const { rerender } = open({ kind: 'claude', id: 'main-1', line: 0 })
    replay()
    expect(selectedRows().join()).toMatch(/Fix the build/)
    expect(FakeEventSource.instances).toHaveLength(1)

    // A second hit in the same session: a new route object, same stream.
    rerender(
      <SessionPane
        route={{ kind: 'claude', id: 'main-1', line: 2 }}
        summary={null}
        onNavigate={() => {}}
        t={t}
        locale="en"
        durationStore={durationStore}
      />,
    )
    expect(selectedRows().join()).toMatch(/Bash/)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.closed).toBe(false)
  })
})
