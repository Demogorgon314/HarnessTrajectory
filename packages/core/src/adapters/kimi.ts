/**
 * Kimi Code CLI adapter: folds the wire transcript
 * `$KIMI_CODE_HOME/sessions/<workspace>/session_<uuid>/agents/<agentId>/wire.jsonl`
 * into the harness-agnostic trajectory contract.
 *
 * Verified against kimi 0.42.0 (wire `protocol_version` "1.5"). Every line is
 * `{ type, time, agentId, ... }` (the leading `metadata` line has no `time`).
 * The unit traps this file has to respect, all of them load-bearing below:
 *
 * - `time` is epoch **milliseconds**. `parseTime` accepts both units, so no
 *   caller may scale it.
 * - A loop event's `turnId` is a **string** (`'0'`) while `turn.ended.turnId`
 *   is a **number** (`0`). Turns are 0-based and steps 1-based, so the turn we
 *   display is `Number(turnId) + 1`.
 * - Loop events (`content.part`, `tool.call`, `tool.result`, `step.end`) are
 *   flushed **after** the response, so their `time` is the flush moment, not
 *   when the thing happened: tool durations are not recoverable, and a
 *   `tool.result` can land either side of the `step.end` of the step that
 *   called it. Results seen while a step is open are therefore buffered and
 *   emitted right after the step's assistant record.
 * - `llm.request.provider` is the wire protocol (`'openai'`), never the vendor.
 *   The vendor comes from `modelAlias`: `kimi-code/…` is the subscription
 *   provider `kimi-for-coding`, anything else falls back to `moonshotai`.
 * - `llm.request.maxTokens` is the **context window** (1048576 / 262144), not a
 *   generation cap; it rides `AssistantRequestConfig.maxTokens` for want of a
 *   better field.
 * - Human vs injected input is decided by `message.origin`, never by the text
 *   (see `kimiMessageClass`, which the server scanner and the context
 *   synthesizer share).
 *
 * Subagents live in sibling files: `task.started` with `info.kind === 'agent'`
 * binds the parent's `Agent`/`AgentSwarm` tool call (`info.parentToolCallId`)
 * to the child directory name (`info.agentId`), which is also the child file's
 * id. A child's tool calls are folded into that parent call as sub-calls; its
 * prompts and assistant text stay in its own transcript.
 */

import type {
  AssistantBlock, AssistantRequestConfig, AssistantRequestView, CompactionRequestView,
  ContentBlock, ImageAttachmentRef, KnownContextForm, TokenUsage, TrajectorySnapshot,
} from '../contract.ts'
import { asArray, asNumber, asString, isRecord, parseJsonLine, parseTime } from '../jsonl.ts'
import type {
  ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun, SubagentStatus,
} from '../session.ts'
import { DataUrlImageStore, TrajectoryAssembler, textOf, titleFrom } from './shared.ts'

/** Tools whose result announces a subagent (`agent_id: <id>`) when no `task.started` was seen. */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'AgentSwarm'])
/** `step.end.finishReason` values that mean the response did not run to completion. */
const ABORTED_FINISH_REASONS: ReadonlySet<string> = new Set([
  'aborted', 'abort', 'cancelled', 'canceled', 'interrupted', 'error',
])
/** Launch receipt of a foreground or background agent tool call. */
const AGENT_ID_LINE = /^[ \t]*agent_id:[ \t]*(\S+)/m

/**
 * How a `context.append_message` reached the context. The origin record decides
 * it; the text is never inspected.
 */
export type KimiMessageClass =
  | { readonly kind: 'human' }
  | { readonly kind: 'injection'; readonly name: string }
  | { readonly kind: 'task'; readonly name: string }
  | { readonly kind: 'skill'; readonly name: string }
  | { readonly kind: 'plugin'; readonly name: string }
  | { readonly kind: 'compaction'; readonly name: string }

/**
 * Classify one `context.append_message` by its `message.origin`.
 *
 * A missing origin is a person (early records omitted it); everything else is
 * harness-injected context that must neither open a turn nor count as a prompt.
 */
