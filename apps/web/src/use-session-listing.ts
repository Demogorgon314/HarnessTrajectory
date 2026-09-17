/**
 * The sidebar's session listing state machine: a paged window over
 * `GET /api/sessions`, polled on an interval, kept consistent across filter
 * changes by an epoch counter. Rendering reads the React state half; the ref
 * half (`ListingState`) exists because `refresh`/`loadMore` must see the
 * newest cursor/loaded synchronously — a `loadMore` landing between refresh
 * and render still has to see the cursor the render hasn't committed yet.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HarnessKind, SessionListPage, SessionSummary } from '@harness-trajectory/core'
import { listSessions } from './api.ts'
import { anySessionLive, appendSessions, mergeSessions, sessionKeyOf } from './session-list.ts'

/** Sessions per `/api/sessions` page; the sidebar fetches the next on scroll. */
export const LIST_PAGE = 100
const LIST_REFRESH_MS = 5_000

interface ListingState {
  /** Bumped on every filter change so in-flight responses die with their epoch. */
  epoch: number
  /** Last seen `/api/sessions` revision; sent as `?rev=` while nothing live shows. */
  rev: number | null
  /** Cursor for the next page; null ends the listing. */
  cursor: string | null
  /** The loaded window, newest first — the same objects `sessions` renders. */
  loaded: readonly SessionSummary[]
  /**
   * Whether the current epoch has already applied a first page. The
   * replace path's tail-keep may only run on covered windows — otherwise the
   * previous filter's leftover rows would glue onto the new listing.
   */
  covered: boolean
  moreLoading: boolean
}

const EMPTY_COUNTS: ReadonlyMap<HarnessKind, number> = new Map()
const EMPTY_PROJECT_COUNTS: Readonly<Record<string, number>> = {}

export interface SessionListing {
  sessions: readonly SessionSummary[]
  /** The first page answered (or failed): until then the list shows a loader. */
  listReady: boolean
  listError: string | null
  /** More sessions sit below the loaded window. */
  hasMore: boolean
  loadingMore: boolean
  /** Sessions per harness kind under the `q` filter (kind filter not applied). */
  counts: ReadonlyMap<HarnessKind, number>
  /** True per-project totals under the active filters (`''` = no cwd). */
  projectCounts: Readonly<Record<string, number>>
  loadMore: () => Promise<void>
}

export function useSessionListing(kinds: ReadonlySet<HarnessKind>, listQuery: string): SessionListing {
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [listReady, setListReady] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [counts, setCounts] = useState<ReadonlyMap<HarnessKind, number>>(EMPTY_COUNTS)
  const [projectCounts, setProjectCounts] = useState<Readonly<Record<string, number>>>(EMPTY_PROJECT_COUNTS)

  const list = useRef<ListingState>({
    epoch: 0, rev: null, cursor: null, loaded: [], covered: false, moreLoading: false,
  })

  const applyPage = useCallback((page: SessionListPage, mode: 'replace' | 'append') => {
    const s = list.current
    s.rev = page.revision
    s.cursor = page.nextCursor
    if (mode === 'append') {
      s.loaded = appendSessions(s.loaded, page.sessions)
    } else {
      const merged = mergeSessions(s.loaded, page.sessions)
      // The server caps one page at its own maximum; when the covered window
      // outgrew the page, keep the uncovered tail — minus whatever the page
      // already re-sent (a row that moved into the top window). Key-filtered,
      // not positional: an insert shifting the boundary must not lose or
      // duplicate the straddling row. The cursor chain re-walks the tail and
      // `appendSessions` dedupes it.
      s.loaded = s.covered && page.nextCursor !== null && page.sessions.length < s.loaded.length
        ? (() => {
          const fresh = new Set(merged.map(sessionKeyOf))
          return [...merged, ...s.loaded.filter(session => !fresh.has(sessionKeyOf(session)))]
        })()
        : merged
      s.covered = true
    }
    setSessions(s.loaded)
    setHasMore(s.cursor !== null)
    setCounts((prev) => {
      const next = new Map(Object.entries(page.counts) as [HarnessKind, number][])
      return prev.size === next.size && [...prev].every(([kind, count]) => next.get(kind) === count)
        ? prev : next
    })
    setProjectCounts((prev) => {
      const keys = Object.keys(page.projectCounts)
      return keys.length === Object.keys(prev).length
        && keys.every(key => prev[key] === page.projectCounts[key])
        ? prev : page.projectCounts
    })
  }, [])

  /**
   * Re-cover the loaded window (`limit` = what is shown) so new and updated
   * sessions merge in place; the cursor chain then continues below it. `?rev=`
   * goes out only while nothing on screen can silently stale — a live flag
   * flips on a clock, not on a `change` event.
   */
  const refresh = useCallback(async () => {
    const s = list.current
    const epoch = s.epoch
    const rev = s.rev !== null && !anySessionLive(s.loaded) ? s.rev : undefined
    try {
      const page = await listSessions({
        kinds,
        query: listQuery,
        limit: Math.max(LIST_PAGE, s.loaded.length),
        ...(rev === undefined ? {} : { rev }),
      })
      if (epoch !== s.epoch) return
      setListReady(true)
      setListError(null)
      if (page === null) return
      applyPage(page, 'replace')
    } catch (error) {
      if (epoch !== s.epoch) return
      setListReady(true)
      setListError(error instanceof Error ? error.message : String(error))
    }
  }, [applyPage, kinds, listQuery])

  const loadMore = useCallback(async () => {
    const s = list.current
    if (s.cursor === null || s.moreLoading) return
    const epoch = s.epoch
    const cursor = s.cursor
    s.moreLoading = true
    setLoadingMore(true)
    try {
      const page = await listSessions({ kinds, query: listQuery, limit: LIST_PAGE, cursor })
      if (epoch !== s.epoch || page === null) return
      applyPage(page, 'append')
    } catch {
      // A failed page keeps its cursor: the next pass near the bottom retries.
    } finally {
      s.moreLoading = false
      setLoadingMore(false)
    }
  }, [applyPage, kinds, listQuery])

  // A filter change restarts paging: cursor, revision and coverage belong to
  // the previous filter's listing. The rendered window stays up until the new
  // page lands — collapsing to a loader on every keystroke-settle is worse
  // than a brief stale list. `covered` going false is what keeps the old
  // filter's tail from gluing onto the first new page.
  useEffect(() => {
    const s = list.current
    s.epoch += 1
    s.rev = null
    s.cursor = null
    s.covered = false
    setHasMore(false)
    setListError(null)
    void refresh()
    const timer = setInterval(() => { void refresh() }, LIST_REFRESH_MS)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  return { sessions, listReady, listError, hasMore, loadingMore, counts, projectCounts, loadMore }
}
