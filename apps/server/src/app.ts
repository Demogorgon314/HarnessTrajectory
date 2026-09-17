/** HTTP API: session listing, detail, live SSE stream, and the built web UI. */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  HARNESS_KINDS, SEARCH_DEFAULT_LIMIT, SEARCH_INDEXING_IDLE, SEARCH_MAX_LIMIT, SEARCH_MIN_QUERY_LENGTH,
  type HarnessKind, type SearchResponse, type SessionListPage, type SessionLiveEvent, type SessionSummary,
} from '@harness-trajectory/core'
import { scopeToFile, summaryOrderKey, type SessionSource } from './index.ts'
import { search, type SearchService } from './search/index.ts'
import type { SettingsController } from './settings.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

function isKind(value: string): value is HarnessKind {
  return (HARNESS_KINDS as readonly string[]).includes(value)
}

const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500

/**
 * A cursor is the last served row's position in the listing's total order
 * (`compareSummaries`: `updatedAt` desc, `kind`/`id` asc): sessions inserted
 * above it never shift what "the next page" means.
 */
interface ListCursor {
  updatedAt: number
  key: string
}

function listCursorOf(session: SessionSummary): string {
  return `${session.updatedAt}:${session.kind}:${encodeURIComponent(session.id)}`
}

function parseListCursor(raw: string | undefined): ListCursor | null {
  if (raw === undefined) return null
  const first = raw.indexOf(':')
  const second = first < 0 ? -1 : raw.indexOf(':', first + 1)
  if (first <= 0 || second <= first) return null
  const updatedAt = Number(raw.slice(0, first))
  if (!Number.isFinite(updatedAt)) return null
  try {
    return { updatedAt, key: `${raw.slice(first + 1, second)}/${decodeURIComponent(raw.slice(second + 1))}` }
  } catch {
    return null
  }
}

/** Whether `session` sorts strictly after the cursor row. */
function afterListCursor(session: SessionSummary, cursor: ListCursor): boolean {
  return session.updatedAt < cursor.updatedAt
    || (session.updatedAt === cursor.updatedAt && summaryOrderKey(session) > cursor.key)
}

export interface AppOptions {
  index: SessionSource
  /** Directory holding the built web UI; omitted or missing disables static serving. */
  staticDir?: string | undefined
  /**
   * Full-text index; omitted (search is off by default) disables `/api/search`.
   * A getter because the Content search toggle starts and stops the service
   * at runtime — routes must see the current state, not the startup one.
   */
  search?: (() => SearchService | undefined) | undefined
  /** Server settings backing `/api/settings`; omitted disables those routes. */
  settings?: SettingsController | undefined
}

/** The shape `/api/search` answers with when nothing is indexed. */
function searchDisabled(query: string): SearchResponse {
  return {
    enabled: false,
    query,
    minLength: SEARCH_MIN_QUERY_LENGTH,
    groups: [],
    totalHits: 0,
    truncated: false,
    indexing: SEARCH_INDEXING_IDLE,
  }
}

