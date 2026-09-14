import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HarnessKind, SessionSummary } from '@harness-trajectory/core'
import {
  createTrajectoryDurationStore, createTrajectoryTranslate, icons, Tooltip, useSnapshotSelector,
  type TrajectoryLocale,
} from '@harness-trajectory/ui'
import { listSessions } from './api.ts'
import { DragHandle } from './DragHandle.tsx'
import { HarnessFilter } from './HarnessFilter.tsx'
import { SessionList } from './SessionList.tsx'
import { SessionPane } from './SessionPane.tsx'
import {
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, clampSidebarWidth, setSidebarCollapsed, setSidebarWidth,
  sidebarStore, toggleGroupFold,
} from './sidebar-store.ts'
import { themeStore, type ThemePreference } from './theme.ts'
import css from './app.module.css'

const { IconPanelLeftOutline16 } = icons

const LIST_REFRESH_MS = 5_000
/** Wide content stays mounted this long after a collapse so it can fade out. */
const COLLAPSE_SETTLE_MS = 150
const THEME_CYCLE: readonly ThemePreference[] = ['system', 'light', 'dark']
const EMPTY_KINDS: ReadonlySet<HarnessKind> = new Set()

export interface Route {
  kind: HarnessKind
  id: string
}

function parseHash(hash: string): Route | null {
  const match = /^#\/(claude|codex)\/([^/]+)$/.exec(hash)
  if (match === null) return null
  return { kind: match[1] as HarnessKind, id: decodeURIComponent(match[2] ?? '') }
}

function useHashRoute(): [Route | null, (route: Route | null) => void] {
  const [route, setRoute] = useState<Route | null>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => { setRoute(parseHash(window.location.hash)) }
    window.addEventListener('hashchange', onChange)
    return () => { window.removeEventListener('hashchange', onChange) }
  }, [])
  const navigate = useCallback((next: Route | null) => {
    window.location.hash = next === null ? '' : `#/${next.kind}/${encodeURIComponent(next.id)}`
  }, [])
  return [route, navigate]
}

function defaultLocale(): TrajectoryLocale {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function themeGlyph(theme: ThemePreference): string {
  return theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'
}

/** Track the frame's own width with a rAF-throttled ResizeObserver. */
function useFrameWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    let frame: number | null = null
    const measure = () => {
      frame = null
      const next = element.getBoundingClientRect().width
      if (next > 0) setWidth(next)
    }
    measure()
    const observer = new ResizeObserver(() => { frame ??= requestAnimationFrame(measure) })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [ref])
  return width
}

