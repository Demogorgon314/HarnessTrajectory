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
import { asArray, asNumber, asString, isCodexHumanPrompt, isRecord, parseJsonLine, parseTime } from '@harness-trajectory/core'
import type { ContentBlock, MessageSource, StreamRecord, TimelineEvent } from '../fold/event.ts'
import type { FileOpInput } from '../fold/fold.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'

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
const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call'])
/** Response-item types that settle a tool call. */
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'])

/** One model response being accumulated (Codex logs its blocks as separate lines). */
interface OpenGroup {
  blocks: ContentBlock[]
  /** Completion instant of each block, parallel to `blocks`. */
  blockTimes: number[]
  /** The step instant this group is generating against. */
  stepStart: number
  lastTime: number
  /** Earliest `item_completed.started_at_ms` of a Reasoning/AgentMessage item seen while open. */
  firstTokenAt?: number
}

/** A tool call awaiting its output. */
interface OpenCall {
  callId: string
  name: string
}

/** A tool call whose `tool/result` already folded (the target of a late `tool/ops`). */
interface SettledCall {
  callId: string
  /** The `tool/result` event's own seq — the fold files late ops under it. */
  resultSeq: number
  name: string
}

class CodexSynthesizer implements EventSynthesizer {
  readonly kind = 'codex' as const

  private seq = 0
  private lastTime = 0

  // ---- meta -----------------------------------------------------------------
  private model: string | undefined
  private provider = DEFAULT_PROVIDER
  private contextWindow: number | undefined
  private label: string | undefined
  /** Label for a thread with no human prompt of its own (a subagent thread). */
  private fallbackLabel: string | undefined
  private version: string | undefined

  // ---- turn / step ----------------------------------------------------------
  private turn = 0
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

  // ---- header ---------------------------------------------------------------
  private systemText: string | undefined
  private tools: unknown[] = []
  /** `session_meta` was read but its header is not emitted yet (see `flushHeader`). */
  private headerPending = false

  // ---- tool pairing ---------------------------------------------------------
  private openCall: OpenCall | null = null
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
  /** Seqs of every live surface node (user/tool/assistant), for the compaction claim. */
  private liveSeqs: number[] = []
  private threadTotalTokens = 0

  // ---- injections -----------------------------------------------------------
  private developerInstructions: string | undefined
  private sawDeveloperMessage = false
  private readonly worldStateSized = new Set<string>()

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
      switch (type) {
        case 'session_meta': this.onSessionMeta(payload, time); break
        case 'turn_context': this.onTurnContext(payload, time, out); break
        case 'event_msg': this.onEventMsg(payload, time, out); break
        case 'response_item': this.onResponseItem(payload, time, out); break
        case 'token_usage_record': this.onTokenUsage(payload, time, out); break
        case 'compacted': this.onCompacted(payload, time, out); break
        case 'world_state': this.onWorldState(payload, time, out); break
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
    this.liveSeqs.push(seq)
    return seq
  }

  // ---------------------------------------------------------------------------
  // session_meta / header
  // ---------------------------------------------------------------------------

