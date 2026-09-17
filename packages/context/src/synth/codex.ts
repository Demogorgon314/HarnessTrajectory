/**
 * Codex rollout → fold events.
 *
 * One instance per rollout file (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 * Every line is `{ timestamp, ordinal?, type, payload }`; this module turns that
 * stream into the fold's event vocabulary (`../fold/event.ts`).
 *
 * The mapping was verified structurally against 82 local rollouts (codex-cli
 * 0.14x–0.15x); the load-bearing observations are called out inline as
 * EVIDENCE notes so a future rollout-format change can be re-checked against
 * the same questions.
 *
 * Unit traps (all three verified on real data):
 *   - `event_msg.task_started.started_at` is epoch SECONDS (10 digits),
 *   - `event_msg.item_completed.{started_at,completed_at}_ms` are epoch MS (13 digits),
 *   - the record-level `timestamp` is ISO-8601.
 * `parseTime` from core normalizes all three (it treats a number below 1e12 as
 * seconds), so every instant this file produces is epoch milliseconds.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { asArray, asNumber, asString, codexUserItems, isRecord, parseJsonLine, parseTime } from '@harness-trajectory/core'
import type { ContentBlock, MessageSource, StreamRecord, TimelineEvent } from '../fold/event.ts'
import type { FileOpInput } from '../fold/fold.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'
import { measuredInput, setRequestInput } from './requestInput.ts'
import type { RequestInput } from '../shared/requestInput.ts'

/** Label length cap, matching the Claude synthesizer's session title. */
const LABEL_MAX = 80

/** Codex never names its provider in the rollout beyond `session_meta.model_provider`. */
const DEFAULT_PROVIDER = 'openai'

const EMPTY_CHILDREN: ReadonlyMap<string, AgentSpawn> = new Map()

/**
 * Settled tool calls kept for a late `tool/ops` booking. Codex writes the
 * `item_completed` mirror of a tool call AFTER the call's output line about
 * 12% of the time; the map lets those ops still find their result node.
 */
const SETTLED_CALLS_MAX = 64

/** Response-item types that open a tool call. */
const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call'])
/** Response-item types that settle a tool call. */
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'])

/** One model response being accumulated (Codex logs its blocks as separate lines). */
interface OpenGroup {
  input: RequestInput
  blocks: ContentBlock[]
  /** Completion instant of each block, parallel to `blocks`. */
  blockTimes: number[]
  /** The step instant this group is generating against. */
  stepStart: number
  lastTime: number
  /** Earliest `item_completed.started_at_ms` of a Reasoning/AgentMessage item seen while open. */
  firstTokenAt?: number
  /**
   * `token_count`'s `last_token_usage` — the only usage signal in rollouts
   * that predate `token_usage_record`. A later authoritative record wins.
   */
  fallbackUsage?: Record<string, number> | undefined
}

/** A tool call awaiting its output. */
interface OpenCall {
  callId: string
  name: string
  /** Raw arguments — the late item's command is matched against them. */
  args: string
}

/** A tool call whose `tool/result` already folded (the target of a late `tool/ops`). */
interface SettledCall {
  callId: string
  /** The `tool/result` event's own seq — the fold files late ops under it. */
  resultSeq: number
  name: string
  /** Raw arguments — a late item's command is matched against them. */
  args: string
}

class CodexSynthesizer implements EventSynthesizer {
  readonly kind = 'codex' as const

  constructor(private readonly file: SessionFileRef) {
    // A child file's lineage replays the base's inherited records BEFORE the
    // head's `session_meta` line arrives, so the boundary must be known from
    // the ref up front — `onSessionMeta` still confirms it from the stream.
    this.historyStartOrdinal = file.historyStartOrdinal
  }

  private seq = 0
  private lastTime = 0

  // ---- meta -----------------------------------------------------------------
  private model: string | undefined
  private provider = DEFAULT_PROVIDER
  private contextWindow: number | undefined
  /** task_started can report the next route's window before turn_context names its model. */
  private windowAwaitingModel = false
  private label: string | undefined
  /** Label for a thread with no human prompt of its own (a subagent thread). */
  private fallbackLabel: string | undefined
  private version: string | undefined

  // ---- turn / step ----------------------------------------------------------
  private turn = 0
  /** Display ids of user turns still present after any prior rollback. */
  private readonly activeTurns: number[] = []
  private step = 0
  private turnOpen = false
  private stepOpen = false
  /** Instant the open step was armed at (the fold's `stepStart`). */
  private stepStartTime = 0
  /** Instant of the last thing the model consumed (prompt, injection, tool output). */
  private lastInputTime = 0
  private group: OpenGroup | null = null
  /** Tool calls of the current step still waiting for their output. */
  private awaitingResults = 0
  /** Self-contained calls (web_search/image_generation) whose result already folded. */
  private readonly earlySettled = new Set<string>()
  /**
   * `token_usage_record`s that settled no open response — remote compaction's
   * usage-only answer — keyed by `response_id` for `compaction_response_id`.
   */
  private readonly unclaimedUsage = new Map<string, Record<string, number>>()

  // ---- header ---------------------------------------------------------------
  private systemText: string | undefined
  private tools: unknown[] = []
  /** `session_meta` was read but its header is not emitted yet (see `flushHeader`). */
  private headerPending = false

  // ---- tool pairing ---------------------------------------------------------
  /**
   * Calls awaiting their output. Codex streams parallel calls' items and
   * completions interleaved, so a single "open call" slot would file a late
   * CommandExecution/FileChange under whichever call opened LAST.
   */
  private readonly openCalls = new Map<string, OpenCall>()
  private readonly pendingOps = new Map<string, FileOpInput[]>()
  private readonly failedCalls = new Set<string>()
  /** Recently settled calls, oldest first, capped at SETTLED_CALLS_MAX. */
  private readonly settledCalls = new Map<string, SettledCall>()
  private lastSettled: SettledCall | null = null
  /**
   * Results settled since the last tool call opened. Exactly 1 means the most
   * recently settled call is the only candidate a late `item_completed` can
   * belong to; more means the pairing is ambiguous (parallel calls) and the
   * ops are dropped rather than misfiled.
   */
  private settledSinceOpen = 0
  /** Diagnostic tally: late file-op batches dropped because the call was ambiguous. */
  private ambiguousLateOps = 0

  // ---- surface bookkeeping --------------------------------------------------
  /** Live surface nodes (user/tool/assistant) with the turn each was emitted under. */
  private liveSeqs: { seq: number; turn: number }[] = []
  /** Context occupancy of the latest response (its `input_tokens`), for the compaction claim. */
  private lastContextTokens: number | undefined

  // ---- injections -----------------------------------------------------------
  private developerInstructions: string | undefined
  private sawDeveloperMessage = false
  private readonly worldStateSized = new Set<string>()
  /**
   * A child thread's `session_meta.subagent_history_start_ordinal`: records
   * below it are the parent's history materialized into the file, not the
   * child's own activity (thread_history_materialization.rs).
   */
  private historyStartOrdinal: number | undefined

  push(line: string): readonly TimelineEvent[] {
    const out: TimelineEvent[] = []
    try {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return out
      const type = asString(record['type'])
      if (type === undefined) return out
      const time = parseTime(record['timestamp']) ?? this.lastTime
      if (time > this.lastTime) this.lastTime = time
      const payload = isRecord(record['payload']) ? record['payload'] : {}
      if (type === 'session_meta' && this.historyStartOrdinal !== undefined
        && asString(payload['id']) !== this.file.id) return out
      if (type !== 'session_meta' && this.historyStartOrdinal !== undefined) {
        const ordinal = asNumber(record['ordinal'])
        if (ordinal !== undefined && ordinal < this.historyStartOrdinal) {
          this.onInheritedRecord(type, payload, time, out)
          return out
        }
      }
      switch (type) {
        case 'session_meta': this.onSessionMeta(payload, time); break
        case 'turn_context': this.onTurnContext(payload, time, out); break
        case 'event_msg': this.onEventMsg(payload, time, out); break
        case 'response_item': this.onResponseItem(payload, time, out); break
        case 'token_usage_record': this.onTokenUsage(payload, time, out); break
        case 'compacted': this.onCompacted(payload, time, out); break
        case 'world_state': this.onWorldState(payload, time, out); break
        case 'inter_agent_communication':
          this.onAgentMessage(interAgentText(payload), agentRoute(payload), time, out)
          break
        case 'retained_context': this.onRetainedContext(payload, time, out); break
        default: break
      }
    } catch {
      // The transcript is untrusted input: a malformed record yields whatever
      // events were already produced for this line and never throws.
    }
    return out
  }

