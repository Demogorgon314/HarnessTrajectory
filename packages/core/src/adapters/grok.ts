/**
 * Grok Build (`grok` CLI, xAI) adapter: folds the update stream
 * `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl` into the
 * harness-agnostic trajectory contract.
 *
 * Verified against grok 1.0.30, source rev `c4ea71c`. `updates.jsonl` is the
 * durable source of truth (GROK-FORMAT §C.0); `chat_history.jsonl` is a derived
 * cache and `events.jsonl` is telemetry, so neither is read here.
 *
 * Every line is `{timestamp, method, params}` (GROK-FORMAT §C.1) where `params`
 * is `{sessionId, update, _meta}` and `update` is tagged on `sessionUpdate`.
 * The unit traps this file has to respect, all of them load-bearing below:
 *
 * - The envelope `timestamp` is epoch **seconds** (`as_secs()`), while
 *   `params._meta.agentTimestampMs` is epoch **milliseconds**. The record time
 *   is `agentTimestampMs` when present, else `timestamp * 1000`; `parseTime` is
 *   deliberately not used on either, so no unit can be guessed wrong.
 * - The two rails (`session/update` and `_x.ai/session/update`) are buffered
 *   **independently**, so an `_x.ai` line can sit in front of a lower-numbered
 *   ACP line (220 inversions in one 676-line file). File order is replay order
 *   and is what this parser folds; timestamps are never used for ordering.
 * - `agent_message_chunk` / `agent_thought_chunk` are **debounced blocks**, not
 *   per-token deltas (65–634 characters each). They are concatenated in file
 *   order with no separator, into one text and one reasoning block per step.
 * - There is no `is_error` field: `tool_call_update.status === 'failed'` is the
 *   error flag (GROK-FORMAT §C.2).
 * - `_meta['x.ai/tool']` is the canonical tool identity and usually arrives on
 *   the first `tool_call_update`, not on the `tool_call` that announced the
 *   call, so identity is merged into an already-running call.
 * - A subagent is bound to its spawning tool call by `promptId` + order, never
 *   by `tool_call_id`: the spawn path records no call id at all
 *   (GROK-FORMAT §D.4). See `bindTaskCall` for the documented heuristic.
 * - `updates.jsonl` is append-only, so a rewind leaves the abandoned branch in
 *   the file. `rewind_marker` is surfaced as a notice and turns keep counting
 *   upwards; already-folded nodes are never deleted (documented limitation).
 * - A legacy line has no `method` key at all: it is a bare ACP
 *   `{sessionId, update}` notification and reads as `session/update`
 *   (GROK-FORMAT §C.1 "Legacy envelope").
 * - `turn_completed` carries `elapsed_ms`, `stop_reason` and (headless only)
 *   `agent_result` besides the usage. Only the usage and `error_kind` are
 *   folded: the contract has no turn-level slot to hang a duration, a stop
 *   reason or a final result on, and per-step timing already comes from the
 *   record stamps.
 *
 * The system prompt (`system_prompt.txt`), the tool schemas
 * (`tool_definitions.json`) and the title/cwd/model (`summary.json`) live
 * outside the jsonl, so the server prepends one synthetic
 * {@link GROK_SIDECAR_METHOD} line carrying them. A sidecar is optional: a file
 * fed without one still folds, it just has no system prompt and no schemas.
 *
 * Subagents live in their own **top-level** session directories (GROK-FORMAT
 * §D.2), so a child transcript arrives as a separate file. Its tool calls fold
 * into the bound parent call as sub-calls; its prompts and assistant text stay
 * in the child's own view, which the server serves standalone.
 */

import type {
  AssistantBlock, AssistantMessageNode, AssistantRequestConfig, AssistantRequestView,
  CompactionRequestView, CompactionSummaryNode, ContentBlock, ContextRole, ImageAttachmentRef,
  KnownContextForm, TokenUsage, ToolSchema, TrajectorySnapshot,
} from '../contract.ts'
import { asArray, asNumber, asString, isRecord, parseJsonLine } from '../jsonl.ts'
import type {
  ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun, SubagentStatus,
} from '../session.ts'
import {
  DataUrlImageStore, TrajectoryAssembler, normalizeImageMediaType, titleFrom,
} from './shared.ts'

/** Method of the synthetic line the server prepends to a grok replay (GROK-DESIGN §3). */
export const GROK_SIDECAR_METHOD = 'harness-trajectory/sidecar'

/** ACP notification method; also the reading of a legacy line that has no `method` at all. */
const ACP_METHOD = 'session/update'

/**
 * Facts grok keeps beside `updates.jsonl` rather than in it, handed to the
 * parser as one synthetic first line (`params` of a {@link GROK_SIDECAR_METHOD}
 * envelope). Every field is optional: a transcript fed without a sidecar folds
 * exactly the same, minus the system prompt and the tool schemas.
 */
export interface GrokSidecar {
  /** `params.sessionId` of the sidecar envelope. */
  readonly sessionId: string | null
  /** The whole `summary.json` object (title, `info.cwd`, `current_model_id`, …). */
  readonly summary: Record<string, unknown> | null
  /** `system_prompt.txt` verbatim. */
  readonly systemPrompt: string | null
  /** `tool_definitions.json`: `{type:'function', function:{name, description?, parameters}}[]`. */
  readonly toolDefinitions: readonly unknown[] | null
}

/**
 * One parsed `updates.jsonl` line. Shared with the server's meta scanner and
 * the context synthesizer so the three never disagree about units or tags.
 */
export interface GrokRecord {
  /** `"session/update"`, `"_x.ai/session/update"`, the sidecar method, or a future one. */
  readonly method: string
  /** Epoch **milliseconds**, or `null` when the line carried no usable stamp. */
  readonly time: number | null
  readonly sessionId: string | null
  /** `params.update`, the payload tagged on `sessionUpdate`; `null` on a sidecar line. */
  readonly update: Record<string, unknown> | null
  /** `params._meta`, the correlation envelope (`eventId`, `promptId`, `streamStartMs`, …). */
  readonly meta: Record<string, unknown> | null
  /** `update.sessionUpdate`, the payload tag. */
  readonly sessionUpdate: string | null
  /** `params._meta.promptId`: the turn grouping key (GROK-FORMAT §G.1). */
  readonly promptId: string | null
  /** `params._meta.streamStartMs`: when this model call's stream opened. */
  readonly streamStartMs: number | null
  /** Sidecar payload when `method === GROK_SIDECAR_METHOD`. */
  readonly sidecar: GrokSidecar | null
}

/**
 * How a `user_message_chunk` reached the context. Decided by the `_meta` flags
 * of GROK-FORMAT §F.4, never by the text.
 */
