/**
 * Vendored from dsh-context `src/host/fold.ts` (Apache-2.0, see ../../NOTICE),
 * with the dsh runtime removed: the event envelope and content vocabulary now
 * come from `./event.ts` (the synthesizer→fold contract), `deriveEventMessage`
 * is a local function, and the projection-definition wrapper is gone —
 * `ContextSession` (./session.ts) drives `applyTimeline` directly.
 *
 * The context-timeline fold — replays one transcript file's synthesized event
 * stream into the per-request context-composition timeline.
 *
 * Contract notes (kept from the projection contract dsh folded under):
 * - `applyTimeline(state, event, bounds)` returns the SAME reference when the
 *   event does not change the state (`Object.is` gates the change feed);
 *   any change returns a new reference built from a lazy shallow clone.
 * - `state` stays plain JSON and bounded. Retention bounds: per-step request
 *   records capped (trimmed by whole turns, never cutting a turn in half),
 *   events capped to the newest tail.
 * - Surface nodes are priced with the token heuristic (pricing.ts) and the
 *   request/event records are the raw material of `buildTimelineView`.
 *
 * PORT ADDITIONS, all marked inline:
 * - `tool/result` `data.fileOps` ({@link FileOpInput}) — a synthesizer that
 *   knows its harness's file tools states the ops itself; `opsOfCall` is the
 *   fallback. A `tool/ops` event books the same rows LATE, for a result whose
 *   ops the harness only recorded after the output line.
 * - the DERIVED system remainder — Claude Code and Codex do not always record
 *   the system prompt, so it is reconstructed from the provider-reported
 *   prompt size (see `systemKnown` / `systemDerived`).
 * - `RequestRecord.cacheWrite` — the client sums the request records to build
 *   the token-usage card that dsh read off the token-meter's own projection.
 * - the BLOCK-FRAMED generation window — a settlement stream that carries
 *   `block-start` markers but no token delta still prices its generation time
 *   and decode split (harnesses that persist settled blocks cannot report a
 *   first token; see the `assistant/message` timing branch).
 */

import type {
  Category,
  ContextEventRecord,
  ContextTimelineDetail,
  CostBucketTotals,
  CostModelUsage,
  FileOpRecord,
  RequestRecord,
  SessionCostUsage,
  Snapshot,
  SurfaceNode,
  SystemPromptNode,
  TimingTotals,
  ToolTimingTotals,
} from '../shared/types.ts'
import { isDeepSeekProvider } from '../shared/providers.ts'
import { estimateSystemContent, estimateSystemTokens } from '../shared/estimate.ts'
import type { FoldBounds } from './config.ts'
import {
  estimateMessage,
  estimateToolsTotal,
  firstText,
  imageCountOf,
  injectionSourceName,
  isInjection,
  toolCallNames,
} from './pricing.ts'
import type { ContentBlock, MessageSource, TimelineEvent } from './event.ts'
import { decodeKindOfBlock, decodeSpansOfStream, firstTokenTimeOfStream, hasBlockStartMarker, isTokenChunk, replaceRangeOf } from './logShapes.ts'
import type { DecodeKind } from './logShapes.ts'
import { opsOfCall, parseCallArgs } from '../shared/fileOps.ts'

export type { TimelineEvent }

/**
 * PORT ADDITION — one file operation as a SYNTHESIZER states it, on a
 * `tool/result` (`data.fileOps`) or a late `tool/ops`. The fold stamps the
 * lifecycle fields (`seq`, `time`, `tool`, `err`) from the event and its call
 * pairing; the record keeps everything it knows itself.
 *
 * `added`/`removed` are optional here (they are required on the stored
 * {@link FileOpRecord}): a read or a search states no line delta, and making
 * the synthesizer write `added: 0, removed: 0` on every such row buys nothing.
 * The fold defaults them to 0.
 *
 * `err` is optional and per-ROW: the envelope's own error flag is the default,
 * and a row raises it when one op of a multi-op call failed on its own (a
 * `tool/ops` event has no result envelope to read it from at all). A row never
 * LOWERS the envelope's flag.
 */
export type FileOpInput =
  Omit<FileOpRecord, 'seq' | 'tool' | 'time' | 'err' | 'added' | 'removed'>
  & { added?: number; removed?: number; err?: boolean }

export interface TimelineState {
  /** Model-visible surface, newest last. */
  surface: SurfaceNode[]
  sums: Record<Category, number>
  systemTokens: number
  /**
   * The live system-prompt nodes, oldest first — `system/message` surface
   * nodes, or the single entry a `request/header.header.system` envelope
   * defines. `systemTokens` is the LAST entry with tokens > 0 (the "last
   * nonempty surviving system" rule), so an empty dormant node keeps its
   * position without clearing the prompt. Bounded by SYSTEM_NODES_MAX.
   */
  systems?: SystemPromptNode[]
  /**
   * Whether `systems` was built from the request ENVELOPE (`header.system`)
   * rather than from `system/message` events. Only then may a system-less
   * header CLEAR the list: its canonical envelope meaning is "this request
   * has no system prompt", while a node-carrying generation's header never
   * carries one. Absent = event-sourced, and never materialized as an
   * `undefined`-valued property (plain-JSON precondition — see `model`).
   */
  systemsFromHeader?: true
  /**
   * PORT ADDITION — the transcript demonstrably RECORDS the system prompt: a
   * `request/header` carried a non-empty `header.system`, or a
   * `system/message` node folded. While this is absent the fold derives the
   * prompt as a remainder at every usage-bearing request (see
   * `systemDerived`), because "0 tokens of system prompt" would be a lie.
   */
  systemKnown?: true
  /** PORT ADDITION — the current `systemTokens` figure is a derived remainder. */
  systemDerived?: true
  toolsTokens: number
  /**
   * PORT ADDITION — at least one request header carried a non-empty tool
   * list, so `toolsTokens` is a real estimate. Absent means the harness never
   * recorded tool schemas and the client must say so rather than show 0.
   */
  toolsKnown?: true
  /**
   * Optional fields use ABSENT properties (`model`/`provider`/`lastModel`/
   * `contextWindow` are simply not set until a value is known) instead of
   * `undefined`-valued ones, so the whole state stays losslessly
   * JSON-serializable. Reads via `state.model` are identical for both shapes.
   */
  model?: string
  provider?: string
  lastModel?: string
  contextWindow?: number
  requests: RequestRecord[]
  events: ContextEventRecord[]
  /**
   * Recently removed surface nodes (stamped COPIES carrying `gone`), in
   * removal order. Feeds the Context browser's per-step reconstruction.
   * Bounded two ways in trimState: capped to `maxArchiveNodes`, and pruned
   * to removals after the oldest retained request (older removals can only
   * serve steps the requests trim already forgot).
   */
  archived: SurfaceNode[]
  /**
   * Session-cost raw material: cumulative billed-token totals per
   * (provider, model), split into pricing periods for DeepSeek (see
   * SessionCostUsage / CostModelUsage). Running totals — never trimmed, so
   * the estimate always covers the COMPLETE session even after the
   * request/event retention bounds cut in.
   */
  cost?: SessionCostUsage
  /**
   * Whole-session human-input tally (see Snapshot.humanInputs): every
   * non-injection `user/message` plus every answered `ask_user_question`
   * result. Running total — never trimmed, like `cost`/`timing`.
   */
  humanInputs?: number
  archiveFloor?: number
  /**
   * The detail collections' revision marker (see ContextTimelineDetail):
   * bumped by every fold that mutates the request records, context events,
   * live surface, or the removed-node archive. Absent until the first detail
   * fold (undefined reads as 0).
   */
  detailRev?: number
  /**
   * Whole-session timing totals (see TimingTotals) — running sums, like
   * `cost`. Absent until the first step or tool lifecycle folds in; created
   * once and cloned-on-touch afterwards (the object is shared with the
   * previous state — see `ensure`).
   */
  timing?: TimingTotals
  /**
   * The open step's start instant, armed by `step/start` and consumed by the
   * `assistant/message` (TTFT/generation split) and `step/end` (wall time)
   * that follow it; `assistant/chunk` stamps `firstToken` on the step's first
   * token delta — absent when the stream carried none, which leaves that
   * call's model time unattributed. One slot, not a map: steps are sequential
   * in the log, so the newest `step/start` is the one those events close — a
   * hostile interleaved log degrades to skipped durations, never to unbounded
   * state.
   *
   * `decode` and `block` carry the generation split (reasoning / answer text /
   * tool arguments — see TimingTotals): `assistant/chunk` `block-start`
   * markers open `block` and close the previous one into `decode`; a stream
   * that rides the settlement instead leaves `decode` absent and
   * `assistant/message` reads the spans off its embedded stream.
   */
  stepStart?: { time: number; firstToken?: number; decode?: Record<DecodeKind, number>; block?: { kind: DecodeKind; since: number } }
  /**
   * Tool callId → the call's name, start instant, and raw arguments, armed by
   * `tool/call` and DELETED when its `tool/result` folds in (one result per
   * call, in log order) — the map stays at pending-call size instead of
   * growing for the session's whole lifetime. The start instant prices the
   * call's duration into `timing.toolsMs` when the result arrives; the raw
   * arguments feed the file-op derivation (shared/fileOps.ts) at that same
   * moment.
   */
  callNames: Record<string, { name: string; start: number; argsRaw?: string }>
  /**
   * Seq list of the surface nodes the next replacement will shadow, armed by
   * the metering event (`compaction/summary` | `compaction/prune`) and
   * consumed by the replacement that must follow it synchronously. The
   * producer's shadow price covers exactly these seqs — which can differ
   * from the replacement's declared range (pruned replacement nodes keep
   * their own seqs, beyond the range end) — so removal must follow the seqs.
   * Absent until armed, and REMOVED (not set to `undefined`) when consumed.
   */
  pendingShadowedSeqs?: number[]
  /**
   * The seq of the compaction/prune event that armed `pendingShadowedSeqs` —
   * the shadowed path rewrites that event's `tokens` from the gross shadow
   * price to the NET freed amount (removed nodes minus the synchronous
   * replacement), so the row matches the drop the trend chart shows.
   */
  pendingShadowEventSeq?: number
  /**
   * The fold-derived file-operation log (the File Activity card's raw
   * material): one record per executed file op, appended in log order — at
   * `tool/result` (the synthesizer's own `data.fileOps`, else the armed
   * call's arguments + the result's meta) and at a run_code result's flush of
   * its nested dispatches. Bounded by `maxFileOps`; the trim stamps
   * `fileOpsFloor`.
   */
  fileOps: FileOpRecord[]
  /** The newest dropped op's seq (the card's coverage floor for the served op log). */
  fileOpsFloor?: number
  /**
   * Nested Code-Mode ops buffered by their top run_code call id until the
   * parent's result folds (the dispatch events land BEFORE it, and the ops'
   * locate target is that result's seq). Flushed (and the key deleted) when
   * the result with that callId folds. Bounded by PENDING_CODE_OPS_MAX — a
   * hostile log that never settles a run_code cannot grow it.
   */
  pendingCodeOps?: Record<string, FileOpRecord[]>
}

