import { useEffect, useMemo, useState } from 'react'
import type {
  HarnessKind, SessionChildSummary, SessionSummary, SubagentRun, SubagentStatus,
} from '@harness-trajectory/core'
import {
  Menu, TrajectoryView, Tooltip, useSnapshotSelector, type MenuEntry, type SnapshotStore, type TrajectoryTranslate,
} from '@harness-trajectory/ui'
import type { Route } from './App.tsx'
import { HarnessMark, harnessMeta } from './harnesses.tsx'
import { relativeTime } from './SessionList.tsx'
import { SessionRuntime } from './session-runtime.ts'
import css from './app.module.css'

export interface SessionPaneProps {
  kind: HarnessKind
  id: string
  /** Child transcript id when the pane shows one subagent on its own. */
  file: string | null
  /** Listing row for this session, when the list has it. */
  summary: SessionSummary | null
  onNavigate: (route: Route) => void
  t: TrajectoryTranslate
  durationStore: SnapshotStore<boolean>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** One row of the subagent catalog: a run reported by the parent transcript joined with its file. */
export interface SubagentRow {
  key: string
  fileId: string | null
  title: string
  agentType: string | null
  model: string | null
  status: SubagentStatus
  startedAt: number | null
  endedAt: number | null
  lastTime: number | null
  toolCalls: number
}

function shortAgentId(agentId: string): string {
  const name = agentId.split('/').pop() ?? agentId
  return name.startsWith('agent-') ? name.slice('agent-'.length) : name
}

/**
 * Join the parser's runs (status, description, call) with the server's child
 * files (which transcript to open). Files the fold has not attributed to a
 * call still get a row from their sidecar facts.
 */
export function subagentRows(
  runs: readonly SubagentRun[],
  children: readonly SessionChildSummary[],
): SubagentRow[] {
  const byAgentId = new Map<string, SessionChildSummary>()
  const byFileId = new Map<string, SessionChildSummary>()
  for (const child of children) {
    byFileId.set(child.file.id, child)
    const agentId = child.file.agent?.agentId
    if (agentId !== undefined) byAgentId.set(agentId, child)
  }
  const rows: SubagentRow[] = []
  const used = new Set<string>()
  for (const run of runs) {
    const child = (run.fileId === null ? undefined : byFileId.get(run.fileId)) ?? byAgentId.get(run.agentId)
    if (child !== undefined) used.add(child.file.id)
    const meta = child?.file.agent
    rows.push({
      key: run.callId ?? run.agentId,
      fileId: child?.file.id ?? run.fileId,
      title: run.description ?? meta?.description ?? shortAgentId(run.agentId),
      agentType: run.agentType ?? meta?.agentType ?? (meta?.isFork === true ? 'fork' : null),
      model: run.model ?? meta?.model ?? null,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      lastTime: run.lastTime ?? child?.updatedAt ?? null,
      toolCalls: run.toolCalls,
    })
  }
  for (const child of children) {
    if (used.has(child.file.id)) continue
    const meta = child.file.agent
    rows.push({
      key: `file:${child.file.id}`,
      fileId: child.file.id,
      title: meta?.description ?? shortAgentId(child.file.id),
      agentType: meta?.agentType ?? (meta?.isFork === true ? 'fork' : null),
      model: meta?.model ?? null,
      status: 'running',
      startedAt: null,
      endedAt: null,
      lastTime: child.updatedAt,
      toolCalls: 0,
    })
  }
  return rows
}

/** A run counts as active only while its transcript keeps being written. */
const ACTIVE_WINDOW_MS = 2 * 60_000

function isActive(row: SubagentRow, sessionLive: boolean, now: number): boolean {
  if (row.status !== 'running' && row.status !== 'launching') return false
  if (!sessionLive) return false
  return row.lastTime === null || now - row.lastTime < ACTIVE_WINDOW_MS
}

function statusLabel(row: SubagentRow, sessionLive: boolean, now: number): string {
  if (row.status === 'running' || row.status === 'launching') return isActive(row, sessionLive, now) ? row.status : 'idle'
  return row.status
}

function SubagentCatalog({ rows, sessionLive, noun, onOpen }: {
  rows: readonly SubagentRow[]
  sessionLive: boolean
  /** What the rows are relative to the open transcript: its own subagents, or the session's agents. */
  noun: 'subagent' | 'agent in session'
  onOpen: (fileId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const now = Date.now()
  const running = rows.filter(row => isActive(row, sessionLive, now)).length
  const items = useMemo<MenuEntry[]>(() => rows.map(row => ({
    id: row.key,
    disabled: row.fileId === null,
    label: (
      <span className={css.agentRow} data-status={statusLabel(row, sessionLive, now)}>
        <span className={css.agentRowTitle}>{row.title}</span>
        <span className={css.agentRowMeta}>
          <span className={css.agentStatus}>{statusLabel(row, sessionLive, now)}</span>
          {row.agentType !== null && <span>{row.agentType}</span>}
          {row.model !== null && <span>{row.model}</span>}
          {row.toolCalls > 0 && <span>{row.toolCalls} tools</span>}
          {row.startedAt !== null && (row.endedAt ?? row.lastTime) !== null && (
            <span>{formatDuration((row.endedAt ?? row.lastTime ?? row.startedAt) - row.startedAt)}</span>
          )}
          {row.lastTime !== null && <span>{relativeTime(row.lastTime)}</span>}
          {row.fileId === null && <span>no transcript yet</span>}
        </span>
      </span>
    ),
  })), [rows, sessionLive, now])
  const plural = noun === 'subagent' ? 'subagents' : 'agents in session'
  const label = `${rows.length} ${rows.length === 1 ? noun : plural}${running > 0 ? ` · ${running} running` : ''}`
  return (
    <Menu
      open={open}
      portal
      align="end"
      dense
      selection="fill"
      autoFocus
      className={css.agentMenu}
      anchor={(
        <Tooltip label="Browse subagent transcripts" delayMs={500}>
          <button
            type="button"
            className={css.agentTrigger}
            data-running={(running > 0 && sessionLive) || undefined}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {label}
          </button>
        </Tooltip>
      )}
      items={items}
      onSelect={(key) => {
        const row = rows.find(candidate => candidate.key === key)
        setOpen(false)
        if (row?.fileId != null) onOpen(row.fileId)
      }}
      onClose={() => { setOpen(false) }}
    />
  )
}

export function SessionPane({ kind, id, file, summary: listSummary, onNavigate, t, durationStore }: SessionPaneProps) {
  const runtime = useMemo(() => new SessionRuntime(kind, id, file), [kind, id, file])
  useEffect(() => {
    runtime.start()
    return () => { runtime.close() }
  }, [runtime])
  const state = useSnapshotSelector(runtime.store, value => value)
  const summary = state.summary ?? listSummary
  const [copied, setCopied] = useState(false)
  const started = summary?.startedAt ?? null
  const resumeCommand = harnessMeta(kind).resumeCommand({ id, cwd: summary?.cwd ?? null })
  const rows = useMemo(() => subagentRows(state.subagents, state.children), [state.subagents, state.children])
  const sessionLive = summary?.live === true
  // The subagent view folds one child file; its facts come from the server's child list.
  const self = file === null ? undefined : state.children.find(child => child.file.id === file)
  const agent = file === null ? undefined : (state.files[0]?.agent ?? self?.file.agent)
  const agentTitle = file === null ? null : (agent?.description ?? shortAgentId(file))
  const openChild = (fileId: string) => { onNavigate({ kind, id, file: fileId }) }
  return (
    <div className={css.pane}>
      <header className={css.paneHeader}>
        {file !== null && (
          <nav className={css.crumbs} aria-label="Session lineage">
            <button type="button" className={css.crumbLink} onClick={() => { onNavigate({ kind, id }) }}>
              {summary?.title ?? id}
            </button>
            <span className={css.crumbSeparator} aria-hidden="true">/</span>
            <span className={css.crumbCurrent}>{agentTitle}</span>
          </nav>
        )}
        <div className={css.paneTitleRow}>
          <span className={css.badge}>
            <HarnessMark kind={kind} size={14} />
            {file === null ? harnessMeta(kind).label : (agent?.agentType ?? 'subagent')}
          </span>
          <h1 className={css.paneTitle} title={file === null ? (summary?.title ?? id) : file}>
            {file === null ? (summary?.title ?? id) : agentTitle}
          </h1>
          {sessionLive && <span className={css.live}>live</span>}
          <span className={css.paneStatus} data-connected={state.connected || undefined}>
            {state.loading ? 'loading…' : state.connected ? 'following' : 'disconnected'}
          </span>
          {rows.length > 0 && (
            <SubagentCatalog
              rows={rows}
              sessionLive={sessionLive}
              noun={file === null ? 'subagent' : 'agent in session'}
              onOpen={openChild}
            />
          )}
        </div>
        <div className={css.paneMeta}>
          {summary?.cwd !== null && summary?.cwd !== undefined && (
            <span className={css.paneMetaItem} title={summary.cwd}><code>{summary.cwd}</code></span>
          )}
          {file !== null && agent?.model !== undefined && (
            <span className={css.paneMetaItem}>{agent.model}</span>
          )}
          {file === null && summary?.model !== null && summary?.model !== undefined && (
            <span className={css.paneMetaItem}>{summary.model}</span>
          )}
          {file === null && started !== null && (
            <span className={css.paneMetaItem}>{new Date(started).toLocaleString()}</span>
          )}
          {file === null && summary !== null && (
            <span className={css.paneMetaItem}>
              {summary.promptCount} prompts · {formatBytes(summary.bytes)}
            </span>
          )}
          {file !== null && self !== undefined && (
            <span className={css.paneMetaItem}>
              {formatBytes(self.bytes)} · last write {relativeTime(self.updatedAt)}
            </span>
          )}
          <span className={css.paneMetaItem}>{state.lines} lines</span>
          <span className={css.paneMetaItem} title={file ?? id}>{file === null ? id.slice(0, 8) : shortAgentId(file)}</span>
          {file === null && (
            <button
              type="button"
              className={css.paneCopy}
              title={resumeCommand}
              aria-label={`Copy the command that resumes this session: ${resumeCommand}`}
              onClick={() => {
                void navigator.clipboard?.writeText(resumeCommand).then(() => {
                  setCopied(true)
                  setTimeout(() => { setCopied(false) }, 1500)
                })
              }}
            >
              {copied ? 'copied' : 'copy resume command'}
            </button>
          )}
        </div>
        {state.error !== null && <div className={css.paneError}>{state.error}</div>}
      </header>
      <div className={css.paneBody}>
        <TrajectoryView
          snapshot={state.snapshot}
          loading={state.loading && state.snapshot.eventNodes.length === 0}
          loadImage={runtime.loadImage}
          durationStore={durationStore}
          t={t}
        />
      </div>
    </div>
  )
}