export function kimiMessageClass(origin: unknown): KimiMessageClass {
  if (!isRecord(origin)) return { kind: 'human' }
  const kind = asString(origin['kind'])
  if (kind === undefined || kind === 'user') return { kind: 'human' }
  switch (kind) {
    case 'injection':
      return { kind: 'injection', name: asString(origin['variant']) ?? 'injection' }
    case 'task':
      return { kind: 'task', name: 'task-notification' }
    case 'skill_activation':
      return { kind: 'skill', name: asString(origin['skillName']) ?? 'skill' }
    case 'plugin_command':
      return { kind: 'plugin', name: 'plugin-command' }
    case 'compaction_summary':
      return { kind: 'compaction', name: 'compaction' }
    default:
      return { kind: 'injection', name: kind }
  }
}

/** One model response in progress: blocks accumulate until `step.end` closes it. */
interface OpenStep {
  turn: number
  step: number
  seq: number
  /** `step.begin` time, which is also the request start. */
  startedAt: number
  firstTokenTime: number | null
  lastTime: number
  blocks: AssistantBlock[]
  usage: TokenUsage | undefined
  /** Results flushed before this step's `step.end`; emitted once the step closes. */
  results: PendingResult[]
}

interface PendingResult {
  callId: string
  time: number
  content: readonly ContentBlock[]
  isError: boolean
}

/** One subagent run, joined from `task.started`/`task.terminated` and the child file. */
interface AgentRun {
  agentId: string
  taskId: string | null
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

function mapUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value['inputOther'])
  const cacheRead = asNumber(value['inputCacheRead'])
  const cacheWrite = asNumber(value['inputCacheCreation'])
  const output = asNumber(value['output'])
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined && output === undefined) {
    return undefined
  }
  // The three input buckets are disjoint, exactly as the contract wants them.
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (output ?? 0),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  }
}

/** Provider id for pricing; the wire `provider` field is the protocol, not the vendor. */
function providerOf(alias: string): string {
  return alias.startsWith('kimi-code/') ? 'kimi-for-coding' : 'moonshotai'
}

/** Model id as the CLI displays it: the tail of `<provider>/<model>`. */
function modelOfAlias(alias: string): string {
  const slash = alias.lastIndexOf('/')
  return slash < 0 ? alias : alias.slice(slash + 1)
}

/** Loop events nest their payload under `event`; read both levels tolerantly. */
function loopEvent(record: Record<string, unknown>): Record<string, unknown> {
  const event = record['event']
  return isRecord(event) ? { ...record, ...event } : record
}

/** `turnId` is a string on loop events and a number on `turn.*` records. */
function turnNumber(value: unknown): number | null {
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  const raw = asNumber(value)
  return raw === undefined ? null : Math.trunc(raw)
}

/** A loop event's own 1-based step number, when it carries one. */
function stepNumber(value: unknown): number | null {
  return asNumber(value) ?? null
}

function stringifyArgs(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}

function contentBlocks(items: readonly unknown[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const item of items) {
    if (typeof item === 'string') {
      blocks.push({ type: 'text', text: item })
      continue
    }
    if (!isRecord(item)) continue
    const type = asString(item['type'])
    if (type === 'think') {
      const text = asString(item['think']) ?? asString(item['text'])
      if (text !== undefined) blocks.push({ type: 'reasoning', text })
      continue
    }
    const text = asString(item['text'])
    if (text !== undefined) blocks.push({ type: 'text', text })
  }
  return blocks
}

/** Where an injected message belongs in the ledger's context vocabulary. */
function contextForm(message: KimiMessageClass): KnownContextForm {
  switch (message.kind) {
    case 'compaction':
      return 'recall'
    case 'skill':
      return 'catalog'
    case 'task':
      return 'relay'
    case 'injection':
      switch (message.name) {
        case 'agents_md':
          return 'instructions'
        case 'date_change':
        case 'context_budget':
        case 'permission_mode':
          return 'snapshot'
        default:
          return 'notice'
      }
    default:
      return 'notice'
  }
}

