import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HarnessKind, SessionSummary } from '@harness-trajectory/core'
import {
  createTrajectoryDurationStore, createTrajectoryTranslate, useSnapshotSelector,
  type TrajectoryLocale,
} from '@harness-trajectory/ui'
import { listSessions } from './api.ts'
import { SessionList } from './SessionList.tsx'
import { SessionPane } from './SessionPane.tsx'
import { themeStore, type ThemePreference } from './theme.ts'
import css from './app.module.css'

const LIST_REFRESH_MS = 5_000
const KIND_FILTERS: readonly { value: HarnessKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
]
const THEME_CYCLE: readonly ThemePreference[] = ['system', 'light', 'dark']

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

export function App() {
  const [route, navigate] = useHashRoute()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [kind, setKind] = useState<HarnessKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [locale, setLocale] = useState<TrajectoryLocale>(defaultLocale)
  const t = useMemo(() => createTrajectoryTranslate(locale), [locale])
  const durationStore = useMemo(() => createTrajectoryDurationStore(), [])
  const theme = useSnapshotSelector(themeStore, value => value)

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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions.filter(session =>
      (kind === 'all' || session.kind === kind)
      && (needle === ''
        || session.title.toLowerCase().includes(needle)
        || (session.cwd ?? '').toLowerCase().includes(needle)
        || session.id.toLowerCase().includes(needle)))
  }, [sessions, kind, query])

  const selectedSummary = useMemo(
    () => (route === null ? null : sessions.find(s => s.kind === route.kind && s.id === route.id) ?? null),
    [route, sessions],
  )

  return (
    <div className={css.app}>
      <aside className={css.sidebar}>
        <header className={css.brand}>
          <span className={css.brandMark} aria-hidden="true">⟿</span>
          <span className={css.brandName}>Harness Trajectory</span>
          <div className={css.brandActions}>
            <button
              type="button"
              className={css.iconButton}
              title={`Theme: ${theme}`}
              onClick={() => {
                const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length] ?? 'system'
                themeStore.set(next)
              }}
            >
              {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
            </button>
            <button
              type="button"
              className={css.iconButton}
              title="Language"
              onClick={() => { setLocale(locale === 'en' ? 'zh' : 'en') }}
            >
              {locale === 'en' ? 'EN' : '中'}
            </button>
          </div>
        </header>
        <div className={css.filters}>
          <div className={css.kinds} role="radiogroup" aria-label="Harness">
            {KIND_FILTERS.map(filter => (
              <button
                key={filter.value}
                type="button"
                role="radio"
                aria-checked={kind === filter.value}
                className={css.kind}
                data-active={kind === filter.value || undefined}
                onClick={() => { setKind(filter.value) }}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            className={css.search}
            placeholder="Search title, project, id"
            value={query}
            onChange={(event) => { setQuery(event.currentTarget.value) }}
          />
        </div>
        {listError !== null && <div className={css.listError}>{listError}</div>}
        <SessionList sessions={filtered} selected={route} onSelect={navigate} />
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
    </div>
  )
}
