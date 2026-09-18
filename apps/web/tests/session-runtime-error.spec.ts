// @vitest-environment jsdom
/**
 * Stream-error classification: EventSource.onerror does not expose the HTTP
 * status, so a dead child link 404s exactly like a dropped socket. The
 * runtime probes the session detail route — a confirmed-missing session or
 * child ends loading with an explicit error and closes the retry loop; an
 * unanswered probe leaves the native reconnect retrying.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionFileRef, SessionLiveEvent } from '@harness-trajectory/core'
import { SessionRuntime } from '../src/session-runtime.ts'

const MAIN: SessionFileRef = { id: 'sess-1', role: 'main', path: '/logs/sess-1.jsonl' }
const CHILD: SessionFileRef = {
  id: 'agent-a0be46c6',
  role: 'child',
  path: 'devin://sessions/sess-1/agent-a0be46c6',
  parentId: 'sess-1',
  agent: { agentId: 'a0be46c6' },
}

/** A `SessionDetail` skeleton — the probe only reads `children[].file.id`. */
function detailWith(childIds: string[]): Record<string, unknown> {
  return {
    children: childIds.map(id => ({
      file: { id, role: 'child', path: `devin://sessions/sess-1/${id}` },
      updatedAt: 0,
      bytes: 0,
    })),
  }
}

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

  open(): void {
    this.onopen?.(new Event('open'))
  }

  /** The socket dropped (or the GET itself failed) — the browser retries. */
  error(): void {
    this.onerror?.(new Event('error'))
  }

  emit(event: SessionLiveEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(new MessageEvent(event.type, { data: JSON.stringify(event) }))
    }
  }
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response
}

function httpResponse(status: number): Response {
  return { ok: false, status, statusText: `status ${status}` } as Response
}