  private onSessionMeta(payload: Record<string, unknown>, _time: number): void {
    this.version = asString(payload['cli_version']) ?? this.version
    const provider = asString(payload['model_provider'])
    if (provider !== undefined && provider !== '') this.provider = provider
    const instructions = payload['base_instructions']
    const text = isRecord(instructions) ? asString(instructions['text']) : asString(instructions)
    if (text !== undefined && text !== '') this.systemText = text
    // `dynamic_tools` is an array of GROUPS, each with its own `tools` array
    // (verified: 2 of 82 rollouts carry it; every other session records no
    // tool schemas at all, which is what makes the fold's "not recorded"
    // Tool Schemas state the normal Codex case).
    const groups = asArray(payload['dynamic_tools'])
    if (groups !== undefined) {
      const tools: unknown[] = []
      for (const group of groups) {
        if (!isRecord(group)) continue
        for (const tool of asArray(group['tools']) ?? []) tools.push(tool)
      }
      if (tools.length > 0) this.tools = tools
    }
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

  private onTurnContext(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const model = asString(payload['model'])
    if (model !== undefined && model !== '') {
      if (this.headerPending) {
        this.model = model
        this.flushHeader(out, time)
      } else if (this.model !== model) {
        this.model = model
        // A model switch has no dedicated durable event: it is a header that
        // differs from the previous one. `header.system` is REPEATED here (the
        // design sketch said to omit it) because the fold clears its
        // header-sourced system prompt when a later header carries none —
        // omitting it would silently zero the System Prompt figure.
        this.emit(out, 'request/header', time, {
          header: {
            ...(this.systemText === undefined ? {} : { system: this.systemText }),
            tools: this.tools,
            config: { model, provider: this.provider },
          },
          reason: 'change',
        })
      }
    }
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
        if (isRecord(info)) this.applyContextWindow(out, asNumber(info['model_context_window']), time)
        return
      }
      case 'item_completed': {
        this.onItemCompleted(payload, time, out)
        return
      }
      default:
        return
    }
  }

  private applyContextWindow(out: TimelineEvent[], window: number | undefined, time: number): void {
    if (window === undefined || window <= 0 || window === this.contextWindow) return
    this.contextWindow = window
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
    const call = this.openCall
    if (call !== null) {
      if (failed) this.failedCalls.add(call.callId)
      this.bufferOps(call.callId, ops)
      return
    }
    this.lateOps(payload, item, ops, failed, time, out)
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
    if (ops.length === 0) return
    const itemId = asString(item['id'])
    const exact = itemId === undefined ? undefined : this.settledCalls.get(itemId)
    const target = exact ?? (this.settledSinceOpen === 1 ? this.lastSettled : null)
    if (target === null || target === undefined) {
      this.ambiguousLateOps += 1
      return
    }
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
    // `response_item.type === 'compaction'` is the encrypted summary item; the
    // `compacted` record carries the readable structure, so this one is ignored.
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
    const hasImage = content.some(block => block.type === 'image')
    const text = textOf(content)
    const injected = hasImage ? null : injectedKindOf(text)
    if (injected !== null) {
      this.emitSurface(out, 'user/message', time, {
        content,
        source: { kind: injected, form: 'context' } satisfies MessageSource,
      })
      this.lastInputTime = time
      return
    }
    // A human prompt. `task_started` already opened the turn (verified: 920 of
    // 921 user messages follow their turn's `task_started`); the increment here
    // only covers a transcript that starts mid-turn.
    if (!this.turnOpen) {
      this.turn += 1
      this.step = 0
      this.turnOpen = true
      this.openStep(out, time)
    }
    if (this.label === undefined && text.trim() !== '') this.label = labelOf(text)
    this.emitSurface(out, 'user/message', time, {
      content,
      source: { kind: 'user' } satisfies MessageSource,
    })
    this.lastInputTime = time
  }

  private onToolCall(payload: Record<string, unknown>, type: string, time: number, out: TimelineEvent[]): void {
    const callId = asString(payload['call_id']) ?? asString(payload['id'])
    if (callId === undefined) return
    const name = type === 'local_shell_call' ? 'local_shell' : (asString(payload['name']) ?? 'tool')
    // `custom_tool_call` carries `input` (a JSON string), `function_call`
    // carries `arguments`; `local_shell_call` carries a structured `action`.
    const args = asString(payload['input'])
      ?? asString(payload['arguments'])
      ?? jsonOrUndefined(payload['action'] ?? payload['input'] ?? payload['arguments'])
      ?? ''
    this.appendBlock(out, { type: 'tool-call', name, arguments: args, callId }, time)
    this.openCall = { callId, name }
    // In-band items now belong to THIS call; the late-pairing candidate count
    // restarts from here.
    this.settledSinceOpen = 0
  }

  private onToolOutput(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const callId = asString(payload['call_id'])
    if (callId === undefined) return
    // The output settles the model response if no `token_usage_record` did.
    this.closeGroup(out, time, undefined)
    const raw = payload['output']
    const content = typeof raw === 'string'
      ? [{ type: 'text' as const, text: raw }]
      : contentBlocksOf(asArray(raw) ?? [])
    // Codex records no error flag on the output itself; the paired
    // `item_completed.item.status === 'failed'` is the only signal, and it
    // lands before the output in the common ordering.
    const isError = this.failedCalls.delete(callId)
    const ops = this.pendingOps.get(callId)
    this.pendingOps.delete(callId)
    const name = this.openCall?.callId === callId ? this.openCall.name : undefined
    const resultSeq = this.emitSurface(out, 'tool/result', time, {
      message: {
        content: [{ type: 'tool-result', toolCallId: callId, isError, content }],
        source: { callId },
      },
      ...(isError ? { error: true } : {}),
      ...(ops === undefined || ops.length === 0 ? {} : { fileOps: ops }),
    })
    this.rememberSettled({ callId, resultSeq, name: name ?? '' })
    if (this.openCall?.callId === callId) this.openCall = null
    this.lastInputTime = time
    if (this.awaitingResults > 0) this.awaitingResults -= 1
    if (this.awaitingResults === 0) this.closeStep(out, time)
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
      blocks: [],
      blockTimes: [],
      stepStart: this.stepStartTime === 0 ? time : this.stepStartTime,
      lastTime: time,
    }
    this.group = group
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
    this.emitSurface(out, 'assistant/message', completed, {
      message: { content: group.blocks },
      ...(usage === undefined ? {} : { usage }),
      turn: this.turn,
      step: this.step,
      ...(stream.length === 0 ? {} : { stream }),
    })
    let calls = 0
    for (const block of group.blocks) {
      if (block.type !== 'tool-call' || block.callId === undefined) continue
      calls += 1
      this.emit(out, 'tool/call', completed, {
        callId: block.callId,
        name: block.name ?? 'tool',
        ...(block.arguments === undefined ? {} : { arguments: block.arguments }),
      })
    }
    this.awaitingResults = calls
    // A response with no tool call ends its step here; otherwise the step ends
    // when the last result lands (see `onToolOutput`).
    if (calls === 0) this.closeStep(out, completed)
  }

  private onTokenUsage(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const thread = payload['thread_token_usage']
    if (isRecord(thread)) {
      const total = asNumber(thread['total_tokens'])
      if (total !== undefined) this.threadTotalTokens = total
    }
    this.closeGroup(out, time, usageOf(payload['usage']))
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
   * EVIDENCE (79 compactions): `replacement_history` is the retained history —
   * `message` items (roles user/developer) followed by ONE `compaction` item
   * whose summary is `encrypted_content` (unreadable; `payload.message` is the
   * empty string in every sample). None of those ids is ever re-emitted as a
   * later `response_item`, so no dedupe is needed.
   */
  private onCompacted(payload: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    this.closeGroup(out, time, undefined)
    const shadowed = this.liveSeqs
    this.liveSeqs = []
    const latest = payload['latest_token_usage_record']
    const thread = isRecord(latest) ? latest['thread_token_usage'] : undefined
    const shadowedTokenCount = (isRecord(thread) ? asNumber(thread['total_tokens']) : undefined)
      ?? this.threadTotalTokens
    this.emit(out, 'compaction/summary', time, { shadowedSeqs: [...shadowed], shadowedTokenCount })
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
    for (const entry of asArray(payload['replacement_history']) ?? []) {
      if (!isRecord(entry)) continue
      if (asString(entry['type']) === 'compaction') {
        // The summary itself: encrypted, so it is recorded as an empty-content
        // node that still carries the compaction identity for the UI.
        emitReplacement([], {
          kind: 'plugin',
          form: 'compaction',
          plugin: 'compaction',
          ...(windowId === undefined ? {} : { compactionId: windowId }),
        })
        continue
      }
      const role = asString(entry['role'])
      if (role !== 'user' && role !== 'developer') continue
      // Retained history keeps its own text but NOT the human-input identity:
      // re-counting it as a prompt would inflate the session's prompt tally.
      emitReplacement(contentBlocksOf(asArray(entry['content']) ?? []), {
        kind: 'compaction-retained',
        form: 'compaction',
        ...(role === 'developer' ? { name: 'developer' } : {}),
      })
    }
    if (first && op !== undefined) {
      // No readable replacement: still claim the range so the shadowed nodes
      // leave the live surface instead of lingering at full price.
      emitReplacement([], {
        kind: 'plugin',
        form: 'compaction',
        plugin: 'compaction',
        ...(windowId === undefined ? {} : { compactionId: windowId }),
      })
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
 * Codex's usage buckets → the fold's disjoint vocabulary: `input_tokens`
 * INCLUDES the cached half, so the uncached figure is the difference.
 */
function usageOf(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value['input_tokens'])
  const output = asNumber(value['output_tokens'])
  const cached = asNumber(value['cached_input_tokens'])
  const cacheWrite = asNumber(value['cache_write_input_tokens'])
  if (input === undefined && output === undefined && cached === undefined) return undefined
  return {
    inputTokens: Math.max(0, (input ?? 0) - (cached ?? 0)),
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

function labelOf(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? ''
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line
}

/**
 * The injection label for a user-role message, or null when it is a person's
 * prompt. `isCodexHumanPrompt` (core's Codex adapter) owns the human/non-human
 * decision outright, so the trajectory view and the context view can never
 * disagree about what counts as a prompt; this function only NAMES what core
 * already rejected, using core's own labels (`classifyUserText`).
 */
function injectedKindOf(text: string): string | null {
  if (isCodexHumanPrompt(text)) return null
  const trimmed = text.trimStart()
  const tag = /^<([A-Za-z_][\w-]*)/.exec(trimmed)
  if (tag !== null) return tag[1] ?? 'context'
  if (/^#\s*AGENTS\.md\b/.test(trimmed)) return 'agents-md'
  if (/^The following is the Codex agent history/.test(trimmed)) return 'history'
  if (/^Here is a list of /.test(trimmed)) return 'catalog'
  return 'context'
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

function jsonOrUndefined(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

export function createCodexSynthesizer(_file: SessionFileRef): EventSynthesizer {
  return new CodexSynthesizer()
}
