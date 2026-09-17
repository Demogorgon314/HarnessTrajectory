// @vitest-environment jsdom
/**
 * The sidebar listing's client half: `mergeSessions`/`appendSessions` keep
 * object identity so unchanged rows never re-render, and `SessionList` renders
 * the flattened group/session list through the virtualizer — hundreds of
 * loaded sessions mount only the viewport's rows. The tail sentinel near the
 * bottom asks for the next page.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionSummary } from '@harness-trajectory/core'
import { SessionList } from '../src/SessionList.tsx'
import { anySessionLive, appendSessions, mergeSessions, sameSession } from '../src/session-list.ts'

const T0 = Date.parse('2026-09-14T10:00:00.000Z')

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-0',
    kind: 'claude',
    title: 'a session',
    cwd: '/work/project',
    model: null,
    startedAt: T0,
    updatedAt: T0,
    bytes: 100,
    live: false,
    childCount: 0,
    promptCount: 1,
    ...over,
  }
}

/** `count` sessions spread over `groups` projects, newest first. */
function listing(count: number, groups = 3): SessionSummary[] {
  return Array.from({ length: count }, (_, i) => summary({
    id: `sess-${i}`,
    title: `session ${i}`,
    cwd: `/work/project-${i % groups}`,
    updatedAt: T0 + (count - i) * 10_000,
  }))
}

afterEach(cleanup)

describe('mergeSessions', () => {
  test('keeps the identity of every unchanged summary', () => {
    const prev = listing(5)
    const next = [...listing(5)]
    const merged = mergeSessions(prev, next)
    for (const [at, session] of merged.entries()) {
      expect(session, `row ${at} must be the same object`).toBe(prev[at])
    }
  })

  test('returns the previous array itself when nothing moved at all', () => {
    const prev = listing(5)
    expect(mergeSessions(prev, listing(5))).toBe(prev)
  })

  test('swaps only the changed summary', () => {
    const prev = listing(5)
    const updated = { ...prev[1]!, title: 'renamed', updatedAt: T0 + 999_000 }
    const merged = mergeSessions(prev, [updated, ...prev.slice(1)])
    expect(merged[0]).toBe(updated)
    expect(merged[1]).toBe(prev[1])
    expect(merged).not.toBe(prev)
  })

  test('a reorder with identical objects still yields a new array', () => {
    const prev = listing(4)
    const reversed = [...prev].reverse()
    const merged = mergeSessions(prev, reversed)
    expect(merged).not.toBe(prev)
    expect(merged.map(session => session.id)).toEqual(reversed.map(session => session.id))
  })
})

describe('appendSessions', () => {
  test('appends a page and skips keys already loaded', () => {
    const prev = listing(3)
    const page = [summary({ id: 'sess-1', title: 'stale re-listing' }), summary({ id: 'sess-9' })]
    const merged = appendSessions(prev, page)
    expect(merged.map(session => session.id)).toEqual(['sess-0', 'sess-1', 'sess-2', 'sess-9'])
    expect(merged[1]?.title, 'the loaded row wins over the re-sent one').toBe('session 1')
  })

  test('returns the same array when the page adds nothing', () => {
    const prev = listing(3)
    expect(appendSessions(prev, [summary({ id: 'sess-1' })])).toBe(prev)
  })
})

describe('sameSession / anySessionLive', () => {
  test('every field counts', () => {
    const base = summary()
    expect(sameSession(base, { ...base })).toBe(true)
    expect(sameSession(base, { ...base, promptCount: 2 })).toBe(false)
    expect(sameSession(base, { ...base, live: true })).toBe(false)
  })

  test('a session inside the live window blocks `?rev=`', () => {
    const now = Date.now()
    expect(anySessionLive([summary({ updatedAt: now - 30_000 })], now)).toBe(true)
    expect(anySessionLive([summary({ updatedAt: now - 600_000 })], now)).toBe(false)
  })
})

