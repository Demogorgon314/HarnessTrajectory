import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HARNESS_KINDS, type HarnessKind, type SessionSummary } from '@harness-trajectory/core'
import {
  createTrajectoryDurationStore, createTrajectoryTranslate, icons, Tooltip, useSnapshotSelector,
  type TrajectoryLocale,
} from '@harness-trajectory/ui'
import { listSessions } from './api.ts'
import { DragHandle } from './DragHandle.tsx'
import { HarnessFilter } from './HarnessFilter.tsx'
import { SessionList } from './SessionList.tsx'
import { SessionPane } from './SessionPane.tsx'
import { IndexProgress, SessionSearch } from './SessionSearch.tsx'
import { SettingsDialog } from './SettingsDialog.tsx'
import {
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, clampSidebarWidth, setSidebarCollapsed, setSidebarWidth,
  sidebarStore, toggleGroupFold,
} from './sidebar-store.ts'
import { themeStore, type ThemePreference } from './theme.ts'
import css from './app.module.css'

const { IconPanelLeftOutline16, IconSettingsOutline16 } = icons

const LIST_REFRESH_MS = 5_000
/** Wide content stays mounted this long after a collapse so it can fade out. */
const COLLAPSE_SETTLE_MS = 150
const THEME_CYCLE: readonly ThemePreference[] = ['system', 'light', 'dark']
const EMPTY_KINDS: ReadonlySet<HarnessKind> = new Set()

/** The pane's tabs; `trajectory` is the address without a tab segment. */
export type SessionTab = 'trajectory' | 'context'

export interface Route {
  kind: HarnessKind
  id: string
  /**
   * Child (subagent) transcript id when the TRAJECTORY view folds one subagent
   * on its own (`/agent/<id>`); the stream then serves that file alone.
   */
  file?: string
  /** The open tab; absent means the trajectory. */
  tab?: SessionTab
  /**
   * Context tab only: which of the session's folded transcripts the dashboard
   * shows (`/context/<id>`). Unlike `file` this does NOT narrow the stream —
   * the Context tab folds every file of the session at once.
   */
  agent?: string
  /**
   * Record anchor a content-search hit aimed at: the 0-based JSONL line index
   * inside the addressed transcript, carried as `?line=N` so the address stays
   * shareable. `SessionPane` hands it to the trajectory, which resolves it
   * through the fold's line index and scrolls to the record it produced.
   * It is deliberately NOT part of `runtimeKey`: moving the anchor inside an
   * open session must not reopen its stream.
   */
  line?: number
}

// Kinds are lowercase words, so no escaping is needed to join them into an alternation.
// Ids are percent-encoded, so `?` only ever starts the query tail.
const ROUTE_KIND_PATTERN = new RegExp(`^#/(${HARNESS_KINDS.join('|')})/([^/?]+)(?:/(agent|context)(?:/([^/?]+))?)?$`)

/** `?line=N`: a 0-based record anchor. Anything else is no anchor at all. */
function parseLine(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('line')
  // `Number('')` is 0, so an empty value must not read as line zero.
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

export function parseHash(hash: string): Route | null {
  const queryAt = hash.indexOf('?')
  const path = queryAt < 0 ? hash : hash.slice(0, queryAt)
  const line = queryAt < 0 ? undefined : parseLine(hash.slice(queryAt + 1))
  const match = ROUTE_KIND_PATTERN.exec(path)
  if (match === null) return null
  const section = match[3]
  const tail = match[4]
  const base = {
    kind: match[1] as HarnessKind,
    id: decodeURIComponent(match[2] ?? ''),
    ...(line === undefined ? {} : { line }),
  }
  if (section === 'agent') {
    // `/agent` with no id is not an address of its own.
    if (tail === undefined) return base
    return { ...base, file: decodeURIComponent(tail) }
  }
  if (section === 'context') {
    return { ...base, tab: 'context', ...(tail === undefined ? {} : { agent: decodeURIComponent(tail) }) }
  }
  return base
}

/** Hash for a route; both tail segments keep the parent session as the address root. */
export function routeHash(route: Route): string {
  const base = `#/${route.kind}/${encodeURIComponent(route.id)}`
  const path = route.tab === 'context'
    ? (route.agent === undefined ? `${base}/context` : `${base}/context/${encodeURIComponent(route.agent)}`)
    : (route.file === undefined ? base : `${base}/agent/${encodeURIComponent(route.file)}`)
  return route.line === undefined ? path : `${path}?line=${route.line}`
}

/**
 * The runtime identity of a route: the stream a pane opens. Both tabs of one
 * session share it, so switching tabs (or agents inside the Context tab)
 * never reopens the stream.
 */
export function runtimeKey(route: Route): string {
  return `${route.kind}/${route.id}/${route.file ?? ''}`
}

function useHashRoute(): [Route | null, (route: Route | null) => void] {
  const [route, setRoute] = useState<Route | null>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => { setRoute(parseHash(window.location.hash)) }
    window.addEventListener('hashchange', onChange)
    return () => { window.removeEventListener('hashchange', onChange) }
  }, [])
  const navigate = useCallback((next: Route | null) => {
    const hash = next === null ? '' : routeHash(next)
    // Re-selecting the SAME address fires no `hashchange`, so a search hit that
    // is already open would never re-arm its record anchor. Publish a fresh
    // route object instead; the pane's stream identity (`runtimeKey`) is
    // unchanged, so nothing reopens.
    if (hash !== '' && window.location.hash === hash) {
      setRoute(next)
      return
    }
    window.location.hash = hash
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
  const [settingsOpen, setSettingsOpen] = useState(false)
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
          <Tooltip label="Settings" delayMs={500}>
            <button
              type="button"
              className={css.iconButton}
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => { setSettingsOpen(true) }}
            >
              <IconSettingsOutline16 size={16} />
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
                placeholder="Search title, project, id, content"
                value={query}
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              />
            </div>
            <IndexProgress />
            {listError !== null && <div className={css.listError}>{listError}</div>}
            <SessionList
              sessions={filtered}
              selected={route}
              onSelect={navigate}
              folded={folded}
              onToggleGroup={toggleGroupFold}
            />
            {/* The slow half of the same query: hits from the server's index. */}
            <SessionSearch query={query} kinds={kinds} selected={route} onSelect={navigate} />
          </>
        )}
      </aside>
      <main className={css.main}>
        {route === null
          ? (
            <div className={css.empty}>
              <div className={css.emptyTitle}>Pick a session</div>
              <div className={css.emptyHint}>
                Sessions are scanned from <code>~/.claude/projects</code>, <code>~/.codex/sessions</code>,{' '}
                <code>~/.kimi-code/sessions</code>, and <code>~/.grok/sessions</code> on this machine.
                Running sessions update live.
              </div>
            </div>
          )
          : (
            <SessionPane
              key={runtimeKey(route)}
              route={route}
              summary={selectedSummary}
              onNavigate={navigate}
              t={t}
              locale={locale}
              durationStore={durationStore}
            />
          )}
      </main>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!collapsed && (
        <DragHandle left={sidebarWidth} onStart={onDragStart} onDrag={onDrag} onEnd={onDragEnd} />
      )}
      <SettingsDialog open={settingsOpen} onClose={() => { setSettingsOpen(false) }} />
    </div>
  )
}
