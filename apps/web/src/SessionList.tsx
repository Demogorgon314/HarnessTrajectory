import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { SessionSummary } from '@harness-trajectory/core'
import { icons } from '@harness-trajectory/ui'
import type { Route } from './App.tsx'
import { HarnessMark, harnessMeta } from './harnesses.tsx'
import { sessionKeyOf, useNow } from './session-list.ts'
import css from './app.module.css'

const { IconFolderClose16, IconFolderOpen16, IconTriangleRightFill14 } = icons

/* Row heights stay fixed so `estimateSize` is exact: 34px project rows and
   32px session rows plus the uniform 2px gap each item carries on top. */
const GROUP_ITEM_HEIGHT = 36
const SESSION_ITEM_HEIGHT = 34
const TAIL_ITEM_HEIGHT = 30
/** Rows of a group expanded within this window get the unfold cascade. */
const EXPAND_CASCADE_MS = 700
/** Approaching the tail by this many rows fetches the next page. */
const LOAD_AHEAD_ROWS = 8
/** Idle ticks re-age `relativeTime` labels while a 304 keeps the data still. */
const NOW_TICK_MS = 30_000

export function relativeTime(epochMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - epochMs)
  const minutes = Math.round(delta / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  return new Date(epochMs).toLocaleDateString()
}

function projectName(cwd: string | null): string {
  if (cwd === null || cwd === '') return 'Unknown project'
  const parts = cwd.split('/').filter(part => part !== '')
  return parts.slice(-2).join('/') || cwd
}

/** Stable fold key for a project group. */
export function groupKey(cwd: string | null): string {
  return cwd ?? ''
}

function rowTooltip(session: SessionSummary): string {
  const meta = harnessMeta(session.kind)
  const lines = [session.title, meta.label + (session.model === null ? '' : ` · ${session.model}`)]
  if (session.cwd !== null) lines.push(session.cwd)
  lines.push(session.id)
  return lines.join('\n')
}

type ListItem =
  | {
    type: 'group'
    key: string
    /** The project's fold key (`groupKey(cwd)`), not the React key. */
    group: string
    cwd: string | null
    count: number
    expanded: boolean
    containsCurrent: boolean
  }
  | { type: 'session'; key: string; session: SessionSummary; delayMs: number | null }
  | { type: 'tail'; key: string }

export interface SessionListProps {
  sessions: readonly SessionSummary[]
  selected: Route | null
  onSelect: (route: Route) => void
  /** Group keys currently folded. */
  folded: ReadonlySet<string>
  onToggleGroup: (key: string) => void
  /** The first page answered (or failed): until then the list shows a loader. */
  ready: boolean
  /** More sessions sit below the loaded window. */
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  /**
   * True per-project totals under the active filters, keyed by `groupKey`
   * (`cwd`, `''` for none). Only a page of rows is loaded, so
   * `group.sessions.length` would under-count and grow while scrolling.
   */
  projectCounts: Readonly<Record<string, number>>
}

/**
 * The sidebar as one flat virtualized list: project headers and the sessions
 * of expanded groups, plus a tail sentinel whose approach fetches the next
 * page. Only the viewport's rows mount, so a loaded window of thousands of
 * sessions costs the same as a dozen.
 */
