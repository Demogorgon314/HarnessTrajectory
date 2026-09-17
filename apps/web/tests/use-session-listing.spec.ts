// @vitest-environment jsdom
/**
 * The listing state machine (`useSessionListing`): epoch invalidation on
 * filter changes, `?rev=` conditional polls, cursor paging with dedupe, and
 * the >500-row tail-keep that must neither lose nor duplicate rows.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SessionListPage, SessionSummary } from '@harness-trajectory/core'
import { useSessionListing } from '../src/use-session-listing.ts'
import { sessionKeyOf } from '../src/session-list.ts'

vi.mock('../src/api.ts', () => ({ listSessions: vi.fn() }))
import { listSessions } from '../src/api.ts'

const mocked = vi.mocked(listSessions)
const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const NO_KINDS = new Set<never>()

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, kind: 'claude', title: `session ${id}`, cwd: '/work/p', model: null,
    startedAt: T0, updatedAt: T0, bytes: 1, live: false, childCount: 0, promptCount: 1,
    ...over,
  }
}

function page(rows: readonly SessionSummary[], nextCursor: string | null = null, revision = 1): SessionListPage {
  return {
    revision,
    sessions: [...rows],
    nextCursor,
    counts: { claude: rows.length },
    projectCounts: { '/work/p': rows.length },
  }
}

const callArgs = (at: number) => mocked.mock.calls[at]?.[0]

/** A window `focus` event is the cheap way to fire a refresh without timers. */
async function focus() {
  await act(async () => { window.dispatchEvent(new Event('focus')) })
}

function renderListing(initial: { kinds?: ReadonlySet<never>; listQuery?: string } = {}) {
  return renderHook(
    ({ kinds, listQuery }) => useSessionListing(kinds, listQuery),
    { initialProps: { kinds: initial.kinds ?? NO_KINDS, listQuery: initial.listQuery ?? '' } },
  )
}

afterEach(() => {
  cleanup()
  mocked.mockReset()
})