export function trimToLastTurns(requests: RequestRecord[], maxTurns: number): RequestRecord[] {
  let runs = 0
  let start = requests.length
  let prevTurn: number | undefined
  for (let i = requests.length - 1; i >= 0; i--) {
    const turn = requests[i]?.turn
    if (turn !== prevTurn) {
      if (runs >= maxTurns) break
      runs++
      prevTurn = turn
    }
    start = i
  }
  return requests.slice(start)
}

function countTurnRuns(requests: RequestRecord[]): number {
  let runs = 0
  let prevTurn: number | undefined
  for (const r of requests) {
    if (r.turn !== prevTurn) {
      runs++
      prevTurn = r.turn
    }
  }
  return runs
}

function trimState(st: TimelineState, bounds: FoldBounds): void {
  // Trim by WHOLE turn-runs as soon as the run count crosses the cap —
  // not only when the raw step count does — so the state stays
  // deterministically at the newest ~maxKeptTurns turns (a threshold-only
  // policy would oscillate: trim to 1200, regrow to 1500, trim again).
  if (countTurnRuns(st.requests) > bounds.maxKeptTurns) {
    st.requests = trimToLastTurns(st.requests, bounds.maxKeptTurns)
  }
  // Pathological many-step turns: hard step backstop after the turn trim.
  if (st.requests.length > bounds.maxRequestSteps) {
    st.requests = st.requests.slice(-bounds.maxRequestSteps)
  }
  if (st.events.length > bounds.maxEvents) st.events = st.events.slice(-bounds.maxEvents)
  // The file-op log: newest tail; the newest dropped op's seq rides
  // `fileOpsFloor` (the same coverage-floor family as archiveFloor).
  if (st.fileOps.length > bounds.maxFileOps) {
    const drop = st.fileOps.length - bounds.maxFileOps
    const last = st.fileOps[drop - 1]
    if (last !== undefined) st.fileOpsFloor = Math.max(st.fileOpsFloor ?? 0, last.seq)
    st.fileOps = st.fileOps.slice(drop)
  }
  // Archive retention (the Context browser's per-step reconstruction raw
  // material). Entries leave in removal order (oldest `gone` first), so the
  // newest dropped `gone` is the last dropped entry's — recorded as
  // `archiveFloor` for the client's approximate-reconstruction note.
  if (st.archived.length > 0) {
    let drop = 0
    // Removals at or before the oldest retained request can only reconstruct
    // steps the requests trim already forgot.
    const oldestReq = st.requests[0]?.seq
    if (oldestReq !== undefined) {
      while (drop < st.archived.length
        && (st.archived[drop]?.gone ?? Infinity) <= oldestReq) drop++
    }
    if (st.archived.length - drop > bounds.maxArchiveNodes) {
      drop = st.archived.length - bounds.maxArchiveNodes
    }
    if (drop > 0) {
      const floor = st.archived[drop - 1]?.gone
      if (floor !== undefined) st.archiveFloor = Math.max(st.archiveFloor ?? 0, floor)
      st.archived = st.archived.slice(drop)
    }
  }
}

export function createTimelineState(): TimelineState {
  return {
    surface: [],
    sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
    systemTokens: 0,
    toolsTokens: 0,
    requests: [],
    events: [],
    archived: [],
    callNames: {},
    fileOps: [],
  }
}

function categoryOf(type: string, message: { source?: MessageSource } | undefined): Category {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  // Skill machinery is its own bucket: a user-explicit `/name` invocation
  // rides a `skill-invocation` source, the available-skills digest a
  // `skill-catalog` one — both user/message injections that the plain
  // injected-context check would otherwise absorb.
  const kind = message?.source?.kind
  if (kind === 'skill-invocation' || kind === 'skill-catalog') return 'skill'
  if (isInjection(message?.source)) return 'inject'
  return 'user'
}

/**
 * Mark the detail collections dirty (TimelineState.detailRev). Every caller
 * is a fold branch that just mutated the requests/events/surface/archive;
 * branches that touch only the working slots (stepStart, callNames, the
 * shadow claim) or the envelope scalars do NOT bump.
 */
function bumpDetailRev(st: TimelineState): void {
  st.detailRev = (st.detailRev ?? 0) + 1
}

/**
 * Bound on the live system-prompt nodes (TimelineState.systems). The
 * effective figure is the LAST nonempty node, so dropping the oldest can only
 * under-report a pathological log whose newest SYSTEM_NODES_MAX nodes are all
 * empty while an older one still carried text.
 */
const SYSTEM_NODES_MAX = 8

/** The effective system-prompt price: the last nonempty node, else 0. */
function systemTokensOf(systems: readonly SystemPromptNode[]): number {
  for (let i = systems.length - 1; i >= 0; i--) {
    const node = systems[i]
    if (node !== undefined && node.tokens > 0) return node.tokens
  }
  return 0
}

/** Append one system-prompt node, bounding the list (see SYSTEM_NODES_MAX). */
function pushSystem(st: TimelineState, node: SystemPromptNode): void {
  const systems = [...(st.systems ?? []), node]
  st.systems = systems.length > SYSTEM_NODES_MAX ? systems.slice(-SYSTEM_NODES_MAX) : systems
  st.systemTokens = systemTokensOf(st.systems)
}

/**
 * Bound on the buffered nested Code-Mode ops (TimelineState.pendingCodeOps)
 * — a hostile log that dispatches without settling the parent run_code
 * cannot grow the state past this.
 */
const PENDING_CODE_OPS_MAX = 200

/** JSON-stringify an unknown argument payload; a hostile (cyclic) value yields no args. */
function argsRawOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** Append op records to the fold-derived log (the trim lives in trimState, with the other collections). */
function pushFileOps(st: TimelineState, ops: FileOpRecord[]): void {
  for (const op of ops) st.fileOps.push(op)
}

/**
 * PORT ADDITION — file the ops of a LATE booking (`tool/ops`) at their own
 * seq, keeping the log seq-ordered. Every op of one batch shares a seq, so the
 * insertion point is the upper bound of that seq: a binary search, and the
 * overwhelmingly common case (the batch is newer than everything already
 * logged) short-circuits to a plain append.
 */
function insertFileOps(st: TimelineState, ops: FileOpRecord[]): void {
  const seq = ops[0]?.seq
  const last = st.fileOps.at(-1)
  if (seq === undefined || last === undefined || last.seq <= seq) {
    pushFileOps(st, ops)
    return
  }
  let lo = 0
  let hi = st.fileOps.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((st.fileOps[mid]?.seq ?? 0) <= seq) lo = mid + 1
    else hi = mid
  }
  st.fileOps.splice(lo, 0, ...ops)
}

