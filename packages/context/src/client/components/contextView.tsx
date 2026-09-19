/**
 * Context tab root: renders one folded transcript file's `ContextTimeline`
 * and composes stats, session info, composition, trend, browser, events,
 * file activity and the agent network.
 *
 * dsh-context read every input from the harness's projection pipeline; this
 * port takes them all as PROPS — the host app owns the `ContextSession` fold
 * and hands in the timeline, the header epochs, the per-seq content, the
 * agent rows and the session facts. Everything below the props boundary is
 * the dsh-context view, unchanged.
 *
 * Vendored from dsh-context (Apache-2.0, see ../../NOTICE).
 */

import { createElement as h, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ContextEventRecord, ContextHeaders, ContextTimeline, HeaderEpochContent, RequestRecord, SessionCostUsage, SurfaceNode, TokenUsage } from '../../shared/types'
import type { ContentBlock } from '../../fold/event'
import { briefNodes, briefOf } from '../brief'
import { headlineOf } from '../headline'
import { numOf } from '../services'
import type { ConversationNodeLike, ImageLoader } from '../services'
import { activityOf, activityOfOps, locateStepOf } from '../fileActivity'
import type { FileOp } from '../fileActivity'
import type { ModelPriceRules } from '@harness-trajectory/core'
import type { ContextSettings } from '../settings'
import type { ContextLocale, Translate } from '../i18n'
import { makeViewKit, type ViewKit } from '../viewkit'
import type { AgentNodeInput } from '../agentTree'
import { makeContextBrowser } from './browser'
import { makeAgentGraph } from './agentGraph'
import { makeDonut } from './donut'
import { makeCurrentComposition } from './currentComposition'
import { makeEventList } from './events'
import { makeFileCard } from './fileCard'
import { makeSessionInfo } from './sessionInfo'
import type { SessionInfo } from './sessionInfo'
import { makeSettingsPopover } from './settingsCard'
import { makeRequestDetail } from './requestDetail'
import { countsOfRecords, makeStatsContext } from './statsContext'
import type { CostPart } from './statsContext'
import { makeStatsTiming } from './statsTiming'
import { makeStatsTokens } from './statsTokens'
import { makeLegend, makeStackedBar } from './stackedBar'
import { aggregateByTurn, attachMarkers, makeTrendChart, turnStepsOf } from './trendChart'
import { makeErrorBoundary } from './errorBoundary'

export type { SessionInfo } from './sessionInfo'
export type { CostPart } from './statsContext'

// The Context view scrolls inside its own `.lc-root`; a module-level
// per-agent position ledger survives tab switches and agent hops, restored
// once content renders. First visits start at the top.
const viewScroll = new Map<string, number>()

const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model', 'mode'] as const

export interface ContextViewProps {
  /** The folded timeline of the agent being shown; null renders the loading well. */
  timeline: ContextTimeline | null
  /** That agent's header epochs (system prompt + tool schema metadata). */
  headers: ContextHeaders | null
  /** The content blocks the fold kept for one node seq. */
  contentOf: (seq: number) => ContentBlock[] | null
  /** The system text + tool schemas one header epoch carried. */
  headerContentOf: (seq: number) => HeaderEpochContent | null
  /** Every agent of the session (the main transcript plus each subagent file). */
  agents: readonly AgentNodeInput[]
  /** The agent this view is showing — one of `agents[].id`. */
  currentAgentId: string
  /** Open another agent's Context view. */
  onOpenAgent: (id: string) => void
  /** The session facts shown by the Session Info card. */
  sessionInfo: SessionInfo
  t: Translate
  locale: ContextLocale
  settings: ContextSettings
  /**
   * The billed totals the Cost cell prices. A session is one transcript per
   * agent, so a host showing the MAIN agent passes the whole family's summed
   * usage (`mergeCostUsage`); absent, the shown agent's own `timeline.cost`
   * stands. Every other card stays per-agent — they describe one context window.
   */
  cost?: SessionCostUsage | undefined
  /** Per-agent shares behind `cost`; two or more itemize the Cost cell's bubble. */
  costParts?: readonly CostPart[] | undefined
  /**
   * The usage the Context Stats board's CACHE-HIT cell reads, when it should
   * describe a different population than the shown agent's own requests — a
   * host passing session-wide `cost` passes the session-wide usage too, so
   * both cells of that card answer for the same population. Absent (the
   * default) keeps the shown agent's own sums. The Token Stats card is never
   * affected: it describes this one context window.
   */
  sessionUsage?: TokenUsage | null | undefined
  /**
   * Show the "← back to the main agent" link while a child is open (default
   * true). A host whose own chrome already carries the session → agent lineage
   * passes false so the two do not stack.
   */
  showBreadcrumb?: boolean | undefined
  /** Optional durable-image resolver for attachment cards. */
  loadImage?: ImageLoader | undefined
  /**
   * PORT ADDITION — the user's model-price rules (`ServerSettings.modelPricing`),
   * handed to the Cost cell's pricing math. The host's fold must be driven by
   * the same table (`ContextSessionOptions.costPeriod`), or an `off` bucket a
   * rule's schedule produced would price at list.
   */
  pricingRules?: ModelPriceRules | undefined
  /**
   * PORT ADDITION — when set, each unpriced billed model in the Cost cell's
   * note becomes a button reporting its fold (provider, model) key, so the
   * host can open a prefilled price-rule editor.
   */
  onPriceModel?: ((provider: string, model: string) => void) | undefined
}

