/** Browser client for the local server API. */

import type { HarnessKind, SessionDetail, SessionLiveEvent, SessionSummary } from '@harness-trajectory/core'

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return await response.json() as T
}

export function listSessions(options: { kind?: HarnessKind | undefined; query?: string | undefined } = {}): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (options.kind !== undefined) params.set('kind', options.kind)
  if (options.query !== undefined && options.query !== '') params.set('q', options.query)
  const suffix = params.size === 0 ? '' : `?${params.toString()}`
  return getJson(`/api/sessions${suffix}`)
}

export function getSession(kind: HarnessKind, id: string): Promise<SessionDetail> {
  return getJson(`/api/sessions/${kind}/${encodeURIComponent(id)}`)
}

export interface LiveStream {
  close(): void
}

/**
 * Open the live event stream of a session. The server replays existing
 * content, sends `ready`, then keeps appending until closed.
 */
export function openSessionStream(
  kind: HarnessKind,
  id: string,
  handlers: {
    onEvent: (event: SessionLiveEvent) => void
    onError?: (error: Event) => void
  },
): LiveStream {
  const source = new EventSource(`/api/sessions/${kind}/${encodeURIComponent(id)}/events`)
  const forward = (message: MessageEvent<string>) => {
    if (message.data === '') return
    let event: SessionLiveEvent
    try {
      event = JSON.parse(message.data) as SessionLiveEvent
    } catch {
      return
    }
    handlers.onEvent(event)
  }
  for (const type of ['lines', 'file', 'meta', 'ready'] as const) {
    source.addEventListener(type, forward as EventListener)
  }
  if (handlers.onError !== undefined) source.onerror = handlers.onError
  return { close: () => { source.close() } }
}
