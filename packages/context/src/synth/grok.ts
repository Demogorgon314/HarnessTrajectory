/**
 * Grok Build (`grok` CLI, xAI) `updates.jsonl` → fold events.
 *
 * One instance per transcript file
 * (`$GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl`). A grok
 * child session writes exactly the same files in its own TOP-LEVEL directory
 * (GROK-FORMAT §D.2), so a child folds through this same class with no branch —
 * which is also why `childKeyOf` needs none: `AgentSpawn.key` is the
 * `subagent_id`, which IS the child session id and the child file's `id`.
 *
 * Every line is `{timestamp, method, params}` with `params = {sessionId,
 * update, _meta}` (GROK-FORMAT §C.1). The envelope is parsed by
 * `parseGrokLine` from `@harness-trajectory/core` — the SAME function the
 * trajectory adapter and the server's meta scanner use — so the three layers
 * can never disagree about units, tags or the human/injected split.
 *
 * UNIT TRAPS, all of them load-bearing below:
 *
 *  1. The envelope `timestamp` is epoch SECONDS; `params._meta.agentTimestampMs`
 *     is epoch MILLISECONDS. `parseGrokLine` resolves the two into one
 *     millisecond instant (`GrokRecord.time`), so no unit is guessed here.
 *  2. The ACP rail (`session/update`) and the xAI rail (`_x.ai/session/update`)
 *     are buffered INDEPENDENTLY, so record stamps are not monotonic in file
 *     order (220 inversions in one 676-line file, GROK-FORMAT §C.1). File order
 *     is replay order and is what this module folds; every emitted event time is
 *     clamped to the previous one so the fold's duration arithmetic can never
 *     see a negative span.
 *  3. `agent_message_chunk` / `agent_thought_chunk` are DEBOUNCED blocks, not
 *     per-token deltas (65–634 characters each, GROK-FORMAT §C.2). They are
 *     concatenated in file order into one reasoning and one text block per model
 *     call, and the first chunk's instant is the best first-token measurement
 *     the file carries (it is an upper bound: the debounce window has already
 *     elapsed by then).
 *  4. `_meta['x.ai/tool']` — the CANONICAL tool identity — usually arrives on
 *     the first `tool_call_update`, AFTER the `tool_call` that announced the
 *     call under its display title (`Read \`/path\``). The fold is event-sourced
 *     and cannot rewrite an emitted `tool/call`, so a step is BUFFERED until its
 *     first result forces it out; by then the identity has merged in and the
 *     `tool/call` carries the wire name (`read_file`).
 *  5. There is no `is_error` field: `tool_call_update.status === 'failed'` is
 *     grok's error flag (GROK-FORMAT §C.2).
 *  6. `turn_completed.usage.inputTokens` INCLUDES the cache-read share (ACP
 *     identity, GROK-FORMAT §B.2) while the fold's buckets are disjoint, so the
 *     cached parts are subtracted out. `reasoningTokens` is a subset of
 *     `outputTokens` and is never added to it.
 *  7. That usage is the SUM OVER THE TURN'S `usage.modelCalls` MODEL CALLS, not
 *     one request's figure. Booking it on a single step made the Current Context
 *     read the whole turn's summed prompt (792k of a 500k window on a real
 *     4-call turn). It is therefore APPORTIONED across the turn's calls — which
 *     is why this synthesizer is TURN-GRANULAR: a turn's events are buffered
 *     until its `turn_completed` lands and only then released, the way Kimi
 *     buffers a step. The per-call prompt size comes from `params._meta`:
 *     `streamStartMs` changes once per model call and the FIRST (minimum)
 *     `totalTokens` stamped on a stream is that call's prompt. Verified on real
 *     data (session 01a09b39): summing the per-stream minima reproduces
 *     `turn_completed.usage.inputTokens` within 0.05% on every settled turn
 *     (e.g. 195856+197724+198828+199227 = 791635 vs 791923 reported).
 *
 * BUFFERING CONSEQUENCES, all deliberate:
 *   - a turn that never terminates (a new human prompt, a compaction or a
 *     rewind arrives first) is released WITHOUT usage: no turn booked it, and
 *     inventing one would price a request the transcript never recorded;
 *   - `meta().running` counts a buffered turn as open work, so a live session
 *     still pulses while its events are held back;
 *   - the Context view lags the trajectory view by at most one turn.
 *
 * The system prompt (`system_prompt.txt`), the tool schemas
 * (`tool_definitions.json`) and the title/cwd/model (`summary.json`) live
 * OUTSIDE the jsonl, so the server prepends one synthetic sidecar line
 * (GROK-DESIGN §3). A sidecar is optional: a file fed without one folds the
 * same, it just shows the System Prompt as the fold's "≈ derived" remainder and
 * the Tool Schemas as not recorded — exactly like Claude Code.
 */

import type { GrokSidecar, SessionFileRef } from '@harness-trajectory/core'
import {
  asArray,
  asNumber,
  asString,
  grokContextWindow,
  grokMessageClass,
  isGrokTaskTool,
  isRecord,
  parseGrokLine,
  titleFrom,
} from '@harness-trajectory/core'
import type { ContentBlock, MessageSource, StreamRecord, TimelineEvent } from '../fold/event.ts'
import type { FileOpInput } from '../fold/fold.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'

/** Label length cap, matching the Claude/Codex/Kimi synthesizers' session titles. */
const LABEL_MAX = 80

/**
 * Pricing provider id (models.dev). grok is xAI's own CLI, and `xai` is a real
 * models.dev provider id, so it passes through `modelsDevProviderOf` verbatim
 * and needs no entry in `shared/providers.ts` — the same call Kimi made.
 */
const PROVIDER = 'xai'

/** 1e10 ticks = $1 USD (`USD_TICKS_PER_USD`, GROK-FORMAT §B.2). */
const USD_TICKS_PER_USD = 1e10

/** `tool_call_update.status` values that carry a result rather than a progress merge. */
const TERMINAL_TOOL_STATUS: ReadonlySet<string> = new Set(['completed', 'failed'])

/**
 * Plan mode has no persisted "mode changed" record: it is expressed as ordinary
 * `tool_call`s of these two tools (GROK-FORMAT §C.3, "mode changes").
 */
const PLAN_MODE_TOOLS: Readonly<Record<string, boolean>> = {
  enter_plan_mode: true,
  exit_plan_mode: false,
}

/** Open tool calls kept for their identity (file-op derivation, result pairing). */
const CALLS_MAX = 256

/** Task-tool calls kept as subagent-binding candidates (GROK-FORMAT §D.4). */
const TASK_CALLS_MAX = 64

/** One model call being accumulated: the chunks of one response plus its tool calls. */
interface OpenStep {
  turn: number
  step: number
  /** `params._meta.streamStartMs` when this call's stream opened, else the first record's time. */
  startedAt: number
  /**
   * `params._meta.streamStartMs` this step belongs to. The stream id IS the
   * model-call identity (unit trap 7), so it — not the tool-call seal — decides
   * where one call ends and the next begins whenever the transcript stamps it.
   */
  stream: number | undefined
  /** First `agent_*_chunk` instant — the file's best time-to-first-token evidence. */
  firstTokenTime: number | undefined
  lastTime: number
  blocks: ContentBlock[]
  callIds: Set<string>
  /**
   * A `tool_call` ended the model's generation; the next chunk opens a new step.
   * Only consulted when the stream is NOT stamped: grok emits parallel tool
   * calls from one model call (24 of 70 streams in a real session), so sealing
   * on the first of them would split one request into several.
   */
  sealed: boolean
  /** Exact usage for this call, when a `response_completed` reported one. */
  exact: GrokUsage | undefined
}