/** Let the probe's fetch + promise chain settle. */
async function settle(): Promise<void> {
  for (let at = 0; at < 8; at += 1) await Promise.resolve()
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

describe('session runtime stream-error classification', () => {
  test('a dead child link ends loading with an explicit error and closes the stream', async () => {
    // The session exists, but the announced children do not include the
    // requested file — a stale `?file=<agentId>` link from before bindings
    // were stream ids.
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(detailWith(['agent-a0be46c6']))))
    const runtime = new SessionRuntime('devin', 'sess-1', 'a0be46c6')
    runtime.start()
    const source = FakeEventSource.instances[0]
    source?.error()
    await settle()
    const state = runtime.store.getSnapshot()
    expect(state.loading).toBe(false)
    expect(state.connected).toBe(false)
    expect(state.error).toContain('a0be46c6')
    expect(source?.closed).toBe(true)
    // A retrying socket would keep firing onerror — the dead stream does not.
    expect(FakeEventSource.instances).toHaveLength(1)
    runtime.close()
  })

  test('a missing session ends loading with an explicit error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(httpResponse(404)))
    const runtime = new SessionRuntime('devin', 'gone-1')
    runtime.start()
    const source = FakeEventSource.instances[0]
    source?.error()
    await settle()
    const state = runtime.store.getSnapshot()
    expect(state.loading).toBe(false)
    expect(state.error).toContain('gone-1')
    expect(source?.closed).toBe(true)
    runtime.close()
  })

  test('an unanswered probe keeps the stream retrying — reconnect refolds cleanly', async () => {
    // The probe itself cannot reach the server: nothing is confirmed missing.
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    const runtime = new SessionRuntime('devin', 'sess-1')
    runtime.start()
    const source = FakeEventSource.instances[0]
    source?.open()
    source?.emit({ type: 'file', file: MAIN })
    source?.emit({ type: 'ready' })
    source?.error()
    await settle()
    let state = runtime.store.getSnapshot()
    expect(state.connected).toBe(false)
    expect(state.error).toBeNull()
    expect(source?.closed).toBe(false)
    // EventSource's native retry lands: replay refolds from empty.
    source?.open()
    source?.emit({ type: 'file', file: MAIN })
    source?.emit({ type: 'ready' })
    state = runtime.store.getSnapshot()
    expect(state.connected).toBe(true)
    expect(state.error).toBeNull()
    runtime.close()
  })

  test('a child listed in the detail is a transient drop, not a dead link', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(detailWith(['agent-a0be46c6']))))
    const runtime = new SessionRuntime('devin', 'sess-1', 'agent-a0be46c6')
    runtime.start()
    const source = FakeEventSource.instances[0]
    source?.error()
    await settle()
    const state = runtime.store.getSnapshot()
    expect(state.connected).toBe(false)
    expect(state.error).toBeNull()
    expect(source?.closed).toBe(false)
    runtime.close()
  })

  test('a probe resolving after the stream recovered does not clobber it', async () => {
    const pending: ((response: Response) => void)[] = []
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => pending.push(resolve)))
    const runtime = new SessionRuntime('devin', 'sess-1', 'stale-file')
    runtime.start()
    const source = FakeEventSource.instances[0]
    source?.open()
    source?.emit({ type: 'ready' })
    source?.error()
    // The socket recovers before the probe answers: the verdict is stale.
    source?.open()
    source?.emit({ type: 'file', file: MAIN })
    source?.emit({ type: 'ready' })
    pending[0]?.(jsonResponse(detailWith([])))
    await settle()
    const state = runtime.store.getSnapshot()
    expect(state.connected).toBe(true)
    expect(state.error).toBeNull()
    expect(source?.closed).toBe(false)
    runtime.close()
  })

  test('a probe started by a failed FIRST connect dies when the retry opens', async () => {
    // The retry's open is the stream's first success — `onReconnect` does not
    // fire for it (there is no prior open to reconnect FROM), so the epoch
    // only moves because `onOpen` bumps it. Without that, a late "missing"
    // answer would close a healthy connection.
    const pending: ((response: Response) => void)[] = []
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => pending.push(resolve)))
    const runtime = new SessionRuntime('devin', 'sess-1', 'stale-file')
    runtime.start()
    const source = FakeEventSource.instances[0]
    // Initial connect attempt fails; the probe launches while the socket
    // retries underneath.
    source?.error()
    // The retry lands — the FIRST open this stream ever sees.
    source?.open()
    source?.emit({ type: 'file', file: MAIN })
    source?.emit({ type: 'ready' })
    // The stale probe finally answers "missing" — too late to matter.
    pending[0]?.(jsonResponse(detailWith([])))
    await settle()
    const state = runtime.store.getSnapshot()
    expect(state.connected).toBe(true)
    expect(state.error).toBeNull()
    expect(source?.closed).toBe(false)
    runtime.close()
  })

  test('a new disconnect probes again while an older probe is still unanswered', async () => {
    // The probe slot is epoch-scoped: an in-flight request from the previous
    // outage must not suppress the next disconnect's check — otherwise a
    // dead-child 404 surfacing on the second failure never gets its verdict.
    const pending: ((response: Response) => void)[] = []
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => pending.push(resolve)))
    const runtime = new SessionRuntime('devin', 'sess-1', 'stale-file')
    runtime.start()
    const source = FakeEventSource.instances[0]
    source?.open()
    source?.emit({ type: 'ready' })
    // First failure: one probe — a second onerror in the SAME outage does
    // not double-fetch.
    source?.error()
    source?.error()
    expect(pending).toHaveLength(1)
    // Recovery, then a NEW failure while the first probe is still in flight.
    source?.open()
    source?.emit({ type: 'ready' })
    source?.error()
    expect(pending).toHaveLength(2)
    // The stale probe's "missing" verdict drops; the live probe's applies.
    pending[0]?.(jsonResponse(detailWith([])))
    await settle()
    expect(runtime.store.getSnapshot().error).toBeNull()
    pending[1]?.(jsonResponse(detailWith([])))
    await settle()
    const state = runtime.store.getSnapshot()
    expect(state.loading).toBe(false)
    expect(state.error).toContain('stale-file')
    expect(source?.closed).toBe(true)
    runtime.close()
  })

  test('a line the parser throws on is skipped; the rest of the batch still folds', () => {
    const runtime = new SessionRuntime('claude', 'sess-1')
    runtime.start()
    const source = FakeEventSource.instances[0]
    source?.open()
    source?.emit({ type: 'file', file: MAIN })
    const parser = (runtime as unknown as { parser: { push: (line: string) => void } }).parser
    const pushed: string[] = []
    vi.spyOn(parser, 'push').mockImplementation((line: string) => {
      pushed.push(line)
      if (pushed.length === 2) throw new Error('boom')
    })
    source?.emit({ type: 'lines', file: MAIN, lines: ['l-1', 'l-2', 'l-3'], startLine: 0 })
    source?.emit({ type: 'ready' })
    // The throw on line 2 neither dropped line 3 nor lost the batch's count.
    expect(pushed).toEqual(['l-1', 'l-2', 'l-3'])
    expect(runtime.store.getSnapshot().lines).toBe(3)
    runtime.close()
  })
})