function terminatedStatus(value: string | undefined): SubagentStatus {
  switch (value) {
    case 'completed':
      return 'completed'
    case 'killed':
    case 'stopped':
    case 'cancelled':
    case 'canceled':
      return 'stopped'
    default:
      return 'failed'
  }
}

class KimiParser implements SessionParser {
  readonly kind = 'kimi' as const
  readonly images = new DataUrlImageStore()

  private readonly assembler = new TrajectoryAssembler()
  private turn = 0
  private step = 0
  /** `turn.prompt`/`turn.steer` opened a turn whose human message has not arrived yet. */
  private turnOpenPending = false
  private lastTime = 0
  private open: OpenStep | null = null
  private readonly turnSeqs = new Map<number, number[]>()
  /** Subagent runs keyed by the child's agent (= directory, = file) id. */
  private readonly runs = new Map<string, AgentRun>()
  private readonly runByTask = new Map<string, string>()
  /** Child tool calls registered under a parent `Agent` call, so results nest instead of surfacing. */
  private readonly childCalls = new Set<string>()
  private systemPrompt: string | null = null
  private provider = 'moonshotai'
  private model: string | null = null
  /** `llm.request.model` outranks the `profile.bind` alias tail once it is known. */
  private modelFromRequest = false
  private thinkingEffort: string | null = null
  private contextWindow: number | null = null
  private cwd: string | null = null
  private startedAt: number | null = null
  private title: string | null = null
  private promptCount = 0

  push(line: string, file: SessionFileRef, lineIndex?: number): void {
    this.assembler.beginLine(file.id, lineIndex)
    const record = parseJsonLine(line)
    if (!isRecord(record)) return
    // `metadata` carries `created_at` instead of `time`; everything else is ms.
    const time = parseTime(record['time']) ?? parseTime(record['created_at']) ?? this.lastTime
    if (time > this.lastTime) this.lastTime = time
    const type = asString(record['type'])
    if (type === undefined) return
    if (file.role === 'child') {
      this.handleChild(file, type, record, time)
      return
    }
    switch (type) {
      case 'metadata':
        // The only record without `time`: it carries `created_at` (ms) instead.
        if (this.startedAt === null && time > 0) this.startedAt = time
        return
      case 'profile.bind':
        this.handleProfileBind(record, time)
        return
      case 'llm.request':
        this.handleRequest(record, time)
        return
      case 'context.append_message':
        this.handleMessage(record, time)
        return
      case 'context.append_loop_event':
        this.handleLoopEvent(loopEvent(record), time)
        return
      case 'turn.prompt':
        this.closeStep('complete')
        this.turn += 1
        this.step = 0
        this.turnOpenPending = true
        return
      case 'turn.steer':
        // Mid-turn message: it joins the turn that is already open.
        this.turnOpenPending = true
        return
      case 'turn.ended': {
        this.closeStep('complete')
        // `turn.ended.turnId` is a number, unlike the loop events' string.
        const ended = turnNumber(record['turnId'])
        this.closeTurn(ended === null ? this.turn : ended + 1)
        this.turnOpenPending = false
        return
      }
      case 'turn.step.interrupted':
        this.closeStep('error', 'Step interrupted')
        return
      case 'prompt.aborted':
        this.closeStep('error', 'Prompt aborted')
        this.closeTurn(this.turn)
        this.turnOpenPending = false
        return
      case 'task.started':
        this.handleTaskStarted(record, time)
        return
      case 'task.terminated':
        this.handleTaskTerminated(record, time)
        return
      case 'context.apply_compaction':
        this.handleCompaction(record, time)
        return
      default:
        // plan_mode.*, permission.*, interaction.*, mcp.*, llm.tools_snapshot,
        // usage.record (== step.end.usage), token_counting.*, file_history.*,
        // tools.update_store, task.waitDelivered, plugin.session_start,
        // context.clear, context.undo, prompt.*: not conversation records.
        return
    }
  }

  snapshot(): TrajectorySnapshot {
    return this.assembler.snapshot()
  }

