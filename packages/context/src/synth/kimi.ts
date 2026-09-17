/**
 * Kimi Code CLI wire log → fold events.
 *
 * One instance per `wire.jsonl` (`~/.kimi-code/sessions/<workspace>/session_<uuid>/agents/<agentId>/wire.jsonl`).
 * Every line is `{ type, time, agentId, ...payload }` — the payload fields sit
 * at the TOP level of the record, not under a `payload` key the way Codex
 * writes them — and this module turns that stream into the fold's event
 * vocabulary (`../fold/event.ts`).
 *
 * The mapping follows the verified format survey of kimi 0.42.0 /
 * `protocol_version` 1.5; the load-bearing observations are called out inline.
 *
 * UNIT TRAPS (all three are real and all three have bitten a naive reading):
 *
 *  1. `time` is epoch MILLISECONDS on every record (no `timestamp` field
 *     exists). `parseTime` from core normalizes it — it treats a number below
 *     1e12 as seconds, which a 13-digit Kimi stamp never is — so every instant
 *     this file produces is epoch milliseconds.
 *  2. The loop's `turnId` is a STRING (`'0'`) on `step.begin` / `content.part`
 *     / `tool.call` / `step.end`, but a NUMBER (`0`) on `turn.ended`,
 *     `turn.cancel` and `turn.step.interrupted`. Turns are 0-based and steps
 *     are 1-based, so the display turn is `Number(turnId) + 1` and the display
 *     step is `event.step` verbatim. `turnNumberOf` accepts both spellings.
 *  3. Loop events (`content.part`, `tool.call`, `tool.result`, `step.end`) are
 *     FLUSHED TO DISK AFTER the response settles, so their `time` is the flush
 *     instant, not the moment the thing happened. In particular
 *     `tool.result.time − tool.call.time` is NOT a tool duration and must
 *     never be presented as one: this synthesizer stamps every block of a step
 *     at the step's computed completion instant instead of at its own record
 *     time, and the only real timings it publishes are the ones the harness
 *     measured itself (`llmFirstTokenLatencyMs`, `llmStreamDurationMs`, and
 *     the `usage.record` write instant as the response end).
 *
 * Because of (3) a step is BUFFERED: nothing but `step/start` is emitted until
 * the step settles, and then the whole step goes out in fold order
 * (assistant/message → tool/call… → tool/result… → step/end) with computed
 * instants.
 */

import type { KimiMessageClass, SessionFileRef } from '@harness-trajectory/core'
import {
  agentMentions,
  asArray,
  asNumber,
  asString,
  isRecord,
  kimiMessageClass,
  kimiTitleText,
  parseJsonLine,
  parseTime,
  titleFrom,
} from '@harness-trajectory/core'
import type { ContentBlock, MessageSource, StreamRecord, TimelineEvent } from '../fold/event.ts'
import type { FileOpInput } from '../fold/fold.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'
import { restoreSurface } from './surfaceRestore.ts'
import { appendSurface, checkpointSurface, surfaceValues, type SurfaceCheckpoint } from './surfaceCheckpoint.ts'
import { disjointInput, setRequestInput } from './requestInput.ts'

/** Label length cap, matching the Claude/Codex synthesizers' session titles. */
const LABEL_MAX = 80

/**
 * Pricing provider ids (models.dev). NEVER `llm.request.provider`: that field
 * names the WIRE PROTOCOL (`'openai'`), not the vendor. The Kimi Code
 * subscription aliases (`kimi-code/<model>`) are listed by models.dev under
 * `kimi-for-coding` at $0 (they are covered by the subscription); any other
 * alias prices through Moonshot's public list.
 */
const PROVIDER_SUBSCRIPTION = 'kimi-for-coding'
const PROVIDER_PUBLIC = 'moonshotai'
const SUBSCRIPTION_ALIAS_PREFIX = 'kimi-code/'

/** Tools whose result can name a spawned subagent (`agent_id: <id>`). */
const AGENT_TOOLS = new Set(['Agent', 'AgentSwarm'])

/** Open tool calls kept for their arguments (file-op derivation, child labels). */
const CALLS_MAX = 256

/** A tool result buffered until its step settles. */
interface BufferedResult {
  callId: string
  content: ContentBlock[]
  isError: boolean
  /** The record's own flush time (see unit trap 3) — clamped to ≥ the step's completion. */
  time: number
}

/** One model step being accumulated between `step.begin` and its settle. */
interface OpenStep {
  /** `step.begin.time` — the request instant (unit trap 3 makes this the ONLY honest start). */
  start: number
  turn: number
  step: number
  blocks: ContentBlock[]
  results: BufferedResult[]
  /** Call ids this step issued, so a result of an EARLIER step is not misfiled into it. */
  callIds: Set<string>
}

/** A tool call's identity, kept until its result settles. */
interface CallInfo {
  name: string
  args: Record<string, unknown> | undefined
}

/** What `step.end` contributes to the settle (absent for an interrupted/implicit flush). */
interface StepEnd {
  usage: Record<string, number> | undefined
  /** `llmFirstTokenLatencyMs` — the harness's own TTFT measurement. */
  ttftMs: number | undefined
  /** `llmStreamDurationMs` — decode wall time, the completion fallback. */
  streamMs: number | undefined
}

class KimiSynthesizer implements EventSynthesizer {
  readonly kind = 'kimi' as const

  private seq = 0
  private lastTime = 0