export type GrokMessageClass =
  | { readonly kind: 'human'; readonly slash: boolean; readonly interjection: boolean }
  | { readonly kind: 'injection'; readonly name: 'hostTurn' | 'preamble' }

/** Context window per catalog model key (GROK-FORMAT §H.3; three sources all agree on 500k). */
export const GROK_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  'grok-4.6': 500_000,
  'grok-4.5': 500_000,
})

/** Assumed window for a model the table does not know; every grok model so far is 500k. */
export const GROK_DEFAULT_CONTEXT_WINDOW = 500_000

/** Provider id for pricing and provenance; grok is xAI's own CLI. */
const GROK_PROVIDER = 'xai'

/** Wire names of the subagent-spawn tool (GROK-FORMAT §D.1, `is_task_tool_id`). */
const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(['task', 'Task', 'spawn_subagent'])

/** `tool_call_update.status` values that carry a result rather than a progress merge. */
const TERMINAL_TOOL_STATUS: ReadonlySet<string> = new Set(['completed', 'failed'])

/**
 * Classify one `params.update` that is a `user_message_chunk`, or `null` when
 * it is any other record.
 *
 * The four structural flags (GROK-FORMAT §F.4): `content._meta.hostTurn` marks
 * a host-injected turn, `content._meta.interjection` a mid-turn Ctrl+Enter
 * steer (human, but not a new turn), `content._meta.displayAsSkill` a typed
 * slash command (still human), and `update._meta.promptIndex` the 0-based turn
 * a chunk starts. A chunk with none of them is the environment preamble that
 * opens every session, which is injected context rather than a prompt.
 */
export function grokMessageClass(update: unknown): GrokMessageClass | null {
  if (!isRecord(update) || asString(update['sessionUpdate']) !== 'user_message_chunk') return null
  const content = isRecord(update['content']) ? update['content'] : undefined
  const contentMeta = content !== undefined && isRecord(content['_meta']) ? content['_meta'] : undefined
  if (contentMeta?.['hostTurn'] === true) return { kind: 'injection', name: 'hostTurn' }
  const slash = contentMeta?.['displayAsSkill'] === true
  if (contentMeta?.['interjection'] === true) return { kind: 'human', slash, interjection: true }
  const meta = isRecord(update['_meta']) ? update['_meta'] : undefined
  if (meta !== undefined && asNumber(meta['promptIndex']) !== undefined) {
    return { kind: 'human', slash, interjection: false }
  }
  return { kind: 'injection', name: 'preamble' }
}

/**
 * Parse one `updates.jsonl` line, returning `null` for a blank, malformed or
 * truncated line. Never throws.
 *
 * Handles both envelopes (GROK-FORMAT §C.1): the current
 * `{timestamp, method, params}` and the legacy bare `{sessionId, update}`
 * notification an older grok wrote, which reads as `session/update`.
 */
export function parseGrokLine(line: string): GrokRecord | null {
  const raw = parseJsonLine(line)
  if (!isRecord(raw)) return null
  const method = asString(raw['method'])
  // A line with no `method` is a legacy bare ACP notification: `params` is the line itself.
  const params = method === undefined
    ? raw
    : (isRecord(raw['params']) ? raw['params'] : undefined)
  if (params === undefined) return null
  const meta = isRecord(params['_meta']) ? params['_meta'] : null
  // `agentTimestampMs` is milliseconds; the envelope `timestamp` is seconds.
  const stampedMs = meta === null ? undefined : asNumber(meta['agentTimestampMs'])
  const envelopeSeconds = asNumber(raw['timestamp'])
  const time = stampedMs ?? (envelopeSeconds === undefined ? null : Math.round(envelopeSeconds * 1000))
  const sessionId = asString(params['sessionId']) ?? null
  if (method === GROK_SIDECAR_METHOD) {
    return {
      method,
      time,
      sessionId,
      update: null,
      meta,
      sessionUpdate: null,
      promptId: null,
      streamStartMs: null,
      sidecar: {
        sessionId,
        summary: isRecord(params['summary']) ? params['summary'] : null,
        systemPrompt: asString(params['systemPrompt']) ?? null,
        toolDefinitions: asArray(params['toolDefinitions']) ?? null,
      },
    }
  }
  const update = isRecord(params['update']) ? params['update'] : null
  return {
    method: method ?? ACP_METHOD,
    time,
    sessionId,
    update,
    meta,
    sessionUpdate: update === null ? null : asString(update['sessionUpdate']) ?? null,
    promptId: meta === null ? null : asString(meta['promptId']) ?? null,
    streamStartMs: meta === null ? null : asNumber(meta['streamStartMs']) ?? null,
    sidecar: null,
  }
}

/**
 * Context window for a model id. `usage.json` and `turn_completed.usage` report
 * the billing id (`grok-4.6-build`) while the catalog is keyed on the display
 * id (`grok-4.6`), so a trailing `-build` is stripped before the lookup
 * (GROK-FORMAT §H.2).
 */
export function grokContextWindow(model: string | undefined): number {
  if (model === undefined || model === '') return GROK_DEFAULT_CONTEXT_WINDOW
  const direct = GROK_CONTEXT_WINDOWS[model]
  if (direct !== undefined) return direct
  const base = model.endsWith('-build') ? model.slice(0, -'-build'.length) : model
  return GROK_CONTEXT_WINDOWS[base] ?? GROK_DEFAULT_CONTEXT_WINDOW
}

/**
 * Whether a wire tool name spawns a subagent. All three spellings are accepted
 * regardless of the enabled feature set; the shipped 1.0.30 build advertises
 * the tool as `spawn_subagent` (GROK-FORMAT §D.1, §E.1).
 */
export function isGrokTaskTool(name: string): boolean {
  return TASK_TOOL_NAMES.has(name)
}

/** Contiguous chunks share one prompt; indices may be reused after rewind. */
export class GrokPromptChunks {
  private index: number | null = null

  continues(tag: string, update: Record<string, unknown>): boolean {
    const meta = isRecord(update['_meta']) ? update['_meta'] : undefined
    const index = tag === 'user_message_chunk' && grokMessageClass(update)?.kind === 'human'
      ? asNumber(meta?.['promptIndex']) ?? null : null
    const continuation = index !== null && index === this.index
    this.index = index
    return continuation
  }

  save(): number | null { return this.index }
  load(value: unknown): void { this.index = asNumber(value) ?? null }
}

/** One model call, grouped by its stream when the transcript records one. */
interface OpenStep {
  stream: number | null
  published?: boolean
  turn: number
  step: number
  seq: number
  startedAt: number
  firstTokenTime: number | null
  lastTime: number
  blocks: AssistantBlock[]
}

