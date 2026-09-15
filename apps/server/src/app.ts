/** HTTP API: session listing, detail, live SSE stream, and the built web UI. */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { HARNESS_KINDS, type HarnessKind, type SessionLiveEvent } from '@harness-trajectory/core'
import { scopeToFile, type SessionIndex } from './index.ts'

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

export interface AppOptions {
  index: SessionIndex
  /** Directory holding the built web UI; omitted or missing disables static serving. */
  staticDir?: string | undefined
}

export function createApp({ index, staticDir }: AppOptions): Hono {
  const app = new Hono()

  app.get('/api/health', c => c.json({ ok: true }))

  app.get('/api/sessions', (c) => {
    const kind = c.req.query('kind')
    const query = (c.req.query('q') ?? '').trim().toLowerCase()
    let sessions = index.list()
    if (kind !== undefined && isKind(kind)) sessions = sessions.filter(session => session.kind === kind)
    if (query !== '') {
      sessions = sessions.filter(session =>
        session.title.toLowerCase().includes(query)
        || (session.cwd ?? '').toLowerCase().includes(query)
        || session.id.toLowerCase().includes(query))
    }
    return c.json(sessions)
  })

  app.get('/api/sessions/:kind/:id', (c) => {
    const kind = c.req.param('kind')
    if (!isKind(kind)) return c.json({ error: 'unknown harness kind' }, 404)
    const detail = index.get(kind, c.req.param('id'))
    if (detail === undefined) return c.json({ error: 'session not found' }, 404)
    return c.json(detail)
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