/**
 * The provider-reported usage totals. dsh read them off the token-meter's own
 * `tokenUsage` projection; this viewer has no such projection, so they are
 * summed over the request records the fold kept (which is every request of the
 * session unless retention trimmed the log). Null when no request reported
 * usage at all — the cache-hit cell then shows a dash rather than a made-up 0%.
 */
export function usageOfRequests(requests: readonly RequestRecord[]): TokenUsage | null {
  let uncachedInputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let seen = false
  for (const r of requests) {
    if (r.prompt === undefined && r.output === undefined) continue
    seen = true
    const cacheRead = numOf(r.cacheRead)
    const cacheWrite = numOf(r.cacheWrite)
    cacheReadTokens += cacheRead
    cacheWriteTokens += cacheWrite
    uncachedInputTokens += Math.max(0, numOf(r.prompt) - cacheRead - cacheWrite)
    outputTokens += numOf(r.output)
  }
  return seen ? { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } : null
}

/**
 * The conversation-window join dsh-context got from the chat's `useChat`
 * seat, rebuilt from the fold's own retained content: one node per surface
 * seq, shaped so the browser's body renderer reads it exactly as it read the
 * harness's chat nodes.
 *
 * A tool result also recovers its CALL (name + raw arguments) from the
 * assistant message that issued it — the browser previews a result by its
 * call arguments (the edited path, the bash description), and the fold's
 * surface node carries only the tool name.
 */
export function joinNodesOf(
  timeline: ContextTimeline,
  contentOf: (seq: number) => ContentBlock[] | null,
): ConversationNodeLike[] {
  const calls = new Map<string, { name: string; argsRaw: string }>()
  const out: ConversationNodeLike[] = []
  const surfaces: SurfaceNode[] = [...timeline.nodes, ...timeline.archive]
    .sort((a, b) => (a.pos ?? a.seq) - (b.pos ?? b.seq))
  // Pass 1: every tool call the log carried, by call id.
  for (const node of surfaces) {
    if (node.cat !== 'assistant') continue
    for (const block of contentOf(node.seq) ?? []) {
      if (block.type !== 'tool-call') continue
      const id = block.callId
      if (typeof id !== 'string' || id === '') continue
      calls.set(id, { name: block.name ?? '?', argsRaw: block.arguments ?? '' })
    }
  }
  for (const node of surfaces) {
    const blocks = contentOf(node.seq)
    if (blocks === null) continue
    if (node.cat === 'assistant') {
      out.push({ kind: 'assistant', seq: node.seq, blocks })
      continue
    }
    if (node.cat === 'tool' || (node.cat === 'skill' && node.tool !== undefined)) {
      // The synthesizers wrap a result in one `tool-result` block; the body
      // renderer wants its inner blocks, and the row wants the call.
      const wrapper = blocks.length === 1 && blocks[0] !== undefined && blocks[0].type === 'tool-result' ? blocks[0] : null
      const inner = wrapper !== null && Array.isArray(wrapper.content) ? wrapper.content : blocks
      const callId = wrapper?.toolCallId
      const call = typeof callId === 'string' ? calls.get(callId) ?? null : null
      out.push({
        kind: 'tool-result',
        seq: node.seq,
        content: inner,
        call,
        isError: wrapper?.isError === true || node.err === true,
      })
      continue
    }
    out.push({ kind: 'user', seq: node.seq, content: blocks })
  }
  return out
}