  // ---- meta -----------------------------------------------------------------
  private model: string | undefined
  /** Whether `model` came from an `llm.request` (authoritative) or the alias tail (provisional). */
  private modelFromRequest = false
  private provider = PROVIDER_PUBLIC
  private auxiliaryRequest = false
  private label: string | undefined
  /** `runtime.set_binding.agentId` — this file's own agent id. */
  private agentId: string | undefined

  // ---- turn / step ----------------------------------------------------------
  private turn = 0
  private step = 0
  private turnOpen = false
  private open: OpenStep | null = null
  /** `usage.record` lands BEFORE the step's loop events; it is the step's usage fallback. */
  private pendingUsage: Record<string, number> | undefined
  /** The `usage.record` write instant ≈ the response end (format note). */
  private responseEnd: number | undefined

  // ---- header ---------------------------------------------------------------
  private systemText: string | undefined
  private tools: unknown[] = []
  private toolsHash: string | undefined
  private sawToolsSnapshot = false
  private headerPending = false
  private headerEmitted = false

  // ---- tool pairing ---------------------------------------------------------
  private readonly calls = new Map<string, CallInfo>()

  // ---- surface bookkeeping --------------------------------------------------
  /** Seqs of every live surface node, for the compaction/prune claims. */
  private liveSeqs: number[] = []
  /** Seqs of the live HUMAN `user/message` nodes, for the compaction kept tail. */
  private humanSeqs: number[] = []
  private readonly surfaceEvents = new Map<number, TimelineEvent>()
  private surfaceCheckpoint: SurfaceCheckpoint<TimelineEvent> | null = null
  private readonly undoAnchors: (SurfaceCheckpoint<TimelineEvent> | null)[] = []
  private readonly ownedInjections = new Map<string, Set<number>>()
  /** Set by `context.apply_compaction` so the mirrored `compaction_summary` message is not doubled. */
  private pendingCompactionSummary = false

  // ---- children -------------------------------------------------------------
  private readonly children = new Map<string, AgentSpawn>()
  /** `task.started.info.taskId` → the child agent id it opened. */
  private readonly tasks = new Map<string, string>()
  /** Tool call ids already bound to a child (so the `agent_id:` fallback never doubles one). */
  private readonly boundCalls = new Set<string>()

  push(line: string): readonly TimelineEvent[] {
    const out: TimelineEvent[] = []
    try {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return out
      const type = asString(record['type'])
      if (type === undefined) return out
      // Unit trap 1: `time` is epoch ms. A record without one inherits the last
      // instant rather than falling back to "now" (replaying a closed file must
      // be deterministic).
      const time = parseTime(record['time']) ?? this.lastTime
      if (time > this.lastTime) this.lastTime = time
      switch (type) {
        case 'runtime.set_binding':
          this.agentId = asString(record['agentId']) ?? this.agentId
          break
        case 'profile.bind': this.onProfileBind(record, time, out); break
        case 'llm.tools_snapshot': this.onToolsSnapshot(record, time, out); break
        case 'llm.request': this.onRequest(record, time, out); break
        case 'usage.record': this.onUsageRecord(record, time); break
        case 'context.append_message': this.onAppendMessage(record, time, out); break
        case 'context.append_loop_event': this.onLoopEvent(record, time, out); break
        case 'turn.prompt':
        case 'turn.steer':
          this.turnOpen = true
          break
        case 'turn.ended':
        case 'prompt.completed':
        case 'prompt.aborted':
          this.flushStep(out, time, undefined)
          this.turnOpen = false
          break
        case 'turn.step.interrupted':
          this.flushStep(out, time, undefined)
          break
        case 'task.started': this.onTaskStarted(record, time); break
        case 'task.terminated': this.onTaskTerminated(record, time); break
        case 'context.apply_compaction': this.onCompaction(record, time, out); break
        case 'context.clear':
          this.flushStep(out, time, undefined)
          this.prune(out, time, [...this.liveSeqs], 'context-clear')
          this.undoAnchors.length = 0
          this.ownedInjections.clear()
          break
        case 'context.undo': this.onUndo(record, time, out); break
        case 'plan_mode.enter':
          this.emit(out, 'plan/mode', time, { active: true })
          break
        case 'plan_mode.exit':
        case 'plan_mode.cancel':
          this.emit(out, 'plan/mode', time, { active: false })
          break
        default:
          // `metadata` (time source only), `mcp.tools_discovered`,
          // `permission.*`, `interaction.*`, `prompt.accepted`/`steered`,
          // `token_counting.*`, `file_history.*`, `tools.update_store`,
          // `task.waitDelivered`, `plugin.session_start`,
          // `context.update_token_count` and `turn.cancel` carry nothing the
          // context composition can use (`turn.cancel` is always followed by
          // the interrupted/ended records that do the work).
          break
      }
    } catch {
      // The transcript is untrusted input: a malformed record yields whatever
      // events were already produced for this line and never throws.
    }
    return out
  }