/**
 * PORT ADDITION — the tool name already recorded for the result at `seq`, for
 * a late `tool/ops` that does not name one itself. The `tool/call` entry is
 * consumed when its result folds, so the name is recovered from what the
 * result LEFT behind: an op already filed at that seq, the live surface node,
 * or its archived copy. '' when nothing knows it (the same honest blank an
 * unpaired `tool/result` books).
 */
function toolNameAtSeq(state: TimelineState, seq: number): string {
  for (let i = state.fileOps.length - 1; i >= 0; i--) {
    const op = state.fileOps[i]
    if (op !== undefined && op.seq === seq && op.tool !== '') return op.tool
  }
  for (let i = state.surface.length - 1; i >= 0; i--) {
    const node = state.surface[i]
    if (node !== undefined && node.seq === seq && node.tool !== undefined) return node.tool
  }
  for (let i = state.archived.length - 1; i >= 0; i--) {
    const node = state.archived[i]
    if (node !== undefined && node.seq === seq && node.tool !== undefined) return node.tool
  }
  return ''
}

/** The three file-op purposes, re-proved over untrusted synthesizer input. */
const OP_KINDS: ReadonlySet<string> = new Set<string>(['read', 'write', 'search'])

/** A non-negative integer count; anything unreadable degrades to 0. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** The read window a stated op carries, in either shape, or null. */
type ReadWindow = { start: number; count: number } | { count: number; est: true }

function readOfInput(value: unknown): ReadWindow | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as { start?: unknown; count?: unknown; est?: unknown }
  const count = countOf(raw.count)
  if (typeof raw.start === 'number' && Number.isFinite(raw.start) && raw.start >= 1) {
    return { start: Math.round(raw.start), count: countOf(raw.count) }
  }
  return count > 0 ? { count, est: true } : null
}

/**
 * PORT ADDITION — normalize the file ops a synthesizer stated on a
 * `tool/result` ({@link FileOpInput}) into stored records, stamping the
 * lifecycle fields off the event and its call pairing. Every field is
 * re-proved: the synthesizer reads an untrusted transcript, so a malformed
 * row is DROPPED rather than folded.
 */
function fileOpsOfInput(raw: unknown, stamp: { seq: number; time: number; tool: string; err: boolean }): FileOpRecord[] {
  if (!Array.isArray(raw)) return []
  const ops: FileOpRecord[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const input = item as FileOpInput
    if (typeof input.path !== 'string' || input.path === '') continue
    if (!OP_KINDS.has(input.kind)) continue
    const op: FileOpRecord = {
      seq: stamp.seq,
      time: stamp.time,
      tool: stamp.tool,
      // A row may RAISE the envelope's error flag (one op of a multi-op call
      // failed on its own), never lower it.
      err: stamp.err || input.err === true,
      kind: input.kind,
      path: input.path,
      added: countOf(input.added),
      removed: countOf(input.removed),
    }
    if (typeof input.detail === 'string' && input.detail !== '') op.detail = input.detail
    const hits = countOf(input.hits)
    if (hits > 0) op.hits = hits
    const read = readOfInput(input.read)
    if (read !== null) op.read = read
    if (typeof input.parent === 'number' && Number.isFinite(input.parent)) op.parent = input.parent
    if (typeof input.program === 'string' && input.program !== '') op.program = input.program
    if (input.pattern === true) op.pattern = true
    ops.push(op)
  }
  return ops
}

/**
 * Buffer nested Code-Mode ops under their top run_code call id (they flush
 * when the parent's result folds — the ops' locate target). A full buffer
 * drops new arrivals wholesale (defensive logs only).
 */
function bufferCodeOps(st: TimelineState, rootCallId: string, ops: FileOpRecord[]): void {
  const pending = st.pendingCodeOps ?? {}
  let total = 0
  for (const k in pending) total += pending[k]?.length ?? 0
  if (total + ops.length > PENDING_CODE_OPS_MAX) return
  st.pendingCodeOps = { ...pending, [rootCallId]: [...(pending[rootCallId] ?? []), ...ops] }
}

/**
 * Archive removed surface nodes as stamped COPIES — the objects leaving
 * `st.surface` are shared with the previous state, so `gone` must never be
 * written onto them directly.
 */
function archiveRemoved(st: TimelineState, removed: SurfaceNode[], goneSeq: number): void {
  for (const n of removed) st.archived.push({ ...n, gone: goneSeq })
}

/**
 * Remove every live surface node whose seq the replacement claims, keeping the
 * per-category sums equal to the surviving nodes and archiving the removals.
 * Removal follows the SEQ list, not the declared range: pruned replacement
 * nodes keep their own seqs beyond the range end, so a range-based removal
 * would leave them behind and overcount. Returns the removed nodes.
 */
function removeSurfaceSeqs(st: TimelineState, claimed: ReadonlySet<number>, goneSeq: number): SurfaceNode[] {
  if (claimed.size === 0) return []
  const kept: SurfaceNode[] = []
  const removed: SurfaceNode[] = []
  for (const n of st.surface) {
    if (claimed.has(n.seq)) {
      st.sums[n.cat] -= n.tokens
      removed.push(n)
    } else {
      kept.push(n)
    }
  }
  archiveRemoved(st, removed, goneSeq)
  st.surface = kept
  return removed
}

interface SurfaceEventLike {
  seq: number
  time: number
  surfaceOp?: unknown
}

interface MessageLike {
  content?: ContentBlock[]
  source?: MessageSource
  error?: boolean
}

/**
 * The message nested under an event payload's `message` field
 * (`system/message`, `assistant/message`, `tool/result`). A malformed payload
 * reads null.
 */
function messageOf(data: Record<string, unknown> | undefined): MessageLike | null {
  const message = data?.message
  return message !== null && message !== undefined && typeof message === 'object'
    ? message as MessageLike
    : null
}

/**
 * PORT REPLACEMENT for dsh's `deriveEventMessage` — the model-visible message
 * of one event:
 *
 *   user/message      → `event.data` IS the message (content + source)
 *   assistant/message → `event.data.message`, or null when its content array
 *                       is empty or missing (a usage-only settlement projects
 *                       to NO message, so it prices 0)
 *   tool/result       → `event.data.message`
 *
 * Anything else, and any malformed payload, reads null. Unlike the dsh
 * function this never throws on a missing `data.message`: it reads as "no
 * message", which the callers already handle.
 */
function deriveEventMessage(event: TimelineEvent): MessageLike | null {
  const data = event.data
  if (data === undefined || data === null) return null
  if (event.type === 'user/message') return data as MessageLike
  const message = messageOf(data)
  if (message === null) return null
  if (event.type === 'assistant/message'
    && (!Array.isArray(message.content) || message.content.length === 0)) {
    return null
  }
  return message
}

/**
 * The first full text block, recursing through nested content blocks (a tool
 * result wraps its text in a `tool-result` block). Unlike `firstText` this
 * must NOT truncate/normalize: the skill name is matched off the raw
 * `<skill_content name="…">` wrapper.
 */
function nestedText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text
    if (block.content !== undefined) {
      const nested = nestedText(block.content)
      if (nested !== '') return nested
    }
  }
  return ''
}

/**
 * The skill name a `skill`-tool result carries. Loaded skills are rendered as
 * `<skill_content name="…">…</skill_content>` in the result's text, so the name
 * is recovered from the content rather than trusted from the call envelope.
 */
function skillNameOf(msg: MessageLike | null | undefined): string {
  const text = nestedText(msg?.content)
  const match = /<skill_content\s+name="([^"]+)"/.exec(text)
  return match?.[1] ?? ''
}

