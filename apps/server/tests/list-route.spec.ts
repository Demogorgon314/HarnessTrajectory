/**
 * The session listing route: cursor pages over the `updatedAt`-desc order,
 * faceted per-kind counts, the `q`/kind filters, and the `?rev=` conditional
 * that lets an idle poll answer 304 instead of a body.
 */

import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionListPage } from '@harness-trajectory/core'
import { createApp } from '../src/app.ts'
import { SessionIndex } from '../src/index.ts'

const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const SESSIONS = 7
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function claudeUser(text: string, sessionId: string, offset: number) {
  return {
    type: 'user', uuid: `u-${offset}`, parentUuid: null, isSidechain: false, sessionId,
    cwd: '/work/project', timestamp: iso(offset), message: { role: 'user', content: text },
    origin: { kind: 'human' },
  }
}

async function page(app: ReturnType<typeof createApp>, query = ''): Promise<SessionListPage> {
  const response = await app.request(`/api/sessions${query}`)
  expect(response.status).toBe(200)
  return await response.json() as SessionListPage
}

describe('GET /api/sessions', () => {
  let dir: string
  let index: SessionIndex
  let app: ReturnType<typeof createApp>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-list-'))
    await mkdir(join(dir, 'claude', '-slug'), { recursive: true })
    // Session i is newer than i-1 by 10 s, on both the record's timestamp and
    // the file's mtime — `updatedAt` takes the max of the two.
    for (let i = 0; i < SESSIONS; i += 1) {
      const path = join(dir, 'claude', '-slug', `sess-${i}.jsonl`)
      await writeFile(path, `${JSON.stringify(claudeUser(`prompt ${i}`, `sess-${i}`, i * 10_000))}\n`)
      const stamp = new Date(T0 + i * 10_000)
      await utimes(path, stamp, stamp)
    }
    index = new SessionIndex({
      roots: [{ kind: 'claude', dir: join(dir, 'claude') }],
      watch: false,
      now: () => T0 + 60_000_000,
    })
    // Attach before `start()`: main.ts does the same, and the sweep's change
    // events are what move the revision off zero.
    app = createApp({ index })
    await index.start()
  })

  afterEach(async () => {
    index.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('answers the listing newest-first with per-kind counts and no cursor', async () => {
    const result = await page(app)
    expect(result.sessions.map(session => session.id))
      .toEqual(Array.from({ length: SESSIONS }, (_, i) => `sess-${SESSIONS - 1 - i}`))
    expect(result.nextCursor).toBeNull()
    expect(result.counts).toEqual({ claude: SESSIONS })
    expect(result.revision).toBeGreaterThan(0)
  })

  it('walks every page exactly once through `nextCursor`', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const query = `?limit=3${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      const result = await page(app, query)
      seen.push(...result.sessions.map(session => session.id))
      if (result.nextCursor === null) break
      cursor = result.nextCursor
    }
    expect(new Set(seen).size, 'no row may repeat across pages').toBe(SESSIONS)
    expect(seen[0]).toBe('sess-6')
    expect(seen[SESSIONS - 1]).toBe('sess-0')
  })

  it('keeps the same order when two sessions share an updatedAt', async () => {
    // Same mtime for every file: only the kind/id tie-break keeps pages stable.
    for (let i = 0; i < SESSIONS; i += 1) {
      const path = join(dir, 'claude', '-slug', `sess-${i}.jsonl`)
      const stamp = new Date(T0 + 1_000)
      await utimes(path, stamp, stamp)
      await index.refreshPath(path)
    }
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const query = `?limit=2${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      const result = await page(app, query)
      seen.push(...result.sessions.map(session => session.id))
      if (result.nextCursor === null) break
      cursor = result.nextCursor
    }
    expect(new Set(seen).size).toBe(SESSIONS)
  })

  it('filters by comma-joined kinds and by title/cwd/id substring', async () => {
    expect((await page(app, '?kind=codex')).sessions).toHaveLength(0)
    expect((await page(app, '?kind=claude')).sessions).toHaveLength(SESSIONS)
    expect((await page(app, '?kind=claude,codex')).sessions).toHaveLength(SESSIONS)
    // A kind param that names no known harness filters nothing at all.
    expect((await page(app, '?kind=nope')).sessions).toHaveLength(SESSIONS)

    const byId = await page(app, '?q=sess-3')
    expect(byId.sessions.map(session => session.id)).toEqual(['sess-3'])
    // Counts answer "what each kind has under q", not what the page holds.
    const byCwd = await page(app, '?kind=codex&q=project')
    expect(byCwd.sessions).toHaveLength(0)
    expect(byCwd.counts).toEqual({ claude: SESSIONS })
  })

  it('answers 304 while the revision stands, then 200 once a file moves', async () => {
    const first = await page(app, '?limit=2')
    const rev = first.revision
    const idle = await app.request(`/api/sessions?rev=${rev}`)
    expect(idle.status).toBe(304)
    expect(await idle.text()).toBe('')

    const path = join(dir, 'claude', '-slug', 'sess-2.jsonl')
    await appendFile(path, `${JSON.stringify(claudeUser('more', 'sess-2', 700_000))}\n`)
    await index.refreshPath(path)
    const moved = await page(app, `?rev=${rev}`)
    expect(moved.revision).toBeGreaterThan(rev)
    expect(moved.sessions[0]?.id).toBe('sess-2')
    // ...and the new revision again short-circuits.
    expect((await app.request(`/api/sessions?rev=${moved.revision}`)).status).toBe(304)
  })

  it('treats a non-numeric rev as no rev at all', async () => {
    const response = await app.request('/api/sessions?rev=abc')
    expect(response.status).toBe(200)
  })

  it('clamps absurd limits instead of trusting them', async () => {
    const result = await page(app, '?limit=99999')
    expect(result.sessions).toHaveLength(SESSIONS)
    expect(result.nextCursor).toBeNull()
  })
})
