import { useEffect, useMemo, useState } from 'react'
import type { HarnessKind, SessionSummary } from '@harness-trajectory/core'
import {
  TrajectoryView, useSnapshotSelector, type SnapshotStore, type TrajectoryTranslate,
} from '@harness-trajectory/ui'
import { SessionRuntime } from './session-runtime.ts'
import css from './app.module.css'

export interface SessionPaneProps {
  kind: HarnessKind
  id: string
  /** Listing row for this session, when the list has it. */
  summary: SessionSummary | null
  t: TrajectoryTranslate
  durationStore: SnapshotStore<boolean>
}

const KIND_LABEL: Record<HarnessKind, string> = { claude: 'Claude Code', codex: 'Codex' }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SessionPane({ kind, id, summary: listSummary, t, durationStore }: SessionPaneProps) {
  const runtime = useMemo(() => new SessionRuntime(kind, id), [kind, id])
  useEffect(() => {
    runtime.start()
    return () => { runtime.close() }
  }, [runtime])
  const state = useSnapshotSelector(runtime.store, value => value)
  const summary = state.summary ?? listSummary
  const [copied, setCopied] = useState(false)
  const started = summary?.startedAt ?? null
  return (
    <div className={css.pane}>
      <header className={css.paneHeader}>
        <div className={css.paneTitleRow}>
          <span className={css.badge} data-kind={kind}>{KIND_LABEL[kind]}</span>
          <h1 className={css.paneTitle} title={summary?.title ?? id}>{summary?.title ?? id}</h1>
          {summary?.live === true && <span className={css.live}>live</span>}
          <span className={css.paneStatus} data-connected={state.connected || undefined}>
            {state.loading ? 'loading…' : state.connected ? 'following' : 'disconnected'}
          </span>
        </div>
        <div className={css.paneMeta}>
          {summary?.cwd !== null && summary?.cwd !== undefined && (
            <span className={css.paneMetaItem} title={summary.cwd}><code>{summary.cwd}</code></span>
          )}
          {summary?.model !== null && summary?.model !== undefined && (
            <span className={css.paneMetaItem}>{summary.model}</span>
          )}
          {started !== null && (
            <span className={css.paneMetaItem}>{new Date(started).toLocaleString()}</span>
          )}
          {summary !== null && (
            <span className={css.paneMetaItem}>
              {summary.promptCount} prompts · {formatBytes(summary.bytes)}
              {summary.childCount > 0 ? ` · ${summary.childCount} subagents` : ''}
            </span>
          )}
          <span className={css.paneMetaItem}>{state.lines} lines</span>
          <button
            type="button"
            className={css.paneCopy}
            title={id}
            onClick={() => {
              void navigator.clipboard?.writeText(id).then(() => {
                setCopied(true)
                setTimeout(() => { setCopied(false) }, 1200)
              })
            }}
          >
            {copied ? 'copied' : 'copy id'}
          </button>
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