function applySurface(
  st: TimelineState,
  ev: SurfaceEventLike,
  type: string,
  data: Record<string, unknown> | undefined,
  message: MessageLike | null | undefined,
): SurfaceNode {
  const cat = categoryOf(type, message ?? undefined)
  const node: SurfaceNode = {
    seq: ev.seq,
    time: ev.time,
    cat,
    // Empty assistant messages project to no model message (usage-only), so
    // they price 0 — `deriveEventMessage` returns null for that case, and
    // `estimateMessage(null, true)` short-circuits before ROLE_OVERHEAD.
    tokens: estimateMessage(message, type === 'assistant/message'),
  }
  // Image blocks ride the NODE (absent when zero): the stats board's image
  // cell sums the live surface, so a compacted message's images stop counting.
  const imgs = imageCountOf(message?.content)
  if (imgs > 0) node.imgs = imgs
  const source = message?.source
  const form = source?.form
  if (typeof form === 'string') node.form = form
  if (type === 'assistant/message') {
    const text = firstText(message?.content)
    if (text !== '') node.text = text
    else {
      const names = toolCallNames(message?.content)
      if (names.length > 0) node.calls = names.slice(0, 3)
    }
  } else if (type === 'tool/result') {
    // The call id rides the source authoritatively
    // (`tool/result.message.source.callId`); the content block mirrors it as
    // `toolCallId`.
    const srcId = (source as { callId?: unknown } | undefined)?.callId
    const block = message?.content?.[0] as { toolCallId?: unknown } | undefined
    const blockId = block?.toolCallId
    // The name is stamped only on a real map hit: an unpaired result (a call
    // event that aged out of the log, a foreign producer, a duplicate callId)
    // must not materialize an `undefined`-valued property.
    const srcEntry = typeof srcId === 'string' ? st.callNames[srcId] : undefined
    const blockEntry = srcEntry === undefined && typeof blockId === 'string'
      ? st.callNames[blockId]
      : undefined
    // Price the completed call into the timing totals: the same entry that
    // names the node carries the call's start instant; an unpaired result
    // carries neither name nor duration.
    const toolEntry = srcEntry ?? blockEntry
    if (toolEntry !== undefined) {
      node.tool = toolEntry.name
      const timing = ensureTiming(st)
      const dur = durOf(toolEntry.start, ev.time)
      timing.toolsMs += dur
      timing.toolCalls += 1
      bumpToolTotals(timing, toolEntry.name, dur)
    }
    // Consume-once: the entry is never looked up again after its result
    // folds in (see TimelineState.callNames). Rebuild without the used ids —
    // consume-once holds the map at pending-call size, so the copy is trivial.
    if (typeof srcId === 'string' || typeof blockId === 'string') {
      const kept: TimelineState['callNames'] = {}
      for (const k in st.callNames) {
        const entry = st.callNames[k]
        if (entry !== undefined && k !== srcId && k !== blockId) kept[k] = entry
      }
      st.callNames = kept
    }
    if (data !== undefined && Boolean(data.error)) node.err = true
  } else if (source?.kind === 'skill-invocation') {
    node.skill = typeof source.name === 'string' ? source.name : '?'
  } else if (source?.kind === 'plugin') {
    if (source.form === 'notice' && typeof source.summary === 'string') node.text = source.summary
    else if (source.form === 'snapshot' && Array.isArray(source.sections)) {
      node.text = source.sections.map(s => s?.name).filter(Boolean).join(', ').slice(0, 80)
    } else {
      const ptext = firstText(message?.content)
      if (ptext !== '') node.text = ptext
    }
  } else {
    const utext = firstText(message?.content)
    if (utext !== '') node.text = utext
  }

  // Consume the armed shadow claim here (a later surface event would expire it, per the shadow-price protocol); DELETE the fields —
  // assigning `undefined` would break the plain-JSON state precondition.
  const shadowedSeqs = st.pendingShadowedSeqs
  const shadowEventSeq = st.pendingShadowEventSeq
  delete st.pendingShadowedSeqs
  delete st.pendingShadowEventSeq

  const op = replaceRangeOf(ev.surfaceOp)
  if (op !== null) {
    if (Array.isArray(shadowedSeqs) && shadowedSeqs.length > 0) {
      // The producer's shadow price covers exactly these node seqs, which can
      // include replacement nodes BEYOND the declared range end (their own
      // seqs postdate the range). Removing by seqs keeps our per-category
      // bookkeeping equal to the producer's total — a range-based removal
      // would leave those nodes behind and overcount.
      const removed = removeSurfaceSeqs(st, new Set(shadowedSeqs), ev.seq)
      st.sums[cat] += node.tokens
      st.surface.push(node)
      // Rewrite the metering event's row from its gross shadow price to the
      // NET freed amount (the replacement re-adds its own tokens), so the
      // number matches the drop the trend chart shows. The record is cloned:
      // the events array's elements are shared with the previous state.
      if (shadowEventSeq !== undefined) {
        const removedSum = removed.reduce((sum, n) => sum + n.tokens, 0)
        const i = st.events.findIndex(e => e.seq === shadowEventSeq)
        const prev = i >= 0 ? st.events[i] : undefined
        if (prev !== undefined) st.events[i] = { ...prev, tokens: Math.max(0, removedSum - node.tokens) }
      }
      return node
    }
    // No shadow claim: the replacement names its span directly, read off BOTH
    // endpoint spellings (logShapes.replaceRangeOf) and spliced IN PLACE — the
    // replacing node takes the span's position. BOTH endpoints must name live
    // nodes; a malformed span degrades to an append, which keeps the nodes
    // rather than silently dropping context.
    let si = -1
    let ei = -1
    for (let i = 0; i < st.surface.length; i++) {
      const n = st.surface[i]
      if (n === undefined) continue
      if (si < 0 && n.seq === op.start) si = i
      if (n.seq === op.end) { ei = i; break }
    }
    if (si >= 0 && ei >= si) {
      const removed = st.surface.splice(si, ei - si + 1, node)
      archiveRemoved(st, removed, ev.seq)
      for (const r of removed) st.sums[r.cat] -= r.tokens
      st.sums[cat] += node.tokens
      return node
    }
  }
  st.surface.push(node)
  st.sums[cat] += node.tokens
  return node
}

/** The usage object, as far as the fold reads it — every bucket is re-proved by `tokenCountOf`, never trusted. */
interface UsageLike {
  inputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  cacheWrite1hTokens?: unknown
  outputTokens?: unknown
}

/** One usage object's buckets, deeply normalized to billed counts (see {@link tokenCountOf}). */
interface BilledUsage {
  input: number
  cacheRead: number
  cacheWrite: number
  /** The 1h-TTL SUBSET of `cacheWrite` (clamped ≤ cacheWrite) — see CostBucketTotals.cacheWrite1h. */
  cacheWrite1h: number
  output: number
}

/**
 * One provider-reported usage bucket as a billed count, or null when the
 * field carries no readable number. Accepts finite numbers and numeric
 * strings; fractions round (some gateways report fractional counts) and
 * negatives clamp to 0 — a mis-accounting gateway that reports
 * `cached_tokens > prompt_tokens` would otherwise drive the disjoint
 * uncached-input figure below zero. NaN, infinities, and non-numeric values
 * read as absent.
 */
function tokenCountOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null
  }
  return null
}

/**
 * DeepSeek's peak windows (the official list: UTC 01:00–04:00 and 06:00–10:00,
 * Monday through Friday — Beijing Time 09:00–12:00 and 14:00–18:00). All other
 * hours, plus entire weekends, bill at the half-price off-peak rate. Harmless
 * for anthropic/openai: `isDeepSeekProvider` is false there and everything
 * books under `peak`.
 */