/** One settled step of the turn in flight, awaiting its share of the turn's usage. */
interface PendingStep {
  /** The buffered `assistant/message` the share is written into. */
  event: TimelineEvent
  /** The model call (`streamStartMs`) this step belongs to; steps sharing one made ONE request. */
  stream: number | undefined
  /** Characters this step emitted (text + reasoning + tool arguments) — the output weight. */
  chars: number
  exact: GrokUsage | undefined
}

/** The fold's four DISJOINT token buckets. */
export interface GrokUsage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** One step's apportionment evidence (see {@link apportionTurnUsage}). */
export interface TurnStepUsageInput {
  /** The model call this step belongs to; consecutive steps sharing one made a single request. */
  stream: number | undefined
  /** That call's prompt size (the first `_meta.totalTokens` on its stream), when stamped. */
  prompt: number | undefined
  /** Characters this step emitted — the weight its share of `outputTokens` is drawn on. */
  chars: number
  /** Exact per-call usage from a `response_completed`, which outranks any apportionment. */
  exact: GrokUsage | undefined
}

/** A tool call from its announcement until its result settles. */
interface CallInfo {
  callId: string
  name: string
  /** Whether `_meta['x.ai/tool'].name` has been seen; the display title is only a fallback. */
  canonical: boolean
  argsRaw: string
  /** Whether normalized `x.ai/tool.input` has been seen; `rawInput` is only a fallback. */
  canonicalArgs: boolean
  /** ACP/`x.ai/tool` kind: `read` | `edit` | `execute` | `search` | `fetch` | `think` | `other`. */
  kind: string | undefined
  /** `locations[].path` — the files the call touched. */
  paths: string[]
  /** `params._meta.promptId` of the announcing record: the turn key the subagent join uses. */
  promptId: string | undefined
  /**
   * The buffered assistant block, rewritten in place while its step is still
   * unflushed (unit trap 4); nulled the moment the step folds.
   */
  block: ContentBlock | null
  /** A `subagent_spawned` already claimed this task call. */
  bound: boolean
  /** The `description` argument, which disambiguates two spawns in one turn. */
  description: string | undefined
}

class GrokSynthesizer implements EventSynthesizer {
  readonly kind = 'grok' as const

  private seq = 0
  /** Last EMITTED event time; every event is clamped to it (unit trap 2). */
  private lastEmit = 0
  /** Last record time seen, the fallback for a line that carried no usable stamp. */
  private lastTime = 0

  // ---- meta -----------------------------------------------------------------
  private model: string | undefined
  /** `auto_compact_started.context_window`: the only in-band window figure. */
  private recordedWindow: number | undefined
  /** `summary.session_summary` / `session_summary_generated`; outranks the first prompt. */
  private summaryLabel: string | undefined
  private promptLabel: string | undefined
  /** Summed `costUsdTicks`; absent until a turn reported one (absent is never 0). */
  private costTicks: number | undefined

  // ---- header ---------------------------------------------------------------
  private systemText: string | undefined
  private tools: unknown[] = []
  private toolsKey: string | undefined
  private headerEmitted = false
  /** The `(window, model)` pair the last `request/context` announced. */
  private emittedWindow: number | undefined
  private emittedModel: string | undefined
  private contextEmitted = false

  // ---- turn / step ----------------------------------------------------------
  private turn = 0
  private step = 0
  private open: OpenStep | null = null
  private streamStartMs: number | undefined
  /** `params._meta.promptId` of the records currently arriving (GROK-FORMAT §G.1). */
  private promptId: string | undefined
  /**
   * The turn in flight's events, held until `turn_completed` apportions its
   * usage (unit trap 7); `null` while nothing is buffered, so the header, the
   * preamble and the opening prompt still reach the fold immediately.
   */
  private pending: TimelineEvent[] | null = null
  /** The settled steps of the turn in flight, in emission order. */
  private turnSteps: PendingStep[] = []
  /** Smallest `_meta.totalTokens` seen per `streamStartMs`: that call's prompt size. */
  private readonly streamPrompt = new Map<number, number>()

  // ---- tools ----------------------------------------------------------------
  private readonly calls = new Map<string, CallInfo>()
  private readonly taskCalls: CallInfo[] = []

  // ---- children -------------------------------------------------------------
  private readonly children = new Map<string, AgentSpawn>()

  // ---- surface bookkeeping --------------------------------------------------
  /** Seqs of every live surface node, for the compaction claim. */
  private liveSeqs: number[] = []
  /** Seqs of the live HUMAN `user/message` nodes (kept for symmetry with the other synths). */
  private humanSeqs: number[] = []

  // ---- compaction -----------------------------------------------------------
  /** `auto_compact_started` seen, its `auto_compact_*` terminator not yet. */
  private compactArmed = false
  private compactTokensBefore: number | undefined
  /** A compaction folded and nothing has joined the surface since (checkpoint de-dup). */
  private compactionFresh = false

  push(line: string): readonly TimelineEvent[] {
    const out: TimelineEvent[] = []
    try {
      const record = parseGrokLine(line)
      if (record === null) return out
      // A line with no usable stamp inherits the last instant rather than
      // falling back to "now": replaying a closed file must be deterministic.
      const time = record.time ?? this.lastTime
      if (time > this.lastTime) this.lastTime = time
      if (record.sidecar !== null) {
        this.onSidecar(record.sidecar, time, out)
        return out
      }
      const update = record.update
      const tag = record.sessionUpdate
      if (update === null || tag === null) return out
      if (record.streamStartMs !== null) {
        this.streamStartMs = record.streamStartMs
        this.notePromptSize(record.streamStartMs, record.meta)
      }
      if (record.promptId !== null) this.promptId = record.promptId
      this.onUpdate(tag, update, time, out)
    } catch {
      // The transcript is untrusted input: a malformed record yields whatever
      // events were already produced for this line and never throws.
    }
    return out
  }