export function createApp({ index, staticDir, search: searchService, settings }: AppOptions): Hono {
  const app = new Hono()
  const currentSearch = (): SearchService | undefined => searchService?.()
  /**
   * Bumped on every source `'change'`: `/api/sessions?rev=` answers 304 while
   * the listing is untouched, so idle polls never serialize or transfer.
   */
  let listRevision = 0
  index.on('change', () => { listRevision += 1 })

  app.get('/api/health', (c) => {
    const service = currentSearch()
    const indexing = service === undefined ? SEARCH_INDEXING_IDLE : service.indexer.stats()
    return c.json({
      ok: true,
      search: { enabled: service !== undefined, indexing },
    })
  })

  /**
   * Server settings, persisted to `settings.json` under the cache directory.
   * The web dialog mirrors them: it renders only what these routes answer.
   */
  if (settings !== undefined) {
    app.get('/api/settings', (c) => {
      return c.json({ ...settings.read(), searchEnabled: currentSearch() !== undefined })
    })
    app.put('/api/settings', async (c) => {
      const body = await c.req.json().catch(() => undefined)
      if (body === undefined) return c.json({ error: 'invalid JSON body' }, 400)
      const update = settings.update(body)
      return c.json({ ...update.value, purged: update.purged, searchEnabled: currentSearch() !== undefined })
    })
  }

  /**
   * The sidebar's session listing, paged by `?cursor=` (from `nextCursor`) at
   * `?limit=` rows, filterable by `?kind=a,b` and `?q=` (title/cwd/id
   * substring). `?rev=` is the client's last seen revision: a match means
   * nothing changed since — filters included — and answers 304 with no body.
   * `counts` facets per kind under `q` so the harness filter stays complete
   * while only a page of rows is loaded.
   */
  app.get('/api/sessions', (c) => {
    // `?rev=` short-circuits only a first-page request: a cursor page is a
    // different slice of the same listing and must always get its body. The
    // revision is global, so it cannot be bound to this request's kind/q —
    // the client contract is to send `rev` only for the same filter it was
    // issued under (a filter change must reset it).
    const cursorParam = c.req.query('cursor')
    const rev = c.req.query('rev')
    if (cursorParam === undefined && rev !== undefined && Number(rev) === listRevision) {
      return c.body(null, 304)
    }
    const kindParam = c.req.query('kind')
    const kinds = new Set((kindParam ?? '').split(',').filter(isKind))
    const kindsFilter = kinds.size === 0 ? null : kinds
    const query = (c.req.query('q') ?? '').trim().toLowerCase()
    const requested = Number(c.req.query('limit') ?? LIST_DEFAULT_LIMIT)
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(Math.floor(requested), LIST_MAX_LIMIT))
      : LIST_DEFAULT_LIMIT
    const cursor = parseListCursor(cursorParam)

    const queried = index.list().filter(session =>
      query === ''
      || session.title.toLowerCase().includes(query)
      || (session.cwd ?? '').toLowerCase().includes(query)
      || session.id.toLowerCase().includes(query))
    const counts: SessionListPage['counts'] = {}
    for (const session of queried) counts[session.kind] = (counts[session.kind] ?? 0) + 1
    let filtered = kindsFilter === null ? queried : queried.filter(session => kindsFilter.has(session.kind))
    // Project totals share the kind filter (they describe what the loaded
    // groups contain), so they're counted before the cursor narrows the page.
    // Null-prototype: a cwd like "constructor" must not read an inherited member.
    const projectCounts: Record<string, number> = Object.create(null)
    for (const session of filtered) {
      const key = session.cwd ?? ''
      projectCounts[key] = (projectCounts[key] ?? 0) + 1
    }
    if (cursor !== null) filtered = filtered.filter(session => afterListCursor(session, cursor))
    const sessions = filtered.slice(0, limit)
    const last = sessions[sessions.length - 1]
    const page: SessionListPage = {
      revision: listRevision,
      sessions,
      nextCursor: filtered.length > limit && last !== undefined ? listCursorOf(last) : null,
      counts,
      projectCounts,
    }
    return c.json(page)
  })

  /**
   * Full-text search across every indexed transcript. Hits are grouped by
   * session and addressed by `(kind, sessionId, fileId, line)`, so the UI can
   * open the session, select the right transcript and scroll to the record.
   */
  app.get('/api/search', (c) => {
    const query = (c.req.query('q') ?? '').trim()
    const service = currentSearch()
    if (service === undefined) return c.json(searchDisabled(query))
    const kind = c.req.query('kind')
    const requested = Number(c.req.query('limit') ?? SEARCH_DEFAULT_LIMIT)
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(Math.floor(requested), SEARCH_MAX_LIMIT))
      : SEARCH_DEFAULT_LIMIT
    return c.json(search(service.store, {
      q: query,
      ...(kind !== undefined && isKind(kind) ? { kind } : {}),
      limit,
      // Title, cwd and last activity live in the session index, not in SQLite.
      describe: (hitKind, sessionId) => index.facts(hitKind, sessionId),
      indexing: service.indexer.stats(),
    }))
  })

  app.get('/api/sessions/:kind/:id', (c) => {
    const kind = c.req.param('kind')
    if (!isKind(kind)) return c.json({ error: 'unknown harness kind' }, 404)
    const detail = index.get(kind, c.req.param('id'))
    if (detail === undefined) return c.json({ error: 'session not found' }, 404)
    return c.json(detail)
  })

  /**
   * One offloaded image of a kimi transcript: `blobref:<mime>;<sha256>` refs
   * whose bytes live in the agent's per-file `blobs/` store. The hash is
   * content-addressed, so the response is immutable.
   */
  app.get('/api/sessions/:kind/:id/blob', async (c) => {
    const kind = c.req.param('kind')
    if (!isKind(kind)) return c.json({ error: 'unknown harness kind' }, 404)
    const match = /^blobref:([^;,]+);([0-9a-f]{16,64})$/.exec(c.req.query('ref') ?? '')
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return c.json({ error: 'bad blobref' }, 400)
    }
    const fileId = c.req.query('file') ?? c.req.param('id')
    const path = index.blobPath?.(kind, c.req.param('id'), fileId, match[2]) ?? null
    if (path === null) return c.json({ error: 'blob not found' }, 404)
    try {
      const body = await readFile(path)
      return c.body(body, 200, {
        'content-type': match[1],
        'cache-control': 'public, max-age=31536000, immutable',
      })
    } catch {
      return c.json({ error: 'blob not found' }, 404)
    }
  })

  /**
   * One stream per open session: existing content first (file + lines events,
   * chunked), then live appends until the client disconnects. `?file=<childId>`
   * narrows the stream to one subagent transcript, served as its own session.
   */
  app.get('/api/sessions/:kind/:id/events', (c) => {
    const kind = c.req.param('kind')
    const id = c.req.param('id')
    const fileId = c.req.query('file')
    if (!isKind(kind) || index.get(kind, id) === undefined) {
      return c.json({ error: 'session not found' }, 404)
    }
    if (fileId !== undefined && !index.hasChild(kind, id, fileId)) {
      return c.json({ error: 'child transcript not found' }, 404)
    }
    return streamSSE(c, async (stream) => {
      let closed = false
      let counter = 0
      const queue: SessionLiveEvent[] = []
      let replaying = true
      const send = async (event: SessionLiveEvent): Promise<void> => {
        if (closed) return
        counter += 1
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event), id: String(counter) })
      }
      const unsubscribe = index.subscribe(kind, id, (raw) => {
        const event = fileId === undefined ? raw : scopeToFile(raw, fileId)
        if (event === null) return
        if (replaying) queue.push(event)
        else void send(event)
      })
      stream.onAbort(() => {
        closed = true
        unsubscribe()
      })
      try {
        const pending: Promise<void>[] = []
        await index.readAll(kind, id, (event) => { pending.push(send(event)) }, fileId)
        await Promise.all(pending)
        replaying = false
        for (const event of queue.splice(0)) await send(event)
        await send({ type: 'ready' })
        // Chrome's EventSource stops draining a large replay (~2 MB buffered) until the
        // next write reaches the socket, so a multi-MB session used to settle only at
        // the next keepalive — in 15 s multiples. A short burst of fast pings right
        // after `ready` unsticks it; idle streams then fall back to the cheap cadence.
        let burst = 20
        while (!closed) {
          await stream.sleep(burst > 0 ? 250 : 15_000)
          if (burst > 0) burst -= 1
          if (!closed) await stream.writeSSE({ event: 'ping', data: '' })
        }
      } finally {
        closed = true
        unsubscribe()
      }
    })
  })

  if (staticDir !== undefined && existsSync(staticDir)) {
    app.get('/*', async (c) => {
      const requested = normalize(decodeURIComponent(new URL(c.req.url).pathname))
      const relative = requested === '/' ? '/index.html' : requested
      const path = join(staticDir, relative)
      if (!path.startsWith(staticDir)) return c.notFound()
      const target = existsSync(path) ? path : join(staticDir, 'index.html')
      try {
        const body = await readFile(target)
        const type = MIME[extname(target)] ?? 'application/octet-stream'
        const cache = target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
        return c.body(body, 200, { 'content-type': type, 'cache-control': cache })
      } catch {
        return c.notFound()
      }
    })
  }

  return app
}