function isPeakUtc(time: number): boolean {
  const at = new Date(time)
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = at.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

/**
 * Fold one billed request into the session-cost totals, cloning along the
 * mutated path only (the untouched branch stays shared with the previous
 * state — the apply contract never mutates it in place). The buckets arrive
 * sanitized ({@link BilledUsage}). The key is the request envelope's
 * (provider, model) face — the exact lookup the client's model-price book
 * resolves (models.dev). A request without a provider still accumulates
 * (under the '' key); without a model there is nothing to price.
 */
function accumulateCost(st: TimelineState, time: number, usage: BilledUsage): void {
  const model = st.model
  if (model === undefined) return
  const provider = st.provider ?? ''
  const period = isDeepSeekProvider(provider) && !isPeakUtc(time) ? 'off' : 'peak'
  const models = st.cost?.[provider] ?? {}
  const periods = models[model] ?? {}
  const b = periods[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const nextPeriods: CostModelUsage = { ...periods }
  const next: CostBucketTotals = {
    uncached: b.uncached + usage.input,
    cacheRead: b.cacheRead + usage.cacheRead,
    cacheWrite: b.cacheWrite + usage.cacheWrite,
    output: b.output + usage.output,
  }
  // The 1h share rides along only once a 1h write actually happened: a bucket
  // that never saw one keeps the dsh shape exactly (four keys).
  const write1h = (b.cacheWrite1h ?? 0) + usage.cacheWrite1h
  if (write1h > 0) next.cacheWrite1h = write1h
  nextPeriods[period] = next
  const nextModels: Record<string, CostModelUsage> = { ...models, [model]: nextPeriods }
  st.cost = { ...(st.cost ?? {}), [provider]: nextModels }
}

/** The timing card's per-tool ranking cap: the busiest 16 names are kept. */
const TOOL_TIMING_CAP = 16

/**
 * The interactive Q&A tool: its settled result IS the user's answer, so it
 * folds into the human-input tally alongside the user's own messages. One
 * result = one answer submission, however many questions the prompt carried.
 */
const ASK_USER_TOOL = 'ask_user_question'

/** The decode buckets of the generation split, in card order (see TimingTotals). */
const DECODE_KINDS: readonly DecodeKind[] = ['reasoning', 'text', 'toolarg']

/** Non-negative, NaN-proof duration between two instants (hostile times degrade to 0). */
function durOf(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, to - from)
}

/**
 * The fold's private timing accumulator: created on first use, and CLONED on
 * every later ensure() (see `applyTimeline`) — the object left in the previous
 * state is never written into in place.
 */
function ensureTiming(st: TimelineState): TimingTotals {
  const existing = st.timing
  if (existing !== undefined) return existing
  const created: TimingTotals = { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }
  st.timing = created
  return created
}

/**
 * Fold one block's decode span into the totals' generation split (see
 * TimingTotals). A zero span stays ABSENT — the field then carries the
 * "no time was decoded in this bucket" fact without adding dead properties to
 * every pre-split-shaped state, and the card reads absence as 0.
 */
function addDecode(timing: TimingTotals, kind: DecodeKind, ms: number): void {
  if (!(ms > 0)) return
  if (kind === 'reasoning') timing.reasoningMs = (timing.reasoningMs ?? 0) + ms
  else if (kind === 'text') timing.textMs = (timing.textMs ?? 0) + ms
  else timing.toolArgMs = (timing.toolArgMs ?? 0) + ms
}

/**
 * Tally one completed tool call into the per-name ranking, bounded to
 * TOOL_TIMING_CAP names: repeated names update in place, a new name beyond
 * the cap evicts the smallest tally first (the ranking's tail), so state
 * stays bounded even over a hostile log of unique names.
 */
function bumpToolTotals(timing: TimingTotals, name: string, ms: number): void {
  // hasOwn, not an index check: a missing key IS possible at runtime (a name
  // outside the persisted tally), and the hasOwn guard reads honestly.
  if (!Object.hasOwn(timing.tools, name)) {
    if (Object.keys(timing.tools).length >= TOOL_TIMING_CAP) {
      // The record is non-empty whenever the cap binds, so the scan always
      // names a minimum (the first probe wins against +Infinity).
      let minKey = ''
      let minMs = Infinity
      for (const k in timing.tools) {
        const row = timing.tools[k]
        if (row !== undefined && row.ms < minMs) {
          minMs = row.ms
          minKey = k
        }
      }
      const kept: Record<string, ToolTimingTotals> = {}
      for (const k in timing.tools) {
        const row = timing.tools[k]
        if (row !== undefined && k !== minKey) kept[k] = row
      }
      timing.tools = kept
    }
    timing.tools[name] = { calls: 1, ms }
    return
  }
  const cur = timing.tools[name] ?? { calls: 0, ms: 0 }
  timing.tools[name] = { calls: cur.calls + 1, ms: cur.ms + ms }
}

/**
 * Advance the fold over ONE event. Uninteresting events return the same
 * reference (`Object.is` gates the change feed); any change returns a new
 * reference over a lazy shallow clone, so the previous state is never mutated
 * in place by the caller. `bounds` are retention only — they never change the
 * state shape.
 */
export function applyTimeline(state: TimelineState, event: TimelineEvent, bounds: FoldBounds): TimelineState {
  let st: TimelineState | undefined
  const ensure = (): TimelineState => st ??= {
    ...state,
    surface: [...state.surface],
    sums: { ...state.sums },
    requests: [...state.requests],
    events: [...state.events],
    archived: [...state.archived],
    callNames: { ...state.callNames },
    fileOps: [...state.fileOps],
    // The pending-ops MAP is cloned here; each key's array is rebuilt on
    // touch (bufferCodeOps/flush), never mutated in place — same rule.
    ...(state.pendingCodeOps !== undefined
      ? { pendingCodeOps: { ...state.pendingCodeOps } }
      : {}),
    // The timing totals are shared with the previous state — private working
    // copies for this event's accumulations (per-name rows are replaced,
    // never mutated, so a one-level copy suffices for them).
    ...(state.timing !== undefined
      ? { timing: { ...state.timing, tools: { ...state.timing.tools } } }
      : {}),
  }

  const data = event.data
  // The transcript is untrusted input, so a malformed event is DROPPED, never
  // thrown: one throwing fold would stall the Context tab on its loading
  // state forever. Any partial mutations are private lazy clones and stay
  // valid plain JSON.
  try {
    switch (event.type) {
      case 'request/header': {
        const header = (data?.header ?? {}) as {
          system?: unknown
          tools?: unknown[]
          config?: { model?: unknown; provider?: unknown }
        }
        const tools = Array.isArray(header.tools) ? header.tools : []
        const s = ensure()
        // Tools TOTAL = the whole-array price (one JSON string of every schema).
        s.toolsTokens = estimateToolsTotal(tools)
        // PORT ADDITION: once a header lists tools, the tool-schema figure is
        // real. A header that lists none does NOT clear the marker — a model
        // switch header legitimately repeats an empty list.
        if (tools.length > 0) s.toolsKnown = true
        // The system prompt may ride this ENVELOPE; the newer generation
        // carries it as a `system/message` surface node instead. A present
        // string is the envelope's own prompt for every request in its
        // series; an absent one means "this request has no system prompt"
        // ONLY when the list was envelope-sourced.
        const systemText = header.system
        if (typeof systemText === 'string' && systemText !== '') {
          s.systems = [{ seq: event.seq, time: event.time, tokens: estimateSystemTokens(systemText) }]
          s.systemsFromHeader = true
          s.systemTokens = systemTokensOf(s.systems)
          // PORT ADDITION: the transcript records the prompt — stop deriving.
          s.systemKnown = true
          delete s.systemDerived
        } else if (s.systemsFromHeader === true) {
          s.systems = []
          delete s.systemsFromHeader
          s.systemTokens = 0
        }
        // Current route/model: the request envelope is the source of truth
        // (request/context is only route/capacity metadata, appended AFTER
        // request/header per request). Optional fields are set conditionally
        // so a still-unknown value never materializes an `undefined` property.
        if (header.config && typeof header.config.model === 'string') s.model = header.config.model
        if (header.config && typeof header.config.provider === 'string') s.provider = header.config.provider
        // A model switch has no dedicated event: it is a request header that
        // differs from the previous one, logged with reason 'change'
        // ('initial' opens a session, 'resume' reopens it). Firing only on a
        // real change keeps the list equal to the record.
        if ((data?.reason === 'change' || data?.reason === 'resume') && s.model && s.lastModel && s.model !== s.lastModel) {
          s.events.push({ seq: event.seq, time: event.time, kind: 'model', from: s.lastModel, to: s.model })
          bumpDetailRev(s)
        }
        if (s.model) s.lastModel = s.model
        break
      }
      case 'system/message': {
        // The system prompt as a SURFACE node (position 0 of the ordered
        // surface) that the fold tracks outside its message categories — it is
        // the envelope figure's source, never a user/inject/assistant/tool
        // node, so it must not enter `surface` or `sums` (that would
        // double-count it against `systemTokens`).
        const s = ensure()
        // Consume the armed shadow claim (the shadow-price protocol expires it
        // on the next surface event) — a system node never carries one.
        delete s.pendingShadowedSeqs
        delete s.pendingShadowEventSeq
        const op = replaceRangeOf(event.surfaceOp)
        if (op !== null) {
          const systems = s.systems ?? []
          s.systems = systems.filter(n => n.seq < op.start || n.seq > op.end)
          // Defensive: a replacement claiming ordinary surface nodes removes
          // them too, so the surface and its sums stay consistent with the claim.
          const claimed = new Set<number>()
          for (const n of s.surface) {
            if (n.seq >= op.start && n.seq <= op.end) claimed.add(n.seq)
          }
          if (removeSurfaceSeqs(s, claimed, event.seq).length > 0) bumpDetailRev(s)
        }
        delete s.systemsFromHeader
        pushSystem(s, { seq: event.seq, time: event.time, tokens: estimateSystemContent(messageOf(data)?.content) })
        // PORT ADDITION: the transcript records the prompt — stop deriving.
        s.systemKnown = true
        delete s.systemDerived
        break
      }
      case 'request/context': {
        const s = ensure()
        // Route/capacity metadata: request/context is logged only when the route or capacity changes (after request/header), so it updates
        // the current route display — never firing a model-switch event on its own.
        if (data && typeof data.contextWindow === 'number') s.contextWindow = data.contextWindow
        if (data && typeof data.model === 'string') s.model = data.model
        if (data && typeof data.provider === 'string') s.provider = data.provider
        break
      }
      case 'tool/call': {
        if (data && typeof data.callId === 'string' && typeof data.name === 'string') {
          const s = ensure()
          // The raw arguments ride along for the result-time file-op derivation (shared/fileOps.ts).
          const argsRaw = argsRawOf(data.arguments)
          s.callNames[data.callId] = {
            name: data.name,
            start: event.time,
            ...(argsRaw !== undefined ? { argsRaw } : {}),
          }
        }
        break
      }
      case 'tool/ops': {
        // PORT ADDITION — a LATE file-op booking for a result that already
        // folded. Codex writes a share of its `item_completed`
        // (CommandExecution / FileChange) records AFTER the tool output line,
        // so its synthesizer would otherwise have to defer every `tool/result`
        // on the chance that a late record follows. It emits this instead.
        //
        // The ops are filed under `resultSeq` — the result's own seq, not this
        // event's — so the File Activity rows locate on the right node and the
        // op log stays seq-ordered (insertFileOps splices them into place).
        const resultSeq = data?.resultSeq
        if (typeof resultSeq !== 'number' || !Number.isFinite(resultSeq)) return state
        const raw = data?.fileOps
        if (!Array.isArray(raw) || raw.length === 0) return state
        // The result's own ops were already trimmed out of the log, so a late
        // row for it would be the only trace of a window we no longer cover.
        if (state.fileOpsFloor !== undefined && resultSeq <= state.fileOpsFloor) return state
        const named = data?.tool
        const ops = fileOpsOfInput(raw, {
          seq: resultSeq,
          time: event.time,
          tool: typeof named === 'string' && named !== '' ? named : toolNameAtSeq(state, resultSeq),
          err: data?.err === true,
        })
        if (ops.length === 0) return state
        const s = ensure()
        insertFileOps(s, ops)
        bumpDetailRev(s)
        break
      }
      case 'tool/code-dispatch':
      case 'tool/ptc-dispatch': {
        // A nested call settling inside a run_code program: one settled
        // sub-dispatch books its file ops exactly like a top-level call —
        // minus meta (the dispatch event carries none, so read windows and
        // per-file search attribution degrade to the argument-only forms).
        // The ops buffer under the top run_code call id and flush when its
        // result folds (their locate target is that result's row). BOTH
        // vocabulary generations land here.
        const rootCallId = data?.rootCallId
        const name = data?.name
        if (typeof rootCallId === 'string' && typeof name === 'string') {
          const ops = opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: name,
            argsRaw: argsRawOf(data?.arguments),
            err: data?.isError === true,
          })
          if (ops.length > 0) {
            const s = ensure()
            bufferCodeOps(s, rootCallId, ops)
          }
        }
        break
      }
      case 'assistant/chunk': {
      // Stream events: the token flood, one event per chunk, so this case
      // stays cheap and mostly reference-stable — only the open step's FIRST
      // token delta stamps the slot (later deltas and steps without a slot
      // return the same state). A settlement-embedded stream rides
      // `assistant/message` / `assistant/attempt` instead (see below).
      //
      // A `block-start` marker opens a decode block (reasoning / answer text /
      // tool arguments) and closes the previous one into the slot's decode
      // spans, so the generation window splits by what was being decoded.
        const start = state.stepStart
        if (start === undefined) return state
        const chunk = data?.chunk as { type?: unknown; blockType?: unknown } | null | undefined
        if (chunk !== null && chunk !== undefined && typeof chunk === 'object' && chunk.type === 'block-start') {
          const kind = decodeKindOfBlock(chunk.blockType)
          // An unknown marker still CLOSES the open block (its end is real);
          // only the interval it would open stays unattributed.
          if (start.block === undefined && kind === undefined) return state
          const s = ensure()
          const decode: Record<DecodeKind, number> = { ...(start.decode ?? { reasoning: 0, text: 0, toolarg: 0 }) }
          if (start.block !== undefined) decode[start.block.kind] += durOf(start.block.since, event.time)
          // The next block is ABSENT (not undefined-valued) when unknown.
          s.stepStart = {
            time: start.time,
            ...(start.firstToken !== undefined ? { firstToken: start.firstToken } : {}),
            decode,
            ...(kind !== undefined ? { block: { kind, since: event.time } } : {}),
          }
          break
        }
        if (start.firstToken !== undefined) return state
        if (!isTokenChunk(data?.chunk)) return state
        const s = ensure()
        s.stepStart = { ...start, firstToken: event.time }
        break
      }
      case 'assistant/attempt': {
      // One model attempt that committed no surface message. Its embedded
      // stream still carries the attempt's first token, so an in-step retry
      // keeps its real TTFT instead of falling into the card's residue.
        const start = state.stepStart
        if (start === undefined || start.firstToken !== undefined) return state
        const first = firstTokenTimeOfStream(data?.stream)
        if (first === undefined) return state
        const s = ensure()
        s.stepStart = { time: start.time, firstToken: first }
        break
      }
      case 'step/start': {
        // Arm the single pending-step slot (see TimelineState.stepStart): the
        // following assistant/chunk stamps the first token on it, and the
        // assistant/message and step/end price the model wait/generation and
        // the whole step against this instant. Always a state change (a new
        // slot value), even over an un-consumed predecessor.
        const s = ensure()
        s.stepStart = { time: event.time }
        break
      }
      case 'step/end': {
        // No open slot (an unpaired step/end) — nothing to price, and the
        // state must stay reference-equal.
        const start = state.stepStart
        if (start === undefined) return state
        const s = ensure()
        ensureTiming(s).wallMs += durOf(start.time, event.time)
        // Consume-once: DELETE the optional field — assigning `undefined`
        // would break the plain-JSON state precondition.
        delete s.stepStart
        break
      }
      case 'user/message': {
      // `deriveEventMessage` returns `event.data` for user/message (no
      // `data.message` indirection).
        const msg = deriveEventMessage(event)
        const s = ensure()
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, data, msg)
        const source = msg?.source
        if (isInjection(source)) {
          const rec: ContextEventRecord = {
            seq: event.seq, time: event.time, kind: 'inject', form: source.form || 'context', tokens: node.tokens,
          }
          if (source.kind === 'skill-invocation') {
            rec.sub = 'skill'
            rec.name = typeof source.name === 'string' ? source.name : '?'
          } else {
            const label = injectionSourceName(source)
            if (label !== '') {
              rec.name = label
              // The same identity rides the surface node (this event's own
              // seq), so the browser rows label the injection the way the
              // events card does — the node's retention then matches the label.
              node.name = label
            }
            // A notice carries the producer's bounded one-line account; show it after the source name.
            if (source.form === 'notice' && typeof source.summary === 'string' && source.summary !== '') {
              rec.detail = source.summary
            }
          }
          s.events.push(rec)
        } else {
          // The user's own message (the exact set the surface's `user`
          // category holds): one human input, whole-session tally.
          s.humanInputs = (s.humanInputs ?? 0) + 1
        }
        break
      }
      case 'tool/result': {
      // The model-visible message is data.message; the envelope also carries
      // callId/error/meta/fileOps, and pricing the envelope would miss all content.
        const toolMsg = deriveEventMessage(event)
        // Read the pairing BEFORE applySurface consumes it (consume-once):
        // the armed call's name/arguments pair this result into file ops, and
        // the result's callId is the flush key for buffered Code-Mode ops.
        const msgSource = toolMsg?.source as { callId?: unknown } | undefined
        const srcId = msgSource?.callId
        const firstBlock = toolMsg?.content?.[0] as { toolCallId?: unknown; isError?: unknown } | undefined
        const blockId = firstBlock?.toolCallId
        const pendingEntry = (typeof srcId === 'string' ? state.callNames[srcId] : undefined)
          ?? (typeof blockId === 'string' ? state.callNames[blockId] : undefined)
        const buffered = (typeof srcId === 'string' ? state.pendingCodeOps?.[srcId] : undefined)
          ?? (typeof blockId === 'string' ? state.pendingCodeOps?.[blockId] : undefined)
        const s = ensure()
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, data, toolMsg)
        // An answered question prompt is a human input too (whole-session
        // tally): the result only carries its tool name when it pairs with
        // the armed call, so an unpaired/foreign one counts nothing.
        if (node.tool === ASK_USER_TOOL) s.humanInputs = (s.humanInputs ?? 0) + 1
        const errored = Boolean(data?.error) || firstBlock?.isError === true
        // PORT ADDITION: a synthesizer that knows its harness's file tools
        // states the ops itself; they win over the argument derivation, and
        // they book even for an unpaired result (a Claude tool/call event may
        // have aged out of the fold's window while its result still carries
        // `toolUseResult`).
        if (Array.isArray(data?.fileOps)) {
          pushFileOps(s, fileOpsOfInput(data.fileOps, {
            seq: event.seq,
            time: event.time,
            tool: pendingEntry?.name ?? '',
            err: errored,
          }))
        } else if (pendingEntry !== undefined) {
          // The fallback derivation (shared/fileOps.ts): the armed call's
          // arguments + the result's presentation meta. Unpaired results book
          // nothing (parity with the surface node's missing tool label).
          pushFileOps(s, opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: pendingEntry.name,
            argsRaw: pendingEntry.argsRaw,
            meta: data?.meta,
            err: errored,
          }))
        }
        if (buffered !== undefined && buffered.length > 0) {
          // The run_code root settles: its nested ops land with `parent` = this
          // result's row, plus the program description off its call arguments.
          const program = parseCallArgs(pendingEntry?.argsRaw)?.description
          pushFileOps(s, buffered.map(op => ({
            ...op,
            parent: event.seq,
            ...(typeof program === 'string' && program !== '' ? { program } : {}),
          })))
          const kept: Record<string, FileOpRecord[]> = {}
          for (const k in s.pendingCodeOps) {
            const rows = s.pendingCodeOps[k]
            if (rows !== undefined && k !== srcId && k !== blockId) kept[k] = rows
          }
          if (Object.keys(kept).length > 0) s.pendingCodeOps = kept
          else delete s.pendingCodeOps
        }
        // A skill load via the `skill` tool returns the loaded skill's
        // instructions as a tool result — content the harness injected into the
        // model's context. Keep it findable (the node is tagged with the skill
        // NAME so rows label it) and give it its own composition bucket: the
        // price moves from `tool` to `skill` at the surface-sum level, so the
        // trend/overview charts show the skill's occupancy instead of burying
        // it among ordinary results, and an inject event still records the row.
        // When the tool/call event is gone (trimmed window, replay) the name is
        // unresolvable — fall back to the wrapper alone: it only appears in
        // genuine skill results, and a missed tag is worse than a content guess.
        if (node.tool === 'skill' || node.tool === undefined) {
          const name = skillNameOf(toolMsg)
          if (name !== '') {
            node.skill = name
            if (node.tool === undefined) node.tool = 'skill'
            s.sums.tool -= node.tokens
            node.cat = 'skill'
            s.sums.skill += node.tokens
            s.events.push({ seq: event.seq, time: event.time, kind: 'inject', form: 'instructions', sub: 'skill', name, tokens: node.tokens })
          }
        }
        break
      }
      case 'assistant/message': {
      // Snapshot the request exactly as dispatched: current surface + header,
      // before this response joins the surface.
        const usage = data?.usage as UsageLike | null | undefined
        const s = ensure()
        bumpDetailRev(s)
        const total = s.systemTokens + s.toolsTokens + s.sums.user + s.sums.inject + s.sums.skill + s.sums.assistant + s.sums.tool
        const record: RequestRecord = {
          time: event.time, seq: event.seq,
          system: s.systemTokens,
          tools: s.toolsTokens,
          user: s.sums.user,
          inject: s.sums.inject,
          skill: s.sums.skill,
          assistant: s.sums.assistant,
          tool: s.sums.tool,
          total,
        }
        // `turn`/`step` are optional in the vocabulary; write only real
        // numbers — an absent value must not materialize an `undefined`
        // property.
        if (data && typeof data.turn === 'number') record.turn = data.turn
        if (data && typeof data.step === 'number') record.step = data.step
        if (usage !== null && usage !== undefined && typeof usage === 'object') {
        // The buckets are disjoint — inputTokens is uncached input only, cache
        // read/write are separate, and billed prompt-side = input + cacheRead +
        // cacheWrite. outputTokens already includes reasoning tokens. Every
        // bucket passes the deep `tokenCountOf` read first: the transcript is
        // untrusted input, and a raw nonconforming figure must never enter the
        // state.
          const input = tokenCountOf(usage.inputTokens)
          const cacheRead = tokenCountOf(usage.cacheReadTokens)
          const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
          const output = tokenCountOf(usage.outputTokens)
          // The 1h-TTL share is a SUBSET of the write bucket, never an extra
          // one: clamping here means a mis-reporting producer can only shift
          // tokens between the two write rates, never invent billed tokens.
          const cacheWrite1h = Math.min(tokenCountOf(usage.cacheWrite1hTokens) ?? 0, cacheWrite ?? 0)
          // Any readable bucket is a billing sample (an output-only sample
          // bills prompt 0). A fully unreadable object is treated as absent, so
          // a fabricated 0 never reaches the client's derived-occupancy anchor.
          if (input !== null || cacheRead !== null || cacheWrite !== null || output !== null) {
            record.prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
            // Cache-hit share of the billed prompt: keep the cache-served half
            // of `prompt`; absent = no cache bucket.
            if (cacheRead !== null) record.cacheRead = cacheRead
            // PORT ADDITION — the cache-WRITE half, for the client's
            // token-usage card (it sums the request records).
            if (cacheWrite !== null) record.cacheWrite = cacheWrite
            if (output !== null) record.output = output
            accumulateCost(s, event.time, {
              input: input ?? 0,
              cacheRead: cacheRead ?? 0,
              cacheWrite: cacheWrite ?? 0,
              cacheWrite1h,
              output: output ?? 0,
            })
          }
        }
        // PORT ADDITION — the DERIVED system remainder. When the transcript
        // never recorded a system prompt, "0 system tokens" would be a lie:
        // the provider's own prompt figure minus everything we DID price is
        // the honest estimate of what the harness sent. Clamped ≥ 0, marked so
        // the client can render it as "≈ derived", and kept as the live figure
        // until the next request recomputes it.
        if (s.systemKnown !== true && typeof record.prompt === 'number') {
          const priced = s.toolsTokens + s.sums.user + s.sums.inject + s.sums.skill + s.sums.assistant + s.sums.tool
          const derived = Math.max(0, record.prompt - priced)
          record.system = derived
          record.systemDerived = true
          record.total = derived + priced
          s.systemTokens = derived
          s.systemDerived = true
        }
        s.requests.push(record)
        // Timing: one completed model call; its wait/generation split prices
        // off the slot's first-token stamp. That stamp comes from an
        // `assistant/chunk` delta or, when the log carries none, from the
        // message's own EMBEDDED stream. A call whose stream carried no token
        // stays unattributed and lands in the card's residue. The pending slot
        // stays armed — the step's tool calls and `step/end` still follow.
        const timing = ensureTiming(s)
        timing.calls += 1
        const stepStart = state.stepStart
        if (stepStart !== undefined) {
          const firstToken = stepStart.firstToken ?? firstTokenTimeOfStream(data?.stream)
          if (firstToken !== undefined) {
            timing.ttftMs += durOf(stepStart.time, firstToken)
            timing.genMs += durOf(firstToken, event.time)
            // Generation split: a chunk stream accumulated the block spans in
            // the slot (its last block closes HERE, at the message); a
            // settlement-embedded stream carries the spans instead. Either way
            // the three buckets tile the generation window and only the
            // settlement tail stays unattributed. The split is priced ONLY
            // when the window was: an unstamped call's model time is
            // unattributed wholesale, so its spans must not reappear as
            // generation time the caller never charged.
            const decode = stepStart.decode
            if (decode !== undefined) {
              const closed: Record<DecodeKind, number> = { ...decode }
              if (stepStart.block !== undefined) {
                closed[stepStart.block.kind] += durOf(stepStart.block.since, event.time)
              }
              for (const kind of DECODE_KINDS) addDecode(timing, kind, closed[kind])
            } else {
              const spans = decodeSpansOfStream(data?.stream, event.time)
              for (const kind of DECODE_KINDS) addDecode(timing, kind, spans[kind])
            }
          } else if (hasBlockStartMarker(data?.stream)) {
            // PORT DEVIATION — no first token, but the settlement's stream
            // FRAMES the model window with `block-start` markers.
            //
            // dsh folded live provider streams, so "no token delta" meant the
            // call really was unattributable. Harnesses that persist SETTLED
            // blocks instead of streams (Claude Code writes one record per
            // completed content block) can never report a first-token instant
            // — their records land at block COMPLETION — so their
            // synthesizers emit block-start markers only, rather than
            // fabricating a TTFT from a completion timestamp. Under the
            // vendored rule every such call fell into the residue and the
            // timing card showed nothing but tool runs.
            //
            // The honest reading: the whole step-start → settlement span was
            // generation (the markers prove the model was decoding across
            // it), and `ttftMs` stays 0 — unattributed, not zero-measured.
            // The client already drops zero rows, so the wire contract is
            // unchanged and a 0 TTFT simply does not render.
            timing.genMs += durOf(stepStart.time, event.time)
            const spans = decodeSpansOfStream(data?.stream, event.time)
            for (const kind of DECODE_KINDS) addDecode(timing, kind, spans[kind])
          }
        }
        // `deriveEventMessage` returns `data.message` for assistant/message, or
        // null when the content array is empty (usage-only events project to no
        // message).
        const asstMsg = deriveEventMessage(event)
        applySurface(s, event, event.type, data, asstMsg)
        break
      }
      case 'plan/mode': {
      // Plan mode adds a guidance section to every model request while
      // active — a real context-composition change, so it earns an event.
        if (data && typeof data.active === 'boolean') {
          const s = ensure()
          s.events.push({ seq: event.seq, time: event.time, kind: 'mode', name: data.active ? 'plan.on' : 'plan.off' })
          bumpDetailRev(s)
        }
        break
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const s = ensure()
        bumpDetailRev(s)
        // Arm the shadow-price claim: the replacement that follows this
        // event synchronously shadows exactly these node seqs.
        if (data && Array.isArray(data.shadowedSeqs)) {
          s.pendingShadowedSeqs = data.shadowedSeqs.filter((x): x is number => typeof x === 'number')
          s.pendingShadowEventSeq = event.seq
        }
        s.events.push({
          seq: event.seq, time: event.time, kind: event.type === 'compaction/summary' ? 'compaction' : 'prune',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
          ...(event.type === 'compaction/summary' && data && Array.isArray(data.shadowedSeqs)
            ? { count: data.shadowedSeqs.length }
            : {}),
        })
        break
      }
      default:
        return state
    }
  } catch {
    // Unreachable over well-formed events; the guard exists so a hostile
    // record can never take the fold down. A failed event is dropped WHOLE:
    // any partial mutation lived on private lazy clones, so falling back to
    // the previous state reference keeps the transition all-or-nothing.
    st = undefined
  }

  if (st !== undefined) {
    trimState(st, bounds)
    return st
  }
  return state
}