describe('SessionList', () => {
  // The virtualizer measures the scroller through `offsetHeight`, which jsdom
  // leaves at 0 — without the stub it would see an empty viewport and mount
  // no rows at all.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  })
  afterEach(() => { vi.restoreAllMocks() })

  const base = {
    selected: null,
    onSelect: () => {},
    folded: new Set<string>(),
    onToggleGroup: () => {},
    ready: true,
    hasMore: false,
    onLoadMore: () => {},
    loadingMore: false,
    projectCounts: {} as Record<string, number>,
  }

  test('mounts only the viewport rows of a long listing', () => {
    const { container } = render(
      <SessionList {...base} sessions={listing(400)} hasMore={false} />,
    )
    const rows = container.querySelectorAll('[role="treeitem"]')
    expect(rows.length).toBeGreaterThan(0)
    // 400 sessions + 3 group headers would fill ~14k px; an 800px window shows ~30.
    expect(rows.length, 'the virtualizer must bound the DOM').toBeLessThan(80)
  })

  test('folded groups contribute their header but no rows', () => {
    const { container, queryByText } = render(
      <SessionList {...base} sessions={listing(60, 2)} folded={new Set(['/work/project-0'])} />,
    )
    expect(queryByText('work/project-0')).not.toBeNull()
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeLessThan(60)
  })

  test('group headers show the project total, not the loaded count', () => {
    // 3 loaded sessions in project-0 while the server says it really has 40.
    const sessions = listing(6, 3)
    const { queryByText } = render(
      <SessionList {...base} sessions={sessions} projectCounts={{ '/work/project-0': 40 }} />,
    )
    const header = queryByText('work/project-0')?.closest('[role="treeitem"]')
    expect(header?.textContent).toContain('40')
    // Groups the page didn't count fall back to their loaded size.
    const other = queryByText('work/project-1')?.closest('[role="treeitem"]')
    expect(other?.textContent).toContain('2')
  })

  test('the tail in view asks for the next page; without it nothing is asked', () => {
    const onLoadMore = vi.fn()
    render(<SessionList {...base} sessions={listing(10)} hasMore={true} onLoadMore={onLoadMore} />)
    expect(onLoadMore).toHaveBeenCalled()
    const quiet = vi.fn()
    render(<SessionList {...base} sessions={listing(10)} hasMore={false} onLoadMore={quiet} />)
    expect(quiet).not.toHaveBeenCalled()
  })

  test('a page landing mid-list holds the first visible row steady', () => {
    // 60 sessions over 3 projects = 63 flat items. Scroll into project-2's
    // run (its header sits at 1432, first session at 1468).
    const { container, rerender } = render(<SessionList {...base} sessions={listing(60, 3)} />)
    const nav = container.querySelector('[role="tree"]') as HTMLElement
    nav.scrollTop = 1500
    fireEvent.scroll(nav)

    // An appended page inserts 5 session rows inside project-0's run
    // (flat items 21..25): everything below moves down by 5*34 = 170px.
    const appended = [...listing(60, 3), ...Array.from({ length: 5 }, (_, i) => summary({
      id: `new-${i}`,
      cwd: '/work/project-0',
      updatedAt: T0 + 9_000_000,
    }))]
    rerender(<SessionList {...base} sessions={appended} />)
    expect(nav.scrollTop).toBe(1670)
  })

  test('the tail sentinel is not an anchor — resting at it never auto-follows', () => {
    const { container, rerender } = render(
      <SessionList {...base} sessions={listing(60, 3)} hasMore={true} />,
    )
    const nav = container.querySelector('[role="tree"]') as HTMLElement
    nav.scrollTop = 2200 // past the last item: the tail is the anchor candidate
    fireEvent.scroll(nav)

    const appended = [...listing(60, 3), ...Array.from({ length: 5 }, (_, i) => summary({
      id: `new-${i}`, cwd: '/work/project-0', updatedAt: T0 + 9_000_000,
    }))]
    rerender(<SessionList {...base} sessions={appended} hasMore={true} />)
    expect(nav.scrollTop).toBe(2200)
  })

  test('before the first answer it is a loader, then an empty listing says so', () => {
    const loading = render(<SessionList {...base} sessions={[]} ready={false} hasMore={false} />)
    expect(loading.container.textContent).toContain('Loading')
    loading.unmount()
    const empty = render(<SessionList {...base} sessions={[]} ready={true} hasMore={false} />)
    expect(empty.container.textContent).toContain('No sessions found')
  })
})
