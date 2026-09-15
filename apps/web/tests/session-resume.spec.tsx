// @vitest-environment jsdom
/**
 * The session header's resume control: a short "resume" label plus the
 * Context card's icon-only copy (`lc-rich-copy`). Subagent views have no
 * resume command, so the control stays off those headers.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createTrajectoryDurationStore, createTrajectoryTranslate } from '@harness-trajectory/ui'
import type { SessionLiveEvent } from '@harness-trajectory/core'
import type { Route } from '../src/App.tsx'
import { SessionPane } from '../src/SessionPane.tsx'

const t = createTrajectoryTranslate('en')
const durationStore = createTrajectoryDurationStore()

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

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } })
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window.navigator, 'clipboard')
})

describe('SessionPane resume copy', () => {
  test('a main session shows resume plus the icon copy, and an accepted write copies the command', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    stubClipboard(async (text) => { writes.push(text) })
    open({ kind: 'claude', id: 'main-1' })
    expect(screen.queryByText('copy resume command')).toBeNull()
    expect(screen.getByText('resume')).toBeTruthy()
    const button = screen.getByRole('button', { name: /Copy the command that resumes this session/ })
    expect(button.className).toContain('lc-rich-copy')
    expect(button.className).not.toContain('lc-rich-copy-on')
    expect(button.getAttribute('title')).toBe('claude --resume main-1')
    await act(async () => { button.click() })
    expect(writes).toEqual(['claude --resume main-1'])
    expect(button.className).toContain('lc-rich-copy-on')
    await act(async () => { button.click() })
    expect(writes).toEqual(['claude --resume main-1'])
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(button.className).not.toContain('lc-rich-copy-on')
  })

  test('a subagent view has no resume control', () => {
    open({ kind: 'kimi', id: 'session_t', file: 'agent-1' })
    expect(screen.queryByText('resume')).toBeNull()
    expect(document.querySelector('.lc-rich-copy')).toBeNull()
  })
})
