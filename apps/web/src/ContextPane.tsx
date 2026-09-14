/**
 * The Context tab's host: turns one session's `ContextSession` fold into the
 * props the vendored dashboard renders from.
 *
 * The runtime folds every transcript file of the session separately (the main
 * agent plus one per subagent); this pane picks the agent the route names,
 * hands the dashboard that file's timeline/headers/content, and builds the
 * Agent Network's rows from every file's own fold.
 */

import { useCallback, useMemo } from 'react'
import type { HarnessKind, SessionFileRef, SessionSummary } from '@harness-trajectory/core'
import { childKeyOf, type AgentSpawn, type ContextTimeline, type SynthMeta } from '@harness-trajectory/context'
import {
  ContextView, createContextSettings, createContextTranslate, headlineOf, mergeCostUsage, usageOfRequests,
  type AgentNodeInput, type ContextLocale, type ContextViewProps, type CostPart, type SessionInfo,
} from '@harness-trajectory/context/client'
import { useSnapshotSelector } from '@harness-trajectory/ui'
import { HarnessMark, harnessMeta } from './harnesses.tsx'
import type { SessionRuntime } from './session-runtime.ts'

export interface ContextPaneProps {
  runtime: SessionRuntime
  kind: HarnessKind
  id: string
  /** The transcript file the dashboard shows; null means the main agent. */
  agent: string | null
  summary: SessionSummary | null
  locale: ContextLocale
  /** Open another agent's Context view (null returns to the main agent). */
  onOpenAgent: (fileId: string | null) => void
}

/** Display preferences persist per browser, not per session. */
const settings = createContextSettings()

/** Trim a label to one readable line in a graph caption. */
function shortLabel(value: string, max = 80): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** The per-file fold reads the Agent Network needs; `ContextSession` satisfies it. */
export interface AgentFoldReader {
  timelineOf(fileId: string): ContextTimeline | null
  metaOf(fileId: string): SynthMeta | null
}

/**
 * Fold the session's transcript files into the Agent Network's rows.
 *
 * Naming and liveness follow whoever actually knows:
 * - the MAIN node is the session, so it takes the server's own title (the one
 *   the session list and the pane header show) and the server's `live` flag;
 *   the synthesizer's guesses are the fallback for both;
 * - a CHILD is named by the PARENT's spawn record (the task description the
 *   parent wrote) before its own first prompt, and a spawn that already has a
 *   `completedAt` ends the node no matter what the child's own fold still
 *   believes — the parent's tool result is the authoritative end of a subagent.
 *
 * @param files - every folded transcript of the session, main first.
 * @param session - the fold to read each file's timeline and meta from.
 * @param summary - the session's listing row, when the server has delivered it.
 * @param ctx - the harness (for the child-key match) and the session id (last-resort caption).
 */
export function agentNodeInputsOf(
  files: readonly SessionFileRef[],
  session: AgentFoldReader,
  summary: SessionSummary | null,
  ctx: { kind: HarnessKind; sessionId: string },
): AgentNodeInput[] {
  // Every spawn record any file reported, keyed by the harness-native child key.
  const spawns = new Map<string, AgentSpawn>()
  for (const file of files) {
    const fileMeta = session.metaOf(file.id)
    if (fileMeta === null) continue
    for (const [key, spawn] of fileMeta.children) spawns.set(key, spawn)
  }
  return files.map((file) => {
    const fileTimeline = session.timelineOf(file.id)
    const fileMeta = session.metaOf(file.id)
    const spawn = spawns.get(childKeyOf(ctx.kind, file))
    const isMain = file.role === 'main'
    const requests = fileTimeline?.requests ?? []
    let billed: number | null = null
    for (const request of requests) {
      if (request.prompt === undefined && request.output === undefined) continue
      billed = (billed ?? 0) + (request.prompt ?? 0) + (request.output ?? 0)
    }
    const first = requests[0]
    const last = requests[requests.length - 1]
    const durationMs = first !== undefined && last !== undefined && last.time > first.time
      ? last.time - first.time
      : spawn?.completedAt !== undefined && spawn.startedAt !== undefined
        ? spawn.completedAt - spawn.startedAt
        : null
    const title = summary?.title
    const label = isMain
      ? (title !== undefined && title !== '' ? title : fileMeta?.label ?? ctx.sessionId)
      : (spawn?.label ?? fileMeta?.label ?? file.id)
    const running = isMain
      ? (summary !== null ? summary.live : fileMeta?.running === true)
      : (spawn?.completedAt !== undefined ? false : fileMeta?.running === true)
    return {
      id: file.id,
      label: shortLabel(label),
      ...(file.parentId === undefined ? {} : { parentId: file.parentId }),
      head: fileTimeline === null ? null : headlineOf(fileTimeline),
      requests: requests.length,
      billed,
      durationMs,
      badge: spawn?.agentType ?? null,
      running,
      // "Done" is only claimed where something actually reported an end.
      completed: !running && (fileMeta !== null || spawn !== undefined),
      subagent: !isMain,
      updatedAt: last?.time ?? 0,
    }
  })
}