export function SessionList({
  sessions, selected, onSelect, folded, onToggleGroup, ready, hasMore, loadingMore, onLoadMore,
  projectCounts,
}: SessionListProps) {
  const listRef = useRef<HTMLDivElement | null>(null)
  // The nav unmounts under the loader/empty states and on sidebar collapse —
  // an effect keyed on the virtualizer (a stable useState instance) would keep
  // a stale null element forever. The element itself must be the dep.
  const [nav, setNav] = useState<HTMLDivElement | null>(null)
  const bindNav = useCallback((element: HTMLDivElement | null) => {
    listRef.current = element
    setNav(element)
  }, [])
  const now = useNow(NOW_TICK_MS)
  /** Group key → when it was last unfolded; all expanded groups start stamped. */
  const expandedAt = useRef(new Map<string, number>())
  const mountedAt = useRef(Date.now())

  const items = useMemo<readonly ListItem[]>(() => {
    const byProject = new Map<string, { cwd: string | null; sessions: SessionSummary[]; latest: number }>()
    for (const session of sessions) {
      const key = groupKey(session.cwd)
      let group = byProject.get(key)
      if (group === undefined) {
        group = { cwd: session.cwd, sessions: [], latest: 0 }
        byProject.set(key, group)
      }
      group.sessions.push(session)
      group.latest = Math.max(group.latest, session.updatedAt)
    }
    const groups = [...byProject.values()].sort((left, right) => right.latest - left.latest)
    const stamp = Date.now()
    const flat: ListItem[] = []
    for (const group of groups) {
      const key = groupKey(group.cwd)
      const expanded = !folded.has(key)
      flat.push({
        type: 'group',
        key: `g ${key}`,
        group: key,
        cwd: group.cwd,
        count: projectCounts[key] ?? group.sessions.length,
        expanded,
        containsCurrent: selected !== null
          && group.sessions.some(session => session.kind === selected.kind && session.id === selected.id),
      })
      if (!expanded) continue
      const unfoldedAt = expandedAt.current.get(key) ?? mountedAt.current
      const cascade = stamp - unfoldedAt < EXPAND_CASCADE_MS
      for (const [index, session] of group.sessions.entries()) {
        flat.push({
          type: 'session',
          key: `s ${sessionKeyOf(session)}`,
          session,
          delayMs: cascade ? Math.min(index, 8) * 24 : null,
        })
      }
    }
    if (hasMore) flat.push({ type: 'tail', key: 'tail' })
    return flat
  }, [sessions, folded, selected, hasMore, projectCounts])

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    estimateSize: (index) => {
      const item = items[index]
      return item?.type === 'group'
        ? GROUP_ITEM_HEIGHT
        : item?.type === 'tail' ? TAIL_ITEM_HEIGHT : SESSION_ITEM_HEIGHT
    },
    getItemKey: index => items[index]?.key ?? index,
    getScrollElement: () => listRef.current,
    initialRect: { width: 0, height: 800 },
    overscan: 12,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const virtualTop = virtualItems[0]?.start ?? 0
  const virtualBottom = virtualItems.length === 0
    ? 0
    : Math.max(0, virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0))

  // Scroll anchoring: a refresh or an appended page inserts rows mid-list
  // (sessions join already-visible groups, new group headers splice into the
  // sorted order), shifting every item below the insertion point. Keep the
  // first visible row's viewport offset steady so the list never jumps under
  // the user. The tail is deliberately NOT an anchor — pinning it would keep
  // the sentinel in view and auto-chain every remaining page.
  const anchor = useRef<{ key: string; offset: number } | null>(null)
  useEffect(() => {
    if (nav === null) return
    const capture = () => {
      const first = virtualizer.getVirtualItems()
        .find(row => row.end > nav.scrollTop) ?? virtualizer.getVirtualItems().at(-1)
      anchor.current = first === undefined || first.key === 'tail'
        ? null
        : { key: String(first.key), offset: nav.scrollTop - first.start }
    }
    nav.addEventListener('scroll', capture, { passive: true })
    return () => { nav.removeEventListener('scroll', capture) }
  }, [nav, virtualizer])

  useLayoutEffect(() => {
    const held = anchor.current
    const element = listRef.current
    if (held === null || element === null) return
    const index = items.findIndex(item => item.key === held.key)
    if (index < 0) return
    // Heights are fixed estimates, so the row's new start is a prefix sum.
    let start = 0
    for (let at = 0; at < index; at += 1) {
      const item = items[at]
      start += item?.type === 'group' ? GROUP_ITEM_HEIGHT
        : item?.type === 'tail' ? TAIL_ITEM_HEIGHT : SESSION_ITEM_HEIGHT
    }
    const target = start + held.offset
    if (Math.abs(element.scrollTop - target) > 1) element.scrollTop = target
  }, [items])

  // The tail sentinel scrolling into view (or near it) fetches the next page.
  const lastVirtual = virtualItems.at(-1)
  useEffect(() => {
    if (!hasMore || loadingMore || lastVirtual === undefined) return
    if (lastVirtual.index >= items.length - 1 - LOAD_AHEAD_ROWS) onLoadMore()
  }, [hasMore, loadingMore, lastVirtual, items.length, onLoadMore])

  // A selection made elsewhere (a search hit, a shared link) scrolls to its row.
  const selectedKey = selected === null ? null : `${selected.kind}/${selected.id}`
  useEffect(() => {
    if (selectedKey === null) return
    const index = items.findIndex(item =>
      item.type === 'session' && sessionKeyOf(item.session) === selectedKey)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
    // Only the selection drives the scroll — re-running on `items` would yank
    // the scroll position on every appended page.
  }, [selectedKey])

  const toggle = (key: string) => {
    if (folded.has(key)) expandedAt.current.set(key, Date.now())
    onToggleGroup(key)
  }

  if (!ready) return <div className={css.listEmpty}>Loading…</div>
  if (sessions.length === 0) return <div className={css.listEmpty}>No sessions found.</div>
  return (
    <nav ref={bindNav} className={css.list} aria-label="Sessions" role="tree">
      <div style={{ height: virtualTop }} aria-hidden="true" />
      {virtualItems.map((virtualItem) => {
        const item = items[virtualItem.index]
        if (item === undefined) return null
        if (item.type === 'group') {
          return (
            <div key={virtualItem.key} className={css.listItem} data-kind="group">
              <div
                className={css.projectRow}
                role="treeitem"
                aria-expanded={item.expanded}
                tabIndex={0}
                title={item.cwd ?? undefined}
                onClick={() => { toggle(item.group) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggle(item.group)
                  }
                }}
              >
                <span className={css.slot} data-role="folder" data-active={(item.expanded && item.containsCurrent) || undefined}>
                  {item.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
                </span>
                <span className={css.slot} data-role="chevron" data-open={item.expanded || undefined}>
                  <IconTriangleRightFill14 className={css.arrow} />
                </span>
                <span className={css.title}>{projectName(item.cwd)}</span>
                <span className={css.time}>{item.count}</span>
              </div>
            </div>
          )
        }
        if (item.type === 'tail') {
          return (
            <div key={virtualItem.key} className={css.listTail}>
              {loadingMore ? 'Loading…' : ''}
            </div>
          )
        }
        const session = item.session
        const active = selectedKey === sessionKeyOf(session)
        const meta = harnessMeta(session.kind)
        return (
          <div key={virtualItem.key} className={css.listItem} data-kind="session">
            <div
              className={css.sessionRow}
              role="treeitem"
              aria-selected={active}
              tabIndex={0}
              data-active={active || undefined}
              data-animate={item.delayMs !== null || undefined}
              title={rowTooltip(session)}
              style={item.delayMs === null ? undefined : { animationDelay: `${item.delayMs}ms` }}
              onClick={() => { onSelect({ kind: session.kind, id: session.id }) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect({ kind: session.kind, id: session.id })
                }
              }}
            >
              {/* Status slot: the harness mark, with a live dot while the transcript is being written. */}
              <span
                className={css.slot}
                data-role="mark"
                data-live={session.live || undefined}
                aria-label={session.live ? `${meta.label}, live` : meta.label}
              >
                <HarnessMark kind={session.kind} size={14} />
              </span>
              <span className={css.title}>{session.title}</span>
              <span className={css.time}>{relativeTime(session.updatedAt, now)}</span>
            </div>
          </div>
        )
      })}
      <div style={{ height: virtualBottom }} aria-hidden="true" />
    </nav>
  )
}