  meta(): SynthMeta {
    const window = this.windowOf()
    const label = this.labelOf()
    return {
      ...(this.model === undefined ? {} : { model: this.model }),
      provider: PROVIDER,
      ...(window === undefined ? {} : { contextWindow: window }),
      ...(label === undefined ? {} : { label }),
      // GROK-DESIGN §6: a model step or a tool run is open, or a settled step is
      // still buffered waiting for its turn's usage (unit trap 7) — all three
      // are open work. Grok's turn terminator (`turn_completed`) closes the step
      // AND releases the buffer, and every settled tool call is deleted from
      // `calls` when its result folds, so this goes quiet the moment a
      // terminated transcript does.
      running: this.open !== null || this.calls.size > 0 || this.turnSteps.length > 0,
      children: this.children,
      ...(this.costTicks === undefined ? {} : { reportedCostUsd: this.costTicks / USD_TICKS_PER_USD }),
      // `version`: grok records no CLI version in `updates.jsonl` (it lives in
      // `~/.grok/version.json`, outside the session), so it stays absent.
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  private onUpdate(
    tag: string,
    update: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
  ): void {
    switch (tag) {
      case 'user_message_chunk': this.onUserChunk(update, time, out); break
      case 'agent_thought_chunk': this.appendChunk(update, 'reasoning', time, out); break
      case 'agent_message_chunk': this.appendChunk(update, 'text', time, out); break
      case 'tool_call': this.onToolCall(update, time, out); break
      case 'tool_call_update': this.onToolCallUpdate(update, time, out); break
      case 'turn_completed': this.onTurnCompleted(update, time, out); break
      case 'auto_compact_started': this.onCompactStarted(update, time, out); break
      case 'auto_compact_completed': this.onCompactCompleted(update, time, out); break
      case 'auto_compact_failed':
      case 'auto_compact_cancelled':
        // The context was NOT replaced: disarm without claiming anything.
        this.compactArmed = false
        this.compactTokensBefore = undefined
        break
      case 'compaction_checkpoint': this.onCompactionCheckpoint(time, out); break
      case 'response_completed': this.onResponseCompleted(update); break
      case 'rewind_marker':
        // A rewind abandons the turn in flight: release its events with no
        // usage (nothing terminated it, so nothing billed it) and start clean.
        this.flushStep(out, time)
        this.flushTurn(out, undefined, time)
        break
      case 'model_changed':
        this.setModel(asString(update['model_id']), time, out)
        break
      case 'model_auto_switched':
        this.setModel(asString(update['new_model_id']), time, out)
        break
      case 'session_summary_generated': {
        const title = asString(update['session_summary'])?.trim()
        if (title !== undefined && title !== '') this.summaryLabel = titleFrom(title, LABEL_MAX)
        break
      }
      case 'subagent_spawned': this.onSubagentSpawned(update, time); break
      case 'subagent_finished': this.onSubagentFinished(update, time); break
      default:
        // Everything else carries nothing the CONTEXT composition can price.
        // `hook_execution` (95% of the xAI rail), the hook/plugin/memory
        // lifecycle, `retry_state`, `session_recap`,
        // `task_*`/`scheduled_task_*`/`monitor_event`, `response_started` /
        // `reasoning_completed`, `diff_review`, the
        // workflow/goal snapshots and every unknown tag are UI notices about
        // the session, not context the model was shown — the trajectory view
        // renders them, and booking them here would inflate the injected
        // bucket with tokens no request ever carried. The ACP `plan` record is
        // skipped for the same reason (GROK-DESIGN §6: the todo list reaches
        // the model as tool arguments, and only the `enter_plan_mode` /
        // `exit_plan_mode` TOOL CALLS become `plan/mode`).
        // `subagent_progress` carries only counters, which `AgentSpawn` has no
        // field for.
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Emission helpers
  // ---------------------------------------------------------------------------

  private emit(
    out: TimelineEvent[],
    type: string,
    time: number,
    data?: Record<string, unknown>,
    surfaceOp?: unknown,
  ): TimelineEvent {
    // Unit trap 2: the two rails interleave out of order, so an event may carry
    // a stamp older than its predecessor's. Clamping here keeps the stream
    // monotonic without ever reordering the records themselves.
    const at = time > this.lastEmit ? time : this.lastEmit
    this.lastEmit = at
    const seq = (this.seq += 1)
    const event: TimelineEvent = {
      type,
      seq,
      time: at,
      ...(data === undefined ? {} : { data }),
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    }
    // Unit trap 7: while a turn is in flight its events wait in the buffer so
    // `turn_completed` can still write each step's usage share into them. Seqs
    // and instants are assigned HERE, so the released order is the emitted one.
    if (this.pending !== null) this.pending.push(event)
    else out.push(event)
    return event
  }

  /**
   * The prompt size of one model call: the first (smallest) `_meta.totalTokens`
   * stamped on its stream (unit trap 7). Later records of the same stream carry
   * a LARGER running total — the context grew as the response and its tool
   * results landed — so the minimum is the figure the request went out with.
   */
  private notePromptSize(stream: number, meta: Record<string, unknown> | null): void {
    const total = meta === null ? undefined : asNumber(meta['totalTokens'])
    if (total === undefined || total <= 0) return
    const seen = this.streamPrompt.get(stream)
    if (seen === undefined || total < seen) this.streamPrompt.set(stream, total)
  }

  /** Emit a surface-bearing event and remember its seq for the next compaction claim. */
  private emitSurface(
    out: TimelineEvent[],
    type: string,
    time: number,
    data: Record<string, unknown>,
    surfaceOp?: unknown,
  ): TimelineEvent {
    const event = this.emit(out, type, time, data, surfaceOp)
    this.liveSeqs.push(event.seq)
    return event
  }

  // ---------------------------------------------------------------------------
  // Sidecar: system prompt, tool schemas, title, model
  // ---------------------------------------------------------------------------

  /**
   * The server-fabricated sidecar (GROK-DESIGN §3) carries the three facts grok
   * keeps beside `updates.jsonl`. It never creates a surface node: it defines
   * the request ENVELOPE. A later sidecar replaces the facts (`summary.json` is
   * rewritten at every turn boundary, so the title changes), and re-emits a
   * header only when the prompt, the schemas or the model actually changed.
   */
  private onSidecar(sidecar: GrokSidecar, time: number, out: TimelineEvent[]): void {
    const summary = sidecar.summary
    let model = this.model
    if (summary !== null) {
      const title = asString(summary['session_summary'])?.trim()
      if (title !== undefined && title !== '') this.summaryLabel = titleFrom(title, LABEL_MAX)
      model = catalogModel(asString(summary['current_model_id'])) ?? model
    }
    const system = sidecar.systemPrompt
    const tools = sidecar.toolDefinitions
    const toolsKey = tools === null ? this.toolsKey : jsonOrEmpty(tools)
    const changed = (system !== null && system !== '' && system !== this.systemText)
      || toolsKey !== this.toolsKey
      || model !== this.model
    if (system !== null && system !== '') this.systemText = system
    if (tools !== null) {
      // `tool_definitions.json` is Chat-Completions shaped
      // (`{type:'function', function:{name, description?, parameters}}`); the
      // fold prices the array as one JSON string, so it rides as-is.
      this.tools = [...tools]
      this.toolsKey = toolsKey
    }
    this.model = model
    if (!this.headerEmitted) this.emitHeader(out, time, 'initial')
    else if (changed) this.emitHeader(out, time, 'change')
    this.emitContext(out, time)
  }

  /**
   * `config` rides INSIDE `header` — that is where the fold reads the model and
   * provider from. `header.system` is REPEATED on every change header: the fold
   * clears its envelope-sourced system prompt when a later header carries none,
   * so omitting it would silently zero the System Prompt figure.
   */
  private emitHeader(out: TimelineEvent[], time: number, reason: 'initial' | 'change'): void {
    this.headerEmitted = true
    this.emit(out, 'request/header', time, {
      header: {
        ...(this.systemText === undefined ? {} : { system: this.systemText }),
        tools: this.tools,
        config: {
          ...(this.model === undefined ? {} : { model: this.model }),
          provider: PROVIDER,
        },
      },
      reason,
    })
  }

  /**
   * ASSUMPTION — grok records its context window in-band only when a compaction
   * fires (`auto_compact_started.context_window`). Until then the figure is the
   * catalog's, which every source agrees on: ≈ assumed 500k for every shipped
   * grok model (GROK-FORMAT §H.3 — `models_cache.json`, the compaction record
   * and the docs all say 500 000). `grokContextWindow` owns the table, shared
   * with the trajectory adapter so the two views can never disagree.
   *
   * Emitted on change only, and always carrying the model: a session with no
   * sidecar has no `request/header` at all, so this is the fold's only route to
   * the model id and the provider.
   */
  private emitContext(out: TimelineEvent[], time: number): void {
    const window = this.windowOf()
    if (this.contextEmitted && window === this.emittedWindow && this.model === this.emittedModel) return
    this.contextEmitted = true
    this.emittedWindow = window
    this.emittedModel = this.model
    this.emit(out, 'request/context', time, {
      ...(window === undefined ? {} : { contextWindow: window }),
      ...(this.model === undefined ? {} : { model: this.model }),
      provider: PROVIDER,
    })
  }

  private windowOf(): number | undefined {
    return this.recordedWindow ?? (this.model === undefined ? undefined : grokContextWindow(this.model))
  }

  private labelOf(): string | undefined {
    return this.summaryLabel ?? this.promptLabel
  }

  /**
   * Adopt a model id. Grok spells the same model two ways (GROK-FORMAT §H.2):
   * the CATALOG id (`grok-4.6`, in `summary.json.current_model_id`, the user
   * chunk's `_meta.modelId` and `model_changed`) and the BILLING id
   * (`grok-4.6-build`, in `usage.json` and `turn_completed.usage.modelUsage`).
   *
   * PRICING DECISION — models.dev publishes `xai/grok-4.6` and `xai/grok-4.5`,
   * and `cost.ts`'s suffix fallback only matches a REGISTRY id that ends with
   * `-<model>`, never the other way round: `grok-4.6-build` would therefore
   * price NOTHING. Every id this synthesizer can reach is a catalog one (the
   * per-model `modelUsage` keys are not read — the fold's `assistant/message`
   * usage has no per-model slot, so GROK-DESIGN §6's per-model attribution is
   * not expressible and the turn's own model is used), but a trailing `-build`
   * is stripped anyway so a future build that reports the billing id on the
   * catalog rail still prices.
   */
  private setModel(next: string | undefined, time: number, out: TimelineEvent[]): void {
    const model = catalogModel(next)
    if (model === undefined || model === this.model) return
    const previous = this.model
    this.model = model
    // A model switch has no dedicated fold event: it is a request header that
    // differs from the previous one. The first model ever seen opens the
    // session rather than switching it.
    if (previous !== undefined) this.emitHeader(out, time, 'change')
    this.emitContext(out, time)
  }

  // ---------------------------------------------------------------------------
  // User chunks
  // ---------------------------------------------------------------------------

  /**
   * Human vs injected is decided by the `_meta` FLAGS (GROK-FORMAT §F.4), never
   * by the text — and by the SAME function core's grok adapter uses, so the
   * trajectory view's prompt count and this view's `humanInputs` can never
   * disagree.
   */
  private onUserChunk(update: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const cls = grokMessageClass(update)
    if (cls === null) return
    const content = isRecord(update['content']) ? update['content'] : {}
    const contentMeta = isRecord(content['_meta']) ? content['_meta'] : undefined
    const meta = isRecord(update['_meta']) ? update['_meta'] : undefined
    // The typed text is `displayText` when the model-facing frame differs
    // (slash commands, interjections); `content.text` is the frame.
    const text = asString(contentMeta?.['displayText']) ?? asString(content['text'])
    const blocks = blocksOfChunk(content, text)
    if (cls.kind === 'injection') {
      this.setModel(asString(meta?.['modelId']), time, out)
      this.emitSurface(out, 'user/message', time, { content: blocks, source: sourceOfInjection(cls.name) })
      this.compactionFresh = false
      return
    }
    // Settle the previous model call FIRST: `setModel` can emit a header and a
    // context change, and a switch announced on this prompt must not jump ahead
    // of the events of the step it interrupted.
    this.flushStep(out, time)
    if (!cls.interjection) {
      // A new prompt ends the previous turn whatever it did: an unterminated
      // turn books no usage (no `turn_completed` billed it).
      this.flushTurn(out, undefined, time)
    }
    this.setModel(asString(meta?.['modelId']), time, out)
    if (!cls.interjection) {
      // Turns are numbered by ARRIVAL, not by `promptIndex`: a rewind replays
      // lower indices into the same append-only file (GROK-FORMAT §C.3).
      this.turn += 1
      this.step = 0
    }
    if (this.promptLabel === undefined && text !== undefined && text.trim() !== '') {
      this.promptLabel = titleFrom(text, LABEL_MAX)
    }
    // GROK-DESIGN §6: with no sidecar this is where the assumed window lands.
    this.emitContext(out, time)
    // DEVIATION (design said "slash → the same source Claude gives a command"):
    // a slash command stays a plain `{ kind: 'user' }` human prompt. The fold's
    // `isInjection` treats ANY source that declares a `form`, or a `kind` other
    // than `'user'`, as injected context — so Claude's `skill-invocation`
    // source would move the prompt out of the human bucket and out of
    // `humanInputs`, contradicting GROK-DESIGN §4 (a typed `/command` IS a
    // human prompt and counts towards `promptCount`). Grok also records only
    // the RAW `/statusline` text on this rail; the expanded skill body never
    // reaches `updates.jsonl` (GROK-FORMAT §F.4 "slash-command asymmetry"), so
    // there is no injected body to book into the skill bucket.
    const human = this.emitSurface(out, 'user/message', time, {
      content: blocks,
      source: { kind: 'user' } satisfies MessageSource,
    })
    this.humanSeqs.push(human.seq)
    this.compactionFresh = false
  }

  // ---------------------------------------------------------------------------
  // Assistant steps
  // ---------------------------------------------------------------------------

  private appendChunk(
    update: Record<string, unknown>,
    kind: 'reasoning' | 'text',
    time: number,
    out: TimelineEvent[],
  ): void {
    const content = isRecord(update['content']) ? update['content'] : {}
    const text = asString(content['text'])
    if (text === undefined || text === '') return
    const open = this.ensureStep(time, out)
    if (open.firstTokenTime === undefined) open.firstTokenTime = time
    // Unit trap 3: chunks are debounced blocks, so consecutive ones of a kind
    // are one block, concatenated with no separator.
    const last = open.blocks[open.blocks.length - 1]
    if (last !== undefined && last.type === kind) last.text = (last.text ?? '') + text
    else open.blocks.push({ type: kind, text })
    if (time > open.lastTime) open.lastTime = time
  }

  /** The step a record belongs to, opening one (and closing the previous call) as needed. */
  private ensureStep(time: number, out: TimelineEvent[]): OpenStep {
    const existing = this.open
    if (existing !== null && this.continuesCall(existing)) return existing
    if (existing !== null) this.flushStep(out, time)
    if (this.turn === 0) this.turn = 1
    this.step += 1
    // `streamStartMs` marks when this model call's stream opened, which
    // precedes the first debounced chunk and is what makes the emitted TTFT a
    // real measurement rather than zero.
    const stream = this.streamStartMs
    const startedAt = stream !== undefined && stream > 0 && stream <= time ? stream : time
    const at = startedAt > this.lastEmit ? startedAt : this.lastEmit
    // Buffering opens with the turn's first model call, so a session's header,
    // preamble and opening prompt still reach the fold as they arrive.
    if (this.pending === null) this.pending = []
    this.emit(out, 'step/start', at)
    const created: OpenStep = {
      turn: this.turn,
      step: this.step,
      startedAt: at,
      stream,
      firstTokenTime: undefined,
      lastTime: time,
      blocks: [],
      callIds: new Set<string>(),
      sealed: false,
      exact: undefined,
    }
    this.open = created
    return created
  }

  /**
   * Whether the arriving record still belongs to the open step's model call.
   *
   * `streamStartMs` is minted once per model call (unit trap 7), so when both
   * the step and the record carry one the stream IS the answer — and it keeps
   * PARALLEL tool calls (common: 24 of 70 streams in a real session) inside the
   * one request that issued them. Only a transcript that stamps no stream falls
   * back to the seal rule, where the first tool call ends the generation.
   */
  private continuesCall(open: OpenStep): boolean {
    const stream = this.streamStartMs
    if (open.stream !== undefined && stream !== undefined) return open.stream === stream
    return !open.sealed
  }

  /**
   * Settle the buffered model call: the whole response goes out in fold order —
   * `assistant/message` → one `tool/call` per buffered tool-call block →
   * `step/end`. A step with no blocks emits only `step/end` (an abort between
   * the stream opening and the first token invents no request record).
   *
   * No usage is written here: `turn_completed` reports it PER TURN (unit trap
   * 7) and {@link flushTurn} apportions it back across the steps this buffered,
   * writing each share into the `assistant/message` while it is still pending.
   */
  private flushStep(out: TimelineEvent[], time: number): void {
    const open = this.open
    if (open === null) return
    this.open = null
    const completed = open.lastTime > open.startedAt ? open.lastTime : open.startedAt
    if (open.blocks.length === 0) {
      // An abort between the stream opening and the first token invents no
      // request record, so it takes no share of the turn's usage either.
      this.emit(out, 'step/end', completed)
      return
    }
    const stream = buildStream(open, completed)
    const event = this.emitSurface(out, 'assistant/message', completed, {
      message: { content: open.blocks },
      turn: open.turn,
      step: open.step,
      ...(stream.length === 0 ? {} : { stream }),
    })
    this.turnSteps.push({ event, stream: open.stream, chars: charsOf(open.blocks), exact: open.exact })
    this.compactionFresh = false
    for (const block of open.blocks) {
      if (block.type !== 'tool-call' || block.callId === undefined) continue
      // Unit trap 4: the block is now frozen — a later identity merge must not
      // rewrite an already-emitted event.
      const info = this.calls.get(block.callId)
      if (info !== undefined) info.block = null
      this.emit(out, 'tool/call', completed, {
        callId: block.callId,
        name: block.name ?? 'tool',
        ...(block.arguments === undefined ? {} : { arguments: block.arguments }),
      })
    }
    this.emit(out, 'step/end', completed)
  }

  /**
   * Close the turn in flight: apportion its usage across the model calls this
   * buffered, then RELEASE the buffered events onto `out` in emission order.
   *
   * `usage` absent means the turn never terminated (a new prompt, a compaction
   * or a rewind arrived first, or the file simply ends mid-turn): no
   * `turn_completed` billed it, so nothing is booked — inventing a figure would
   * price a request the transcript never recorded.
   */
  private flushTurn(out: TimelineEvent[], usage: unknown, time: number): void {
    const totals = usageOf(usage)
    const steps = this.turnSteps
    if (totals !== undefined) {
      if (steps.length === 0) this.emitUsageOnly(out, time, totals)
      else {
        const shares = apportionTurnUsage(
          steps.map(step => ({
            stream: step.stream,
            prompt: step.stream === undefined ? undefined : this.streamPrompt.get(step.stream),
            chars: step.chars,
            exact: step.exact,
          })),
          totals,
        )
        // The events are still pending, so writing the share in is a plain
        // field set rather than a (forbidden) rewrite of a folded event.
        for (const [index, step] of steps.entries()) {
          const share = shares[index]
          if (share !== undefined && step.event.data !== undefined) step.event.data['usage'] = share
        }
      }
    }
    this.turnSteps = []
    // `streamPrompt` is NOT cleared: `streamStartMs` is an epoch instant, so a
    // key is never reused, and keeping the table makes the lookup independent
    // of where a turn boundary happened to fall (one number per model call).
    const pending = this.pending
    this.pending = null
    if (pending !== null) out.push(...pending)
  }

  /**
   * A turn that billed tokens without a single settled model call (it was
   * cancelled before the first token, or every step it opened stayed empty)
   * still has to book them. An EMPTY `assistant/message` is the fold's own
   * usage-only request record: `deriveEventMessage` projects it to no model
   * message, so it prices 0 context while its usage reaches the cost rollup.
   */
  private emitUsageOnly(out: TimelineEvent[], time: number, usage: GrokUsage): void {
    this.emitSurface(out, 'assistant/message', time, {
      message: { content: [] },
      usage,
      turn: this.turn > 0 ? this.turn : 1,
      step: this.step,
    })
    this.compactionFresh = false
  }

  /**
   * `response_completed.usage` (`ResponseUsage`, GROK-FORMAT §C.3) is the one
   * PER-CALL figure grok can write, so it outranks any apportionment of the
   * turn total. Its field names are snake_case — the Rust struct carries no
   * `rename_all` — and its `input_tokens` is the UNCACHED portion (the Messages
   * API convention, documented on the struct), which is already the fold's
   * bucket. No local transcript contains this record (0 in 46 MB), so this path
   * exists for newer builds and is proven by unit test rather than by fixture.
   */
  private onResponseCompleted(update: Record<string, unknown>): void {
    const usage = responseUsageOf(update['usage'])
    if (usage === undefined) return
    if (this.open !== null) this.open.exact = usage
    else {
      const last = this.turnSteps[this.turnSteps.length - 1]
      if (last !== undefined) last.exact = usage
    }
  }

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  private onToolCall(update: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const callId = asString(update['toolCallId'])
    if (callId === undefined || callId === '') return
    if (this.calls.has(callId)) {
      this.mergeCall(callId, update, time, out)
      return
    }
    this.startCall(callId, update, time, out)
  }

  private startCall(
    callId: string,
    update: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
  ): void {
    const open = this.ensureStep(time, out)
    const { name, canonical } = toolNameOf(update)
    const args = toolArgsOf(update)
    const argsRaw = args?.argsRaw ?? '{}'
    const block: ContentBlock = { type: 'tool-call', name, arguments: argsRaw, callId }
    open.blocks.push(block)
    open.callIds.add(callId)
    // A tool call ends the model's generation (the same rule the trajectory
    // adapter applies), so the step is sealed: the next chunk opens a new one.
    open.sealed = true
    if (time > open.lastTime) open.lastTime = time
    const info: CallInfo = {
      callId,
      name,
      canonical,
      argsRaw,
      canonicalArgs: args?.canonical === true,
      kind: kindOf(update),
      paths: pathsOf(update),
      promptId: this.promptId,
      block,
      bound: false,
      description: descriptionOf(argsRaw),
    }
    this.remember(callId, info)
    if (isGrokTaskTool(name)) this.rememberTask(info)
    this.notePlanMode(name, time, out)
  }

  /**
   * Merge a later identity into a running call (unit trap 4). The canonical
   * `x.ai/tool` envelope usually lands on the first `tool_call_update`, after
   * the `tool_call` announced the call under its display title, so the buffered
   * block is rewritten in place — which is only legal while its step is still
   * unflushed (`info.block` is nulled the moment it folds).
   */
  private mergeCall(
    callId: string,
    update: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
  ): void {
    const info = this.calls.get(callId)
    if (info === undefined) return
    const { name, canonical } = toolNameOf(update)
    if (canonical && !info.canonical) {
      info.canonical = true
      info.name = name
      if (info.block !== null) info.block.name = name
      if (isGrokTaskTool(name)) this.rememberTask(info)
      this.notePlanMode(name, time, out)
    }
    const args = toolArgsOf(update)
    if (args !== undefined && (args.canonical || !info.canonicalArgs)) {
      if (args.canonical) info.canonicalArgs = true
      info.argsRaw = args.argsRaw
      if (info.block !== null) info.block.arguments = args.argsRaw
      info.description = descriptionOf(args.argsRaw) ?? info.description
    }
    // The real kind arrives with the identity: client tools register as
    // `ToolKind::Other` on the early notification (GROK-FORMAT §C.2).
    const kind = kindOf(update)
    if (kind !== undefined) info.kind = kind
    for (const path of pathsOf(update)) {
      if (!info.paths.includes(path)) info.paths.push(path)
    }
  }

  private onToolCallUpdate(
    update: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
  ): void {
    const callId = asString(update['toolCallId'])
    if (callId === undefined || callId === '') return
    if (this.calls.has(callId)) this.mergeCall(callId, update, time, out)
    // The announcing `tool_call` can be missing from a truncated head.
    else this.startCall(callId, update, time, out)
    const status = asString(update['status'])
    if (status === undefined || !TERMINAL_TOOL_STATUS.has(status)) return
    // Unit trap 5: `status === 'failed'` is grok's only error flag.
    this.emitToolResult(out, callId, update, status === 'failed', time)
  }

  private emitToolResult(
    out: TimelineEvent[],
    callId: string,
    update: Record<string, unknown>,
    isError: boolean,
    time: number,
  ): void {
    // The `tool/call` must fold BEFORE its result: if the call is still
    // buffered in the open step, settle that step first (unit trap 4).
    if (this.open !== null && this.open.callIds.has(callId)) this.flushStep(out, time)
    const info = this.calls.get(callId)
    const ops = info === undefined ? [] : fileOpsOf(info, update)
    this.emitSurface(out, 'tool/result', time, {
      message: {
        content: [{ type: 'tool-result', toolCallId: callId, isError, content: resultBlocks(update) }],
        source: { callId },
      },
      ...(isError ? { error: true } : {}),
      ...(ops.length === 0 ? {} : { fileOps: ops }),
    })
    this.calls.delete(callId)
    this.compactionFresh = false
  }

  private remember(callId: string, info: CallInfo): void {
    this.calls.delete(callId)
    this.calls.set(callId, info)
    if (this.calls.size > CALLS_MAX) {
      const oldest = this.calls.keys().next().value
      if (oldest !== undefined) this.calls.delete(oldest)
    }
  }

  private rememberTask(info: CallInfo): void {
    if (this.taskCalls.includes(info)) return
    this.taskCalls.push(info)
    if (this.taskCalls.length > TASK_CALLS_MAX) this.taskCalls.shift()
  }

  /** Plan mode is expressed as ordinary tool calls (GROK-FORMAT §C.3). */
  private notePlanMode(name: string, time: number, out: TimelineEvent[]): void {
    const active = PLAN_MODE_TOOLS[name]
    if (active === undefined) return
    this.emit(out, 'plan/mode', time, { active })
  }

  // ---------------------------------------------------------------------------
  // Turn completion
  // ---------------------------------------------------------------------------

  private onTurnCompleted(
    update: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
  ): void {
    const usage = update['usage']
    this.addCost(usage)
    // Settle the last model call, then close the turn: the figure this record
    // carries is the SUM over `usage.modelCalls` calls (unit trap 7), so it is
    // apportioned back across every step the turn buffered.
    this.flushStep(out, time)
    this.flushTurn(out, usage, time)
  }

  /**
   * grok's own server-computed cost, in ticks (1e10 ticks = $1, GROK-FORMAT
   * §B.2). The shell SCRUBS `costUsdTicks` whenever the ledger is incomplete
   * (`scrub_untrustworthy_costs`), so a PRESENT figure is a trustworthy one and
   * an ABSENT one means "unknown", never "free": a turn without ticks is
   * skipped, never summed as 0, and `reportedCostUsd` stays absent until at
   * least one turn reported a figure. The two flags are re-checked here anyway
   * — they are the harness's own trust rule, and the transcript is untrusted
   * input.
   */
  private addCost(value: unknown): void {
    if (!isRecord(value)) return
    if (value['usageIsIncomplete'] === true || value['costIsPartial'] === true) return
    const ticks = asNumber(value['costUsdTicks'])
    if (ticks === undefined || ticks <= 0) return
    this.costTicks = (this.costTicks ?? 0) + ticks
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  /** The only in-band source of the window size (GROK-FORMAT §C.3, §H.3). */
  private onCompactStarted(
    update: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
  ): void {
    // A compaction cuts the turn in flight short: release it, booking nothing.
    this.flushStep(out, time)
    this.flushTurn(out, undefined, time)
    const window = asNumber(update['context_window'])
    if (window !== undefined && window > 0) {
      this.recordedWindow = window
      this.emitContext(out, time)
    }
    this.compactArmed = true
    this.compactTokensBefore = asNumber(update['tokens_used']) ?? this.compactTokensBefore
  }

  private onCompactCompleted(
    update: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
  ): void {
    this.flushStep(out, time)
    this.flushTurn(out, undefined, time)
    const before = asNumber(update['tokens_before']) ?? this.compactTokensBefore
    const preview = asString(update['summary_preview'])
    this.compactArmed = false
    this.compactTokensBefore = undefined
    this.emitCompaction(out, time, before, preview === undefined || preview.trim() === '' ? '' : preview)
  }

  /**
   * `compaction_checkpoint` is PERSIST-ONLY: it records that a compaction
   * happened, without a summary (the compacted history goes to
   * `compaction_checkpoints/<id>.json`). It is the only marker a manual
   * `/compact` leaves, so it claims the surface too — but it is written for the
   * SAME event as the `auto_compact_*` pair, so a checkpoint that lands while a
   * compaction is in flight, or while the last one is still the newest thing on
   * the surface, is that pair's own marker and is skipped.
   */
  private onCompactionCheckpoint(time: number, out: TimelineEvent[]): void {
    if (this.compactArmed || this.compactionFresh) return
    this.flushStep(out, time)
    this.flushTurn(out, undefined, time)
    this.emitCompaction(out, time, undefined, '')
  }

  /**
   * A grok compaction replaces the WHOLE conversation: unlike Kimi there is no
   * kept tail (`compacted_history` is rebuilt from the checkpoint file), so the
   * claim covers every live seq.
   *
   * The `compaction/summary` event only ARMS the fold's shadow claim —
   * `fold.ts` consumes it in `applySurface`, so the shadowed nodes leave the
   * surface only when the NEXT surface event carries a `replace` op. The
   * summary message therefore carries that op, exactly as the Kimi synthesizer
   * does; without it the composition would log the boundary while still showing
   * the compacted context at full price.
   */
  private emitCompaction(
    out: TimelineEvent[],
    time: number,
    tokensBefore: number | undefined,
    summary: string,
  ): void {
    const shadowed = [...this.liveSeqs]
    this.emit(out, 'compaction/summary', time, {
      shadowedSeqs: shadowed,
      ...(tokensBefore === undefined ? {} : { shadowedTokenCount: tokensBefore }),
    })
    this.liveSeqs = []
    this.humanSeqs = []
    const op = shadowed.length === 0
      ? undefined
      : { op: 'replace', startSeq: Math.min(...shadowed), endSeq: Math.max(...shadowed) }
    this.emitSurface(out, 'user/message', time, {
      content: summary === '' ? [] : [{ type: 'text', text: summary }],
      source: { kind: 'plugin', form: 'compaction', plugin: 'compaction' } satisfies MessageSource,
    }, op)
    this.compactionFresh = true
  }

  // ---------------------------------------------------------------------------
  // Children
  // ---------------------------------------------------------------------------

  /**
   * `subagent_spawned` names the child by `subagent_id`, which IS the child
   * session id and the child file's `id` — so `AgentSpawn.key` needs no
   * transform and `childKeyOf` needs no grok branch.
   */
  private onSubagentSpawned(update: Record<string, unknown>, time: number): void {
    const agentId = asString(update['subagent_id'])
    if (agentId === undefined || agentId === '') return
    const description = asString(update['description'])
    const agentType = asString(update['subagent_type'])
    const existing = this.children.get(agentId)
    const call = existing?.callId === undefined ? this.bindTaskCall(description) : undefined
    if (call !== undefined) call.bound = true
    const callId = existing?.callId ?? call?.callId
    this.children.set(agentId, {
      key: agentId,
      label: titleFrom(description ?? 'subagent', LABEL_MAX),
      ...(agentType === undefined ? {} : { agentType }),
      ...(callId === undefined ? {} : { callId }),
      startedAt: existing?.startedAt ?? time,
      ...(existing?.completedAt === undefined ? {} : { completedAt: existing.completedAt }),
    })
  }

  /**
   * Pick the task-tool call a `subagent_spawned` belongs to. Grok records NO
   * tool-call id on the spawn path — grepping `tool_call_id` across the
   * subagent and task crates returns zero hits (GROK-FORMAT §D.4) — so the join
   * is a heuristic: the most recent UNBOUND task call of the same `promptId`,
   * preferring one whose `description` argument matches when a turn spawned
   * several, and falling back to the most recent unbound task call anywhere.
   * The same rule the trajectory adapter applies, so both views draw the same
   * parent→child edge.
   */
  private bindTaskCall(description: string | undefined): CallInfo | undefined {
    const pool = this.taskCalls.filter(call => !call.bound)
    if (pool.length === 0) return undefined
    const sameTurn = this.promptId === undefined
      ? []
      : pool.filter(call => call.promptId === this.promptId)
    const scope = sameTurn.length > 0 ? sameTurn : pool
    const named = description === undefined || description === ''
      ? []
      : scope.filter(call => call.description === description)
    const pick = named.length > 0 ? named : scope
    return pick[pick.length - 1]
  }

  private onSubagentFinished(update: Record<string, unknown>, time: number): void {
    const agentId = asString(update['subagent_id'])
    if (agentId === undefined || agentId === '') return
    const child = this.children.get(agentId)
    if (child === undefined) return
    this.children.set(agentId, { ...child, completedAt: time })
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/**
 * The catalog spelling of a model id: `usage.json` and
 * `turn_completed.usage.modelUsage` key the same model `grok-4.6-build` while
 * the catalog (and models.dev) spell it `grok-4.6` (GROK-FORMAT §H.2). See
 * `setModel` for why the strip happens here rather than at lookup time.
 */
function catalogModel(id: string | undefined): string | undefined {
  if (id === undefined || id === '') return undefined
  return id.endsWith('-build') ? id.slice(0, -'-build'.length) : id
}

/**
 * The fold source of an injected `user_message_chunk`. `hostTurn` is a
 * host-injected turn (a relay), and a chunk with no `promptIndex` and no flags
 * is the environment preamble every session opens with — context, not a prompt
 * (GROK-FORMAT §F.4).
 */
function sourceOfInjection(name: 'hostTurn' | 'preamble'): MessageSource {
  return name === 'hostTurn'
    ? { kind: 'host-turn', form: 'relay' }
    : { kind: 'preamble', form: 'context' }
}

/** One ACP `ContentBlock` OBJECT (not an array, GROK-FORMAT §C.2) into fold blocks. */
function blocksOfChunk(content: Record<string, unknown>, text: string | undefined): ContentBlock[] {
  if (asString(content['type']) === 'image') return [{ type: 'image' }]
  const resolved = text ?? asString(content['text'])
  return resolved === undefined ? [] : [{ type: 'text', text: resolved }]
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
 * title, else the ACP kind, else `'tool'` — the pager's own resolution order
 * (GROK-FORMAT §C.2).
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
 * tool records carry it), else the internal `rawInput` shape.
 */
function toolArgsOf(update: Record<string, unknown>): { argsRaw: string; canonical: boolean } | undefined {
  const input = toolIdentity(update)?.['input']
  if (input !== undefined) return { argsRaw: jsonOrEmpty(input), canonical: true }
  const raw = update['rawInput']
  if (raw !== undefined) return { argsRaw: jsonOrEmpty(raw), canonical: false }
  return undefined
}

/** The canonical tool kind, else the ACP `ToolCall.kind` (GROK-FORMAT §C.2). */
function kindOf(update: Record<string, unknown>): string | undefined {
  const canonical = asString(toolIdentity(update)?.['kind'])
  if (canonical !== undefined && canonical !== '') return canonical
  const kind = asString(update['kind'])
  return kind === undefined || kind === '' ? undefined : kind
}

/** `locations[].path` — the files a call touched. */
function pathsOf(update: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const item of asArray(update['locations']) ?? []) {
    if (!isRecord(item)) continue
    const path = asString(item['path'])
    if (path !== undefined && path !== '' && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/** The `description` argument of a call, which disambiguates two spawns in one turn. */
function descriptionOf(argsRaw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return isRecord(parsed) ? asString(parsed['description']) : undefined
  } catch {
    return undefined
  }
}

/**
 * The tool result's content blocks. ACP `ToolCallContent` comes in two shapes
 * (GROK-FORMAT §C.2): `content` (whose payload nests under `content.content`)
 * and `diff` (a before/after pair). A diff is rendered the way the trajectory
 * adapter renders it, so both views size the same text.
 */
function resultBlocks(update: Record<string, unknown>): ContentBlock[] {
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
      blocks.push({ type: 'image' })
      continue
    }
    const text = asString(inner['text'])
    if (text !== undefined) blocks.push({ type: 'text', text })
  }
  return blocks
}

/**
 * File operations, read off the RESULT rather than the call arguments — grok is
 * the one harness of the four that reports them structurally: `locations[].path`
 * names the files a call touched and a `diff` content block carries the exact
 * before/after text (GROK-FORMAT §C.2). Line deltas are therefore real counts,
 * not the argument-derived estimates Kimi has to settle for.
 *
 * Only `kind ∈ {read, edit}` books a row (GROK-DESIGN §6). `execute`, `search`,
 * `fetch`, `think` and `other` name no file identity that survives the
 * normalization: a `search`'s `locations` is the scanned ROOT rather than the
 * files read, and booking it would put a directory in the File Activity table.
 */
function fileOpsOf(info: CallInfo, update: Record<string, unknown>): FileOpInput[] {
  const diffs: FileOpInput[] = []
  for (const item of asArray(update['content']) ?? []) {
    if (!isRecord(item) || asString(item['type']) !== 'diff') continue
    const path = asString(item['path'])
    if (path === undefined || path === '') continue
    diffs.push({
      kind: 'write',
      path,
      added: lineCount(asString(item['newText']) ?? ''),
      removed: lineCount(asString(item['oldText']) ?? ''),
    })
  }
  if (diffs.length > 0) return diffs
  if (info.kind !== 'read' && info.kind !== 'edit') return []
  const kind = info.kind === 'read' ? 'read' as const : 'write' as const
  return info.paths.map(path => ({ kind, path }))
}

function lineCount(text: string): number {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

/**
 * `turn_completed.usage` (`PromptUsage`, flattened) onto the fold's DISJOINT
 * buckets (GROK-DESIGN §6, GROK-FORMAT §B.2):
 *
 *   cacheReadTokens  = cachedReadTokens
 *   cacheWriteTokens = cacheCreationTokens
 *   inputTokens      = inputTokens − cachedReadTokens − cacheCreationTokens
 *   outputTokens     = outputTokens
 *
 * The wire's `inputTokens` is the FULL prompt input including the cache reads
 * ("ACP identity"), and `cacheCreationTokens` is folded into it too, so both are
 * subtracted out and the remainder is clamped at 0. `reasoningTokens` is a
 * SUBSET of `outputTokens` and is never added. `totalTokens` (input + output
 * only) is not a bucket the fold keeps.
 */
function usageOf(value: unknown): GrokUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value['inputTokens'])
  const cacheRead = asNumber(value['cachedReadTokens'])
  const cacheWrite = asNumber(value['cacheCreationTokens'])
  const output = asNumber(value['outputTokens'])
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined && output === undefined) {
    return undefined
  }
  return {
    inputTokens: Math.max(0, (input ?? 0) - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    cacheReadTokens: Math.max(0, cacheRead ?? 0),
    cacheWriteTokens: Math.max(0, cacheWrite ?? 0),
    outputTokens: Math.max(0, output ?? 0),
  }
}

/**
 * One model call's own `ResponseUsage` (`response_completed`), onto the fold's
 * buckets. snake_case is the wire spelling (the Rust struct declares no
 * `rename_all`); the camelCase twin is accepted in case a future build renames
 * it. `input_tokens` is already the UNCACHED portion here — unlike
 * `PromptUsage.inputTokens`, which includes both cache shares (unit trap 6).
 */
function responseUsageOf(value: unknown): GrokUsage | undefined {
  if (!isRecord(value)) return undefined
  const pick = (snake: string, camel: string): number | undefined =>
    asNumber(value[snake]) ?? asNumber(value[camel])
  const input = pick('input_tokens', 'inputTokens')
  const output = pick('output_tokens', 'outputTokens')
  const cacheRead = pick('cache_read_input_tokens', 'cacheReadInputTokens')
  const cacheWrite = pick('cache_creation_input_tokens', 'cacheCreationInputTokens')
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined
  }
  return {
    inputTokens: Math.max(0, input ?? 0),
    cacheReadTokens: Math.max(0, cacheRead ?? 0),
    cacheWriteTokens: Math.max(0, cacheWrite ?? 0),
    outputTokens: Math.max(0, output ?? 0),
  }
}

/** Characters a step emitted: the text it wrote plus the arguments it called tools with. */
function charsOf(blocks: readonly ContentBlock[]): number {
  let total = 0
  for (const block of blocks) total += (block.text?.length ?? 0) + (block.arguments?.length ?? 0)
  return total
}

/**
 * Split `total` across `weights`, exactly: every share is a non-negative
 * integer, they sum to `total`, and the rounding remainder lands on the LAST
 * share. A zero (or absent) weight vector splits evenly.
 */
function splitTotal(total: number, weights: readonly number[]): number[] {
  const count = weights.length
  if (count === 0) return []
  if (total <= 0) return weights.map(() => 0)
  const sum = weights.reduce((a, b) => a + b, 0)
  const basis = sum > 0 ? weights : weights.map(() => 1)
  const denominator = sum > 0 ? sum : count
  const shares = basis.map(weight => Math.floor((total * weight) / denominator))
  const assigned = shares.reduce((a, b) => a + b, 0)
  shares[count - 1] = (shares[count - 1] ?? 0) + (total - assigned)
  return shares
}

/**
 * Force `values` to sum to `total` by adjusting from the END, never below zero.
 * This is what keeps COST exact: whatever the apportionment rounds or clamps,
 * the per-step usage still sums to the turn's own figure in every field.
 */
function reconcileTotal(values: number[], total: number): void {
  let diff = total - values.reduce((a, b) => a + b, 0)
  for (let index = values.length - 1; index >= 0 && diff !== 0; index--) {
    const current = values[index] ?? 0
    const next = Math.max(0, current + diff)
    diff -= next - current
    values[index] = next
  }
}

/**
 * Apportion one `turn_completed.usage` across the model calls of its turn
 * (unit trap 7).
 *
 * Steps are grouped into model CALLS first: consecutive steps that share a
 * `streamStartMs` came from one request (grok emits parallel tool calls, and a
 * transcript can also resume chunking after a tool call), so the group takes one
 * share and the group's LAST step carries it — the earlier ones get `undefined`
 * and book nothing, exactly as a step that is not a request should.
 *
 * Per group:
 *   promptSize = the first `_meta.totalTokens` on that call's stream (the real
 *                prompt the request went out with), or an even split when the
 *                transcript stamped none;
 *   cacheRead / cacheWrite = the turn's totals split on promptSize;
 *   input      = promptSize − cacheRead − cacheWrite, clamped at 0;
 *   output     = the turn's total split on the characters the group emitted.
 *
 * A group whose own `response_completed` reported `exact` usage keeps it
 * verbatim and only the REMAINDER is apportioned over the rest. Every field is
 * finally reconciled against the turn total, so `Σ shares === turn usage`
 * always holds — the cost rollup is unchanged by this function.
 */
export function apportionTurnUsage(
  steps: readonly TurnStepUsageInput[],
  turn: GrokUsage,
): (GrokUsage | undefined)[] {
  const shares: (GrokUsage | undefined)[] = steps.map(() => undefined)
  if (steps.length === 0) return shares
  // 1. Group consecutive steps of one model call.
  interface Group { last: number; prompt: number | undefined; chars: number; exact: GrokUsage | undefined }
  const groups: Group[] = []
  steps.forEach((step, index) => {
    const previous = groups[groups.length - 1]
    const merge = previous !== undefined
      && step.stream !== undefined
      && steps[previous.last]?.stream === step.stream
    if (merge && previous !== undefined) {
      previous.last = index
      previous.chars += step.chars
      previous.prompt = previous.prompt === undefined
        ? step.prompt
        : (step.prompt === undefined ? previous.prompt : Math.min(previous.prompt, step.prompt))
      previous.exact = previous.exact ?? step.exact
      return
    }
    groups.push({ last: index, prompt: step.prompt, chars: step.chars, exact: step.exact })
  })
  // 2. A call that reported its own usage keeps it; only the rest is apportioned.
  const rest: GrokUsage = { ...turn }
  for (const group of groups) {
    if (group.exact === undefined) continue
    rest.inputTokens = Math.max(0, rest.inputTokens - group.exact.inputTokens)
    rest.cacheReadTokens = Math.max(0, rest.cacheReadTokens - group.exact.cacheReadTokens)
    rest.cacheWriteTokens = Math.max(0, rest.cacheWriteTokens - group.exact.cacheWriteTokens)
    rest.outputTokens = Math.max(0, rest.outputTokens - group.exact.outputTokens)
  }
  const open = groups.filter(group => group.exact === undefined)
  // 3. Prompt weights: the stamped call sizes, with an unstamped call taking the
  //    average of the stamped ones (an even split when none was stamped at all).
  const stamped = open.filter(group => group.prompt !== undefined).map(group => group.prompt ?? 0)
  const average = stamped.length === 0 ? 0 : stamped.reduce((a, b) => a + b, 0) / stamped.length
  const weights = open.map(group => group.prompt ?? average)
  const promptTotal = rest.inputTokens + rest.cacheReadTokens + rest.cacheWriteTokens
  const prompts = splitTotal(promptTotal, weights)
  const cacheReads = splitTotal(rest.cacheReadTokens, weights)
  const cacheWrites = splitTotal(rest.cacheWriteTokens, weights)
  const outputs = splitTotal(rest.outputTokens, open.map(group => group.chars))
  const inputs = open.map((_, index) =>
    Math.max(0, (prompts[index] ?? 0) - (cacheReads[index] ?? 0) - (cacheWrites[index] ?? 0)))
  // 4. Write the shares back and reconcile every bucket against the turn total.
  const assigned = new Map<Group, GrokUsage>()
  open.forEach((group, index) => {
    assigned.set(group, {
      inputTokens: inputs[index] ?? 0,
      cacheReadTokens: cacheReads[index] ?? 0,
      cacheWriteTokens: cacheWrites[index] ?? 0,
      outputTokens: outputs[index] ?? 0,
    })
  })
  const all = groups.map(group => assigned.get(group) ?? { ...(group.exact as GrokUsage) })
  for (const field of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const) {
    const values = all.map(usage => usage[field])
    reconcileTotal(values, turn[field])
    all.forEach((usage, index) => { usage[field] = values[index] ?? 0 })
  }
  groups.forEach((group, index) => { shares[group.last] = all[index] })
  return shares
}

/**
 * The embedded stream the fold reads for this step's first-token instant and
 * its decode split.
 *
 * grok streams live (unit trap 3), so the first `agent_*_chunk`'s own stamp is
 * a real measurement — an upper bound, since the session's debounce window has
 * already elapsed by the time the block is written. What grok does NOT record
 * is per-block timing, so every `block-start` is stamped at that first-token
 * instant and the fold tiles the decode window with zero-length spans for all
 * but the last block — the honest reading of "the blocks are not individually
 * timed", exactly as the Kimi synthesizer does.
 *
 * A step with no chunk at all (a bare tool call) carries no stream: it has no
 * first token to report, and inventing one would fabricate a wait.
 */
function buildStream(step: OpenStep, completed: number): StreamRecord[] {
  const first = step.firstTokenTime
  if (first === undefined || first < step.startedAt || first > completed) return []
  const stream: StreamRecord[] = [
    // The text is a marker only: the fold reads the chunk's INSTANT and needs a
    // non-empty delta to recognize it as a token (`logShapes.isTokenChunk`).
    { type: 'chunk', time: first, chunk: { type: 'text-delta', text: ' ' } },
  ]
  for (const block of step.blocks) {
    const blockType = block.type === 'reasoning'
      ? 'reasoning'
      : block.type === 'tool-call' ? 'tool-call' : 'text'
    stream.push({ type: 'chunk', time: first, chunk: { type: 'block-start', blockType } })
  }
  return stream
}

function jsonOrEmpty(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

export function createGrokSynthesizer(_file: SessionFileRef): EventSynthesizer {
  return new GrokSynthesizer()
}