export function makeContextView(
  kit: ViewKit,
  settings: ContextSettings,
): (props: ContextViewProps) => ReactElement {
  const { t } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const TrendChart = makeTrendChart(kit)
  const RequestDetail = makeRequestDetail(kit, StackedBar)
  const EventList = makeEventList(kit)
  const FileCard = makeFileCard(kit, settings)
  const Donut = makeDonut(kit)
  const StatsContext = makeStatsContext(kit)
  const StatsTiming = makeStatsTiming(kit, Donut)
  const StatsTokens = makeStatsTokens(kit, Donut)
  const SessionInfoCard = makeSessionInfo(kit)
  const SettingsPopover = makeSettingsPopover(kit)
  const ContextBrowser = makeContextBrowser(kit, StackedBar, settings)
  const AgentGraph = makeAgentGraph(kit)
  const ErrorBoundary = makeErrorBoundary(t)

  // The body renders under the error boundary: a corrupt value (past the timelineOf shape guard) degrades to a styled error
  // card, not a white screen; the boundary itself has NO hooks, so the body's hook order and loading/data flow stay unchanged.
  function ContextViewBody(props: ContextViewProps): ReactElement {
    const agentId = props.currentAgentId
    const data = props.timeline
    const headers = props.headers
    const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = useState<number | null>(null)
    const [hoverTurn, setHoverTurn] = useState<number | null>(null)
    // Mount-time default from the settings popover; in-chart toggling stays mount-local and never writes back.
    const [granularity, setGranularity] = useState<'step' | 'turn'>(() => settings.defaultGranularity())
    // 'total' plots each request's cumulative composition, 'delta' its incremental change vs the previous one;
    // like granularity, the default is read at mount and in-chart toggling never writes back.
    const [trendMode, setTrendMode] = useState<'total' | 'delta'>(() => settings.defaultTrendMode())
    // Adaptive scale (the title-adjacent toggle): the trend bars rescale to the visible window; like the two
    // toggles above, mount-local and never written back.
    const [adaptive, setAdaptive] = useState(false)
    // Strip-clicked turn: chart switches to turn granularity and scroll-centers that turn's bar, then clears via onFocusTurnHandled.
    const [focusTurn, setFocusTurn] = useState<number | null>(null)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    // The browser's open category: the trend card focuses its bars on it (collapsing the category restores all).
    const [focusCat, setFocusCat] = useState<string | null>(null)
    const [pickedKinds, setPickedKinds] = useState<string[]>([...EVENT_KINDS])
    const toggleKind = (k: string) => {
      setPickedKinds((p) => {
        if (p.length === EVENT_KINDS.length) return [k]
        if (!p.includes(k)) return [...p, k]
        return p.length === 1 ? [...EVENT_KINDS] : p.filter(x => x !== k)
      })
    }
    // Step-brief → browser reveal bridge: one-shot focus request consumed by the Context browser.
    const [nodeFocus, setNodeFocus] = useState<{ step: number | 'live'; seq: number; cat: SurfaceNode['cat'] } | null>(null)
    const clearNodeFocus = useCallback(() => { setNodeFocus(null) }, [])

    const contentOf = props.contentOf
    const headerContentOf = props.headerContentOf
    // The fold's retained content, joined onto the surface nodes — the same
    // join the chat window gave dsh-context, built locally (see joinNodesOf).
    const convNodes = useMemo(
      () => (data !== null ? joinNodesOf(data, contentOf) : undefined),
      [data, contentOf],
    )
    // The header epoch's own content resolves from the same local fold; the
    // browser's fetch-on-miss machinery stays (its notes cover a seq the fold
    // never kept), so the read is wrapped as the promise it expects.
    const fetchHeader = useMemo(
      () => (seq: number): Promise<HeaderEpochContent | null> => Promise.resolve(headerContentOf(seq)),
      [headerContentOf],
    )

    const rootRef = useRef<HTMLDivElement | null>(null)
    // The agent whose position was already applied this mount — re-applying on re-renders would yank the reader's scroll.
    const restoredRef = useRef<string | null>(null)

    // Restore the saved position (or the top on first visit) in a layout effect.
    useLayoutEffect(() => {
      if (agentId === '' || data === null) return
      if (restoredRef.current === agentId) return
      restoredRef.current = agentId
      const scroller = rootRef.current
      if (scroller === null) return
      scroller.scrollTop = viewScroll.get(agentId) ?? 0
    }, [agentId, data])

    // Save the position on unmount/agent change — a layout-effect cleanup, so it fires before the incoming view's own layout effects
    // re-scroll.
    useLayoutEffect(() => {
      const scroller = rootRef.current
      return () => {
        if (agentId === '' || scroller === null) return
        viewScroll.set(agentId, scroller.scrollTop)
      }
    }, [agentId])

    // Hooks stay unconditional (Rules of Hooks): the timeline can arrive AFTER a loading first render, and an early return above
    // these useMemos would grow the hook count between renders (React #310); fall back to empty collections and keep the loading return
    // below the last hook.
    const requests = data ? data.requests : []
    const events = data ? data.events : []
    // The stats board's count figures, shared by the stats card's shape cells and the events card's kind-filter counts.
    const counts = data?.counts ?? countsOfRecords(requests, events)
    // The per-kind tallies that ride the filter buttons: only the three priced
    // kinds the fold counts (model/mode switches carry no tally, hence undefined).
    const kindCounts: Record<string, number | undefined> = { inject: counts.injects, compaction: counts.compactions, prune: counts.prunes }
    const shownEvents = pickedKinds.length === EVENT_KINDS.length ? events : events.filter(e => pickedKinds.includes(e.kind))
    // Per-step bars, or one per turn (each turn's LAST step's record); memoized so hover-driven re-renders keep bar props identity-stable —
    // the chart's memoized bars then skip reconciliation (turn-mode aggregation allocates).
    const displayRequests = useMemo(
      () => (granularity === 'turn' ? aggregateByTurn(requests) : requests),
      [requests, granularity],
    )
    // The step labels' per-turn totals ("Turn t · Step s of n"), tallied over the RAW step records — turn-mode
    // aggregates read their own stepCount instead.
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    const markers = useMemo(() => attachMarkers(displayRequests, events), [displayRequests, events])

    // The provider usage totals, summed over the request records (see usageOfRequests).
    const usage = useMemo(() => usageOfRequests(requests), [requests])

    // Step-brief raw material: every served node seq-sorted (live tail + archive).
    const briefList = useMemo(() => (data ? briefNodes(data) : []), [data])
    const bySeq = useMemo(() => {
      const m = new Map<number, ConversationNodeLike>()
      for (const n of convNodes ?? []) m.set(n.seq, n)
      return m
    }, [convNodes])

    // Active bar / pin lookup — derived BEFORE the loading-return so the hooks below stay unconditional (React #310).
    let pinnedIdx = -1
    for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i]!.seq === selectedSeq) pinnedIdx = i
    const pinnedReq = pinnedIdx >= 0 ? displayRequests[pinnedIdx]! : null
    let activeIdx = -1
    if (hoveredSeq !== null) {
      for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i]!.seq === hoveredSeq) { activeIdx = i; break }
    }
    if (activeIdx < 0) activeIdx = pinnedIdx
    if (activeIdx < 0 && displayRequests.length > 0) activeIdx = displayRequests.length - 1
    const activeReq = activeIdx >= 0 ? displayRequests[activeIdx]! : null
    // File activity follows the same active bar: the EXCLUSIVE upper bound is the next RAW request's seq, so the picked step's own
    // tool calls (results land before the next request) count too; the latest bar's null bound serves everything.
    let filesBefore: number | null = null
    if (activeReq !== null) {
      // The active bar's seq always exists in the raw list (turn aggregates keep their last step's record).
      const ri = requests.findIndex(r => r.seq === activeReq.seq)
      filesBefore = ri + 1 < requests.length ? requests[ri + 1]!.seq : null
    }
    // The active bar's semantic identity ("what this step was about"); pure derivation over the served nodes, null when nothing is known.
    const brief = useMemo(
      () => (activeReq !== null ? briefOf(briefList, displayRequests, activeIdx) : null),
      [activeReq, briefList, displayRequests, activeIdx],
    )
    const convOf = useCallback((seq: number): ConversationNodeLike | undefined => bySeq.get(seq), [bySeq])

    // File activity follows the same active bar: the fold's op log covers the full session log; the legacy
    // path (no op log) re-derives from the join.
    const fileActivity = useMemo(
      () => {
        if (data !== null && data.fileOps !== undefined) {
          return activityOfOps(data.fileOps, data.archive, filesBefore)
        }
        return activityOf(briefList, convOf, filesBefore)
      },
      [data, briefList, convOf, filesBefore],
    )
    const locateFileOp = useCallback((op: FileOp): void => {
      const seq = op.parent ?? op.seq
      const step = locateStepOf(requests, seq, op.gone)
      if (step === null) return
      setNodeFocus({ step, seq, cat: 'tool' })
    }, [requests])
    // A brief row's reveal target: inputs/opener live in the picked step's OWN assembled surface; the response node (seq === the
    // request's) first appears in the NEXT step's surface — or the live surface when the last bar is picked.
    const locateNode = useCallback((node: SurfaceNode, isResponse: boolean): void => {
      /* v8 ignore next 1 -- locateNode is only wired to brief rows, and
         brief !== null guarantees activeReq !== null in the same closure. */
      if (activeReq === null) return
      const next = isResponse && activeIdx + 1 < displayRequests.length ? displayRequests[activeIdx + 1]! : null
      const step: number | 'live' = isResponse ? (next !== null ? next.seq : 'live') : activeReq.seq
      setNodeFocus({ step, seq: node.seq, cat: node.cat })
    }, [activeReq, activeIdx, displayRequests])

    // The agent family and the breadcrumb target (the root agent) — read
    // before the loading return so the header renders while the fold warms up.
    const agents = props.agents
    const rootAgent = agents.find(a => a.parentId === undefined) ?? null
    const onCurrent = rootAgent === null || rootAgent.id === agentId
    const withCrumb = props.showBreadcrumb !== false

    const header = (
      <div className="lc-cols lc-topbar">
        {withCrumb && !onCurrent && rootAgent !== null
          ? (
            <button
              type="button"
              className="lc-crumb hover:text-(--dsw-alias-label-primary)"
              onClick={() => { props.onOpenAgent(rootAgent.id) }}
            >{t('agents.back', { label: rootAgent.label })}</button>
          )
          : null}
        <SettingsPopover settings={props.settings} />
      </div>
    )

    if (!data) {
      return <div className="lc-root" ref={rootRef}>{header}<div className="lc-empty">{t('loading')}</div></div>
    }

    const markerOf = (req: RequestRecord): ContextEventRecord | undefined => {
      const i = displayRequests.indexOf(req)
      /* v8 ignore next 1 -- the only caller passes displayRequests[activeIdx],
         an element of the very array indexOf scans. */
      return i >= 0 ? markers[i] : undefined
    }

    // The headline anchor is the fold's own derivation: this viewer has no
    // foreign pressure/breakdown projections, so both arguments stay null and
    // `headlineOf` falls back to the newest request's provider prompt.
    const head = headlineOf(data, null, null)
    let fileScope = t('files.scopeLatest')
    if (activeReq !== null && filesBefore !== null) {
      fileScope = activeReq.stepCount !== undefined && activeReq.stepCount > 1
        ? t('detail.turn', { t: activeReq.turn ?? 0, n: activeReq.stepCount })
        : t('detail.step', { t: activeReq.turn ?? 0, s: activeReq.step ?? 0, n: stepsOf(activeReq.turn) })
    }

    // Turn highlight is hover-only: the turn strip hover wins, then the hovered bar's turn — no fallback, so a pinned or default selection
    // never keeps a turn glowing.
    let activeTurn: number | null = hoverTurn
    if (activeTurn === null && hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) { activeTurn = req.turn ?? null; break }
    }

    // The trend card mirrors the SAME shared category hover the browser's live link uses: the overview's 'free' key drops
    // (no segment in the chart or the detail bar), and every bar + the detail bar light that category's segment.
    const trendHoverCat = hoverCat !== null && hoverCat !== 'free' ? hoverCat : null

    const subtitle = (data.model ?? '') + (data.provider ? ' · ' + data.provider : '')
    // The two honesty markers the transcript harnesses force (see the fold):
    // a derived system remainder, and tool schemas the log never recorded.
    const systemDerived = data.systemDerived === true
    const toolsKnown = data.toolsKnown === true

    // The three main-row cards, built once and laid out by the shared
    // arrangement below.
    const compositionCard = (
      <CurrentComposition
        head={head}
        subtitle={subtitle}
        hoverKey={hoverCat}
        onHoverKey={setHoverCat}
        derivedKey={systemDerived ? 'system' : null}
      />
    )
    const trendCard = (
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('trend.title')}</span>
          {/* The adaptive switch rides the title's right (the browser card's DNA toggle idiom): bars rescale
              to the bars currently on screen instead of the whole retained log. */}
          <span className="lc-gran lc-trend-adaptive" role="group" title={t('trend.adaptiveHint')}>
            <button
              type="button"
              className={'lc-gran-btn' + (adaptive ? ' lc-gran-on' : '')}
              onClick={() => { setAdaptive(on => !on) }}
            >{t('trend.adaptive')}</button>
          </span>
          {focusCat !== null
            ? <span className="lc-card-sub">{t('trend.focus', { cat: kit.catLabel(focusCat) })}</span>
            : null}
          <div className="lc-trend-ctl">
            <div className="lc-gran">
              <button
                className={'lc-gran-btn' + (granularity === 'step' ? ' lc-gran-on' : '')}
                onClick={() => { setGranularity('step') }}
              >{t('gran.step')}</button>
              <button
                className={'lc-gran-btn' + (granularity === 'turn' ? ' lc-gran-on' : '')}
                onClick={() => { setGranularity('turn') }}
              >{t('gran.turn')}</button>
            </div>
            <div className="lc-gran" title={t('gran.modeHint')}>
              <button
                className={'lc-gran-btn' + (trendMode === 'total' ? ' lc-gran-on' : '')}
                onClick={() => { setTrendMode('total') }}
              >{t('gran.total')}</button>
              <button
                className={'lc-gran-btn' + (trendMode === 'delta' ? ' lc-gran-on' : '')}
                onClick={() => { setTrendMode('delta') }}
              >{t('gran.delta')}</button>
            </div>
          </div>
        </div>
        {displayRequests.length === 0
          ? <div className="lc-empty">{t('trend.empty')}</div>
          : (
            <div>
              <TrendChart
                // Remount per agent: switching agents re-anchors the chart at the newest bars instead of inheriting stale scroll
                // state.
                key={agentId}
                requests={displayRequests}
                markers={markers}
                selectedSeq={pinnedReq ? pinnedReq.seq : null}
                hoveredSeq={hoveredSeq}
                activeTurn={activeTurn}
                granularity={granularity}
                mode={trendMode}
                focusTurn={focusTurn}
                hoverCat={trendHoverCat}
                focusCat={focusCat}
                adaptive={adaptive}
                onSelect={setSelectedSeq}
                onHover={setHoveredSeq}
                onHoverTurn={setHoverTurn}
                onPickTurn={(turn) => { setGranularity('turn'); setFocusTurn(turn) }}
                onFocusTurnHandled={() => { setFocusTurn(null) }}
              />
              <RequestDetail
                request={activeReq}
                // Delta mode pairs the detail with the SAME previous record the chart diffs against (first bar: null).
                prev={trendMode === 'delta' && activeIdx >= 0 ? (activeIdx > 0 ? displayRequests[activeIdx - 1]! : null) : undefined}
                /* v8 ignore next 1 -- RequestDetail renders only when
                   displayRequests.length > 0, which forces activeReq
                   non-null via the activeIdx fallback above. */
                marker={activeReq !== null ? markerOf(activeReq) : undefined}
                brief={brief}
                convOf={convOf}
                stepsOf={stepsOf}
                onLocate={locateNode}
                hoverKey={trendHoverCat}
              />
            </div>
          )}
      </div>
    )
    const browserCard = (
      <ContextBrowser
        data={data}
        headers={headers}
        convNodes={convNodes}
        fetchHeader={fetchHeader}
        previewSeq={hoveredSeq}
        pinSeq={pinnedReq !== null ? pinnedReq.seq : null}
        hoverKey={hoverCat}
        onHoverKey={setHoverCat}
        onOpenCat={setFocusCat}
        nodeFocus={nodeFocus}
        onNodeFocusHandled={clearNodeFocus}
        loadImage={props.loadImage}
        systemDerived={systemDerived}
        toolsKnown={toolsKnown}
      />
    )

    return (
      <div className="lc-root" ref={rootRef}>
        {header}

        {/* The head band splits into two rows: the session's shape beside the
            session card, then the two donut cards together. The rows' own
            flex-wrap stacks each pair in a narrow pane at the shared 360px
            card floor. */}
        <div className="lc-cols lc-head">
          {/* The board's cost and cache-hit cells share one population: both
              take the host's session-wide figures when it supplies them
              (`undefined` — not null — means "the shown agent's own"). */}
          <StatsContext
            counts={counts}
            humanInputs={data.humanInputs}
            toolCalls={data.toolCalls}
            usage={props.sessionUsage !== undefined ? props.sessionUsage : usage}
            cost={props.cost ?? data.cost}
            costParts={props.costParts}
            requests={requests}
            requestInput={data.requestInput}
            events={events}
            images={data.images}
            // Children of the SESSION, not of the shown agent: the board's
            // cost and cache-hit cells already answer for the whole family,
            // and `agents` always carries every transcript file of it.
            subagents={agents.filter(a => a.subagent).length}
            pricingRules={props.pricingRules}
            onPriceModel={props.onPriceModel}
            locale={props.locale}
          />
          <SessionInfoCard
            info={props.sessionInfo}
            pricingRules={props.pricingRules}
            onPriceModel={props.onPriceModel}
            locale={props.locale}
          />
        </div>
        <div className="lc-cols lc-head">
          <StatsTokens usage={usage} current={data.current} breakdown={null} />
          <StatsTiming timing={data.timing ?? null} />
        </div>

        {/* One arrangement: composition over trend in the left column, the
            browser beside them and stretched to the pair's height. All
            columns share the 360px floor (`min-w-[min(360px,100%)]`): the
            rows wrap at it, and a sub-360px pane narrows the column instead
            of overflowing. */}
        <div className="lc-cols lc-cols-main">
          <div className="lc-col flex-1 min-w-[min(360px,100%)]">{compositionCard}{trendCard}</div>
          {/* `lc-col-browser` stretches the browser card to the left column's height. */}
          <div className="lc-col lc-col-browser flex-1 min-w-[min(360px,100%)]">{browserCard}</div>
        </div>

        <div className="lc-cols">
          <div className="lc-card lc-col flex-1 min-w-[min(360px,100%)]">
            <div className="lc-card-title">
              <span className="lc-card-title-text">{t('events.title')}</span>
              <div className="lc-kinds @max-[380px]/lc-card:flex-wrap">
                {EVENT_KINDS.map((k) => {
                  const n = kindCounts[k]
                  return (
                    <button
                      key={k}
                      data-kind={k}
                      className={'lc-gran-btn' + (pickedKinds.includes(k) ? ' lc-gran-on lc-kind-' + k : '')}
                      onClick={() => { toggleKind(k) }}
                    >
                      {t('kind.' + k)}
                      {n !== undefined ? <span className="lc-kind-n">{kit.fmt(n)}</span> : null}
                    </button>
                  )
                })}
              </div>
            </div>
            <EventList events={shownEvents} />
          </div>
          <FileCard activity={fileActivity} scope={fileScope} onLocate={locateFileOp} />
        </div>

        <AgentGraph agents={agents} currentId={agentId} onOpenAgent={props.onOpenAgent} />

        <div className="lc-foot">{t('footer')}</div>
      </div>
    )
  }

  return function ContextViewInner(props: ContextViewProps): ReactElement {
    return h(ErrorBoundary, null, h(ContextViewBody, props))
  }
}

/**
 * The Context dashboard.
 *
 * The component factories the vendored view is built from close over the
 * bound translate and the settings face, so they are rebuilt when either
 * identity changes (locale switch) and reused otherwise — keep `t` and
 * `settings` stable across renders in the host app.
 */
export function ContextView(props: ContextViewProps): ReactElement {
  const View = useMemo(() => makeContextView(makeViewKit(props.t), props.settings), [props.t, props.settings])
  return h(View, props)
}