/**
 * The envelope scalars both wire generations share: current composition, the
 * live-surface counters, and the copied cost/timing totals. Served value
 * fields are COPIES — the served value must never alias fold state. Optional
 * scalars use conditional spread: an unknown value must not materialize an
 * `undefined`-valued property.
 */
function headFieldsOf(state: TimelineState): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.skill + state.sums.assistant + state.sums.tool
  const result: Snapshot = {
    ok: true,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.provider !== undefined ? { provider: state.provider } : {}),
    ...(state.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
    // PORT ADDITIONS — the honesty markers for the two figures this viewer
    // cannot always measure (see TimelineState.systemDerived / toolsKnown).
    ...(state.systemDerived === true ? { systemDerived: true as const } : {}),
    ...(state.toolsKnown === true ? { toolsKnown: true as const } : {}),
    current: {
      system: state.systemTokens,
      tools: state.toolsTokens,
      user: state.sums.user,
      inject: state.sums.inject,
      skill: state.sums.skill,
      assistant: state.sums.assistant,
      tool: state.sums.tool,
      total: surfaceTotal + state.systemTokens + state.toolsTokens,
    },
    images: state.surface.reduce((n, node) => n + (node.imgs ?? 0), 0),
    // Tool calls WITH A RESULT live in the current context: one `tool/result`
    // folds to exactly one surface node, so live tool nodes are the count.
    // A `skill`-tool load reclassifies its node into the `skill` bucket — its
    // tool identity rides `node.tool`, so those nodes keep counting here.
    // Calls still in flight (no result yet) and results compacted or pruned
    // out of the surface are both excluded.
    toolCalls: state.surface.reduce((n, node) => node.cat === 'tool' || (node.cat === 'skill' && node.tool !== undefined) ? n + 1 : n, 0),
    // The whole-session human-input tally (see TimelineState.humanInputs) —
    // a running total, so unlike turns/steps it covers the COMPLETE log.
    humanInputs: state.humanInputs ?? 0,
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
  // The cost totals ride the wire as COPIES (same rule as the collections:
  // the served value must never alias fold state).
  if (state.cost !== undefined) {
    const cost: SessionCostUsage = {}
    for (const provider in state.cost) {
      const modelsIn = state.cost[provider]
      if (modelsIn === undefined) continue
      const models: Record<string, CostModelUsage> = {}
      for (const model in modelsIn) {
        const periods = modelsIn[model]
        if (periods === undefined) continue
        const copy: CostModelUsage = {}
        if (periods.peak !== undefined) copy.peak = { ...periods.peak }
        if (periods.off !== undefined) copy.off = { ...periods.off }
        models[model] = copy
      }
      cost[provider] = models
    }
    result.cost = cost
  }
  // The timing totals ride the wire as COPIES too (per-name rows included).
  if (state.timing !== undefined) {
    const tools: Record<string, ToolTimingTotals> = {}
    for (const k in state.timing.tools) {
      const row = state.timing.tools[k]
      if (row !== undefined) tools[k] = { ...row }
    }
    result.timing = { ...state.timing, tools }
  }
  // The live system-prompt nodes ride the wire as COPIES: the browser resolves
  // the prompt in force at any step from them and fetches its TEXT on demand
  // from `seq`. Absent when the transcript carried none — the derived
  // remainder path (see systemDerived) then labels `current.system` instead.
  if (state.systems !== undefined && state.systems.length > 0) {
    result.systems = state.systems.map(n => ({ ...n }))
  }
  return result
}

