import { useMemo } from 'react'
import type { SessionSummary } from '@harness-trajectory/core'
import type { Route } from './App.tsx'
import css from './app.module.css'

const KIND_LABEL: Record<SessionSummary['kind'], string> = {
  claude: 'Claude',
  codex: 'Codex',
}

function relativeTime(epochMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - epochMs)
  const minutes = Math.round(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(epochMs).toLocaleDateString()
}

function projectName(cwd: string | null): string {
  if (cwd === null || cwd === '') return 'Unknown project'
  const parts = cwd.split('/').filter(part => part !== '')
  return parts.slice(-2).join('/') || cwd
}

export interface SessionListProps {
  sessions: readonly SessionSummary[]
  selected: Route | null
  onSelect: (route: Route) => void
}

export function SessionList({ sessions, selected, onSelect }: SessionListProps) {
  const groups = useMemo(() => {
    const byProject = new Map<string, { cwd: string | null; sessions: SessionSummary[]; latest: number }>()
    for (const session of sessions) {
      const key = session.cwd ?? ''
      let group = byProject.get(key)
      if (group === undefined) {
        group = { cwd: session.cwd, sessions: [], latest: 0 }
        byProject.set(key, group)
      }
      group.sessions.push(session)
      group.latest = Math.max(group.latest, session.updatedAt)
    }
    return [...byProject.values()].sort((left, right) => right.latest - left.latest)
  }, [sessions])

  if (sessions.length === 0) {
    return <div className={css.listEmpty}>No sessions found.</div>
  }
  return (
    <nav className={css.list} aria-label="Sessions">
      {groups.map(group => (
        <section key={group.cwd ?? ''} className={css.group}>
          <h2 className={css.groupTitle} title={group.cwd ?? undefined}>{projectName(group.cwd)}</h2>
          {group.sessions.map((session) => {
            const active = selected !== null && selected.kind === session.kind && selected.id === session.id
            return (
              <button
                key={`${session.kind}/${session.id}`}
                type="button"
                className={css.item}
                data-active={active || undefined}
                onClick={() => { onSelect({ kind: session.kind, id: session.id }) }}
                title={`${session.id}\n${session.cwd ?? ''}`}
              >
                <span className={css.itemTitle}>{session.title}</span>
                <span className={css.itemMeta}>
                  <span className={css.badge} data-kind={session.kind}>{KIND_LABEL[session.kind]}</span>
                  {session.live && <span className={css.live} title="Written to recently">live</span>}
                  {session.model !== null && <span className={css.itemModel}>{session.model}</span>}
                  <span className={css.itemTime}>{relativeTime(session.updatedAt)}</span>
                </span>
              </button>
            )
          })}
        </section>
      ))}
    </nav>
  )
}