  meta(): ParsedSessionMeta {
    return {
      title: this.title,
      cwd: this.cwd,
      model: this.model,
      startedAt: this.startedAt,
      promptCount: this.promptCount,
    }
  }

  subagents(): readonly SubagentRun[] {
    return [...this.runs.values()].map(run => ({
      agentId: run.agentId,
      // The child's directory name is its agent id, which is also its file id.
      fileId: run.agentId,
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
  // Session facts
  // ---------------------------------------------------------------------------

  private handleProfileBind(record: Record<string, unknown>, time: number): void {
    const alias = asString(record['modelAlias'])
    if (alias !== undefined && alias !== '') {
      this.provider = providerOf(alias)
      if (!this.modelFromRequest) this.model = modelOfAlias(alias)
    }
    const effort = asString(record['thinkingEffort'])
    if (effort !== undefined && effort !== '') this.thinkingEffort = effort
    const disclosure = record['environmentDisclosure']
    if (this.cwd === null && isRecord(disclosure)) {
      const cwd = asString(disclosure['cwd'])
      if (cwd !== undefined && cwd !== '') this.cwd = cwd
    }
    const text = asString(record['systemPrompt'])
    if (text === undefined || text === '' || text === this.systemPrompt) return
    // A rebind with different instructions is a new prompt, not a correction.
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

  private handleRequest(record: Record<string, unknown>, time: number): void {
    const model = asString(record['model'])
    if (model !== undefined && model !== '') {
      this.model = model
      this.modelFromRequest = true
    }
    const alias = asString(record['modelAlias'])
    if (alias !== undefined && alias !== '') this.provider = providerOf(alias)
    const effort = asString(record['thinkingEffort'])
    if (effort !== undefined && effort !== '') this.thinkingEffort = effort
    const maxTokens = asNumber(record['maxTokens'])
    if (maxTokens !== undefined) this.contextWindow = maxTokens
    // Normally `step.begin` already opened the step; a truncated head may not have.
    // `turnStep` spells `<0-based turn>.<1-based step>`.
    const parts = asString(record['turnStep'])?.split('.') ?? []
    this.ensureStep(time, turnNumber(parts[0]), turnNumber(parts[1]))
  }

  private requestConfig(): AssistantRequestConfig {
    return {
      provider: this.provider,
      model: this.model ?? '',
      ...(this.thinkingEffort === null ? {} : { reasoningEffort: this.thinkingEffort }),
      // Kimi's `maxTokens` is the context window; there is no separate field for it.
      ...(this.contextWindow === null ? {} : { maxTokens: this.contextWindow }),
    }
  }

  // ---------------------------------------------------------------------------
  // Context messages
  // ---------------------------------------------------------------------------

  private handleMessage(record: Record<string, unknown>, time: number): void {
    const message = record['message']
    if (!isRecord(message) || asString(message['role']) !== 'user') return
    const raw = message['content']
    const content = typeof raw === 'string'
      ? [{ type: 'text' as const, text: raw }]
      : contentBlocks(asArray(raw) ?? [])
    const classified = kimiMessageClass(message['origin'])
    if (classified.kind !== 'human') {
      this.pushContext(content, classified, time)
      return
    }
    this.closeStep('complete')
    if (!this.turnOpenPending) {
      this.turn += 1
      this.step = 0
    }
    this.turnOpenPending = false
    this.promptCount += 1
    const text = textOf(content)
    if (this.title === null && text.trim() !== '') this.title = titleFrom(text)
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({ kind: 'user', seq, time, content, source: { kind: 'user' } })
    this.locate(seq, this.turn)
  }

  private pushContext(
    content: readonly ContentBlock[],
    classified: KimiMessageClass,
    time: number,
  ): void {
    const label = classified.kind === 'human' ? 'user' : classified.name
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({
      kind: 'context',
      seq,
      time,
      content,
      source: { kind: 'plugin', plugin: label, origin: classified.kind },
      provenance: { role: classified.kind === 'compaction' ? 'recall' : 'inject', label },
      form: contextForm(classified),
    })
    if (this.turn > 0) this.locate(seq, this.turn)
  }

  private handleCompaction(record: Record<string, unknown>, time: number): void {
    this.closeStep('complete')
    const text = compactionSummary(record)
    const summary = text.trim() === '' ? null : text
    const shadowedItems = asNumber(record['compactedCount'])
      ?? asNumber(record['count'])
      ?? asNumber(record['droppedCount'])
      ?? null
    const tokensBefore = asNumber(record['tokensBefore']) ?? null
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({
      kind: 'compaction',
      seq,
      time,
      summary,
      summaryEventSeq: summary === null ? null : seq,
      shadowedItemCount: shadowedItems,
      shadowedTokenCount: tokensBefore,
    })
    if (this.turn > 0) this.locate(seq, this.turn)
    const request: CompactionRequestView = {
      purpose: 'compaction',
      turn: this.turn > 0 ? this.turn : null,
      step: 0,
      startSeq: seq,
      startedAt: time,
      completedAt: time,
      status: 'complete',
      resultSeq: seq,
      replacementSeq: seq,
      ...(summary === null ? {} : { summary: [{ type: 'text', text: summary }] }),
      ...(this.model === null ? {} : {
        provenance: { provider: this.provider, model: this.model },
        requestConfig: this.requestConfig(),
      }),
    }
    this.assembler.upsertRequest(request)
  }

  // ---------------------------------------------------------------------------
  // Loop events (the model's own record)
  // ---------------------------------------------------------------------------

  private handleLoopEvent(event: Record<string, unknown>, time: number): void {
    switch (asString(event['type'])) {
      case 'step.begin':
        this.beginStep(event, time)
        return
      case 'content.part': {
        const part = isRecord(event['part']) ? event['part'] : event
        const open = this.stepOf(event, time)
        const kind = asString(part['type'])
        const text = kind === 'think'
          ? asString(part['think']) ?? asString(part['text'])
          : asString(part['text'])
        if (text === undefined || text === '') return
        this.appendBlock(open, kind === 'think' ? { kind: 'reasoning', text } : { kind: 'text', text }, time)
        return
      }
      case 'tool.call': {
        const callId = asString(event['toolCallId'])
        if (callId === undefined) return
        const open = this.stepOf(event, time)
        const name = asString(event['name']) ?? 'tool'
        const argsRaw = stringifyArgs(event['args'])
        this.appendBlock(open, { kind: 'tool-call', callId, name, argsRaw }, time)
        this.assembler.tools.start({
          callId, name, argsRaw, turn: open.turn, step: open.step, time, subCalls: [],
        })
        this.assembler.touch()
        return
      }
      case 'tool.result':
        this.handleToolResult(event, time)
        return
      case 'step.end':
        this.endStep(event, time)
        return
      default:
        return
    }
  }

  private beginStep(event: Record<string, unknown>, time: number): void {
    this.closeStep('complete')
    this.stepOf(event, time)
  }

  /** The open step, opened from a loop event's own turn/step numbers if need be. */
  private stepOf(event: Record<string, unknown>, time: number): OpenStep {
    return this.ensureStep(time, turnNumber(event['turnId']), stepNumber(event['step']))
  }

  /**
   * Open a step, reusing one that is already open. Turns are 0-based on the
   * wire and 1-based in the contract; steps are 1-based in both.
   */
  private ensureStep(time: number, turn: number | null, step: number | null): OpenStep {
    if (this.open !== null) return this.open
    this.turn = turn === null ? Math.max(1, this.turn) : turn + 1
    this.step = step ?? this.step + 1
    this.turnOpenPending = false
    return this.openStep(time)
  }

  private openStep(time: number): OpenStep {
    const open: OpenStep = {
      turn: this.turn,
      step: this.step,
      seq: this.assembler.seq.next(),
      startedAt: time,
      firstTokenTime: null,
      lastTime: time,
      blocks: [],
      usage: undefined,
      results: [],
    }
    this.open = open
    this.assembler.partial = { turn: open.turn, step: open.step, blocks: [] }
    this.assembler.touch()
    return open
  }

  private appendBlock(open: OpenStep, block: AssistantBlock, time: number): void {
    open.blocks.push(block)
    if (time > open.lastTime) open.lastTime = time
    this.assembler.partial = { turn: open.turn, step: open.step, blocks: [...open.blocks] }
    this.assembler.touch()
  }

  private endStep(event: Record<string, unknown>, time: number): void {
    const open = this.open
    if (open === null) return
    open.usage = mapUsage(event['usage'])
    // TTFT is a latency from the request start, not a timestamp.
    const ttft = asNumber(event['llmFirstTokenLatencyMs'])
    if (ttft !== undefined && ttft >= 0) open.firstTokenTime = open.startedAt + ttft
    if (time > open.lastTime) open.lastTime = time
    const finish = asString(event['finishReason'])
    if (finish !== undefined && ABORTED_FINISH_REASONS.has(finish)) {
      this.closeStep('error', `Step ended (${finish})`, finish)
      return
    }
    this.closeStep('complete')
  }

  private closeStep(status: 'complete' | 'error', error?: string, code?: string): void {
    const open = this.open
    if (open === null) return
    this.open = null
    const provenance = this.model === null ? undefined : { provider: this.provider, model: this.model }
    const requestConfig = this.model === null ? undefined : this.requestConfig()
    this.assembler.pushNode({
      kind: 'assistant',
      seq: open.seq,
      time: open.lastTime,
      turn: open.turn,
      step: open.step,
      blocks: open.blocks,
      ...(open.usage === undefined ? {} : { usage: open.usage }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      timing: {
        stepStartTime: open.startedAt,
        firstTokenTime: open.firstTokenTime ?? open.startedAt,
        completedTime: open.lastTime,
      },
      ...(status === 'error' ? { interrupted: true as const } : {}),
    })
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
      ...(open.usage === undefined ? {} : { usage: open.usage }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
    }
    this.assembler.upsertRequest(request)
    this.assembler.partial = null
    this.assembler.touch()
    for (const result of open.results) this.emitToolResult(result)
  }

  // ---------------------------------------------------------------------------
  // Tool results
  // ---------------------------------------------------------------------------

  private handleToolResult(event: Record<string, unknown>, time: number): void {
    const callId = asString(event['toolCallId'])
    if (callId === undefined) return
    const result = isRecord(event['result']) ? event['result'] : {}
    const note = asString(result['note'])
    const content: ContentBlock[] = [
      { type: 'text', text: asString(result['output']) ?? '' },
      ...(note === undefined || note === '' ? [] : [{ type: 'text' as const, text: note }]),
    ]
    const pending: PendingResult = { callId, time, content, isError: result['isError'] === true }
    // Results flushed before this step's `step.end` must still follow it.
    if (this.open !== null) {
      this.open.results.push(pending)
      return
    }
    this.emitToolResult(pending)
  }

  private emitToolResult(result: PendingResult): void {
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(result.callId, {
      seq,
      time: result.time,
      content: result.content,
      isError: result.isError,
    })
    if (topLevel) {
      this.assembler.pushNode(node)
      this.locate(seq, Math.max(1, this.turn))
    } else {
      this.assembler.touch()
    }
    if (node.call !== null && SUBAGENT_TOOL_NAMES.has(node.call.name)) {
      this.bindAgentFromResult(node.call.argsRaw, node.callId, textOf(result.content), result.time)
    }
  }

  // ---------------------------------------------------------------------------
  // Subagents
  // ---------------------------------------------------------------------------

  private handleTaskStarted(record: Record<string, unknown>, time: number): void {
    const info = isRecord(record['info']) ? record['info'] : undefined
    if (info === undefined || asString(info['kind']) !== 'agent') return
    const agentId = asString(info['agentId'])
    if (agentId === undefined) return
    const run = this.runFor(agentId, time)
    run.taskId = asString(info['taskId']) ?? run.taskId
    run.callId ??= asString(info['parentToolCallId']) ?? null
    run.description ??= asString(info['description']) ?? null
    run.agentType ??= asString(info['subagentType']) ?? null
    run.model ??= asString(info['model']) ?? null
    run.startedAt = parseTime(info['startedAt']) ?? run.startedAt ?? time
    if (run.status === 'launching') run.status = 'running'
    if (run.taskId !== null) this.runByTask.set(run.taskId, agentId)
  }

  private handleTaskTerminated(record: Record<string, unknown>, time: number): void {
    const info = isRecord(record['info']) ? record['info'] : undefined
    if (info === undefined) return
    const taskId = asString(info['taskId'])
    const agentId = asString(info['agentId'])
      ?? (taskId === undefined ? undefined : this.runByTask.get(taskId))
    if (agentId === undefined) return
    const run = this.runs.get(agentId)
    if (run === undefined) return
    run.status = terminatedStatus(asString(info['status']))
    run.endedAt = parseTime(info['endedAt']) ?? time
  }

  /**
   * Fallback binding: an `Agent`/`AgentSwarm` result whose output opens with
   * `agent_id: <id>` (foreground) or carries one after `task_id:` (background).
   */
  private bindAgentFromResult(argsRaw: string, callId: string, output: string, time: number): void {
    const agentId = AGENT_ID_LINE.exec(output)?.[1]
    if (agentId === undefined || this.runs.has(agentId)) return
    const run = this.runFor(agentId, time)
    run.callId ??= callId
    const args: unknown = parseJsonLine(argsRaw)
    if (isRecord(args)) {
      run.description ??= asString(args['description'])
        ?? (asString(args['prompt'])?.slice(0, 80) ?? null)
      run.agentType ??= asString(args['subagent_type']) ?? null
    }
    if (run.status === 'launching') run.status = 'running'
  }

  private runFor(agentId: string, time: number): AgentRun {
    const existing = this.runs.get(agentId)
    if (existing !== undefined) return existing
    const run: AgentRun = {
      agentId,
      taskId: null,
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
  private handleChild(
    file: SessionFileRef,
    type: string,
    record: Record<string, unknown>,
    time: number,
  ): void {
    const run = this.runFor(file.id, time)
    run.lastTime = run.lastTime === null ? time : Math.max(run.lastTime, time)
    if (run.status === 'launching') run.status = 'running'
    if (type !== 'context.append_loop_event') return
    const event = loopEvent(record)
    switch (asString(event['type'])) {
      case 'tool.call': {
        run.toolCalls += 1
        const callId = asString(event['toolCallId'])
        if (callId === undefined || run.callId === null) return
        const name = asString(event['name']) ?? 'tool'
        this.childCalls.add(callId)
        this.assembler.tools.start({
          callId,
          parentCallId: run.callId,
          name,
          argsRaw: stringifyArgs(event['args']),
          turn: Math.max(1, this.turn),
          step: this.step,
          time,
          subCalls: [],
        })
        this.assembler.touch()
        return
      }
      case 'tool.result': {
        const callId = asString(event['toolCallId'])
        if (callId === undefined || !this.childCalls.has(callId)) return
        const result = isRecord(event['result']) ? event['result'] : {}
        this.emitToolResult({
          callId,
          time,
          content: [{ type: 'text', text: asString(result['output']) ?? '' }],
          isError: result['isError'] === true,
        })
        return
      }
      default:
        return
    }
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

/** Summary text of a compaction record, across the current and the legacy shapes. */
function compactionSummary(record: Record<string, unknown>): string {
  const summary = record['summary'] ?? record['contextMessage']
  if (typeof summary === 'string') return summary
  const contextSummary = asString(record['contextSummary'])
  if (contextSummary !== undefined && contextSummary !== '') return contextSummary
  if (isRecord(summary)) {
    // Legacy records stored a whole message object instead of its text.
    const inner = isRecord(summary['message']) ? summary['message'] : summary
    const content = inner['content']
    if (typeof content === 'string') return content
    return textOf(contentBlocks(asArray(content) ?? []))
  }
  return ''
}

/** Create the incremental Kimi Code wire parser. */
export function createKimiParser(): SessionParser {
  return new KimiParser()
}