/**
 * The heavy collections: copies of the retained request records and context
 * events (each event attached to the requests around it — the chart's ✂
 * anchoring), the bounded served surface window, and the removed-node
 * archive. Shared verbatim by the inline view and the detail payload.
 */
function detailCollectionsOf(state: TimelineState, bounds: FoldBounds): Omit<ContextTimelineDetail, 'rev'> {
  const result: Omit<ContextTimelineDetail, 'rev'> = {
    requests: state.requests.map(r => ({ ...r })),
    events: state.events.map(e => ({ ...e })),
    nodes: [],
    droppedNodes: 0,
    archive: state.archived.map(n => ({ ...n })),
    // The fold-derived file-op log rides the collections (the inline view and
    // the detail payload share this builder) — COPIES, never state aliases.
    fileOps: state.fileOps.map(o => ({ ...o })),
    ...(state.fileOpsFloor !== undefined ? { fileOpsFloor: state.fileOpsFloor } : {}),
  }
  // The served slice: the newest `maxNodes` tail PLUS every live inject/skill
  // node older than the tail. Injections (AGENTS.md, session-start context, …)
  // land on the surface FIRST, so in a long session the plain tail window
  // drops their identity while their tokens keep counting (sums cover the
  // full surface) — the browser's section would show a token sum with zero
  // listable items. Skill content behaves the same way; pin both categories
  // into the served list. The overflow slice precedes the tail by position,
  // so the concatenation stays seq-ordered.
  const overflowCount = Math.max(0, state.surface.length - bounds.maxNodes)
  const overflow = state.surface.slice(0, overflowCount)
  const tail = state.surface.slice(overflowCount)
  const pinned = overflow.filter(n => n.cat === 'inject' || n.cat === 'skill')
  result.nodes = pinned.length > 0 ? [...pinned, ...tail] : tail
  result.droppedNodes = overflowCount - pinned.length
  // Coverage floors for the Context browser's per-step reconstruction:
  // `surfaceFloor` names the newest live node NOT served (the dropped slice
  // is the oldest by position); `archiveFloor` rides the state's retention
  // ledger (see trimState). Both let the client mark a picked step's
  // reconstruction approximate instead of silently under-showing it.
  if (result.droppedNodes > 0) {
    let floor = 0
    for (const n of overflow) if (n.cat !== 'inject' && n.cat !== 'skill') floor = Math.max(floor, n.seq)
    result.surfaceFloor = floor
  }
  if (state.archiveFloor !== undefined) result.archiveFloor = state.archiveFloor

  // Attach each event to the requests around it (same attachment the chart uses for ✂): `turn`/`step` name the first request logged after
  // the event, `fromTurn`/`fromStep` the request before it; both lists stay seq-sorted, so one pointer walk suffices. Events with no
  // following (or preceding) retained request keep only one side.
  const requests = result.requests
  const events = result.events
  let ri = 0
  for (const ev of events) {
    while (ri < requests.length && (requests[ri]?.seq ?? Infinity) <= ev.seq) ri++
    // .at() keeps the past-the-end case visible to the type system.
    const next = requests.at(ri)
    const prev = ri > 0 ? requests.at(ri - 1) : undefined
    if (next !== undefined && typeof next.turn === 'number' && typeof next.step === 'number') {
      ev.turn = next.turn
      ev.step = next.step
    }
    if (prev !== undefined && typeof prev.turn === 'number' && typeof prev.step === 'number') {
      ev.fromTurn = prev.turn
      ev.fromStep = prev.step
    }
  }
  return result
}