/** A tool call from its announcement to its result, with the identity merged in as it lands. */
interface OpenCall {
  callId: string
  /** Turn key of the record that announced the call, used to bind subagents (§D.4). */
  promptId: string | null
  time: number
  /** Whether `_meta['x.ai/tool'].name` has been seen; the display title is only a fallback. */
  canonical: boolean
  /** Whether normalized arguments have been seen; `rawInput` is only a fallback. */
  canonicalArgs: boolean
  /** The emitted assistant block, kept so a later identity update rewrites it in place. */
  block: { kind: 'tool-call'; callId: string; name: string; argsRaw: string }
  /** Set once a `subagent_spawned` claimed this task-tool call. */
  boundAgentId: string | null
}

/** One subagent run, joined from the parent's `subagent_*` records and the child file. */
interface AgentRun {
  agentId: string
  fileId: string | null
  callId: string | null
  description: string | null
  agentType: string | null
  model: string | null
  status: SubagentStatus
  startedAt: number | null
  endedAt: number | null
  lastTime: number | null
  toolCalls: number
}

/** A compaction that has started but not yet reported its result. */
interface OpenCompaction {
  seq: number
  startedAt: number
  tokensBefore: number | null
}

/**
 * `turn_completed.usage` (`PromptUsage`, flattened) onto the contract's
 * disjoint buckets. `inputTokens` on the wire is the **total** input including
 * the cached part, so the cached buckets are subtracted out (GROK-FORMAT §B.2);
 * `reasoningTokens` is a subset of `outputTokens` and is never added to it.
 */
function mapUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value['inputTokens'])
  const output = asNumber(value['outputTokens'])
  const cacheRead = asNumber(value['cachedReadTokens'])
  const cacheWrite = asNumber(value['cacheCreationTokens'])
  const reasoning = asNumber(value['reasoningTokens'])
  const total = asNumber(value['totalTokens'])
  if (input === undefined && output === undefined && cacheRead === undefined
    && cacheWrite === undefined && total === undefined) {
    return undefined
  }
  const uncached = Math.max(0, (input ?? 0) - (cacheRead ?? 0) - (cacheWrite ?? 0))
  return {
    inputTokens: uncached,
    outputTokens: output ?? 0,
    totalTokens: total ?? (input ?? 0) + (output ?? 0),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function stringifyArgs(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}

/** The `_meta['x.ai/tool']` descriptor of a tool record, when it carries one. */
function toolIdentity(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = update['_meta']
  if (!isRecord(meta)) return undefined
  const identity = meta['x.ai/tool']
  return isRecord(identity) ? identity : undefined
}

/**
 * Canonical model-facing tool name: the `x.ai/tool` envelope, else the display
 * title, else the ACP kind, else `'tool'` (GROK-FORMAT §C.2, quoting the
 * pager's own resolution order).
 */
function toolNameOf(update: Record<string, unknown>): { name: string; canonical: boolean } {
  const canonical = asString(toolIdentity(update)?.['name'])
  if (canonical !== undefined && canonical !== '') return { name: canonical, canonical: true }
  const title = asString(update['title'])
  if (title !== undefined && title !== '') return { name: title, canonical: false }
  return { name: asString(update['kind']) ?? 'tool', canonical: false }
}

/**
 * Tool arguments: the normalized `x.ai/tool.input` when present (only ~39% of
 * records carry it), else the internal `rawInput` shape.
 */
function toolArgsOf(update: Record<string, unknown>): { argsRaw: string; canonical: boolean } | undefined {
  const input = toolIdentity(update)?.['input']
  if (input !== undefined) return { argsRaw: stringifyArgs(input), canonical: true }
  const raw = update['rawInput']
  if (raw !== undefined) return { argsRaw: stringifyArgs(raw), canonical: false }
  return undefined
}

/** Render one `plan` snapshot as text; the durable copy is `plan.json`. */
function planText(entries: readonly unknown[]): string {
  return entries
    .flatMap(entry => {
      if (!isRecord(entry)) return []
      const content = asString(entry['content'])
      if (content === undefined) return []
      const status = asString(entry['status']) ?? 'pending'
      return [`[${status}] ${content}`]
    })
    .join('\n')
}

function subagentStatus(value: string | undefined): SubagentStatus {
  switch (value) {
    case 'completed':
      return 'completed'
    case 'cancelled':
    case 'canceled':
    case 'stopped':
      return 'stopped'
    default:
      return 'failed'
  }
}

/** One-line summary for the background-task and scheduler records that only earn a notice. */
function noticeText(tag: string, update: Record<string, unknown>): string | null {
  switch (tag) {
    case 'task_backgrounded': {
      const label = asString(update['description']) ?? asString(update['command']) ?? ''
      return `Task backgrounded${label === '' ? '' : `: ${label}`}`
    }
    case 'background_tasks':
      return `Background tasks: ${(asArray(update['tasks']) ?? []).length}`
    case 'task_completed': {
      const snapshot = isRecord(update['task_snapshot']) ? update['task_snapshot'] : undefined
      const label = asString(snapshot?.['description']) ?? asString(snapshot?.['command']) ?? ''
      return `Task completed${label === '' ? '' : `: ${label}`}`
    }
    case 'scheduled_task_created':
      return `Scheduled task created: ${asString(update['human_schedule']) ?? asString(update['task_id']) ?? ''}`
    case 'scheduled_task_fired':
      return `Scheduled task fired: ${asString(update['task_id']) ?? ''}`
    case 'scheduled_task_deleted':
      return `Scheduled task deleted: ${asString(update['reason']) ?? asString(update['task_id']) ?? ''}`
    case 'monitor_event':
      return `Monitor: ${asString(update['description']) ?? asString(update['event_text']) ?? ''}`
    default:
      return null
  }
}

class GrokParser implements SessionParser {
  readonly kind = 'grok' as const
  readonly images = new DataUrlImageStore()

  private readonly assembler = new TrajectoryAssembler()
  private turn = 0
  private step = 0
  private lastTime = 0
  private open: OpenStep | null = null
  /** `streamStartMs` of the last stamped record; refines the next step's start time. */
  private streamStartMs: number | null = null
  private readonly promptChunks = new GrokPromptChunks()
  private promptContinuation = false
  private readonly turnSeqs = new Map<number, number[]>()
  /** `promptId` → display turn, so `turn_completed.prompt_id` closes the right turn. */
  private readonly promptTurns = new Map<string, number>()
  private currentPromptId: string | null = null
  private readonly calls = new Map<string, OpenCall>()
  /** Task-tool calls in announcement order; a `subagent_spawned` claims the newest unbound one. */
  private readonly taskCalls: OpenCall[] = []
  private readonly runs = new Map<string, AgentRun>()
  /** Child tool calls registered under a parent task call, so results nest instead of surfacing. */
  private readonly childCalls = new Set<string>()
  /** Tool schemas from the sidecar, keyed by wire name and attached per call id. */
  private readonly toolCatalog = new Map<string, ToolSchema>()
  private openCompaction: OpenCompaction | null = null
  private systemPrompt: string | null = null
  private model: string | null = null
  private reasoningEffort: string | null = null
  private contextWindow: number | null = null
  private cwd: string | null = null
  private startedAt: number | null = null
  /** `summary.session_summary` or `session_summary_generated`; outranks the first prompt. */
  private summaryTitle: string | null = null
  private firstPromptTitle: string | null = null
  private promptCount = 0
  private lastPlanText: string | null = null

  push(line: string, file: SessionFileRef, lineIndex?: number): void {
    this.assembler.beginLine(file.id, lineIndex)
    const record = parseGrokLine(line)
    if (record === null) return
    const time = record.time ?? this.lastTime
    if (time > this.lastTime) this.lastTime = time
    if (file.role === 'child') {
      this.handleChild(file, record, time)
      return
    }
    if (this.startedAt === null && time > 0) this.startedAt = time
    if (record.sidecar !== null) {
      this.handleSidecar(record.sidecar, time)
      return
    }
    const update = record.update
    const tag = record.sessionUpdate
    if (update === null || tag === null) return
    this.promptContinuation = this.promptChunks.continues(tag, update)
    if (record.streamStartMs !== null) this.streamStartMs = record.streamStartMs
    this.notePromptId(record.promptId)
    this.handleUpdate(tag, update, record, time)
  }

  snapshot(): TrajectorySnapshot {
    return this.assembler.snapshot()
  }

  meta(): ParsedSessionMeta {
    return {
      title: this.summaryTitle ?? this.firstPromptTitle,
      cwd: this.cwd,
      model: this.model,
      startedAt: this.startedAt,
      promptCount: this.promptCount,
    }
  }

  subagents(): readonly SubagentRun[] {
    return [...this.runs.values()].map(run => ({
      agentId: run.agentId,
      // The child session id is the child file's id; it defaults to the subagent id.
      fileId: run.fileId ?? run.agentId,
      callId: run.callId,
      description: run.description,
      agentType: run.agentType,
      model: run.model,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      lastTime: run.lastTime,
      toolCalls: run.toolCalls,
    }))
  }

  imageUrl(attachment: ImageAttachmentRef): string | undefined {
    return this.images.get(attachment.attachmentId)
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  private handleUpdate(
    tag: string,
    update: Record<string, unknown>,
    record: GrokRecord,
    time: number,
  ): void {
    switch (tag) {
      case 'user_message_chunk':
        this.handleUserChunk(update, record, time)
        return
      case 'agent_thought_chunk':
        this.appendChunk(update, 'reasoning', time)
        return
      case 'agent_message_chunk':
        this.appendChunk(update, 'text', time)
        return
      case 'tool_call':
        this.handleToolCall(update, record, time)
        return
      case 'tool_call_update':
        this.handleToolCallUpdate(update, record, time)
        return
      case 'plan':
        this.handlePlan(update, time)
        return
      case 'turn_completed':
        this.handleTurnCompleted(update, time)
        return
      case 'auto_compact_started':
        this.handleCompactStarted(update, time)
        return
      case 'auto_compact_completed':
        this.handleCompactCompleted(update, time)
        return
      case 'auto_compact_failed':
        this.handleCompactFailed(update, time)
        return
      case 'compaction_checkpoint':
        this.handleCompactionCheckpoint(time)
        return
      case 'auto_compact_cancelled':
        this.pushNotice(`Compaction cancelled: ${asString(update['reason']) ?? 'unknown'}`, time, 'compaction')
        return
      case 'retry_state':
        this.handleRetryState(update, time)
        return
      case 'rewind_marker':
        // Append-only file: the abandoned branch stays visible, we only mark the seam.
        this.pushNotice(`Rewound to prompt ${asNumber(update['target_prompt_index']) ?? 0}`, time, 'rewind')
        return
      case 'model_changed': {
        const model = asString(update['model_id'])
        if (model !== undefined && model !== '') this.model = model
        const effort = asString(update['reasoning_effort'])
        if (effort !== undefined && effort !== '') this.reasoningEffort = effort
        return
      }
      case 'model_auto_switched': {
        const next = asString(update['new_model_id'])
        if (next !== undefined && next !== '') this.model = next
        const previous = asString(update['previous_model_id']) ?? 'previous model'
        this.pushNotice(
          `Model switched from ${previous} to ${next ?? 'unknown'}: ${asString(update['reason']) ?? ''}`.trimEnd(),
          time,
          'model',
        )
        return
      }
      case 'session_summary_generated': {
        const title = asString(update['session_summary'])?.trim()
        if (title !== undefined && title !== '') this.summaryTitle = titleFrom(title)
        return
      }
      case 'subagent_spawned':
        this.handleSubagentSpawned(update, record, time)
        return
      case 'subagent_progress':
        this.handleSubagentProgress(update, time)
        return
      case 'subagent_finished':
        this.handleSubagentFinished(update, time)
        return
      default: {
        const notice = noticeText(tag, update)
        if (notice !== null) this.pushNotice(notice, time, tag)
        // `hook_execution` (95% of the xAI rail), hook/plugin/memory lifecycle,
        // `session_recap`, `response_started`/`response_completed`,
        // `reasoning_completed`, `diff_review`, workflow/goal snapshots and every
        // unknown tag carry nothing the trajectory shows (GROK-DESIGN §4).
        return
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session facts
  // ---------------------------------------------------------------------------

  private handleSidecar(sidecar: GrokSidecar, time: number): void {
    const summary = sidecar.summary
    if (summary !== null) {
      const title = asString(summary['session_summary'])?.trim()
      // A later sidecar replaces the title: `summary.json` is rewritten per turn.
      if (title !== undefined && title !== '') this.summaryTitle = titleFrom(title)
      const info = isRecord(summary['info']) ? summary['info'] : undefined
      const cwd = asString(info?.['cwd'])
      if (cwd !== undefined && cwd !== '') this.cwd = cwd
      const model = asString(summary['current_model_id'])
      if (model !== undefined && model !== '') this.model = model
      const created = Date.parse(asString(summary['created_at']) ?? '')
      if (!Number.isNaN(created)) this.startedAt = created
    }
    if (sidecar.toolDefinitions !== null) this.readToolDefinitions(sidecar.toolDefinitions)
    const text = sidecar.systemPrompt
    if (text === null || text === '' || text === this.systemPrompt) return
    const update = this.systemPrompt !== null
    this.systemPrompt = text
    this.assembler.systemPrompts.push({
      seq: this.assembler.seq.next(),
      time,
      turn: this.turn,
      step: this.step,
      text,
      update,
    })
    this.assembler.touch()
  }

  /**
   * `tool_definitions.json` is Chat-Completions shaped: `{type, function:{name, …}}`.
   *
   * The server re-sends the sidecar whenever `summary.json` changes, which grok
   * rewrites on essentially every appended line, so an identical catalog is the
   * common case: only a real change invalidates the memoized snapshot.
   */
  private readToolDefinitions(definitions: readonly unknown[]): void {
    let changed = false
    for (const item of definitions) {
      if (!isRecord(item)) continue
      const fn = isRecord(item['function']) ? item['function'] : item
      const name = asString(fn['name'])
      if (name === undefined || name === '') continue
      const parameters = fn['parameters']
      const schema: ToolSchema = {
        name,
        description: asString(fn['description']) ?? '',
        parameters: isRecord(parameters) ? parameters : {},
      }
      if (sameSchema(this.toolCatalog.get(name), schema)) continue
      this.toolCatalog.set(name, schema)
      changed = true
    }
    if (changed) this.assembler.touch()
  }

  private requestConfig(): AssistantRequestConfig {
    return {
      provider: GROK_PROVIDER,
      model: this.model ?? '',
      ...(this.reasoningEffort === null ? {} : { reasoningEffort: this.reasoningEffort }),
      // Like Kimi, the only token budget grok records in-band is the context
      // window (`auto_compact_started.context_window`), not a generation cap.
      ...(this.contextWindow === null ? {} : { maxTokens: this.contextWindow }),
    }
  }

  /** Bind the first `promptId` seen after a prompt to the open turn (GROK-FORMAT §G.1). */
  private notePromptId(promptId: string | null): void {
    if (promptId === null) return
    this.currentPromptId = promptId
    if (this.promptTurns.has(promptId) || this.turn === 0) return
    this.promptTurns.set(promptId, this.turn)
  }

  // ---------------------------------------------------------------------------
  // User chunks
  // ---------------------------------------------------------------------------

  private handleUserChunk(update: Record<string, unknown>, record: GrokRecord, time: number): void {
    const classified = grokMessageClass(update)
    if (classified === null) return
    const content = isRecord(update['content']) ? update['content'] : {}
    const contentMeta = isRecord(content['_meta']) ? content['_meta'] : undefined
    const meta = isRecord(update['_meta']) ? update['_meta'] : undefined
    const model = asString(meta?.['modelId'])
    if (model !== undefined && model !== '') this.model = model
    // The typed text is `displayText` when the model-facing frame differs (slash
    // commands, interjections); `content.text` is the frame (GROK-FORMAT §F.4).
    const text = asString(contentMeta?.['displayText']) ?? asString(content['text'])
    const blocks = this.chunkBlocks(content, text)
    if (classified.kind === 'injection') {
      this.pushContext(blocks, time, classified.name, classified.name === 'hostTurn' ? 'relay' : 'notice')
      return
    }
    if (!this.promptContinuation) this.closeStep('complete')
    if (!classified.interjection && !this.promptContinuation) {
      // Turns are numbered by arrival, not by `promptIndex`: a rewind replays
      // lower indices into the same append-only file (§C.3 `rewind_marker`).
      this.turn += 1
      this.step = 0
      this.currentPromptId = record.promptId
      if (record.promptId !== null) this.promptTurns.set(record.promptId, this.turn)
    }
    if (!this.promptContinuation) this.promptCount += 1
    if (this.firstPromptTitle === null && text !== undefined && text.trim() !== '') {
      this.firstPromptTitle = titleFrom(text)
    }
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({
      kind: 'user',
      seq,
      time,
      content: blocks,
      source: {
        kind: 'user',
        ...(classified.slash ? { slash: true } : {}),
        ...(classified.interjection ? { interjection: true } : {}),
      },
    })
    this.locate(seq, this.turn)
  }

  /** One ACP `ContentBlock` object (not an array) into contract blocks. */
  private chunkBlocks(content: Record<string, unknown>, text?: string | undefined): ContentBlock[] {
    if (asString(content['type']) === 'image') {
      const data = asString(content['data'])
      if (data !== undefined) {
        const attachment = this.images.add(data, normalizeImageMediaType(content['mimeType']))
        return [{ type: 'image', attachment }]
      }
    }
    const resolved = text ?? asString(content['text'])
    return resolved === undefined ? [] : [{ type: 'text', text: resolved }]
  }

  private pushContext(
    content: readonly ContentBlock[],
    time: number,
    label: string,
    form: KnownContextForm,
    role: ContextRole = 'inject',
  ): void {
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({
      kind: 'context',
      seq,
      time,
      content,
      source: { kind: 'plugin', plugin: label },
      provenance: { role, label },
      form,
    })
    if (this.turn > 0) this.locate(seq, this.turn)
  }

  private pushNotice(text: string, time: number, label: string): void {
    this.pushContext([{ type: 'text', text }], time, label, 'notice')
  }

  private handlePlan(update: Record<string, unknown>, time: number): void {
    const text = planText(asArray(update['entries']) ?? [])
    // `plan` is a last-wins snapshot of the whole todo list, so an unchanged
    // list is not news.
    if (text === '' || text === this.lastPlanText) return
    this.lastPlanText = text
    this.pushContext([{ type: 'text', text }], time, 'plan', 'snapshot')
  }

  // ---------------------------------------------------------------------------
  // Assistant steps
  // ---------------------------------------------------------------------------

  private appendChunk(update: Record<string, unknown>, kind: 'text' | 'reasoning', time: number): void {
    const content = isRecord(update['content']) ? update['content'] : {}
    const text = asString(content['text'])
    if (text === undefined || text === '') return
    const open = this.ensureStep(time)
    if (open.firstTokenTime === null) open.firstTokenTime = time
    // Chunks are debounced blocks, so consecutive ones of a kind are one block.
    const last = open.blocks[open.blocks.length - 1]
    if (last !== undefined && last.kind === kind) last.text += text
    else open.blocks.push({ kind, text })
    if (time > open.lastTime) open.lastTime = time
    this.assembler.partial = { turn: open.turn, step: open.step, blocks: [...open.blocks] }
    this.assembler.touch()
  }

  private ensureStep(time: number): OpenStep {
    const existing = this.open
    if (existing !== null) {
      if (existing.stream === null || this.streamStartMs === null || existing.stream === this.streamStartMs) return existing
      this.closeStep('complete')
    }
    if (this.turn === 0) this.turn = 1
    this.step += 1
    // `streamStartMs` marks when this model call's stream opened, which precedes
    // the first debounced chunk.
    const stream = this.streamStartMs
    const open: OpenStep = {
      stream,
      turn: this.turn,
      step: this.step,
      seq: this.assembler.seq.next(),
      startedAt: stream !== null && stream > 0 && stream <= time ? stream : time,
      firstTokenTime: null,
      lastTime: time,
      blocks: [],
    }
    this.open = open
    this.assembler.partial = { turn: open.turn, step: open.step, blocks: [] }
    this.assembler.touch()
    return open
  }

  private closeStep(
    status: 'complete' | 'error',
    error?: string,
    code?: string,
    usage?: TokenUsage,
  ): void {
    const open = this.open
    if (open === null) return
    this.open = null
    this.publishStep(open, status, error, code, usage)
  }

  private publishStep(open: OpenStep, status: 'complete' | 'error', error?: string, code?: string, usage?: TokenUsage): void {
    const provenance = this.model === null ? undefined : { provider: GROK_PROVIDER, model: this.model }
    const requestConfig = this.model === null ? undefined : this.requestConfig()
    const node: AssistantMessageNode = {
      kind: 'assistant',
      seq: open.seq,
      time: open.lastTime,
      turn: open.turn,
      step: open.step,
      blocks: [...open.blocks],
      ...(usage === undefined ? {} : { usage }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      timing: {
        stepStartTime: open.startedAt,
        firstTokenTime: open.firstTokenTime ?? open.startedAt,
        completedTime: open.lastTime,
      },
      ...(status === 'error' ? { interrupted: true as const } : {}),
    }
    if (open.published) this.assembler.replaceNode(open.seq, node)
    else this.assembler.pushNode(node)
    open.published = true
    this.locate(open.seq, open.turn)
    const request: AssistantRequestView = {
      purpose: 'assistant',
      turn: open.turn,
      step: open.step,
      startSeq: open.seq,
      startedAt: open.startedAt,
      completedAt: open.lastTime,
      status,
      resultSeq: open.seq,
      ...(error === undefined ? {} : { error, errorCode: code ?? 'interrupted' }),
      ...(usage === undefined ? {} : { usage }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
    }
    this.assembler.upsertRequest(request)
    this.assembler.partial = null
    this.assembler.touch()
  }

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  private handleToolCall(update: Record<string, unknown>, record: GrokRecord, time: number): void {
    const callId = asString(update['toolCallId'])
    if (callId === undefined || this.calls.has(callId)) {
      if (callId !== undefined) this.mergeCall(callId, update)
      return
    }
    this.startCall(callId, update, record, time)
    // Old transcripts without stream identity use a tool call as the boundary.
    // Stamped parallel calls remain in the same model response.
    if (record.streamStartMs === null) this.closeStep('complete')
    else if (this.open !== null) this.publishStep(this.open, 'complete')
  }

  private startCall(
    callId: string,
    update: Record<string, unknown>,
    record: GrokRecord,
    time: number,
  ): OpenCall {
    const open = this.ensureStep(time)
    const { name, canonical } = toolNameOf(update)
    const args = toolArgsOf(update)
    const block = { kind: 'tool-call' as const, callId, name, argsRaw: args?.argsRaw ?? '{}' }
    open.blocks.push(block)
    if (time > open.lastTime) open.lastTime = time
    this.assembler.partial = { turn: open.turn, step: open.step, blocks: [...open.blocks] }
    this.assembler.tools.start({
      callId, name, argsRaw: block.argsRaw, turn: open.turn, step: open.step, time, subCalls: [],
    })
    const call: OpenCall = {
      callId,
      promptId: record.promptId ?? this.currentPromptId,
      time,
      canonical,
      canonicalArgs: args?.canonical === true,
      block,
      boundAgentId: null,
    }
    this.calls.set(callId, call)
    this.attachSchema(callId, name)
    if (isGrokTaskTool(name)) this.taskCalls.push(call)
    this.assembler.touch()
    return call
  }

  /**
   * Merge a later identity into a running call. The canonical `x.ai/tool`
   * envelope usually arrives on the first `tool_call_update`, after the
   * `tool_call` announced the call under its display title, so both the tracker
   * entry and the already-emitted assistant block are rewritten in place.
   */
  private mergeCall(callId: string, update: Record<string, unknown>): void {
    const call = this.calls.get(callId)
    if (call === undefined) return
    const { name, canonical } = toolNameOf(update)
    const args = toolArgsOf(update)
    let changed = false
    if (canonical && !call.canonical) {
      call.canonical = true
      call.block.name = name
      changed = true
      if (isGrokTaskTool(name) && !this.taskCalls.includes(call)) this.taskCalls.push(call)
      this.attachSchema(callId, name)
    }
    if (args !== undefined && (args.canonical || !call.canonicalArgs)) {
      if (args.canonical) call.canonicalArgs = true
      if (call.block.argsRaw !== args.argsRaw) {
        call.block.argsRaw = args.argsRaw
        changed = true
      }
    }
    if (!changed) return
    const pending = this.assembler.tools.pendingCall(callId)
    if (pending !== undefined) {
      pending.name = call.block.name
      pending.argsRaw = call.block.argsRaw
    }
    this.assembler.touch()
  }

  private attachSchema(callId: string, name: string): void {
    const schema = this.toolCatalog.get(name)
    if (schema === undefined) return
    this.assembler.callSchemas.set(callId, schema)
    this.assembler.touch()
  }

  private handleToolCallUpdate(
    update: Record<string, unknown>,
    record: GrokRecord,
    time: number,
  ): void {
    const callId = asString(update['toolCallId'])
    if (callId === undefined) return
    if (!this.calls.has(callId)) {
      // The announcing `tool_call` can be missing from a truncated head.
      this.startCall(callId, update, record, time)
    } else {
      this.mergeCall(callId, update)
    }
    const status = asString(update['status'])
    if (status === undefined || !TERMINAL_TOOL_STATUS.has(status)) return
    // `status === 'failed'` is grok's only error flag (GROK-FORMAT §C.2).
    this.completeCall(callId, this.resultBlocks(update), status === 'failed', time)
  }

  private resultBlocks(update: Record<string, unknown>): ContentBlock[] {
    const blocks: ContentBlock[] = []
    for (const item of asArray(update['content']) ?? []) {
      if (!isRecord(item)) continue
      if (asString(item['type']) === 'diff') {
        const path = asString(item['path']) ?? ''
        const oldText = asString(item['oldText']) ?? ''
        const newText = asString(item['newText']) ?? ''
        blocks.push({ type: 'text', text: `--- ${path}\n${oldText} → ${newText}` })
        continue
      }
      const inner = isRecord(item['content']) ? item['content'] : item
      if (asString(inner['type']) === 'image') {
        const data = asString(inner['data'])
        if (data !== undefined) {
          blocks.push({ type: 'image', attachment: this.images.add(data, normalizeImageMediaType(inner['mimeType'])) })
          continue
        }
      }
      const text = asString(inner['text'])
      if (text !== undefined) blocks.push({ type: 'text', text })
    }
    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
  }

  private completeCall(
    callId: string,
    content: readonly ContentBlock[],
    isError: boolean,
    time: number,
  ): void {
    if (!this.assembler.tools.isPending(callId)) return
    const call = this.calls.get(callId)
    const seq = this.assembler.seq.next()
    // grok's measured durations live in `events.jsonl` only (GROK-FORMAT §G.3);
    // this is the update-stamp delta, which is all `updates.jsonl` can give.
    const durationMs = call === undefined ? undefined : Math.max(0, time - call.time)
    const { node, topLevel } = this.assembler.tools.complete(callId, {
      seq,
      time,
      content,
      isError,
      ...(durationMs === undefined ? {} : { meta: { durationMs } }),
    })
    if (topLevel) {
      this.assembler.pushNode(node)
      this.locate(seq, Math.max(1, this.turn))
    } else {
      this.assembler.touch()
    }
  }

  // ---------------------------------------------------------------------------
  // Turn completion
  // ---------------------------------------------------------------------------

  private handleTurnCompleted(update: Record<string, unknown>, time: number): void {
    const promptId = asString(update['prompt_id'])
    const turn = (promptId === undefined ? undefined : this.promptTurns.get(promptId)) ?? this.turn
    const usage = mapUsage(update['usage'])
    const errorKind = asString(update['error_kind'])
    if (errorKind === undefined) this.closeStep('complete', undefined, undefined, usage)
    else this.closeStep('error', `Turn ended (${errorKind})`, errorKind, usage)
    if (usage !== undefined) this.attachTurnUsage(turn, usage)
    this.closeTurn(turn)
    if (promptId !== undefined && promptId === this.currentPromptId) this.currentPromptId = null
  }

  /**
   * `turn_completed.usage` is per turn, not per model call, so it lands on the
   * turn's last assistant record — unless that record was just closed with it.
   */
  private attachTurnUsage(turn: number, usage: TokenUsage): void {
    for (let index = this.assembler.requests.length - 1; index >= 0; index -= 1) {
      const request = this.assembler.requests[index]
      if (request === undefined || request.purpose !== 'assistant' || request.turn !== turn) continue
      if (request.usage !== undefined) return
      this.assembler.upsertRequest({ ...request, usage })
      const node = this.assembler.nodes.find(
        (item): item is AssistantMessageNode => item.kind === 'assistant' && item.seq === request.startSeq,
      )
      if (node !== undefined) this.assembler.replaceNode(node.seq, { ...node, usage })
      return
    }
  }

  // ---------------------------------------------------------------------------
  // Compaction and retries
  // ---------------------------------------------------------------------------

  private handleCompactStarted(update: Record<string, unknown>, time: number): void {
    const window = asNumber(update['context_window'])
    // The only in-band source of the window size (GROK-FORMAT §H.3).
    if (window !== undefined && window > 0) this.contextWindow = window
    if (this.openCompaction !== null) return
    this.closeStep('complete')
    const tokensBefore = asNumber(update['tokens_used']) ?? null
    const seq = this.openCompactionNode(time, tokensBefore, null)
    this.openCompaction = { seq, startedAt: time, tokensBefore }
    this.assembler.upsertRequest({
      purpose: 'compaction',
      turn: this.turn > 0 ? this.turn : null,
      step: 0,
      startSeq: seq,
      startedAt: time,
      completedAt: null,
      status: 'running',
    })
  }

  private openCompactionNode(time: number, tokensBefore: number | null, summary: string | null): number {
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({
      kind: 'compaction',
      seq,
      time,
      summary,
      summaryEventSeq: summary === null ? null : seq,
      shadowedItemCount: null,
      shadowedTokenCount: tokensBefore,
    })
    if (this.turn > 0) this.locate(seq, this.turn)
    return seq
  }

  private handleCompactCompleted(update: Record<string, unknown>, time: number): void {
    const preview = asString(update['summary_preview'])
    const summary = preview === undefined || preview.trim() === '' ? null : preview
    const tokensBefore = asNumber(update['tokens_before'])
      ?? this.openCompaction?.tokensBefore
      ?? null
    const open = this.openCompaction
    const seq = open?.seq ?? this.openCompactionNode(time, tokensBefore, summary)
    if (open !== null) {
      const node = this.assembler.nodes.find(
        (item): item is CompactionSummaryNode => item.kind === 'compaction' && item.seq === seq,
      )
      if (node !== undefined) {
        this.assembler.replaceNode(seq, {
          ...node,
          summary,
          summaryEventSeq: summary === null ? null : seq,
          shadowedTokenCount: tokensBefore,
        })
      }
    }
    const request: CompactionRequestView = {
      purpose: 'compaction',
      turn: this.turn > 0 ? this.turn : null,
      step: 0,
      startSeq: seq,
      startedAt: open?.startedAt ?? time,
      completedAt: time,
      status: 'complete',
      resultSeq: seq,
      replacementSeq: seq,
      ...(summary === null ? {} : { summary: [{ type: 'text', text: summary }] }),
    }
    this.assembler.upsertRequest(request)
    this.openCompaction = null
  }

  private handleCompactFailed(update: Record<string, unknown>, time: number): void {
    const open = this.openCompaction
    const message = asString(update['error']) ?? 'compaction failed'
    const seq = open?.seq ?? this.openCompactionNode(time, null, null)
    this.assembler.upsertRequest({
      purpose: 'compaction',
      turn: this.turn > 0 ? this.turn : null,
      step: 0,
      startSeq: seq,
      startedAt: open?.startedAt ?? time,
      completedAt: time,
      status: 'error',
      error: message,
    })
    this.openCompaction = null
  }

  /** Persist-only marker; it records that a compaction happened without a summary. */
  private handleCompactionCheckpoint(time: number): void {
    if (this.openCompaction !== null) return
    this.closeStep('complete')
    const seq = this.openCompactionNode(time, null, null)
    this.assembler.upsertRequest({
      purpose: 'compaction',
      turn: this.turn > 0 ? this.turn : null,
      step: 0,
      startSeq: seq,
      startedAt: time,
      completedAt: time,
      status: 'complete',
      resultSeq: seq,
      replacementSeq: seq,
    })
  }

  private handleRetryState(update: Record<string, unknown>, time: number): void {
    // `RetryState` is a flattened newtype: `type`/`error_type`/`message` sit
    // beside `sessionUpdate` (GROK-FORMAT §C.3).
    const type = asString(update['type']) ?? 'retrying'
    const errorType = asString(update['error_type']) ?? 'error'
    const message = asString(update['message']) ?? ''
    this.pushNotice(`${type}: ${errorType}${message === '' ? '' : `: ${message}`}`, time, 'retry')
    if (type === 'failed') this.closeStep('error', `${errorType}${message === '' ? '' : `: ${message}`}`, errorType)
  }

  // ---------------------------------------------------------------------------
  // Subagents
  // ---------------------------------------------------------------------------

  private handleSubagentSpawned(
    update: Record<string, unknown>,
    record: GrokRecord,
    time: number,
  ): void {
    const agentId = asString(update['subagent_id'])
    if (agentId === undefined) return
    const run = this.runFor(agentId, time)
    run.fileId = asString(update['child_session_id']) ?? run.fileId
    run.description = asString(update['description']) ?? run.description
    run.agentType = asString(update['subagent_type']) ?? run.agentType
    // `SubagentSpawned.model` is the effective model of the run and may differ
    // from the parent's; it is optional on the wire (GROK-FORMAT §D.4), in which
    // case the spawning call's own `model` argument is the only other source.
    run.model = asString(update['model']) ?? run.model
    run.startedAt = run.startedAt ?? time
    run.status = 'running'
    if (run.callId !== null) return
    const call = this.bindTaskCall(record.promptId ?? this.currentPromptId, run.description)
    if (call === undefined) return
    call.boundAgentId = agentId
    run.callId = call.callId
    run.model ??= callArg(call, 'model')
  }

  /**
   * Pick the task-tool call a `subagent_spawned` belongs to. Grok records no
   * tool-call id on the spawn path (GROK-FORMAT §D.4), so the join is: the most
   * recent unbound task call of the same `promptId`, preferring one whose
   * `description` argument matches when a turn spawned several; falling back to
   * the most recent unbound task call anywhere.
   */
  private bindTaskCall(promptId: string | null, description: string | null): OpenCall | undefined {
    const unbound = this.taskCalls.filter(call => call.boundAgentId === null)
    if (unbound.length === 0) return undefined
    const sameTurn = promptId === null ? [] : unbound.filter(call => call.promptId === promptId)
    const pool = sameTurn.length > 0 ? sameTurn : unbound
    if (description !== null && description !== '' && pool.length > 1) {
      for (let index = pool.length - 1; index >= 0; index -= 1) {
        const call = pool[index]
        if (call !== undefined && callDescription(call) === description) return call
      }
    }
    return pool[pool.length - 1]
  }

  private handleSubagentProgress(update: Record<string, unknown>, time: number): void {
    const agentId = asString(update['subagent_id'])
    if (agentId === undefined) return
    const run = this.runs.get(agentId)
    if (run === undefined) return
    run.toolCalls = Math.max(run.toolCalls, asNumber(update['tool_call_count']) ?? 0)
    run.lastTime = run.lastTime === null ? time : Math.max(run.lastTime, time)
  }

  private handleSubagentFinished(update: Record<string, unknown>, time: number): void {
    const agentId = asString(update['subagent_id'])
    if (agentId === undefined) return
    const run = this.runs.get(agentId)
    if (run === undefined) return
    run.status = subagentStatus(asString(update['status']))
    run.endedAt = time
    run.toolCalls = Math.max(run.toolCalls, asNumber(update['tool_calls']) ?? 0)
    const output = asString(update['output'])
    // A background task tool returns immediately; a foreground one is still
    // open here and this is its result.
    if (output !== undefined && run.callId !== null && this.assembler.tools.isPending(run.callId)) {
      this.completeCall(run.callId, [{ type: 'text', text: output }], run.status === 'failed', time)
    }
  }

  private runFor(agentId: string, time: number): AgentRun {
    const existing = this.runs.get(agentId)
    if (existing !== undefined) return existing
    const run: AgentRun = {
      agentId,
      fileId: null,
      callId: null,
      description: null,
      agentType: null,
      model: null,
      status: 'launching',
      startedAt: time,
      endedAt: null,
      lastTime: null,
      toolCalls: 0,
    }
    this.runs.set(agentId, run)
    return run
  }

  /**
   * A child transcript contributes its counters and, when the parent call is
   * known, its tool calls as sub-calls of that call. Its prompts and assistant
   * text stay in the child's own view, which the server serves standalone.
   */
  private handleChild(file: SessionFileRef, record: GrokRecord, time: number): void {
    const run = this.runFor(file.id, time)
    run.fileId = file.id
    run.lastTime = run.lastTime === null ? time : Math.max(run.lastTime, time)
    if (run.status === 'launching') run.status = 'running'
    const update = record.update
    const tag = record.sessionUpdate
    if (update === null || tag === null) return
    const callId = asString(update['toolCallId'])
    if (callId === undefined) return
    if (tag === 'tool_call' && !this.childCalls.has(callId)) {
      run.toolCalls += 1
      if (run.callId === null) return
      this.childCalls.add(callId)
      const { name } = toolNameOf(update)
      this.assembler.tools.start({
        callId,
        parentCallId: run.callId,
        name,
        argsRaw: toolArgsOf(update)?.argsRaw ?? '{}',
        turn: Math.max(1, this.turn),
        step: this.step,
        time,
        subCalls: [],
      })
      this.assembler.touch()
      return
    }
    if (tag !== 'tool_call_update' || !this.childCalls.has(callId)) return
    const status = asString(update['status'])
    if (status === undefined || !TERMINAL_TOOL_STATUS.has(status)) return
    this.completeCall(callId, this.resultBlocks(update), status === 'failed', time)
  }

  // ---------------------------------------------------------------------------
  // Turn locations
  // ---------------------------------------------------------------------------

  private locate(seq: number, turn: number): void {
    if (this.assembler.locations.has(seq)) return
    this.assembler.locations.set(seq, { kind: 'turn', turn: { turn, status: 'open' } })
    const seqs = this.turnSeqs.get(turn) ?? []
    seqs.push(seq)
    this.turnSeqs.set(turn, seqs)
  }

  private closeTurn(turn: number): void {
    for (const seq of this.turnSeqs.get(turn) ?? []) {
      this.assembler.locations.set(seq, { kind: 'turn', turn: { turn, status: 'closed' } })
    }
    this.assembler.touch()
  }
}

/** Whether a catalog entry already holds exactly this schema (same name, text and parameters). */
function sameSchema(current: ToolSchema | undefined, next: ToolSchema): boolean {
  if (current === undefined) return false
  if (current.description !== next.description) return false
  return JSON.stringify(current.parameters) === JSON.stringify(next.parameters)
}

/** One string argument of a tool call, read back from the emitted block's JSON. */
function callArg(call: OpenCall, key: string): string | null {
  const args: unknown = parseJsonLine(call.block.argsRaw)
  return isRecord(args) ? asString(args[key]) ?? null : null
}

/** The `description` argument of a task-tool call, used to disambiguate spawns in one turn. */
function callDescription(call: OpenCall): string | null {
  return callArg(call, 'description')
}

/** Create the incremental Grok Build `updates.jsonl` parser. */
export function createGrokParser(): SessionParser {
  return new GrokParser()
}