  meta(): SynthMeta {
    return {
      ...(this.model === undefined ? {} : { model: this.model }),
      provider: this.provider,
      ...(this.label === undefined ? {} : { label: this.label }),
      // Liveness is the prompt lifecycle, not the step buffer: a turn is
      // running from `turn.prompt`/`turn.steer` (or a step opening) until
      // `turn.ended`/`prompt.completed`/`prompt.aborted`.
      running: this.turnOpen,
      children: this.children,
      // Kimi records neither a CLI version in the wire log (only
      // `metadata.protocol_version`) nor a cost rollup, so `version` and
      // `reportedCostUsd` stay absent — the cost card prices from usage.
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

  /** Emit a surface-bearing event and remember its seq for the next compaction/prune claim. */
  private emitSurface(
    out: TimelineEvent[],
    type: string,
    time: number,
    data: Record<string, unknown>,
    surfaceOp?: unknown,
  ): number {
    const seq = this.emit(out, type, time, data, surfaceOp)
    this.surfaceEvents.set(seq, { type, seq, time, data })
    this.surfaceCheckpoint = appendSurface(this.surfaceCheckpoint, { type, seq, time, data })
    this.liveSeqs.push(seq)
    return seq
  }

  // ---------------------------------------------------------------------------
  // Header: profile.bind (system prompt) + llm.tools_snapshot (tool schemas)
  // ---------------------------------------------------------------------------

  /**
   * `profile.bind` carries the FULL system prompt verbatim plus the profile's
   * model alias — Kimi is the one harness of the three that records the prompt
   * outright, so the fold never has to derive it as a remainder.
   */
  private onProfileBind(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    this.applyAlias(asString(record['modelAlias']))
    const system = asString(record['systemPrompt'])
    if (!this.headerEmitted) {
      if (system !== undefined && system !== '') this.systemText = system
      this.headerPending = true
      return
    }
    // A rebind (profile switch) with a different prompt is a new header epoch.
    if (system !== undefined && system !== '' && system !== this.systemText) {
      this.systemText = system
      this.emitHeader(out, time, 'change')
    }
  }

  /**
   * The model alias (`kimi-code/k3`) names the PRICING provider and, until the
   * first `llm.request`, the model itself (its tail after the `/`).
   */
  private applyAlias(alias: string | undefined): void {
    if (alias === undefined || alias === '') return
    this.provider = alias.startsWith(SUBSCRIPTION_ALIAS_PREFIX) ? PROVIDER_SUBSCRIPTION : PROVIDER_PUBLIC
    if (this.modelFromRequest) return
    const tail = alias.slice(alias.lastIndexOf('/') + 1)
    if (tail !== '') this.model = tail
  }

  /**
   * `llm.tools_snapshot` is the exact tool-schema array that was sent, emitted
   * whenever its `hash` changes. It is what makes the fold's Tool Schemas
   * figure REAL for Kimi (`toolsKnown`), where Codex records nothing.
   */
  private onToolsSnapshot(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const tools = asArray(record['tools'])
    if (tools !== undefined) this.tools = [...tools]
    const hash = asString(record['hash'])
    const changed = !this.sawToolsSnapshot || hash !== this.toolsHash
    this.sawToolsSnapshot = true
    this.toolsHash = hash
    if (this.headerPending) this.flushHeader(out, time)
    else if (changed) this.emitHeader(out, time, 'change')
  }

  /**
   * Emit the opening `request/header`.
   *
   * DEVIATION (design said "a step beginning before any snapshot flushes the
   * header with `tools: []`"): the flush is triggered by the first tool
   * snapshot or by the step SETTLE (`flushStep`, just before the
   * `assistant/message` the header describes), never by `step.begin`. In the
   * real record order `step.begin` precedes the first `llm.tools_snapshot` in
   * EVERY session, so flushing at `step.begin` would make the initial epoch
   * permanently tool-less and turn the very first snapshot into a spurious
   * 'change'. Because steps are buffered, nothing between `step.begin` and the
   * settle needs the header, and the later trigger yields exactly one
   * 'initial' header already carrying both the system prompt and the tools —
   * the same reasoning as the Codex synthesizer's deferral. The tools-less
   * fallback still exists: a step that settles before any snapshot flushes the
   * header with whatever it has.
   */
  private flushHeader(out: TimelineEvent[], time: number): void {
    if (!this.headerPending) return
    this.headerPending = false
    this.headerEmitted = true
    this.emit(out, 'request/header', time, { header: this.headerPayload(), reason: 'initial' })
  }

  private emitHeader(out: TimelineEvent[], time: number, reason: 'initial' | 'change'): void {
    this.headerPending = false
    this.headerEmitted = true
    this.emit(out, 'request/header', time, { header: this.headerPayload(), reason })
  }

  /**
   * `config` rides INSIDE `header` — that is where the fold reads the model and
   * provider from. `header.system` is REPEATED on every change header: the fold
   * clears its envelope-sourced system prompt when a later header carries none,
   * so omitting it would silently zero the System Prompt figure.
   */
  private headerPayload(): Record<string, unknown> {
    return {
      ...(this.systemText === undefined ? {} : { system: this.systemText }),
      tools: this.tools,
      config: {
        ...(this.model === undefined ? {} : { model: this.model }),
        provider: this.provider,
      },
    }
  }

  /**
   * `llm.request` names the model actually dispatched (`k3`), the alias (the
   * pricing provider). `maxTokens` is a completion cap in current builds;
   * older recordings do not identify its semantics, so it supplies no window.
   */
  private onRequest(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    this.auxiliaryRequest = asString(record['kind']) === 'compaction'
    if (this.auxiliaryRequest) {
      this.flushStep(out, time, undefined)
      this.pendingUsage = undefined
      this.responseEnd = undefined
      return
    }
    this.applyAlias(asString(record['modelAlias']))
    const model = asString(record['model'])
    if (model !== undefined && model !== '') {
      const previous = this.model
      this.modelFromRequest = true
      this.model = model
      // A model switch has no dedicated record: it is a header that differs
      // from the previous one. A still-pending header just carries the new
      // model into its 'initial' epoch.
      if (this.headerEmitted && previous !== undefined && previous !== model) {
        this.emitHeader(out, time, 'change')
      }
    }
  }

  /**
   * `usage.record` is written when the response completes — BEFORE the step's
   * loop events are flushed — so it supplies both the step's usage fallback
   * (an interrupted `step.end` carries none) and the response-end instant the
   * completion time is computed from.
   */
  private onUsageRecord(record: Record<string, unknown>, time: number): void {
    if (this.auxiliaryRequest || asString(record['kind']) === 'compaction') return
    const usage = usageOf(record['usage'])
    if (usage === undefined) return
    this.pendingUsage = usage
    this.responseEnd = time
  }

  // ---------------------------------------------------------------------------
  // context.append_message — the canonical context entry
  // ---------------------------------------------------------------------------

  private onAppendMessage(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const message = record['message']
    if (!isRecord(message)) return
    if (asString(message['role']) !== 'user') return
    // Human vs injected is decided by the ORIGIN, never by the text — and by
    // the SAME function core's Kimi adapter uses, so the trajectory view's
    // prompt count and this view's `humanInputs` can never disagree.
    const cls = kimiMessageClass(message['origin'])
    // `context.apply_compaction` already emitted the summary node; the mirrored
    // `compaction_summary` message would double it.
    if (cls.kind === 'compaction' && this.pendingCompactionSummary) {
      this.pendingCompactionSummary = false
      return
    }
    const content = contentBlocksOf(asArray(message['content']) ?? [])
    const origin = isRecord(message['origin']) ? message['origin'] : undefined
    const anchor = origin === undefined || origin['kind'] === 'user'
      || ((origin['kind'] === 'skill_activation' || origin['kind'] === 'plugin_command') && origin['trigger'] === 'user-slash')
    if (anchor) {
      this.flushStep(out, time, undefined)
      const id = asString(message['id'])
      const owned = id === undefined ? undefined : this.ownedInjections.get(id)
      let before = this.surfaceCheckpoint
      while (before !== null && owned?.has(before.value.seq)) before = before.previous
      this.undoAnchors.push(before)
    }
    if (cls.kind === 'human') {
      // DEVIATION (design said "any user message closes an open group"): only a
      // HUMAN message settles the buffered step. Kimi marks its step boundaries
      // explicitly (`step.end`, `turn.step.interrupted`, `turn.ended`), and the
      // injected variants (`interruption`, `permission_mode`, `context_budget`,
      // `todo_list_reminder`) are appended to the context WHILE the loop runs —
      // settling on them would split one model response into two request
      // records with one usage between them.
      this.flushStep(out, time, undefined)
      if (!this.turnOpen) {
        this.turn += 1
        this.step = 0
        this.turnOpen = true
      }
      const text = kimiTitleText(textOf(content))
      if (this.label === undefined && text.trim() !== '') this.label = titleFrom(text, LABEL_MAX)
      const seq = this.emitSurface(out, 'user/message', time, {
        content,
        source: { kind: 'user' } satisfies MessageSource,
      })
      this.humanSeqs.push(seq)
      return
    }
    const seq = this.emitSurface(out, 'user/message', time, { content, source: sourceOfClass(cls) })
    const owner = origin?.['kind'] === 'injection' ? asString(origin['ownerPromptId']) : undefined
    if (owner !== undefined) {
      const owned = this.ownedInjections.get(owner) ?? new Set<number>()
      owned.add(seq)
      this.ownedInjections.set(owner, owned)
    }
  }

  // ---------------------------------------------------------------------------
  // context.append_loop_event — the model loop
  // ---------------------------------------------------------------------------

  private onLoopEvent(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const event = record['event']
    if (!isRecord(event)) return
    switch (asString(event['type'])) {
      case 'step.begin': this.onStepBegin(event, time, out); break
      case 'content.part': this.onContentPart(event, time, out); break
      case 'tool.call': this.onToolCall(event, time, out); break
      case 'tool.result': this.onToolResult(event, time, out); break
      case 'step.end': this.onStepEnd(event, time, out); break
      default: break
    }
  }

  private onStepBegin(event: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    // A step that never ended (a crash, a truncated file) settles here.
    this.flushStep(out, time, undefined)
    // Unit trap 2: `turnId` is a string here, turns are 0-based, steps 1-based.
    const turn = turnNumberOf(event['turnId'])
    this.turn = turn === undefined ? Math.max(1, this.turn) : turn + 1
    this.step = asNumber(event['step']) ?? this.step + 1
    this.turnOpen = true
    this.emit(out, 'step/start', time)
    this.open = {
      start: time,
      turn: this.turn,
      step: this.step,
      blocks: [],
      results: [],
      callIds: new Set<string>(),
    }
  }

  /** The step a loop event belongs to, opening one when `step.begin` was missed. */
  private ensureStep(out: TimelineEvent[], time: number): OpenStep {
    const open = this.open
    if (open !== null) return open
    if (this.turn === 0) this.turn = 1
    this.step += 1
    this.emit(out, 'step/start', time)
    const created: OpenStep = {
      start: time,
      turn: this.turn,
      step: this.step,
      blocks: [],
      results: [],
      callIds: new Set<string>(),
    }
    this.open = created
    return created
  }

  private onContentPart(event: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const part = event['part']
    if (!isRecord(part)) return
    const type = asString(part['type'])
    if (type === 'think') {
      this.ensureStep(out, time).blocks.push({ type: 'reasoning', text: asString(part['think']) ?? '' })
      return
    }
    if (type === 'text') {
      const text = asString(part['text'])
      if (text === undefined) return
      this.ensureStep(out, time).blocks.push({ type: 'text', text })
    }
  }

  private onToolCall(event: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const callId = asString(event['toolCallId'])
    if (callId === undefined || callId === '') return
    const name = asString(event['name']) ?? 'tool'
    const raw = event['args']
    const step = this.ensureStep(out, time)
    step.blocks.push({ type: 'tool-call', name, arguments: jsonOrEmpty(raw), callId })
    step.callIds.add(callId)
    this.rememberCall(callId, { name, args: isRecord(raw) ? raw : undefined })
  }

  private rememberCall(callId: string, info: CallInfo): void {
    this.calls.delete(callId)
    this.calls.set(callId, info)
    if (this.calls.size > CALLS_MAX) {
      const oldest = this.calls.keys().next().value
      if (oldest !== undefined) this.calls.delete(oldest)
    }
  }

  private onToolResult(event: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const callId = asString(event['toolCallId'])
    if (callId === undefined || callId === '') return
    const result = isRecord(event['result']) ? event['result'] : {}
    // `output` is a plain string, or a content-part array when the result
    // carries media (ReadMediaFile's `{ type: 'image_url' }` parts).
    const raw = result['output']
    const content: ContentBlock[] = typeof raw === 'string'
      ? [{ type: 'text', text: raw }]
      : contentBlocksOf(asArray(raw) ?? [])
    const note = asString(result['note'])
    // `result.note` is the harness's own annotation on the output (truncation,
    // a permission remark); it is context the model saw, so it is sized as a
    // second text block rather than folded into the output string.
    if (note !== undefined && note !== '') content.push({ type: 'text', text: note })
    this.bindAgentFromResult(callId, textOf(content), time)
    const open = this.open
    // A result belonging to THIS step rides its settle (so the fold sees
    // call-then-result in order); one whose call came from an already-settled
    // step goes out immediately at its own time.
    if (open !== null && open.callIds.has(callId)) {
      open.results.push({ callId, content, isError: result['isError'] === true, time })
      return
    }
    this.emitToolResult(out, callId, content, result['isError'] === true, time)
  }

  private onStepEnd(event: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    this.flushStep(out, time, {
      usage: usageOf(event['usage']),
      ttftMs: asNumber(event['llmFirstTokenLatencyMs']),
      streamMs: asNumber(event['llmStreamDurationMs']),
    })
  }

  /**
   * Settle the buffered step: the whole model response goes out in fold order
   * with computed instants (unit trap 3).
   *
   *   completed = the `usage.record` instant when it is ≥ the step start,
   *               else `stepStart + llmStreamDurationMs`,
   *               else the settling record's own time.
   *
   * A step settled WITHOUT a `step.end` (interrupted, turn ended, the next
   * `step.begin`) emits the same sequence without usage and without a stream:
   * neither figure exists for it.
   */
  private flushStep(out: TimelineEvent[], time: number, end: StepEnd | undefined): void {
    const open = this.open
    if (open === null) return
    this.open = null
    const pendingUsage = this.pendingUsage
    const responseEnd = this.responseEnd
    this.pendingUsage = undefined
    this.responseEnd = undefined
    if (open.blocks.length === 0 && open.results.length === 0) {
      // Nothing was generated (an abort between `step.begin` and the first
      // token): close the open step without inventing an empty request record.
      this.emit(out, 'step/end', Math.max(time, open.start))
      return
    }
    const usage = end === undefined ? undefined : (end.usage ?? pendingUsage)
    const completed = completionOf(open.start, responseEnd, end?.streamMs, time)
    // The header must fold before the request it describes.
    this.flushHeader(out, open.start)
    const stream = end === undefined ? [] : buildStream(open, end.ttftMs, completed)
    this.emitSurface(out, 'assistant/message', completed, {
      message: { content: open.blocks },
      ...(usage === undefined ? {} : { usage }),
      turn: open.turn,
      step: open.step,
      ...(stream.length === 0 ? {} : { stream }),
    })
    setRequestInput(out.at(-1), disjointInput(usage, this.model))
    let calls = 0
    for (const block of open.blocks) {
      if (block.type !== 'tool-call' || block.callId === undefined) continue
      calls += 1
      this.emit(out, 'tool/call', completed, {
        callId: block.callId,
        name: block.name ?? 'tool',
        ...(block.arguments === undefined ? {} : { arguments: block.arguments }),
      })
    }
    let last = completed
    for (const result of open.results) {
      // The flush time can predate the computed completion (the loop events are
      // written in one batch); clamp so the stream stays monotonic.
      const at = Math.max(result.time, completed)
      this.emitToolResult(out, result.callId, result.content, result.isError, at)
      if (at > last) last = at
    }
    this.emit(out, 'step/end', calls === 0 ? completed : last)
  }

  private emitToolResult(
    out: TimelineEvent[],
    callId: string,
    content: ContentBlock[],
    isError: boolean,
    time: number,
  ): void {
    const call = this.calls.get(callId)
    // File ops come from the CALL's arguments: Kimi's `file_history.*` records
    // are undo snapshots, and a tool result carries no structured file report.
    const ops = call === undefined ? [] : fileOpsOf(call.name, call.args)
    this.emitSurface(out, 'tool/result', time, {
      message: {
        content: [{ type: 'tool-result', toolCallId: callId, isError, content }],
        source: { callId, ...(call === undefined ? {} : { name: call.name }) },
      },
      ...(isError ? { error: true } : {}),
      ...(ops.length === 0 ? {} : { fileOps: ops }),
    })
    this.calls.delete(callId)
  }

  // ---------------------------------------------------------------------------
  // Children
  // ---------------------------------------------------------------------------

  /**
   * `task.started` with `info.kind === 'agent'` is the authoritative binding:
   * it names the child's agent id (its `agents/<agentId>/wire.jsonl` directory,
   * which is also the child file's id) AND the parent tool call that spawned it.
   */
  private onTaskStarted(record: Record<string, unknown>, time: number): void {
    const info = record['info']
    if (!isRecord(info)) return
    if (asString(info['kind']) !== 'agent') return
    const agentId = asString(info['agentId'])
    if (agentId === undefined || agentId === '') return
    const callId = asString(info['parentToolCallId'])
    const agentType = asString(info['subagentType'])
    const model = asString(info['model'])
    const description = asString(info['description'])
    this.children.set(agentId, {
      key: agentId,
      label: titleFrom(description ?? 'subagent', LABEL_MAX),
      ...(agentType === undefined ? {} : { agentType }),
      ...(model === undefined ? {} : { model }),
      ...(callId === undefined ? {} : { callId }),
      startedAt: parseTime(info['startedAt']) ?? time,
    })
    const taskId = asString(info['taskId'])
    if (taskId !== undefined) this.tasks.set(taskId, agentId)
    if (callId !== undefined) this.boundCalls.add(callId)
  }

  private onTaskTerminated(record: Record<string, unknown>, time: number): void {
    const info = record['info']
    if (!isRecord(info)) return
    const taskId = asString(info['taskId'])
    const agentId = (taskId === undefined ? undefined : this.tasks.get(taskId)) ?? asString(info['agentId'])
    if (agentId === undefined) return
    const child = this.children.get(agentId)
    if (child === undefined) return
    this.children.set(agentId, { ...child, completedAt: parseTime(info['endedAt']) ?? time })
  }

  /**
   * Fallback binding when no `task.started` was seen (a foreground launch only
   * ever names the child in its result text): `agentMentions` parses the
   * single-agent `agent_id:` header and the swarm's `<subagent>` elements.
   */
  private bindAgentFromResult(callId: string, output: string, time: number): void {
    if (this.boundCalls.has(callId)) return
    const call = this.calls.get(callId)
    if (call === undefined || !AGENT_TOOLS.has(call.name)) return
    const mentions = agentMentions(output)
    if (mentions.length === 0) return
    this.boundCalls.add(callId)
    const fallbackLabel = asString(call.args?.['description']) ?? asString(call.args?.['prompt']) ?? 'subagent'
    const fallbackType = asString(call.args?.['subagent_type'])
    for (const mention of mentions) {
      // A resumed swarm can echo THIS file's own id (`runtime.set_binding`); an
      // agent is never its own child.
      if (mention.agentId === this.agentId) continue
      if (this.children.has(mention.agentId)) continue
      const agentType = mention.agentType ?? fallbackType
      this.children.set(mention.agentId, {
        key: mention.agentId,
        label: titleFrom(mention.description ?? fallbackLabel, LABEL_MAX),
        ...(agentType === undefined ? {} : { agentType }),
        callId,
        startedAt: time,
        ...(mention.status === null ? {} : { completedAt: time }),
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Compaction / clear / undo
  // ---------------------------------------------------------------------------

  /**
   * `context.apply_compaction` replaces the whole context with one summary
   * message plus a SELECTION OF USER MESSAGES — never whole turns. The kept
   * set is `keptUserMessageCount` prompts: `keptHeadUserMessageCount` of them
   * from the session's head (present only when the selection elided the
   * middle), the rest from the tail. The kept prompts' assistant replies and
   * tool results are compacted away too, so only the human message nodes
   * themselves survive the shadow claim. `legacyTail` marks the older builds
   * whose count describes a raw message slice, so the claim covers everything.
   */
  private onCompaction(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    this.flushStep(out, time, undefined)
    // Kimi's undo precheck stops at a compaction summary; unlike Grok rewind,
    // it cannot restore an older prompt across that boundary.
    this.undoAnchors.length = 0
    this.ownedInjections.clear()
    const kept = this.keptTailSeqs(record)
    const shadowed = this.liveSeqs.filter(seq => !kept.has(seq))
    const tokensBefore = asNumber(record['tokensBefore'])
    this.emit(out, 'compaction/summary', time, {
      shadowedSeqs: shadowed,
      ...(tokensBefore === undefined ? {} : { shadowedTokenCount: tokensBefore }),
    })
    this.liveSeqs = this.liveSeqs.filter(seq => kept.has(seq))
    this.surfaceCheckpoint = checkpointSurface(this.liveSeqs.flatMap(seq => {
      const event = this.surfaceEvents.get(seq)
      return event === undefined ? [] : [event]
    }))
    this.humanSeqs = this.humanSeqs.filter(seq => kept.has(seq))
    // The shadow claim the fold just armed is consumed by the NEXT surface
    // event: the summary must carry the replace op or the shadowed nodes stay
    // on the surface at full price.
    const op = shadowed.length === 0
      ? undefined
      : { op: 'replace', startSeq: Math.min(...shadowed), endSeq: Math.max(...shadowed) }
    this.pendingCompactionSummary = true
    const text = compactionSummaryOf(record)
    this.emitSurface(out, 'user/message', time, {
      content: text === '' ? [] : [{ type: 'text', text }],
      source: { kind: 'plugin', form: 'compaction', plugin: 'compaction' } satisfies MessageSource,
    }, op)
  }

  /** The live seqs the kept selection protects: the kept head and tail HUMAN message nodes. */
  private keptTailSeqs(record: Record<string, unknown>): Set<number> {
    const kept = asNumber(record['keptUserMessageCount'])
    if (kept === undefined || kept <= 0 || record['legacyTail'] === true) return new Set<number>()
    const keptHead = Math.max(0, Math.floor(asNumber(record['keptHeadUserMessageCount']) ?? 0))
    const head = keptHead === 0 ? [] : this.humanSeqs.slice(0, keptHead)
    const tailCount = Math.max(0, Math.floor(kept) - keptHead)
    const tail = tailCount === 0 ? [] : this.humanSeqs.slice(-tailCount)
    const protectedSeqs = new Set([...head, ...tail])
    return new Set(this.liveSeqs.filter(seq => protectedSeqs.has(seq)))
  }

  /** `context.undo` retracts the last `count` context messages. */
  private onUndo(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    this.flushStep(out, time, undefined)
    const count = asNumber(record['count']) ?? 1
    if (!Number.isSafeInteger(count) || count <= 0 || count > this.undoAnchors.length) return
    const index = this.undoAnchors.length - count
    const saved = surfaceValues(this.undoAnchors[index] ?? null)
    this.undoAnchors.length = index
    const events = restoreSurface(this.liveSeqs, saved, time, this.seq + 1, 'context-undo')
    out.push(...events)
    this.seq += events.length
    const restored = events.filter(event => event.type !== 'compaction/prune')
    this.surfaceCheckpoint = checkpointSurface(restored)
    this.liveSeqs = restored.map(event => event.seq)
    this.humanSeqs = restored.filter(event => isRecord(event.data?.source) && event.data.source['kind'] === 'user').map(event => event.seq)
    for (const event of restored) this.surfaceEvents.set(event.seq, event)
    this.turnOpen = false
  }

  /**
   * Free a span of the live surface.
   *
   * DEVIATION (design said "`context.clear` → `compaction/prune { shadowedSeqs:
   * all live }`", full stop): the prune event only ARMS the fold's shadow
   * claim — `fold.ts` consumes it in `applySurface`, so the shadowed nodes
   * leave the surface only when the next surface event carries a `replace` op.
   * A bare prune would log the boundary while the composition kept showing an
   * emptied context at full price. The claim is therefore consumed by a
   * contentless marker `user/message` naming the operation, exactly the way the
   * Codex synthesizer claims a range with no readable replacement. The fold
   * rewrites the prune event's token figure to the amount actually freed, so
   * the marker also makes the events row report the real number.
   */
  private prune(out: TimelineEvent[], time: number, shadowed: readonly number[], plugin: string): void {
    if (shadowed.length === 0) return
    this.emit(out, 'compaction/prune', time, { shadowedSeqs: [...shadowed] })
    const gone = new Set(shadowed)
    this.liveSeqs = this.liveSeqs.filter(seq => !gone.has(seq))
    this.surfaceCheckpoint = checkpointSurface(this.liveSeqs.flatMap(seq => {
      const event = this.surfaceEvents.get(seq)
      return event === undefined ? [] : [event]
    }))
    this.humanSeqs = this.humanSeqs.filter(seq => !gone.has(seq))
    this.emitSurface(out, 'user/message', time, {
      content: [],
      source: { kind: 'plugin', form: 'compaction', plugin } satisfies MessageSource,
    }, { op: 'replace', startSeq: Math.min(...shadowed), endSeq: Math.max(...shadowed) })
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/**
 * The fold source for an injected `context.append_message`.
 *
 * DEVIATION (design said `kind: 'skill'` for a skill activation): the fold
 * books its `skill` composition bucket on the source kinds `skill-invocation`
 * and `skill-catalog` (`fold.ts` `categoryOf`), and labels the events row from
 * `skill-invocation` too. A bare `'skill'` kind would price the activation as
 * ordinary injected context, so the contract's intent ("use the form fold.ts
 * expects") is met with `skill-invocation` + `form: 'skill'`.
 */
function sourceOfClass(cls: KimiMessageClass): MessageSource {
  switch (cls.kind) {
    case 'human': return { kind: 'user' }
    case 'task': return { kind: 'task-notification', form: 'context', name: cls.name }
    case 'skill': return { kind: 'skill-invocation', form: 'skill', name: cls.name }
    case 'plugin': return { kind: 'plugin-command', form: 'context' }
    case 'compaction': return { kind: 'plugin', form: 'compaction', plugin: 'compaction' }
    default: return { kind: cls.name, form: 'context' }
  }
}

/**
 * The step's completion instant. `usage.record` is written when the response
 * completes, so its own record time is the best measurement available; the
 * harness's decode duration is the fallback, and the settling record's time the
 * last resort. Never earlier than the step start.
 */
function completionOf(
  start: number,
  responseEnd: number | undefined,
  streamMs: number | undefined,
  fallback: number,
): number {
  if (responseEnd !== undefined && responseEnd >= start) return responseEnd
  if (streamMs !== undefined && Number.isFinite(streamMs) && streamMs >= 0) return start + streamMs
  return Math.max(fallback, start)
}

/**
 * The embedded stream the fold reads for this step's first-token instant and
 * its decode split.
 *
 * Kimi measures TTFT itself (`step.end.llmFirstTokenLatencyMs`, relative to the
 * request start = `step.begin.time`), so the token chunk is a RECORDED figure
 * here, not the inference the Codex synthesizer has to make. What Kimi does NOT
 * record is per-block timing: the parts are flushed in one batch after the
 * response (unit trap 3), so every `block-start` is stamped at the first-token
 * instant. The fold then tiles the decode window with zero-length spans for all
 * but the last block — the honest reading of "the blocks are not individually
 * timed" — while the wait/decode split stays exact.
 */
function buildStream(step: OpenStep, ttftMs: number | undefined, completed: number): StreamRecord[] {
  const stream: StreamRecord[] = []
  let blockStart = step.start
  if (ttftMs !== undefined && Number.isFinite(ttftMs) && ttftMs >= 0) {
    const at = step.start + ttftMs
    if (at >= step.start && at <= completed) {
      // The text is a marker only: the fold reads the chunk's INSTANT and needs
      // a non-empty delta to recognize it as a token (`logShapes.isTokenChunk`).
      stream.push({ type: 'chunk', time: at, chunk: { type: 'text-delta', text: ' ' } })
      blockStart = at
    }
  }
  for (const block of step.blocks) {
    const blockType = block.type === 'reasoning' ? 'reasoning' : block.type === 'tool-call' ? 'tool-call' : 'text'
    stream.push({ type: 'chunk', time: blockStart, chunk: { type: 'block-start', blockType } })
  }
  return stream
}

/**
 * Kimi's usage buckets → the fold's disjoint vocabulary. The four fields are
 * already disjoint (`inputOther` is the UNCACHED prompt share, not the total:
 * the format's own rule is `prompt = inputOther + inputCacheRead +
 * inputCacheCreation`), so unlike Codex's nested figures nothing is subtracted.
 * `inputCacheCreation` has been 0 in every observed record.
 */
function usageOf(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value['inputOther'])
  const cacheRead = asNumber(value['inputCacheRead'])
  const cacheWrite = asNumber(value['inputCacheCreation'])
  const output = asNumber(value['output'])
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined && output === undefined) {
    return undefined
  }
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    outputTokens: output ?? 0,
  }
}

/** A message's content array → fold content blocks. */
function contentBlocksOf(items: readonly unknown[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const type = asString(item['type'])
    // Kimi's own spelling is `image_url`; `image`/`input_image` are the other
    // harnesses' habits, kept for forward compatibility.
    if (type === 'image_url' || type === 'image' || type === 'input_image') {
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
 * The compaction summary text AS IT ENTERS THE CONTEXT: current builds put the
 * context's message in `contextSummary` (the shorter `summary` is the working
 * summary the trajectory view shows). The legacy shape put a whole message
 * object in `summary`.
 */
function compactionSummaryOf(record: Record<string, unknown>): string {
  const context = asString(record['contextSummary'])
  if (context !== undefined && context !== '') return context
  const summary = record['summary']
  const direct = asString(summary)
  if (direct !== undefined && direct !== '') return direct
  if (isRecord(summary)) {
    const text = textOf(contentBlocksOf(asArray(summary['content']) ?? []))
    if (text !== '') return text
    const legacy = asString(summary['text'])
    if (legacy !== undefined) return legacy
  }
  const message = record['contextMessage']
  if (isRecord(message)) return textOf(contentBlocksOf(asArray(message['content']) ?? []))
  return ''
}

/**
 * File operations read off a tool call's ARGUMENTS. Kimi's tool results carry
 * no structured file report (its `file_history.*` records are undo snapshots
 * of a different shape), so the arguments are the whole evidence — which is
 * also why line deltas are the argument-derived estimates the `FileOpRecord`
 * contract already describes.
 */
function fileOpsOf(name: string, args: Record<string, unknown> | undefined): FileOpInput[] {
  if (args === undefined) return []
  switch (name) {
    case 'Read': {
      const path = asString(args['path'])
      if (path === undefined || path === '') return []
      const offset = asNumber(args['offset'])
      const limit = asNumber(args['limit'])
      if (offset !== undefined && limit !== undefined) {
        return [{ kind: 'read', path, read: { start: offset, count: limit } }]
      }
      // Only a limit: the window's start is unknown, so the count rides as the
      // argument-derived estimate the record type reserves for exactly this.
      if (limit !== undefined) return [{ kind: 'read', path, read: { count: limit, est: true } }]
      return [{ kind: 'read', path }]
    }
    case 'Write': {
      const path = asString(args['path'])
      if (path === undefined || path === '') return []
      return [{ kind: 'write', path, added: lineCount(asString(args['content']) ?? '') }]
    }
    case 'Edit': {
      const path = asString(args['path'])
      if (path === undefined || path === '') return []
      return [{
        kind: 'write',
        path,
        added: lineCount(asString(args['new_string']) ?? ''),
        removed: lineCount(asString(args['old_string']) ?? ''),
      }]
    }
    case 'Grep':
    case 'Glob': {
      const pattern = asString(args['pattern'])
      const path = asString(args['path'])
      const target = path !== undefined && path !== '' ? path : pattern
      if (target === undefined || target === '') return []
      return [{
        kind: 'search',
        path: target,
        // A pathless search books the PATTERN as its path; the marker keeps the
        // client from relativizing it as a file.
        ...(path !== undefined && path !== '' ? {} : { pattern: true as const }),
        ...(pattern === undefined || pattern === '' ? {} : { detail: pattern }),
      }]
    }
    default:
      // Bash, WaitFor, TodoList, Skill, FetchURL, WebSearch, Agent/AgentSwarm,
      // AskUserQuestion, plan-mode toggles and every `mcp__*` tool name no
      // file identity can be read from their arguments.
      return []
  }
}

function lineCount(text: string): number {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

/** The loop's `turnId` (unit trap 2: a string on loop events, a number elsewhere). */
function turnNumberOf(value: unknown): number | undefined {
  const direct = asNumber(value)
  if (direct !== undefined) return direct
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
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

export function createKimiSynthesizer(_file: SessionFileRef): EventSynthesizer {
  return new KimiSynthesizer()
}