  meta(): SynthMeta {
    const label = this.label ?? this.fallbackLabel
    return {
      ...(this.model === undefined ? {} : { model: this.model }),
      provider: this.provider,
      ...(this.contextWindow === undefined ? {} : { contextWindow: this.contextWindow }),
      ...(label === undefined ? {} : { label }),
      running: this.turnOpen,
      children: EMPTY_CHILDREN,
      ...(this.version === undefined ? {} : { version: this.version }),
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
  ): number {
    const seq = (this.seq += 1)
    out.push({
      type,
      seq,
      time,
      ...(data === undefined ? {} : { data }),
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    })
    return seq
  }

  /** Emit a surface-bearing event and remember its seq for the next compaction claim. */
  private emitSurface(
    out: TimelineEvent[],
    type: string,
    time: number,
    data: Record<string, unknown>,
    surfaceOp?: unknown,
  ): number {
    const seq = this.emit(out, type, time, data, surfaceOp)
    this.liveSeqs.push({ seq, turn: this.turn })
    return seq
  }

  // ---------------------------------------------------------------------------
  // session_meta / header
  // ---------------------------------------------------------------------------

  /** Inherited model content is replayed without adopting the parent's activity. */
  private onInheritedRecord(type: string, payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    if (type === 'compacted') {
      this.onCompacted(payload, time, out)
      return
    }
    if (type !== 'response_item' && type !== 'inter_agent_communication') return
    const itemType = asString(payload['type'])
    let eventType = 'user/message'
    let content: ContentBlock[] = []
    let source: MessageSource = { kind: 'inherited', form: 'context' }
    if (type === 'inter_agent_communication' || itemType === 'agent_message') {
      const text = type === 'inter_agent_communication' ? interAgentText(payload) : agentMessageText(payload)
      content = [{ type: 'text', text }]
      source = { kind: 'agent-message', form: 'relay' }
    } else if (itemType === 'message') {
      const role = asString(payload['role'])
      content = contentBlocksOf(asArray(payload['content']) ?? [])
      if (role === 'assistant') eventType = 'assistant/message'
      else if (role === 'user') {
        // Preserve human versus injected content categories without counting
        // either as a new input; mixed messages use the shared classifier.
        for (const part of codexUserItems(payload)) {
          const source: MessageSource = part.human
            ? { kind: 'user' } : { kind: part.label ?? 'context', form: 'context' }
          this.emitSurface(out, 'user/message', time, {
            content: contentBlocksOf([part.item]), source, replay: true,
          })
        }
        return
      }
      else if (role !== 'developer') return
    } else if (itemType === 'reasoning') {
      eventType = 'assistant/message'
      content = [{ type: 'reasoning', text: (asArray(payload['summary']) ?? [])
        .flatMap(item => isRecord(item) ? [asString(item['text']) ?? ''] : []).join('\n\n') }]
    } else if (itemType !== undefined && (CALL_TYPES.has(itemType) || itemType === 'web_search_call' || itemType === 'image_generation_call')) {
      eventType = 'assistant/message'
      const { name, args } = toolCallContent(payload, itemType)
      content = [{ type: 'tool-call', name, arguments: args }]
      if (itemType === 'image_generation_call' && asString(payload['result'])) {
        content.push({ type: 'image' })
      }
    } else if (itemType !== undefined && (OUTPUT_TYPES.has(itemType) || itemType === 'tool_search_output')) {
      eventType = 'tool/result'
      const tools = itemType === 'tool_search_output' ? asArray(payload['tools']) : undefined
      content = toolOutputContent(payload['output'], tools)
    } else return
    // No call ids, tool/call events, usage, timing or human-input bookkeeping
    // are imported. These are copies on the child's initial model surface.
    this.emitSurface(out, eventType, time, eventType === 'user/message'
      ? { content, source, replay: true }
      : { message: { content }, replay: true })
  }

  private onSessionMeta(payload: Record<string, unknown>, _time: number): void {
    this.version = asString(payload['cli_version']) ?? this.version
    // Persisted as a stringified number (`"24"`) in current rollouts.
    const rawStart = payload['subagent_history_start_ordinal']
    const start = asNumber(rawStart) ?? (typeof rawStart === 'string' ? asNumber(Number(rawStart)) : undefined)
    if (start !== undefined) this.historyStartOrdinal = start
    const provider = asString(payload['model_provider'])
    if (provider !== undefined && provider !== '') this.provider = provider
    const instructions = payload['base_instructions']
    const text = isRecord(instructions) ? asString(instructions['text']) : asString(instructions)
    if (text !== undefined && text !== '') this.systemText = text
    // `dynamic_tools` holds the session's dynamic tool specs. Canonical wire
    // shape (protocol/dynamic_tools.rs): each entry is `{"type":"function"}`
    // or `{"type":"namespace", tools: [{"type":"function"}]}`; a legacy flat
    // `{name, inputSchema, namespace?}` list also occurs. Normalized here to
    // one flat list of function specs, each stamped with its `namespace` so
    // same-named tools in different namespaces stay distinct.
    const dynamicTools = normalizeDynamicTools(asArray(payload['dynamic_tools']))
    if (dynamicTools.length > 0) this.tools = dynamicTools
    // A subagent / guardian thread has no human prompt of its own (verified:
    // the first message of all 13 sampled child rollouts is a `developer` one),
    // so the Agent Network would show it unlabelled. `session_meta.source`
    // names it — the same fallback the trajectory adapter's `subagentLabel` uses.
    const source = payload['source']
    if (asString(payload['parent_thread_id']) !== undefined
      || (isRecord(source) && source['subagent'] !== undefined)) {
      this.fallbackLabel = subagentLabelOf(payload)
    }
    this.headerPending = true
  }

  /**
   * Emit the opening `request/header`.
   *
   * Deferred on purpose: `session_meta` carries the base instructions but NOT
   * the model (that lands on the first `turn_context`, usually 1–6 records
   * later). Emitting at `session_meta` would either publish a model-less epoch
   * and then a second one, or leave `lastModel` unset in the fold so the FIRST
   * model switch of the session logs no event. Deferring to the first model
   * sighting — or to the first model response, whichever comes first — gives
   * exactly one initial epoch that already names the model.
   */
  private flushHeader(out: TimelineEvent[], time: number): void {
    if (!this.headerPending) return
    this.headerPending = false
    this.emit(out, 'request/header', time, {
      // `config` rides INSIDE `header` — that is where the fold reads the
      // request's model/provider from (see fold/event.ts).
      header: {
        ...(this.systemText === undefined ? {} : { system: this.systemText }),
        tools: this.tools,
        config: {
          ...(this.model === undefined ? {} : { model: this.model }),
          provider: this.provider,
        },
      },
      reason: 'initial',
    })
  }

  /**
   * Register a model sighting. The first one flushes the deferred opening
   * header; a later DIFFERENT model is a `reason:'change'` header whose
   * `system`/`tools` are repeated because the fold clears header-sourced
   * fields a sparse header doesn't carry.
   */
  private noteModel(model: string, time: number, out: TimelineEvent[]): void {
    if (this.headerPending) {
      this.model = model
      this.flushHeader(out, time)
      this.windowAwaitingModel = false
      return
    }
    if (this.model === model) {
      this.windowAwaitingModel = false
      return
    }
    this.closeGroup(out, time, undefined)
    if (!this.windowAwaitingModel) this.contextWindow = undefined
    this.windowAwaitingModel = false
    this.model = model
    this.emit(out, 'request/header', time, {
      header: {
        ...(this.systemText === undefined ? {} : { system: this.systemText }),
        tools: this.tools,
        config: { model, provider: this.provider },
      },
      reason: 'change',
    })
    if (this.contextWindow !== undefined) {
      this.emit(out, 'request/context', time, { model, contextWindow: this.contextWindow, provider: this.provider })
    }
  }

  private onTurnContext(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const model = asString(payload['model'])
    if (model !== undefined && model !== '') this.noteModel(model, time, out)
    const mode = payload['collaboration_mode']
    const settings = isRecord(mode) ? mode['settings'] : undefined
    const instructions = isRecord(settings) ? asString(settings['developer_instructions']) : undefined
    if (instructions !== undefined && instructions !== '' && instructions !== this.developerInstructions) {
      this.developerInstructions = instructions
      this.emitSurface(out, 'user/message', time, {
        content: [{ type: 'text', text: instructions }],
        source: { kind: 'developer-instructions', form: 'context' } satisfies MessageSource,
      })
      this.lastInputTime = time
    }
  }

  // ---------------------------------------------------------------------------
  // event_msg
  // ---------------------------------------------------------------------------

  private onEventMsg(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    switch (asString(payload['type'])) {
      case 'task_started': {
        this.closeGroup(out, time, undefined)
        this.closeStep(out, time)
        this.turn += 1
        this.step = 0
        this.turnOpen = true
        const started = parseTime(payload['started_at']) ?? time
        this.lastInputTime = started
        this.openStep(out, started)
        this.applyContextWindow(out, asNumber(payload['model_context_window']), started)
        this.windowAwaitingModel = (asNumber(payload['model_context_window']) ?? 0) > 0
        return
      }
      case 'task_complete':
      case 'turn_aborted': {
        this.closeGroup(out, time, undefined)
        this.closeStep(out, time)
        this.turnOpen = false
        return
      }
      case 'token_count': {
        const info = payload['info']
        if (isRecord(info)) {
          this.applyContextWindow(out, asNumber(info['model_context_window']), time)
          // Old rollouts record no `token_usage_record`; `last_token_usage` is
          // their only per-response accounting. The record mirrors the response
          // that just streamed, so it prices the open group — later sightings
          // describe newer partial responses and replace the earlier figure.
          const usage = usageOf(info['last_token_usage'])
          if (usage !== undefined && this.group !== null) {
            this.group.fallbackUsage = usage
            const raw = info['last_token_usage']
            this.group.input = { ...this.group.input, ...measuredInput(isRecord(raw) ? raw['input_tokens'] : undefined, this.model) }
            this.lastContextTokens = contextTokensOf(info['last_token_usage']) ?? this.lastContextTokens
          }
        }
        return
      }
      case 'item_completed': {
        this.onItemCompleted(payload, time, out)
        return
      }
      case 'thread_rolled_back': {
        this.onThreadRolledBack(payload, time, out)
        return
      }
      case 'thread_settings_applied': {
        // Durable settings snapshot; a model switch inside it is the same
        // attribution change `turn_context` drives.
        const settings = payload['thread_settings']
        if (!isRecord(settings)) return
        const model = asString(settings['model'])
        if (model !== undefined && model !== '') this.noteModel(model, time, out)
        return
      }
      case 'thread_goal_updated': {
        const goal = payload['goal']
        const objective = isRecord(goal) ? asString(goal['objective']) : undefined
        if (objective === undefined || objective === '') return
        this.emitSurface(out, 'user/message', time, {
          content: [{ type: 'text', text: objective }],
          source: { kind: 'thread-goal', form: 'notice' } satisfies MessageSource,
        })
        this.lastInputTime = time
        return
      }
      default:
        return
    }
  }

  /**
   * `thread_rolled_back` is a legacy marker that drops the LAST N user turns
   * from model context (thread_rollout_truncation.rs). The fold equivalent is
   * a `compaction/prune` claim covering the surface nodes of those turns,
   * consumed by a marker node that replaces them. Turn-0 nodes (pre-turn
   * injections like base instructions) are never user turns — always kept.
   */
  private onThreadRolledBack(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const numTurns = asNumber(payload['num_turns']) ?? 0
    if (numTurns <= 0) return
    this.closeGroup(out, time, undefined)
    this.closeStep(out, time)
    this.turnOpen = false
    const removed = new Set(this.activeTurns.splice(Math.max(0, this.activeTurns.length - Math.floor(numTurns))))
    const shadowed = this.liveSeqs
      .filter(entry => removed.has(entry.turn))
      .map(entry => entry.seq)
    this.liveSeqs = this.liveSeqs.filter(entry => !removed.has(entry.turn))
    this.emit(out, 'compaction/prune', time, { shadowedSeqs: shadowed })
    this.emit(out, 'user/message', time, {
      content: [],
      source: { kind: 'rollback', form: 'notice', summary: `Rolled back ${numTurns} turn${numTurns === 1 ? '' : 's'}` } satisfies MessageSource,
    }, shadowed.length === 0
      ? undefined
      : { op: 'replace', startSeq: Math.min(...shadowed), endSeq: Math.max(...shadowed) })
    this.lastInputTime = time
  }

  private applyContextWindow(out: TimelineEvent[], window: number | undefined, time: number): void {
    if (window === undefined || window <= 0 || window === this.contextWindow) return
    this.contextWindow = window
    if (this.group !== null) this.group.input.window = { tokens: window, source: 'recorded', kind: 'usable' }
    this.emit(out, 'request/context', time, {
      contextWindow: window,
      ...(this.model === undefined ? {} : { model: this.model }),
      provider: this.provider,
    })
  }

  /**
   * `item_completed` is the UI-facing mirror of a response item; the two
   * interesting kinds carry the file activity a bare `exec` call cannot show.
   *
   * EVIDENCE (82 rollouts, 12 015 CommandExecution/FileChange items):
   *   - `item.id` NEVER equals the matching `function_call`/`custom_tool_call`
   *     `call_id`, nor the call's own `response_item.id` (item ids are a
   *     41-char `xxxx-<uuid>`; call ids are `call_<24 hex>`). Only `McpToolCall`
   *     ids are call ids (1084 of 1465). So the design's preferred id match is
   *     NOT available for CommandExecution/FileChange.
   *   - Positionally the item lands BETWEEN its call and the call's output in
   *     10 615 of 12 015 cases, and in EVERY one of those exactly ONE tool call
   *     was open. Pairing therefore keys off the open call, not the item id.
   *   - The remaining 1 400 arrive AFTER the output (almost always
   *     `output, token_count, item_completed`). The `tool/result` that would
   *     carry them has already folded, so they ride a LATE `tool/ops` event
   *     naming that result's seq instead (see `lateOps`). In the sample corpus
   *     every one of those 1 400 was a CommandExecution whose only `parsed_cmd`
   *     was `unknown` — i.e. no file op to lose — so the late path is currently
   *     dormant there. It is kept because "the item is written late" and "the
   *     command was classifiable" are independent properties of a build.
   */
  private onItemCompleted(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const item = payload['item']
    if (!isRecord(item)) return
    const kind = asString(item['type'])
    if (kind === 'Reasoning' || kind === 'AgentMessage') {
      const started = asNumber(payload['started_at_ms'])
      if (started !== undefined && this.group !== null && this.group.firstTokenAt === undefined) {
        this.group.firstTokenAt = started
      }
      return
    }
    if (kind !== 'CommandExecution' && kind !== 'FileChange') return
    const ops = kind === 'CommandExecution' ? opsOfCommand(item) : opsOfFileChange(item)
    const failed = asString(item['status']) === 'failed'
    const attrib = this.attributeItem(item)
    if (attrib !== undefined && 'open' in attrib) {
      if (failed) this.failedCalls.add(attrib.open.callId)
      this.bufferOps(attrib.open.callId, ops)
      return
    }
    if (attrib !== undefined) {
      this.emitLateOps(payload, ops, failed, attrib.settled, time, out)
      return
    }
    if (this.openCalls.size > 0) {
      // Several calls in flight and no verifiable link: keep the activity
      // visible as its own unpaired result instead of filing it under the
      // wrong call.
      this.emitSurface(out, 'tool/result', time, {
        message: {
          content: [{ type: 'text', text: itemLabel(item) }],
        },
        ...(failed ? { error: true } : {}),
        ...(ops.length === 0 ? {} : { fileOps: ops }),
      })
      return
    }
    this.lateOps(payload, item, ops, failed, time, out)
  }

  /**
   * The call an `item_completed` Command/FileChange belongs to, when one can
   * be proven — across BOTH pending and settled calls, since a late item
   * routinely lands after its own result folded. Order: exact item id (the
   * McpToolCall shape, where item id IS the call id) → unique command-content
   * match → the lone-open call when nothing has settled since it opened (a
   * just-folded result can still own the item, so "only one call remains"
   * alone proves nothing). `undefined` when the pairing is ambiguous.
   */
  private attributeItem(
    item: Record<string, unknown>,
  ): { open: OpenCall } | { settled: SettledCall } | undefined {
    const itemId = asString(item['id'])
    if (itemId !== undefined) {
      const open = this.openCalls.get(itemId)
      if (open !== undefined) return { open }
      const settled = this.settledCalls.get(itemId)
      if (settled !== undefined) return { settled }
    }
    const command = commandOf(item)
    if (command !== undefined) {
      let matched: { open: OpenCall } | { settled: SettledCall } | undefined
      for (const call of this.openCalls.values()) {
        if (!call.args.includes(command)) continue
        if (matched !== undefined) return undefined
        matched = { open: call }
      }
      for (const call of this.settledCalls.values()) {
        if (!call.args.includes(command)) continue
        if (matched !== undefined) return undefined
        matched = { settled: call }
      }
      if (matched !== undefined) return matched
    }
    if (this.openCalls.size === 1 && this.settledSinceOpen === 0) {
      return { open: this.openCalls.values().next().value! }
    }
    return undefined
  }

  /**
   * A file-op item that arrived after its call's output folded. The call is
   * named either exactly (`item.id` IS a call id — true for `McpToolCall`
   * today, and the shape a future build may adopt for the others) or by the
   * only candidate that can have produced it: the single result settled since
   * the last call opened. Anything else is ambiguous — parallel calls — and is
   * dropped rather than misfiled against the wrong node.
   */
  private lateOps(
    payload: Record<string, unknown>,
    item: Record<string, unknown>,
    ops: FileOpInput[],
    failed: boolean,
    time: number,
    out: TimelineEvent[],
  ): void {
    if (ops.length === 0 && !failed) return
    const itemId = asString(item['id'])
    const exact = itemId === undefined ? undefined : this.settledCalls.get(itemId)
    const target = exact ?? (this.settledSinceOpen === 1 ? this.lastSettled : null)
    if (target === null || target === undefined) {
      this.ambiguousLateOps += 1
      return
    }
    this.emitLateOps(payload, ops, failed, target, time, out)
  }

  private emitLateOps(
    payload: Record<string, unknown>,
    ops: FileOpInput[],
    failed: boolean,
    target: SettledCall,
    time: number,
    out: TimelineEvent[],
  ): void {
    // `completed_at_ms` is epoch MILLISECONDS (the record `timestamp` is ISO).
    const at = parseTime(payload['completed_at_ms']) ?? time
    this.emit(out, 'tool/ops', at, {
      resultSeq: target.resultSeq,
      // An unknown name is OMITTED, not sent blank: the fold then recovers it
      // from what the result left behind (`toolNameAtSeq`).
      ...(target.name === '' ? {} : { tool: target.name }),
      ...(failed ? { err: true } : {}),
      fileOps: ops,
    })
  }

  /** Remember a settled call as a late-`tool/ops` target, oldest evicted first. */
  private rememberSettled(settled: SettledCall): void {
    this.settledCalls.delete(settled.callId)
    this.settledCalls.set(settled.callId, settled)
    if (this.settledCalls.size > SETTLED_CALLS_MAX) {
      const oldest = this.settledCalls.keys().next().value
      if (oldest !== undefined) this.settledCalls.delete(oldest)
    }
    this.lastSettled = settled
    this.settledSinceOpen += 1
  }

  private bufferOps(callId: string, ops: FileOpInput[]): void {
    if (ops.length === 0) return
    const existing = this.pendingOps.get(callId)
    if (existing === undefined) this.pendingOps.set(callId, ops)
    else existing.push(...ops)
  }

  // ---------------------------------------------------------------------------
  // response_item
  // ---------------------------------------------------------------------------

  private onResponseItem(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const type = asString(payload['type'])
    if (type === undefined) return
    if (type === 'message') {
      this.onMessage(payload, time, out)
      return
    }
    if (type === 'reasoning') {
      // The reasoning trace itself is `encrypted_content` (opaque); only the
      // model-authored summary is readable, so that is what gets sized. An
      // empty summary still opens a reasoning block so the stream's decode
      // split keeps the block, priced at ~0.
      const summary = (asArray(payload['summary']) ?? [])
        .flatMap(entry => (isRecord(entry) ? [asString(entry['text']) ?? ''] : []))
        .filter(text => text !== '')
        .join('\n\n')
      this.appendBlock(out, { type: 'reasoning', text: summary }, time)
      return
    }
    if (CALL_TYPES.has(type)) {
      this.onToolCall(payload, type, time, out)
      return
    }
    if (OUTPUT_TYPES.has(type)) {
      this.onToolOutput(payload, time, out)
      return
    }
    if (type === 'tool_search_output') {
      // `tool_search_output` carries `tools` (the discovered schemas), not `output`.
      this.onToolOutput(payload, time, out, asArray(payload['tools']))
      return
    }
    if (type === 'web_search_call' || type === 'image_generation_call') {
      this.onSelfContainedCall(payload, type, time, out)
      return
    }
    if (type === 'agent_message') {
      this.onAgentMessage(agentMessageText(payload), agentRoute(payload), time, out)
      return
    }
    if (type === 'configuration_update') {
      // A durable input control (today: reasoning effort). Not priced — the
      // fold has no effort figure — but visible as an inject marker.
      const reasoning = payload['reasoning']
      const effort = isRecord(reasoning) ? asString(reasoning['effort']) : undefined
      if (effort !== undefined && effort !== '') {
        this.emitSurface(out, 'user/message', time, {
          content: [{ type: 'text', text: `Reasoning effort set to ${effort}` }],
          source: { kind: 'configuration-update', form: 'notice' } satisfies MessageSource,
        })
        this.lastInputTime = time
      }
      return
    }
    // `compaction`/`context_compaction` items are the encrypted summary; the
    // `compacted` record carries the readable structure, so these are ignored.
    // `additional_tools`/`compaction_trigger` are request controls the rollout
    // policy never persists.
  }

  private onMessage(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const role = asString(payload['role'])
    const items = asArray(payload['content']) ?? []
    if (role === 'assistant') {
      for (const item of items) {
        if (!isRecord(item)) continue
        const text = asString(item['text'])
        if (text !== undefined && text !== '') this.appendBlock(out, { type: 'text', text }, time)
      }
      return
    }
    if (role !== 'user' && role !== 'developer') return
    // Any input settles the model response that was still open.
    this.closeGroup(out, time, undefined)
    const content = contentBlocksOf(items)
    if (role === 'developer') {
      this.sawDeveloperMessage = true
      this.emitSurface(out, 'user/message', time, {
        content,
        source: { kind: 'developer', form: 'context' } satisfies MessageSource,
      })
      this.lastInputTime = time
      return
    }
    // Per-item classification (core's `codexUserItems`): a message can mix
    // injected fragments with a real prompt. Context items emit as context
    // sources; human items — and media, which is never a contextual fragment —
    // form the user's message.
    const classified = codexUserItems(payload)
    const contextParts = classified.filter(item => !item.human)
    const humanParts = classified.filter(item => item.human)
    if (humanParts.length === 0) {
      if (contextParts.length === 0) return
      const first = contextParts[0]
      this.emitSurface(out, 'user/message', time, {
        content,
        source: { kind: first?.label ?? 'context', form: 'context' } satisfies MessageSource,
      })
      this.lastInputTime = time
      return
    }
    for (const part of contextParts) {
      this.emitSurface(out, 'user/message', time, {
        content: contentBlocksOf([part.item]),
        source: { kind: part.label ?? 'context', form: 'context' } satisfies MessageSource,
      })
    }
    const humanContent = contentBlocksOf(humanParts.map(part => part.item))
    // A human prompt. `task_started` already opened the turn (verified: 920 of
    // 921 user messages follow their turn's `task_started`); the increment here
    // only covers a transcript that starts mid-turn.
    if (!this.turnOpen) {
      this.turn += 1
      this.step = 0
      this.turnOpen = true
      this.openStep(out, time)
    }
    const text = humanParts.map(part => part.text).filter(part => part !== '').join('\n')
    if (this.activeTurns.at(-1) !== this.turn) this.activeTurns.push(this.turn)
    if (this.label === undefined && text.trim() !== '') this.label = labelOf(text)
    this.emitSurface(out, 'user/message', time, {
      content: humanContent,
      source: { kind: 'user' } satisfies MessageSource,
    })
    this.lastInputTime = time
  }

  private onToolCall(payload: Record<string, unknown>, type: string, time: number, out: TimelineEvent[]): void {
    const callId = asString(payload['call_id']) ?? asString(payload['id'])
    if (callId === undefined) return
    const { name, args } = toolCallContent(payload, type)
    this.appendBlock(out, { type: 'tool-call', name, arguments: args, callId }, time)
    this.openCalls.set(callId, { callId, name, args })
    // In-band items now belong to THIS call; the late-pairing candidate count
    // restarts from here.
    this.settledSinceOpen = 0
  }

  private onToolOutput(
    payload: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
    /** Structured result for outputs that carry no `output` field (tool_search's `tools`). */
    itemsOverride?: readonly unknown[],
  ): void {
    const callId = asString(payload['call_id'])
    // The output settles the model response if no `token_usage_record` did.
    this.closeGroup(out, time, undefined)
    const content = toolOutputContent(payload['output'], itemsOverride)
    if (callId === undefined) {
      this.emitSurface(out, 'user/message', time, {
        content,
        source: { kind: 'inject', form: 'context', name: asString(payload['name']) ?? 'standalone-tool-output' },
      })
      this.lastInputTime = time
      return
    }
    // Codex records no error flag on `function_call_output` itself; the paired
    // `item_completed.item.status === 'failed'` is the usual signal, while
    // `tool_search_output` carries a terminal `status` of its own.
    const status = asString(payload['status'])
    const isError = this.failedCalls.delete(callId)
      || status === 'failed' || status === 'error' || status === 'incomplete'
    const ops = this.pendingOps.get(callId)
    this.pendingOps.delete(callId)
    const open = this.openCalls.get(callId)
    const resultSeq = this.emitSurface(out, 'tool/result', time, {
      message: {
        content: [{ type: 'tool-result', toolCallId: callId, isError, content }],
        source: { callId },
      },
      ...(isError ? { error: true } : {}),
      ...(ops === undefined || ops.length === 0 ? {} : { fileOps: ops }),
    })
    this.rememberSettled({ callId, resultSeq, name: open?.name ?? '', args: open?.args ?? '' })
    this.openCalls.delete(callId)
    this.lastInputTime = time
    if (this.awaitingResults > 0) this.awaitingResults -= 1
    if (this.awaitingResults === 0) this.closeStep(out, time)
  }

  /**
   * `web_search_call` and `image_generation_call` are self-contained durable
   * items: one record carries the call AND its terminal `status`, with no
   * separate output item. The call joins the open group as a `tool-call`
   * block, while its `tool/call` + `tool/result` events emit immediately —
   * unlike ordinary calls, whose outputs arrive after the group closes and
   * whose call events can therefore wait for it.
   */
  private onSelfContainedCall(
    payload: Record<string, unknown>,
    type: 'web_search_call' | 'image_generation_call',
    time: number,
    out: TimelineEvent[],
  ): void {
    const callId = asString(payload['id'])
    if (callId === undefined) return
    const isImage = type === 'image_generation_call'
    const { name, args } = toolCallContent(payload, type)
    this.appendBlock(out, { type: 'tool-call', name, arguments: args, callId }, time)
    // Call event BEFORE the result: the fold names a `tool/result` only from
    // a `tool/call` it has already seen, and the group's close-time emission
    // would land after it.
    this.emit(out, 'tool/call', time, {
      callId,
      name,
      ...(args === '' ? {} : { arguments: args }),
    })
    const status = asString(payload['status'])
    const failed = status === 'failed' || status === 'error' || status === 'incomplete'
    // Image results are base64 payloads — an `image` block lets the fold price
    // them without inflating text; web search yields no readable output.
    const result = isImage ? asString(payload['result']) : undefined
    const content: ContentBlock[] = result === undefined || result === ''
      ? []
      : [{ type: 'image' }]
    const resultSeq = this.emitSurface(out, 'tool/result', time, {
      message: {
        content: [{ type: 'tool-result', toolCallId: callId, isError: failed, content }],
        source: { callId },
      },
      ...(failed ? { error: true } : {}),
    })
    // Its result already folded: the group-close call event must not leave the
    // step waiting on an output that will never arrive.
    this.earlySettled.add(callId)
    this.rememberSettled({ callId, resultSeq, name, args })
    this.lastInputTime = time
  }

  /**
   * Agent-to-agent traffic — `agent_message` response items and the top-level
   * `inter_agent_communication` record — is model-visible context, not human
   * input. The source names both endpoints so it cannot masquerade as a
   * person, and so the Agent Network can tell relayed text apart.
   */
  private onAgentMessage(text: string, route: string, time: number, out: TimelineEvent[]): void {
    if (text === '') return
    this.closeGroup(out, time, undefined)
    this.emitSurface(out, 'user/message', time, {
      content: [{ type: 'text', text }],
      source: {
        kind: 'agent-message',
        form: 'relay',
        ...(route === '' ? {} : { name: route }),
      } satisfies MessageSource,
    })
    this.lastInputTime = time
  }

  /**
   * `retained_context` checkpoints host-held facts — today only
   * `verified_answer`, the user's accepted `request_user_input` replies
   * (history/retained_context.rs). Model-invisible to Codex but user-authored,
   * so they surface as a zero-token notice, outside model content.
   */
  private onRetainedContext(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    if (asString(payload['type']) !== 'verified_answer') return
    const lines = (asArray(payload['questions']) ?? [])
      .flatMap(entry => {
        if (!isRecord(entry)) return []
        const question = asString(entry['question']) ?? ''
        const answer = asString(entry['answer']) ?? ''
        return question === '' && answer === '' ? [] : [`Q: ${question}\nA: ${answer}`]
      })
    if (lines.length === 0) return
    this.emit(out, 'user/message', time, {
      content: [],
      source: { kind: 'verified-answer', form: 'notice', summary: lines.join('\n\n') } satisfies MessageSource,
    })
  }

  // ---------------------------------------------------------------------------
  // Model response grouping
  // ---------------------------------------------------------------------------

  private appendBlock(out: TimelineEvent[], block: ContentBlock, time: number): void {
    const group = this.ensureGroup(out, time)
    group.blocks.push(block)
    group.blockTimes.push(time)
    if (time > group.lastTime) group.lastTime = time
  }

  private ensureGroup(out: TimelineEvent[], time: number): OpenGroup {
    if (this.group !== null) return this.group
    if (this.turn === 0) {
      this.turn = 1
      this.step = 0
      this.turnOpen = true
    }
    if (!this.stepOpen) this.openStep(out, this.lastInputTime === 0 ? time : this.lastInputTime)
    // The header must be folded before the first request it describes.
    if (this.headerPending) this.flushHeader(out, time)
    const group: OpenGroup = {
      input: {
        source: 'estimated',
        ...(this.model === undefined ? {} : { model: this.model }),
        ...(this.contextWindow === undefined ? {} : { window: { tokens: this.contextWindow, source: 'recorded', kind: 'usable' } }),
      },
      blocks: [],
      blockTimes: [],
      stepStart: this.stepStartTime === 0 ? time : this.stepStartTime,
      lastTime: time,
    }
    this.group = group
    this.windowAwaitingModel = false
    return group
  }

  /**
   * Settle the open model response.
   *
   * EVIDENCE: `token_usage_record` lands after the response's reasoning /
   * message / tool-call items and BEFORE the tool output that answers them
   * (of 9 496 records the preceding line is the response's own tool call or
   * its `item_completed` mirror, the following line the `*_output`). It is
   * therefore the response boundary. Its `response_id` (`resp_0…`) matches no
   * `response_item.id`, so grouping is positional, not id-based.
   */
  private closeGroup(out: TimelineEvent[], time: number, usage: Record<string, number> | undefined): void {
    const group = this.group
    if (group === null) return
    this.group = null
    const completed = Math.max(group.lastTime, time)
    this.step += 1
    const stream = buildStream(group, completed)
    const priced = usage ?? group.fallbackUsage
    this.emitSurface(out, 'assistant/message', completed, {
      message: { content: group.blocks },
      ...(priced === undefined ? {} : { usage: priced }),
      turn: this.turn,
      step: this.step,
      ...(stream.length === 0 ? {} : { stream }),
    })
    setRequestInput(out.at(-1), group.input)
    let calls = 0
    for (const block of group.blocks) {
      if (block.type !== 'tool-call' || block.callId === undefined) continue
      // A self-contained call emitted `tool/call` + `tool/result` inline (the
      // fold pairs a result only with a call it has already seen); it waits
      // on no output.
      if (this.earlySettled.delete(block.callId)) continue
      this.emit(out, 'tool/call', completed, {
        callId: block.callId,
        name: block.name ?? 'tool',
        ...(block.arguments === undefined ? {} : { arguments: block.arguments }),
      })
      calls += 1
    }
    this.awaitingResults = calls
    // A response with no tool call ends its step here; otherwise the step ends
    // when the last result lands (see `onToolOutput`).
    if (calls === 0) this.closeStep(out, completed)
  }

  private onTokenUsage(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    this.lastContextTokens = contextTokensOf(payload['usage']) ?? this.lastContextTokens
    if (this.group !== null) {
      const raw = payload['usage']
      this.group.input = { ...this.group.input, ...measuredInput(isRecord(raw) ? raw['input_tokens'] : undefined, this.group.input.model) }
      this.closeGroup(out, time, usageOf(payload['usage']))
      return
    }
    // No open response: a usage-only answer — remote compaction runs one —
    // must not be booked onto the previous turn. Buffer it for the
    // `compacted` record that names it through `compaction_response_id`.
    const usage = usageOf(payload['usage'])
    if (usage === undefined) return
    const responseId = asString(payload['response_id']) ?? ''
    this.unclaimedUsage.delete(responseId)
    this.unclaimedUsage.set(responseId, usage)
    if (this.unclaimedUsage.size > 32) {
      const oldest = this.unclaimedUsage.keys().next().value
      if (oldest !== undefined) this.unclaimedUsage.delete(oldest)
    }
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  private openStep(out: TimelineEvent[], time: number): void {
    if (this.stepOpen) this.closeStep(out, time)
    this.emit(out, 'step/start', time)
    this.stepOpen = true
    this.stepStartTime = time
  }

  private closeStep(out: TimelineEvent[], time: number): void {
    if (!this.stepOpen) return
    this.stepOpen = false
    this.emit(out, 'step/end', time)
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  /**
   * A `compacted` record rebuilds the model's context. `replacement_history`
   * is authoritative for what the model keeps: message items, the retained
   * `agent_message`s `is_retained_for_remote_compaction_v2` admits
   * (non-progress, non-completion), plus ONE `compaction` /
   * `context_compaction` summary item (encrypted; `payload.message` is the
   * plaintext-summary path, empty in every sampled build).
   * `retained_context.user_messages` is host-review evidence — "retained
   * outside model summarization for delegated review" — never part of the
   * model's post-compaction context, so it annotates the summary event rather
   * than joining the surface. `shadowedTokenCount` is the PRE-COMPACTION
   * context occupancy (the last response's `input_tokens` via
   * `latest_token_usage_record`), never the cumulative
   * `thread_token_usage.total_tokens`, which counts consumption.
   */
  private onCompacted(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    this.closeGroup(out, time, undefined)
    // The remote compaction ran a usage-only response of its own; its
    // `token_usage_record` was buffered under `response_id` and is claimed
    // here through `compaction_response_id`. Emitting it as an empty
    // assistant message books the cost (a zero-token node, then shadowed)
    // instead of overwriting the previous turn's usage or dropping it.
    const responseId = asString(payload['compaction_response_id'])
    let usage = responseId === undefined ? undefined : this.unclaimedUsage.get(responseId)
    if (usage === undefined && this.unclaimedUsage.size === 1) {
      usage = this.unclaimedUsage.values().next().value
      this.unclaimedUsage.clear()
    } else if (responseId !== undefined) {
      this.unclaimedUsage.delete(responseId)
    }
    if (usage !== undefined) {
      this.emitSurface(out, 'assistant/message', time, {
        message: { content: [] },
        usage,
        turn: this.turn,
        step: this.step,
      })
    }
    const shadowed = this.liveSeqs.map(entry => entry.seq)
    this.liveSeqs = []
    const latest = payload['latest_token_usage_record']
    const shadowedTokenCount = (isRecord(latest) ? contextTokensOf(latest['usage']) : undefined)
      ?? this.lastContextTokens
    const retained = payload['retained_context']
    const evidence = (isRecord(retained) ? asArray(retained['user_messages']) ?? [] : [])
      .flatMap(entry => (isRecord(entry) ? [asString(entry['text']) ?? ''] : []))
      .filter(text => text !== '')
    this.emit(out, 'compaction/summary', time, {
      shadowedSeqs: shadowed,
      ...(shadowedTokenCount === undefined ? {} : { shadowedTokenCount }),
      ...(evidence.length === 0 ? {} : { retained: evidence }),
    })
    const windowId = asString(payload['window_id'])
    // The shadow claim the fold just armed is consumed by the NEXT surface
    // event: the first replacement must carry the replace op or the shadowed
    // nodes stay on the surface.
    const op = shadowed.length === 0
      ? undefined
      : { op: 'replace', startSeq: Math.min(...shadowed), endSeq: Math.max(...shadowed) }
    let first = true
    const emitReplacement = (content: ContentBlock[], source: MessageSource): void => {
      this.emitSurface(out, 'user/message', time, { content, source }, first ? op : undefined)
      first = false
    }
    const compactionSource = (): MessageSource => ({
      kind: 'plugin',
      form: 'compaction',
      plugin: 'compaction',
      ...(windowId === undefined ? {} : { compactionId: windowId }),
    })
    // The plaintext summary path (`payload.message`, or a retained message
    // carrying the SUMMARY_PREFIX marker) renders as the compaction node.
    const message = asString(payload['message'])
    let summaryEmitted = false
    const emitSummary = (text: string | undefined): void => {
      if (summaryEmitted) return
      summaryEmitted = true
      emitReplacement(
        text === undefined || text === '' ? [] : [{ type: 'text', text }],
        compactionSource(),
      )
    }
    for (const entry of asArray(payload['replacement_history']) ?? []) {
      if (!isRecord(entry)) continue
      const type = asString(entry['type'])
      if (type === 'compaction' || type === 'context_compaction') {
        emitSummary(message)
        continue
      }
      if (type === 'agent_message') {
        // Codex keeps non-progress agent messages through remote compaction;
        // they stay model-visible under their relay identity.
        const text = agentMessageText(entry)
        const route = agentRoute(entry)
        emitReplacement(
          text === '' ? [] : [{ type: 'text', text }],
          { kind: 'agent-message', form: 'relay', ...(route === '' ? {} : { name: route }) },
        )
        continue
      }
      if (type !== 'message') continue
      const role = asString(entry['role'])
      if (role !== 'user' && role !== 'developer') continue
      const content = contentBlocksOf(asArray(entry['content']) ?? [])
      const text = textOf(content)
      if (isSummaryMessage(text)) {
        emitSummary(text)
        continue
      }
      // Retained history keeps its own text but NOT the human-input identity:
      // re-counting it as a prompt would inflate the session's prompt tally.
      emitReplacement(content, {
        kind: 'compaction-retained',
        form: 'compaction',
        ...(role === 'developer' ? { name: 'developer' } : {}),
      })
    }
    if (!summaryEmitted && message !== undefined && message !== '') emitSummary(message)
    if (first && op !== undefined) {
      // No readable replacement: still claim the range so the shadowed nodes
      // leave the live surface instead of lingering at full price.
      emitReplacement([], compactionSource())
    }
  }

  // ---------------------------------------------------------------------------
  // world_state
  // ---------------------------------------------------------------------------

  /**
   * `world_state` is a full snapshot of the standing instructions Codex folds
   * into every request. Newer builds deliver them as `developer` messages,
   * which are already sized as inject nodes; older ones only ever record them
   * here. Per the design this is a FALLBACK: it sizes `agents_md.text` and
   * `host_skills.body` once each, and only while no developer message has been
   * seen, so the two channels can never double-count the same instructions.
   */
  private onWorldState(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    if (this.sawDeveloperMessage) return
    const state = payload['state']
    if (!isRecord(state)) return
    const agents = state['agents_md']
    this.sizeWorldStateText(out, time, 'agents-md', isRecord(agents) ? asString(agents['text']) : undefined)
    const skills = state['host_skills']
    this.sizeWorldStateText(out, time, 'host-skills', isRecord(skills) ? asString(skills['body']) : undefined)
  }

  private sizeWorldStateText(out: TimelineEvent[], time: number, kind: string, text: string | undefined): void {
    if (text === undefined || text === '') return
    const key = `${kind}:${text}`
    if (this.worldStateSized.has(key)) return
    this.worldStateSized.add(key)
    this.emitSurface(out, 'user/message', time, {
      content: [{ type: 'text', text }],
      source: { kind, form: 'context' } satisfies MessageSource,
    })
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/**
 * The embedded stream the fold reads for this step's first-token instant and
 * its decode split: an optional token chunk, then one `block-start` per block.
 *
 * DEVIATION + EVIDENCE (two changes from the design sketch, both forced by the
 * data):
 *
 * 1. SOURCE. The sketch asks for `stepStart + time_to_first_token_ms`, but that
 *    figure is only ever written on `task_complete` — the END of the turn, long
 *    after the turn's first response was emitted, and a synthesizer cannot amend
 *    an event it already returned. The causally available stand-in is the
 *    `started_at_ms` of the step's first Reasoning/AgentMessage `item_completed`,
 *    which lands before the response settles in 580 of 584 sampled turns and
 *    tracks the recorded per-turn TTFT to a median of −0.5 s (p25 −2.2 s,
 *    p75 +0.4 s). It is used only when it falls inside [stepStart, completion].
 * 2. SCOPE. The sketch restricts the chunk to the turn's FIRST step because
 *    `time_to_first_token_ms` is a per-TURN figure. The replacement source is
 *    per-STEP, so the restriction has nothing left to protect — and it costs a
 *    lot: over the same 82 rollouts, first-step-only attributes 3.2 s of wait
 *    and 3.0 s of generation per 1 000 calls' worth of the fold's timing totals
 *    (ttftMs 3.17 M / genMs 3.02 M), against 29.5 M / 40.8 M when every step is
 *    stamped — i.e. ~90 % of the model's time would otherwise land in the
 *    timing card's unattributed residue. To restore the literal rule, gate the
 *    token chunk on the group being the turn's first (`step === 0` at open).
 *
 * Block starts: Codex writes a response item when its block COMPLETES, so block
 * i started when block i−1 completed (block 0 at the first-token instant, else
 * at the step start).
 */
function buildStream(group: OpenGroup, completed: number): StreamRecord[] {
  const stream: StreamRecord[] = []
  const first = group.firstTokenAt
  const firstToken = first !== undefined && first >= group.stepStart && first <= completed ? first : undefined
  if (firstToken !== undefined) {
    // The text is a marker only: the fold reads the chunk's INSTANT and needs
    // a non-empty delta to recognize it as a token (`logShapes.isTokenChunk`).
    stream.push({ type: 'chunk', time: firstToken, chunk: { type: 'text-delta', text: ' ' } })
  }
  for (const [index, block] of group.blocks.entries()) {
    const blockType = block.type === 'reasoning' ? 'reasoning' : block.type === 'tool-call' ? 'tool-call' : 'text'
    const previous = index === 0 ? (firstToken ?? group.stepStart) : (group.blockTimes[index - 1] ?? group.stepStart)
    stream.push({ type: 'chunk', time: previous, chunk: { type: 'block-start', blockType } })
  }
  return stream
}

/**
 * Codex's usage buckets → the fold's disjoint vocabulary. `input_tokens` is
 * the WHOLE prompt and `cached_input_tokens` its cache-served share, so the
 * uncached figure is the difference; `output_tokens` already includes
 * `reasoning_output_tokens`. EVIDENCE (9471 `token_usage_record`s across 78
 * rollouts): `total_tokens === input_tokens + output_tokens` in every single
 * record, which holds only if the cached half is inside `input_tokens` and
 * reasoning is inside `output_tokens`; and summing `usage` over a rollout
 * reproduces that file's last `thread_token_usage` exactly (39 of 45 files —
 * the other 6 are resumed threads whose cumulative figure also covers the
 * rollout files that came before, which is why the per-FILE sum is the one
 * we bill).
 *
 * `cache_write_input_tokens` is 0 in all 9471 sampled records, so which side
 * of `input_tokens` it falls on is unprovable from data. It is treated as a
 * SHARE of the prompt (like the cached half) and subtracted — but only when
 * the prompt is large enough to contain it, so the reading can shift tokens
 * between the miss and write rates and never invent or double-bill any.
 */
function usageOf(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value['input_tokens'])
  const output = asNumber(value['output_tokens'])
  const cached = asNumber(value['cached_input_tokens'])
  const cacheWrite = asNumber(value['cache_write_input_tokens'])
  if (input === undefined && output === undefined && cached === undefined) return undefined
  const prompt = input ?? 0
  const read = cached ?? 0
  const written = cacheWrite ?? 0
  const uncached = prompt - read - (prompt >= read + written ? written : 0)
  return {
    inputTokens: Math.max(0, uncached),
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    outputTokens: output ?? 0,
  }
}

/** `input_text` / `output_text` → text, `input_image` → image (dimensions unknown). */
function contentBlocksOf(items: readonly unknown[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const type = asString(item['type'])
    if (type === 'input_image' || type === 'image') {
      blocks.push({ type: 'image' })
      continue
    }
    const text = asString(item['text'])
    if (text !== undefined) blocks.push({ type: 'text', text })
  }
  return blocks
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/**
 * Tokens occupying the context window for one response — its `input_tokens`
 * (the whole prompt, cached half included). What a compaction shadows is the
 * context that was live when it ran, so this — not a cumulative thread total —
 * is the figure `shadowedTokenCount` reports.
 */
function contextTokensOf(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined
  const input = asNumber(usage['input_tokens'])
  if (input !== undefined) return input
  return asNumber(usage['total_tokens'])
}

/** `core/src/compact.rs`'s plaintext summary marker (templates/compact/summary_prefix.md). */
const SUMMARY_PREFIX = 'Another language model started to solve this problem'

function isSummaryMessage(text: string): boolean {
  return text.startsWith(SUMMARY_PREFIX)
}

function labelOf(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? ''
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line
}

/**
 * `CommandExecution.parsed_cmd` → file ops. Codex pre-parses the command line,
 * so the harness's own classification is used instead of a local `cat`/`rg`
 * heuristic: the observed types are `read` (`name`, `path`), `search`
 * (`query`, `path`), `list_files` (`path`) and `unknown` (no file identity).
 */
function opsOfCommand(item: Record<string, unknown>): FileOpInput[] {
  const ops: FileOpInput[] = []
  // A bare `ls` parses to `list_files` with no path; the item's own working
  // directory is the directory it listed (52 such rows in the sample corpus).
  const cwd = asString(item['cwd'])
  for (const entry of asArray(item['parsed_cmd']) ?? []) {
    if (!isRecord(entry)) continue
    const type = asString(entry['type'])
    const path = asString(entry['path'])
    const query = asString(entry['query'])
    // Reads and searches state no line delta; the fold defaults added/removed
    // to 0, so writing them here would only pad every event.
    if (type === 'read') {
      if (path === undefined || path === '') continue
      ops.push({ kind: 'read', path })
    } else if (type === 'search') {
      // A pathless search books the PATTERN as its path (the fold's
      // `pattern: true` marker keeps the client from relativizing it).
      const target = path !== undefined && path !== '' ? path : query
      if (target === undefined || target === '') continue
      ops.push({
        kind: 'search',
        path: target,
        ...(path !== undefined && path !== '' ? {} : { pattern: true as const }),
        ...(query === undefined || query === '' ? {} : { detail: query }),
      })
    } else if (type === 'list_files') {
      const target = path !== undefined && path !== '' ? path : cwd
      if (target === undefined || target === '') continue
      ops.push({ kind: 'search', path: target })
    }
  }
  return ops
}

/** `FileChange.changes` is a MAP of path → `{ type: add|update|delete, unified_diff?, content? }`. */
function opsOfFileChange(item: Record<string, unknown>): FileOpInput[] {
  const changes = item['changes']
  if (!isRecord(changes)) return []
  const ops: FileOpInput[] = []
  for (const [path, value] of Object.entries(changes)) {
    if (path === '') continue
    const change = isRecord(value) ? value : {}
    const diff = asString(change['unified_diff'])
    const counted = diff === undefined ? null : countDiff(diff)
    const content = asString(change['content'])
    const kindLabel = asString(change['type'])
    const added = counted?.added ?? (content === undefined ? 0 : lineCount(content))
    const removed = counted?.removed ?? 0
    ops.push({
      kind: 'write',
      path,
      added: kindLabel === 'delete' && counted === null ? 0 : added,
      removed: kindLabel === 'delete' && counted === null && content !== undefined ? lineCount(content) : removed,
      ...(kindLabel === undefined ? {} : { detail: kindLabel }),
    })
  }
  return ops
}

/** Added/removed line counts of a unified diff (`+++`/`---` headers excluded). */
function countDiff(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

function lineCount(text: string): number {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

/**
 * A subagent thread's own name: `session_meta.source.subagent` holds one
 * descriptive string under a build-specific key, and `thread_source` names the
 * flavour (`subagent`, `guardian_review`). Mirrors core's `subagentLabel`.
 */
function subagentLabelOf(payload: Record<string, unknown>): string | undefined {
  const source = payload['source']
  if (isRecord(source)) {
    const subagent = source['subagent']
    if (isRecord(subagent)) {
      for (const value of Object.values(subagent)) {
        if (typeof value === 'string' && value !== '') return labelOf(value)
      }
      const [firstKey] = Object.keys(subagent)
      if (firstKey !== undefined) return firstKey
    }
    if (typeof subagent === 'string' && subagent !== '') return labelOf(subagent)
  }
  const threadSource = asString(payload['thread_source'])
  if (threadSource !== undefined && threadSource !== '') return threadSource
  return asString(payload['parent_thread_id']) === undefined ? undefined : 'subagent'
}

/**
 * The command a CommandExecution item ran: `command` is argv, and the shell's
 * `-c` argument (or the bare argv) is what a call's raw arguments contain.
 */
function commandOf(item: Record<string, unknown>): string | undefined {
  const argv = (asArray(item['command']) ?? []).filter((part): part is string => typeof part === 'string')
  if (argv.length === 0) return undefined
  const dashC = argv.findIndex(part => part === '-c' || part === '-lc' || part === '-cl')
  return argv[dashC + 1] ?? argv[argv.length - 1]
}

/** Human-readable label for an unattributed file-activity item. */
function itemLabel(item: Record<string, unknown>): string {
  const command = commandOf(item)
  if (command !== undefined) return command
  const changes = item['changes']
  if (isRecord(changes)) {
    const paths = Object.keys(changes)
    if (paths.length > 0) return paths.join(', ')
  }
  return asString(item['type']) ?? 'activity'
}

function jsonOrUndefined(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/**
 * `session_meta.dynamic_tools` → one flat list of function specs. Canonical
 * entries (protocol/dynamic_tools.rs `DynamicToolSpec`) are
 * `{"type":"function", name, description, inputSchema, deferLoading?}` or
 * `{"type":"namespace", name, description, tools:[…functions…]}`; the legacy
 * shape is a flat `{name, description, inputSchema, namespace?, deferLoading?/
 * exposeToContext?}` list. Every emitted spec keeps its `namespace` (owning
 * namespace name, or the legacy entry's own) so identity survives flattening.
 */
function normalizeDynamicTools(specs: readonly unknown[] | undefined): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = []
  for (const spec of specs ?? []) {
    if (!isRecord(spec)) continue
    const type = asString(spec['type'])
    if (type === 'function') {
      tools.push(spec)
      continue
    }
    if (type === 'namespace') {
      const namespace = asString(spec['name'])
      for (const tool of asArray(spec['tools']) ?? []) {
        if (!isRecord(tool)) continue
        tools.push(namespace === undefined ? tool : { ...tool, namespace })
      }
      continue
    }
    // Legacy flat entry: `{name, inputSchema, namespace?, exposeToContext?}` —
    // `type` absent. `exposeToContext: false` maps to `deferLoading: true`
    // (normalize_dynamic_tool_specs).
    if (asString(spec['name']) === undefined) continue
    const normalized: Record<string, unknown> = { type: 'function', ...spec }
    const namespace = asString(normalized['namespace'])
    delete normalized['namespace']
    delete normalized['exposeToContext']
    if (normalized['deferLoading'] === undefined && spec['exposeToContext'] === false) {
      normalized['deferLoading'] = true
    }
    if (namespace !== undefined) normalized['namespace'] = namespace
    tools.push(normalized)
  }
  return tools
}

/** Readable text of an `agent_message` item: `input_text` parts joined; encrypted parts drop out. */
function agentMessageText(payload: Record<string, unknown>): string {
  return (asArray(payload['content']) ?? [])
    .flatMap(item => (isRecord(item) && asString(item['type']) === 'input_text'
      ? [asString(item['text']) ?? '']
      : []))
    .filter(text => text !== '')
    .join('\n')
}

/** `author → recipient` of an agent-communication payload (AgentPath strings on the wire). */
function agentRoute(payload: Record<string, unknown>): string {
  const author = asString(payload['author'])
  const recipient = asString(payload['recipient'])
  if (author === undefined && recipient === undefined) return ''
  return `${author ?? '?'} → ${recipient ?? '?'}`
}

/** `inter_agent_communication` carries a plain-string `content` (or only `encrypted_content`). */
function interAgentText(payload: Record<string, unknown>): string {
  return asString(payload['content']) ?? ''
}

/** Wire decoding shared by new activity and inherited model-context replay. */
function toolCallContent(payload: Record<string, unknown>, type: string): { name: string; args: string } {
  if (type === 'image_generation_call') {
    return { name: 'image_generation', args: jsonOrUndefined({ prompt: asString(payload['revised_prompt']) ?? '' }) ?? '' }
  }
  if (type === 'web_search_call') {
    return { name: 'web_search', args: jsonOrUndefined(payload['action']) ?? '' }
  }
  let name = asString(payload['name']) ?? 'tool'
  if (type === 'local_shell_call') name = 'local_shell'
  if (type === 'tool_search_call') name = 'tool_search'
  const namespace = asString(payload['namespace'])
  if (namespace !== undefined && namespace !== '' && namespace !== 'functions') name = `${namespace}.${name}`
  // Custom calls use input, function calls use arguments, and local shell
  // uses a structured action. Keep the same readable representation in replay.
  const args = asString(payload['input']) ?? asString(payload['arguments'])
    ?? jsonOrUndefined(payload['action'] ?? payload['input'] ?? payload['arguments']) ?? ''
  return { name, args }
}

function toolOutputContent(output: unknown, tools?: readonly unknown[]): ContentBlock[] {
  if (tools !== undefined) return [{ type: 'text', text: jsonOrUndefined(tools) ?? '' }]
  if (typeof output === 'string') return [{ type: 'text', text: output }]
  return contentBlocksOf(asArray(output) ?? [])
}

export function createCodexSynthesizer(file: SessionFileRef): EventSynthesizer {
  return new CodexSynthesizer(file)
}
