// @vitest-environment jsdom
/**
 * SSE reconnect: EventSource re-establishes the stream after a drop (server
 * restart, sleep/wake) and the server replays the session from the top on the
 * new socket. The runtime must refold from empty before those events land —
 * feeding the replay into the live parsers doubles every record.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionFileRef, SessionLiveEvent } from '@harness-trajectory/core'
import { SessionRuntime } from '../src/session-runtime.ts'

const MAIN: SessionFileRef = { id: 'sess-1', role: 'main', path: '/logs/sess-1.jsonl' }
const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const iso = (offset: number) => new Date(T0 + offset).toISOString()

const LINES: readonly string[] = [
  {
    type: 'user', uuid: 'u-0', sessionId: 'sess-1', cwd: '/work', timestamp: iso(0),
    message: { role: 'user', content: 'Fix the build' },
  },
  {
    type: 'assistant', uuid: 'a-1', sessionId: 'sess-1', timestamp: iso(1_000), requestId: 'req-1',
    message: {
      id: 'msg-1', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'On it.' }],
      stop_reason: 'end_turn',
    },
  },
].map(record => JSON.stringify(record))

/** An EventSource the spec drives by hand, `open()` firing the DOM open callback. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()
  onopen: ((event: Event) => void) | null = null
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

  /** A (re)connection — the first open is the initial connect, later ones are reconnects. */
  open(): void {
    this.onopen?.(new Event('open'))
  }

  emit(event: SessionLiveEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(new MessageEvent(event.type, { data: JSON.stringify(event) }))
    }
  }
}

/** Replay the whole transcript, as the server does on a fresh socket. */
function replay(source: FakeEventSource | undefined): void {
  source?.emit({ type: 'file', file: MAIN })
  source?.emit({ type: 'lines', file: MAIN, lines: [...LINES], startLine: 0 })
  source?.emit({ type: 'ready' })
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

describe('session runtime across an SSE reconnect', () => {
  test('the replayed stream refolds from empty — lines and folded state do not double', () => {
    const runtime = new SessionRuntime('claude', 'sess-1')
    runtime.start()
    const source = FakeEventSource.instances[0]
    source?.open()
    replay(source)

    expect(runtime.store.getSnapshot().lines).toBe(LINES.length)
    const nodesBefore = runtime.context.timelineOf('sess-1')?.nodes.length

    // The socket drops and EventSource re-establishes it: the server replays
    // the whole session on the same EventSource object.
    source?.open()
    expect(runtime.store.getSnapshot().loading).toBe(true)
    replay(source)

    const state = runtime.store.getSnapshot()
    // The replay must not accumulate onto the first pass.
    expect(state.lines).toBe(LINES.length)
    expect(state.files).toHaveLength(1)
    // The fold holds exactly the first pass's records — no second copies.
    expect(runtime.context.timelineOf('sess-1')?.nodes.length).toBe(nodesBefore)
    runtime.close()
  })

  test('the initial open is not mistaken for a reconnect', () => {
    const runtime = new SessionRuntime('claude', 'sess-1')
    runtime.start()
    const source = FakeEventSource.instances[0]
    source?.open()
    replay(source)
    expect(runtime.store.getSnapshot().lines).toBe(LINES.length)
    runtime.close()
  })
})