/**
 * The SLIM head: the envelope scalars plus the precomputed count figures, the
 * newest request's billing summary (the headline's derived anchor), and the
 * detail revision marker. Small enough to hand around whole (~1KB).
 */
export function buildTimelineHead(state: TimelineState): Snapshot {
  const result = headFieldsOf(state)
  // The stats board's count figures, over the RETAINED records (the same set
  // the detail serves): distinct turn values and per-kind event tallies.
  const turns = new Set<number>()
  for (const r of state.requests) turns.add(r.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  for (const e of state.events) {
    if (e.kind === 'inject') injects++
    else if (e.kind === 'compaction') compactions++
    else if (e.kind === 'prune') prunes++
  }
  result.counts = { turns: turns.size, steps: state.requests.length, injects, compactions, prunes }
  const last = state.requests.at(-1)
  if (last !== undefined) {
    result.last = { seq: last.seq, total: last.total, ...(typeof last.prompt === 'number' ? { prompt: last.prompt } : {}) }
  }
  result.detailRev = state.detailRev ?? 0
  return result
}

/**
 * The on-demand DETAIL payload: the heavy collections plus the revision
 * marker the head carries.
 */
export function buildTimelineDetail(state: TimelineState, bounds: FoldBounds): ContextTimelineDetail {
  return { rev: state.detailRev ?? 0, ...detailCollectionsOf(state, bounds) }
}

/**
 * The INLINE view — the head scalars with the detail collections in place.
 * This is what `ContextSession.timelineOf` serves: the browser reads one
 * whole value, no detail channel. Bound the surface nodes to the newest tail
 * and attach each event to the request around it; stamp COPIES — the fold
 * state objects are never mutated.
 */
export function buildTimelineView(state: TimelineState, bounds: FoldBounds): Snapshot {
  return { ...headFieldsOf(state), ...detailCollectionsOf(state, bounds) }
}