export function ContextPane(props: ContextPaneProps) {
  const { runtime, kind, agent, summary } = props
  const state = useSnapshotSelector(runtime.store, value => value)
  const revision = state.contextRevision
  const session = runtime.context
  const t = useMemo(() => createContextTranslate(props.locale), [props.locale])

  // The fold is mutable and memoizes its views per file, so everything below
  // is recomputed exactly when the revision moves.
  const files = useMemo(() => session.files(), [session, revision])
  const mainFile = files.find(file => file.role === 'main') ?? files[0] ?? null
  const currentId = agent ?? mainFile?.id ?? ''

  const timeline = useMemo(() => (currentId === '' ? null : session.timelineOf(currentId)), [session, currentId, revision])
  const headers = useMemo(() => (currentId === '' ? null : session.headersOf(currentId)), [session, currentId, revision])
  const meta = useMemo(() => (currentId === '' ? null : session.metaOf(currentId)), [session, currentId, revision])

  const contentOf = useCallback(
    (seq: number) => (currentId === '' ? null : session.contentOf(currentId, seq)),
    [session, currentId],
  )
  const headerContentOf = useCallback(
    (seq: number) => (currentId === '' ? null : session.headerContentOf(currentId, seq)),
    [session, currentId],
  )

  // The agent family: one row per folded transcript file (see agentNodeInputsOf).
  const agents = useMemo<AgentNodeInput[]>(
    () => agentNodeInputsOf(files, session, summary, { kind, sessionId: props.id }),
    [session, files, kind, revision, summary, props.id],
  )

  const sessionInfo = useMemo<SessionInfo>(() => {
    const harness = harnessMeta(kind)
    const onMain = mainFile === null || currentId === mainFile.id
    const startedAt = timeline?.requests[0]?.time ?? summary?.startedAt ?? undefined
    return {
      harness: (
        <span className="lc-session-harness">
          <HarnessMark kind={kind} size={13} />
          {harness.label}
        </span>
      ),
      harnessName: harness.label,
      ...(meta?.model !== undefined ? { model: meta.model } : timeline?.model !== undefined ? { model: timeline.model } : {}),
      ...(meta?.provider ?? timeline?.provider ? { provider: meta?.provider ?? timeline?.provider } : {}),
      ...(timeline?.contextWindow !== undefined ? { contextWindow: timeline.contextWindow } : {}),
      ...(meta?.version !== undefined ? { version: meta.version } : {}),
      ...(summary?.cwd != null && summary.cwd !== '' ? { cwd: summary.cwd } : {}),
      ...(startedAt != null ? { startedAt } : {}),
      // The resume command reopens the SESSION; a subagent transcript has no
      // address of its own in either CLI, so the row only shows on the main agent.
      ...(onMain ? { resumeCommand: harness.resumeCommand({ id: props.id, cwd: summary?.cwd ?? null }) } : {}),
      ...(meta?.reportedCostUsd !== undefined ? { reportedCostUsd: meta.reportedCostUsd } : {}),
    }
  }, [kind, meta, timeline, summary, props.id, mainFile, currentId])

  // Cost is the one figure on the board that is about the SESSION rather than
  // one context window: a subagent's spend is the session's spend. On the main
  // agent the cell prices the whole family's summed usage and itemizes it per
  // agent; a selected child shows its own (`cost` left undefined, so the view
  // falls back to that file's timeline).
  const onMainAgent = mainFile === null || currentId === mainFile.id
  const costParts = useMemo<CostPart[]>(
    () => agents.map(row => ({ id: row.id, label: row.label, cost: session.timelineOf(row.id)?.cost })),
    [agents, session, revision],
  )
  const cost = useMemo(
    () => (onMainAgent ? mergeCostUsage(costParts.map(part => part.cost)) : undefined),
    [onMainAgent, costParts],
  )
  // The cache-hit cell sits beside the cost cell on the same card, so it takes
  // the same population: every folded file's requests while the main agent is
  // shown, that one file's while a child is. (The Token Stats card keeps the
  // shown agent's own sums — it describes one context window.)
  const sessionUsage = useMemo(
    () => (onMainAgent
      ? usageOfRequests(files.flatMap(file => session.timelineOf(file.id)?.requests ?? []))
      : undefined),
    [onMainAgent, files, session, revision],
  )

  const onOpenAgent = props.onOpenAgent
  const openAgent = useCallback((fileId: string) => {
    onOpenAgent(mainFile !== null && fileId === mainFile.id ? null : fileId)
  }, [onOpenAgent, mainFile])

  // The dashboard rebuilds its component factories when `t` or `settings`
  // change identity; both are stable per locale, so keep the props object
  // itself cheap to compare.
  const viewProps: ContextViewProps = {
    timeline,
    headers,
    contentOf,
    headerContentOf,
    agents,
    currentAgentId: currentId,
    onOpenAgent: openAgent,
    sessionInfo,
    t,
    locale: props.locale,
    settings,
    cost,
    costParts: onMainAgent ? costParts : undefined,
    sessionUsage,
    // The pane header already carries the session → agent lineage for both
    // tabs, so the dashboard's own back link would only stack on it.
    showBreadcrumb: false,
  }
  return <ContextView {...viewProps} />
}
