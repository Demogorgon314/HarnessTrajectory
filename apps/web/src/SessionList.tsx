import { useMemo } from 'react'
import type { SessionSummary } from '@harness-trajectory/core'
import { icons } from '@harness-trajectory/ui'
import type { Route } from './App.tsx'
import { HarnessMark, harnessMeta } from './harnesses.tsx'
import css from './app.module.css'

const { IconFolderClose16, IconFolderOpen16, IconTriangleRightFill14 } = icons

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

export interface SessionListProps {
  sessions: readonly SessionSummary[]
  selected: Route | null
  onSelect: (route: Route) => void
  /** Group keys currently folded. */
  folded: ReadonlySet<string>
  onToggleGroup: (key: string) => void
}

export function SessionList({ sessions, selected, onSelect, folded, onToggleGroup }: SessionListProps) {
  const groups = useMemo(() => {
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
    return [...byProject.values()].sort((left, right) => right.latest - left.latest)
  }, [sessions])

  if (sessions.length === 0) {
    return <div className={css.listEmpty}>No sessions found.</div>
  }
  return (
    <nav className={css.list} aria-label="Sessions" role="tree">
      {groups.map((group) => {
        const key = groupKey(group.cwd)
        const expanded = !folded.has(key)
        const containsCurrent = selected !== null
          && group.sessions.some(session => session.kind === selected.kind && session.id === selected.id)
        return (
          <section key={key} className={css.group}>
            <div
              className={css.projectRow}
              role="treeitem"
              aria-expanded={expanded}
              tabIndex={0}
              title={group.cwd ?? undefined}
              onClick={() => { onToggleGroup(key) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggleGroup(key)
                }
              }}
            >
              <span className={css.slot} data-role="folder" data-active={(expanded && containsCurrent) || undefined}>
                {expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
              </span>
              <span className={css.slot} data-role="chevron">
                <IconTriangleRightFill14 className={css.arrow} data-open={expanded || undefined} />
              </span>
              <span className={css.title}>{projectName(group.cwd)}</span>
              <span className={css.time}>{group.sessions.length}</span>
            </div>
            {expanded && group.sessions.map((session) => {
              const active = selected !== null && selected.kind === session.kind && selected.id === session.id
              const meta = harnessMeta(session.kind)
              return (
                <div
                  key={`${session.kind}/${session.id}`}
                  className={css.sessionRow}
                  role="treeitem"
                  aria-selected={active}
                  tabIndex={0}
                  data-active={active || undefined}
                  title={rowTooltip(session)}
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
                  <span className={css.time}>{relativeTime(session.updatedAt)}</span>
                </div>
              )
            })}
          </section>
        )
      })}
    </nav>
  )
}