describe('useSessionListing', () => {
  test('the first page fills the window with counts and a cursor', async () => {
    mocked.mockResolvedValue(page([summary('a'), summary('b')], 'c1', 7))
    const { result } = renderListing()
    await act(async () => {})
    expect(result.current.listReady).toBe(true)
    expect(result.current.sessions.map(s => s.id)).toEqual(['a', 'b'])
    expect(result.current.hasMore).toBe(true)
    expect(result.current.counts.get('claude')).toBe(2)
    expect(result.current.projectCounts['/work/p']).toBe(2)
    expect(callArgs(0)).toMatchObject({ limit: 100 })
  })

  test('an idle poll sends rev; a 304 keeps the same array', async () => {
    const rows = [summary('a'), summary('b')]
    mocked.mockResolvedValueOnce(page(rows, null, 7))
    const { result } = renderListing()
    await act(async () => {})
    const before = result.current.sessions

    mocked.mockResolvedValueOnce(null) // 304
    await focus()
    expect(callArgs(1)).toMatchObject({ rev: 7 })
    expect(result.current.sessions).toBe(before)
  })

  test('a session inside the live window withholds rev', async () => {
    mocked.mockResolvedValueOnce(page([summary('hot', { updatedAt: Date.now() })], null, 7))
    const { result } = renderListing()
    await act(async () => {})

    mocked.mockResolvedValueOnce(page([summary('hot', { updatedAt: Date.now() })], null, 8))
    await focus()
    expect(callArgs(1)).not.toHaveProperty('rev')
  })

  test('a filter change keeps the old window until the new page lands', async () => {
    mocked.mockResolvedValueOnce(page([summary('a'), summary('b')], 'c1', 7))
    const { result, rerender } = renderListing()
    await act(async () => {})
    const old = result.current.sessions

    // The new filter's first page is still in flight: nothing may collapse.
    let resolveNext: ((p: SessionListPage | null) => void) | undefined
    mocked.mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve }))
    rerender({ kinds: NO_KINDS, listQuery: 'needle' })
    expect(result.current.sessions).toBe(old)
    expect(result.current.listReady).toBe(true)
    expect(callArgs(1)).toMatchObject({ query: 'needle' })
    expect(callArgs(1)).not.toHaveProperty('rev')
    expect(callArgs(1)).not.toHaveProperty('cursor')

    await act(async () => { resolveNext?.(page([summary('x')], null, 8)) })
    expect(result.current.sessions.map(s => s.id)).toEqual(['x'])
    // The new epoch's rev is what the next poll uses.
    mocked.mockResolvedValueOnce(null)
    await focus()
    expect(callArgs(2)).toMatchObject({ rev: 8 })
  })

  test('loadMore appends deduped rows and walks the cursor chain', async () => {
    mocked.mockResolvedValueOnce(page([summary('a'), summary('b')], 'c1', 1))
    const { result } = renderListing()
    await act(async () => {})

    mocked.mockResolvedValueOnce(page([summary('b'), summary('c')], 'c2', 2))
    await act(async () => { await result.current.loadMore() })
    expect(callArgs(1)).toMatchObject({ cursor: 'c1' })
    expect(result.current.sessions.map(s => s.id)).toEqual(['a', 'b', 'c'])

    mocked.mockResolvedValueOnce(page([summary('d')], null, 3))
    await act(async () => { await result.current.loadMore() })
    expect(result.current.sessions.map(s => s.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.current.hasMore).toBe(false)
  })

  test('a failed page keeps its cursor so the next approach retries', async () => {
    mocked.mockResolvedValueOnce(page([summary('a')], 'c1', 1))
    const { result } = renderListing()
    await act(async () => {})

    mocked.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await result.current.loadMore() })
    expect(result.current.hasMore).toBe(true)

    mocked.mockResolvedValueOnce(page([summary('b')], null, 2))
    await act(async () => { await result.current.loadMore() })
    expect(callArgs(2)).toMatchObject({ cursor: 'c1' })
    expect(result.current.sessions.map(s => s.id)).toEqual(['a', 'b'])
  })

  test('a stale epoch cannot write: in-flight pages die with their filter', async () => {
    let resolveFirst: ((p: SessionListPage | null) => void) | undefined
    mocked.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    const { result, rerender } = renderListing()
    await act(async () => {})

    mocked.mockResolvedValueOnce(page([summary('new')], null, 9))
    rerender({ kinds: NO_KINDS, listQuery: 'q2' })
    // The first epoch's response lands late and must be dropped.
    await act(async () => { resolveFirst?.(page([summary('stale')], 'cx', 1)) })
    await act(async () => {})
    expect(result.current.sessions.map(s => s.id)).toEqual(['new'])
  })

  test('replace beyond the page cap keeps the tail by key — no loss, no dupes', async () => {
    // 600 loaded rows: a 500 first page plus a 100-row cursor page.
    const first500 = Array.from({ length: 500 }, (_, i) => summary(`s${i}`))
    mocked.mockResolvedValueOnce(page(first500, 'c500', 1))
    const { result } = renderListing()
    await act(async () => {})
    const next100 = Array.from({ length: 100 }, (_, i) => summary(`s${500 + i}`))
    mocked.mockResolvedValueOnce(page(next100, 'c600', 2))
    await act(async () => { await result.current.loadMore() })
    expect(result.current.sessions).toHaveLength(600)
    const old = result.current.sessions

    // Refresh: a new row Z lands on top AND tail row s550 moved into the
    // window. The page (server-capped at 500) = [Z, s0..s497, s550].
    const moved = old[550]!
    const fresh = [summary('z', { updatedAt: T0 + 9_000_000 }), ...old.slice(0, 498), moved]
    expect(fresh).toHaveLength(500)
    mocked.mockResolvedValueOnce(page(fresh, 'c550', 3))
    await focus()

    const loaded = result.current.sessions
    // 601 rows: 500 fresh + the uncovered tail (s498, s499, s500..s549,
    // s551..s599). No duplicates, and the displaced s498/s499 are not lost.
    expect(loaded).toHaveLength(601)
    expect(new Set(loaded.map(sessionKeyOf)).size, 'no duplicate keys').toBe(loaded.length)
    expect(loaded.map(s => s.id)).toContain('s498')
    expect(loaded.map(s => s.id)).toContain('s499')
    expect(loaded[0]?.id).toBe('z')
    expect(loaded.filter(s => s.id === 's550')).toHaveLength(1)
    // The moved row is the fresh object, not the stale tail copy.
    expect(loaded[499]).toBe(moved)
  })
})
