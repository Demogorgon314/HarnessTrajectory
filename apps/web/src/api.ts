/** Browser client for the local server API. */

import {
  SEARCH_MIN_QUERY_LENGTH,
  type HarnessKind, type SearchResponse, type SessionDetail, type SessionLiveEvent, type SessionSummary,
} from '@harness-trajectory/core'

/** A non-2xx answer, carrying the status so callers can act on it. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

async function getJson<T>(url: string, signal?: AbortSignal | undefined): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    // `exactOptionalPropertyTypes`: never hand `fetch` an explicit undefined signal.
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new HttpError(response.status, `${response.status} ${response.statusText} for ${url}`)
  return await response.json() as T
}

export function listSessions(options: { kind?: HarnessKind | undefined; query?: string | undefined } = {}): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (options.kind !== undefined) params.set('kind', options.kind)
  if (options.query !== undefined && options.query !== '') params.set('q', options.query)
  const suffix = params.size === 0 ? '' : `?${params.toString()}`
  return getJson(`/api/sessions${suffix}`)
}

export interface SearchRequest {
  /** Raw query; the server decides whether it is long enough to answer. */
  q: string
  /** Narrow to one harness; omitted, every indexed harness answers. */
  kind?: HarnessKind | undefined
  /** Cap on returned hits across all groups. */
  limit?: number | undefined
  /** Cancels the request when the query moves on. */
  signal?: AbortSignal | undefined
}

/** What a server without the search route is saying: the index is off. */
function searchDisabled(query: string): SearchResponse {
  return {
    enabled: false,
    query,
    minLength: SEARCH_MIN_QUERY_LENGTH,
    groups: [],
    totalHits: 0,
    truncated: false,
    indexing: { pendingFiles: 0, ready: true },
  }
}

/**
 * Full-text search over the indexed transcripts. Rejects with an `AbortError`
 * when `signal` fires, which callers treat as "superseded", not as a failure.
 */
export async function searchSessions(request: SearchRequest): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: request.q })
  if (request.kind !== undefined) params.set('kind', request.kind)
  if (request.limit !== undefined) params.set('limit', String(request.limit))
  const url = `/api/search?${params.toString()}`
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    // `exactOptionalPropertyTypes`: never hand `fetch` an explicit undefined signal.
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  // A build that serves no search route either 404s or falls through to the
  // app's own HTML. Both mean "this server has no index", not a failure worth
  // painting red in the sidebar.
  if (response.status === 404 || !(response.headers.get('content-type') ?? '').includes('json')) {
    return searchDisabled(request.q)
  }
  if (!response.ok) throw new HttpError(response.status, `${response.status} ${response.statusText} for ${url}`)
  return await response.json() as SearchResponse
}

export function getSession(kind: HarnessKind, id: string): Promise<SessionDetail> {
  return getJson(`/api/sessions/${kind}/${encodeURIComponent(id)}`)
}

export interface LiveStream {
  close(): void
}

/**
 * Open the live event stream of a session. The server replays existing
 * content, sends `ready`, then keeps appending until closed. With `file`,
 * only that child transcript streams, served as a session of its own.
 */
export function openSessionStream(
  kind: HarnessKind,
  id: string,
  handlers: {
    onEvent: (event: SessionLiveEvent) => void
    onError?: (error: Event) => void
  },
  options: { file?: string | undefined } = {},
): LiveStream {
  const suffix = options.file === undefined ? '' : `?file=${encodeURIComponent(options.file)}`
  const source = new EventSource(`/api/sessions/${kind}/${encodeURIComponent(id)}/events${suffix}`)
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