export function App() {
  const [route, navigate] = useHashRoute()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [kinds, setKinds] = useState<ReadonlySet<HarnessKind>>(EMPTY_KINDS)
  const [query, setQuery] = useState('')
  const [locale, setLocale] = useState<TrajectoryLocale>(defaultLocale)
  const t = useMemo(() => createTrajectoryTranslate(locale), [locale])
  const durationStore = useMemo(() => createTrajectoryDurationStore(), [])
  const theme = useSnapshotSelector(themeStore, value => value)
  const sidebar = useSnapshotSelector(sidebarStore, value => value)
  const folded = useMemo(() => new Set(sidebar.foldedGroups), [sidebar.foldedGroups])

  // -- sidebar geometry ----------------------------------------------------
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = useFrameWidth(frameRef)
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  // On a narrow frame the sidebar rests collapsed; expanding it there is a
  // session-only choice that does not overwrite the wide-frame preference.
  const [narrowExpanded, setNarrowExpanded] = useState(false)
  const collapsed = narrow ? !narrowExpanded : sidebar.collapsed
  const toggleSidebar = useCallback(() => {
    if (narrow) setNarrowExpanded(value => !value)
    else setSidebarCollapsed(!sidebar.collapsed)
  }, [narrow, sidebar.collapsed])
  const [dragging, setDragging] = useState(false)
  const dragBase = useRef(sidebar.width)
  const onDragStart = useCallback(() => {
    dragBase.current = sidebarStore.getSnapshot().width
    setDragging(true)
  }, [])
  const onDrag = useCallback((dx: number) => { setSidebarWidth(clampSidebarWidth(dragBase.current + dx)) }, [])
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const sidebarWidth = collapsed ? SIDEBAR_COLLAPSED : sidebar.width

  // Wide content stays mounted while the collapse animates, unmounts at
  // settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) {
      setSettled(false)
      return
    }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled
  const lastWideWidth = useRef(sidebar.width)
  if (!collapsed) lastWideWidth.current = sidebar.width

  // -- session list ----------------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      setSessions(await listSessions())
      setListError(null)
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, LIST_REFRESH_MS)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const counts = useMemo(() => {
    const map = new Map<HarnessKind, number>()
    for (const session of sessions) map.set(session.kind, (map.get(session.kind) ?? 0) + 1)
    return map
  }, [sessions])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions.filter(session =>
      (kinds.size === 0 || kinds.has(session.kind))
      && (needle === ''
        || session.title.toLowerCase().includes(needle)
        || (session.cwd ?? '').toLowerCase().includes(needle)
        || session.id.toLowerCase().includes(needle)))
  }, [sessions, kinds, query])

  const selectedSummary = useMemo(
    () => (route === null ? null : sessions.find(s => s.kind === route.kind && s.id === route.id) ?? null),
    [route, sessions],
  )

  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar'

  return (
    <div
      ref={frameRef}
      className={css.app}
      style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
      data-sidebar-collapsed={collapsed || undefined}
      data-dragging={dragging || undefined}
    >
      <aside
        className={css.sidebar}
        data-collapsed={!wide || undefined}
        data-fading={(collapsed && wide) || undefined}
        style={wide ? { width: collapsed ? lastWideWidth.current : sidebar.width } : undefined}
      >
        <header className={css.brand}>
          {wide && (
            <span className={css.brandIdentity}>
              <span className={css.brandMark} aria-hidden="true">⟿</span>
              <span className={css.brandName}>Harness Trajectory</span>
            </span>
          )}
          {/* Collapsed, the rail rests as the brand mark and hovering reveals the panel icon. */}
          <Tooltip label={toggleLabel} delayMs={500}>
            <button
              type="button"
              className={css.toggle}
              aria-label={toggleLabel}
              aria-expanded={!collapsed}
              onClick={toggleSidebar}
            >
              {!wide && <span className={css.railMark} aria-hidden="true">⟿</span>}
              <IconPanelLeftOutline16 className={css.panelIcon} size={wide ? 16 : 18} />
            </button>
          </Tooltip>
        </header>
        <div className={css.controls}>
          {wide && <HarnessFilter selected={kinds} onChange={setKinds} counts={counts} />}
          <span className={css.controlsSpacer} />
          <Tooltip label={`Theme: ${theme}`} delayMs={500}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={`Theme: ${theme}`}
              onClick={() => {
                const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length] ?? 'system'
                themeStore.set(next)
              }}
            >
              {themeGlyph(theme)}
            </button>
          </Tooltip>
          <Tooltip label="Language" delayMs={500}>
            <button
              type="button"
              className={css.iconButton}
              aria-label="Language"
              onClick={() => { setLocale(locale === 'en' ? 'zh' : 'en') }}
            >
              {locale === 'en' ? 'EN' : '中'}
            </button>
          </Tooltip>
          {!wide && <HarnessFilter selected={kinds} onChange={setKinds} counts={counts} compact />}
        </div>
        {wide && (
          <>
            <div className={css.searchRow}>
              <input
                type="search"
                className={css.search}
                placeholder="Search title, project, id"
                value={query}
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              />
            </div>
            {listError !== null && <div className={css.listError}>{listError}</div>}
            <SessionList
              sessions={filtered}
              selected={route}
              onSelect={navigate}
              folded={folded}
              onToggleGroup={toggleGroupFold}
            />
          </>
        )}
      </aside>
      <main className={css.main}>
        {route === null
          ? (
            <div className={css.empty}>
              <div className={css.emptyTitle}>Pick a session</div>
              <div className={css.emptyHint}>
                Sessions are scanned from <code>~/.claude/projects</code> and <code>~/.codex/sessions</code> on this machine.
                Running sessions update live.
              </div>
            </div>
          )
          : (
            <SessionPane
              key={`${route.kind}/${route.id}`}
              kind={route.kind}
              id={route.id}
              summary={selectedSummary}
              t={t}
              durationStore={durationStore}
            />
          )}
      </main>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!collapsed && (
        <DragHandle left={sidebarWidth} onStart={onDragStart} onDrag={onDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
