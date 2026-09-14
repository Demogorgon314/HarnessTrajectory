/**
 * Claude Code transcript (`~/.claude/projects/**`) → fold events.
 *
 * One instance per transcript FILE: the main session transcript, or one
 * `agent-<agentId>.jsonl` subagent transcript (each subagent is its own
 * context, folded separately — see the package design). `isSidechain: true`
 * records written into a MAIN transcript are skipped here: they belong to a
 * child file that is folded on its own.
 *
 * Shape notes below record what the real transcripts actually carry; they were
 * verified structurally (keys, types, enumerations, timestamp deltas only) over
 * local sessions — no transcript content was read into this port.
 *
 * Record vocabulary (`type`):
 *   assistant | user | attachment | system | cost-state | ai-title | summary |
 *   queue-operation | mode | permission-mode | last-prompt | bridge-session |
 *   atis-latch | pr-link | file-history-snapshot | file-history-delta
 *
 * Everything not listed in the mapping below is ignored.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import {
  asArray, asNumber, asString, classifyInjectedUser, isRecord, parseJsonLine, parseTime, titleFrom,
} from '@harness-trajectory/core'
import type { ContentBlock, MessageSource, StreamRecord, TimelineEvent } from '../fold/event.ts'
import type { FileOpRecord } from '../shared/types.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'

/**
 * The `tool/result` `data.fileOps` element the fold consumes: a
 * {@link FileOpRecord} minus the fields the fold fills from the event and the
 * call/result pairing. Declared locally so this module depends only on the
 * shared wire contract (the fold re-exports the same shape).
 */
type FileOpInput = Omit<FileOpRecord, 'seq' | 'tool' | 'time' | 'err'>

const PROVIDER = 'anthropic'
/** Claude's standard context window, and the extended one `[1m]` model ids select. */
const SMALL_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000
/** Tools that spawn a subagent whose transcript is a separate child file. */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])
/** Plan-mode tool calls that flip the harness's plan mode. */
const PLAN_MODE_TOOLS: Readonly<Record<string, boolean>> = { EnterPlanMode: true, ExitPlanMode: false }
/** Per-call cap on search rows (one Glob can name hundreds of files). */
const MAX_SEARCH_ROWS = 200

/** Provider usage of one API response, in the fold's disjoint-bucket vocabulary. */
interface Usage {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
}

/** One tool_use block waiting for its `tool_result`. */
interface PendingCall {
  name: string
  args: Record<string, unknown> | null
  time: number
}

/** A subagent spawn waiting for the `agentId` its result reports. */
interface PendingSpawn {
  callId: string
  label: string
  agentType?: string
  model?: string
  startedAt: number
}

/** One API response being accumulated from its per-block `assistant` records. */
interface OpenGroup {
  requestId: string
  /**
   * A second run of records under a requestId already emitted: Claude Code
   * executes a tool as soon as its block finishes streaming, so a `user`
   * tool_result record can land in the middle of one API response. The
   * continuation is emitted as its own `assistant/message` (seq order forbids
   * re-opening a closed node) but WITHOUT usage and under the original
   * turn/step, so the response is billed exactly once.
   */
  continuation: boolean
  turn: number
  step: number
  blocks: ContentBlock[]
  /**
   * LIVENESS ONLY: the newest block record carried a non-null
   * `message.stop_reason`, so the API response has stopped generating. It is
   * NOT a group terminator — mid-group records carry `tool_use`/`end_turn` too
   * (see `onAssistant`) — but a transcript whose final record is a settled
   * block must not read as still running (see `meta`).
   */
  settled: boolean
  /** Completion time of each block, parallel to `blocks` (see the TTFT note). */
  blockTimes: number[]
  uuids: string[]
  stepStart: number
  lastTime: number
  usage: Usage | undefined
  model: string | undefined
  toolCalls: { callId: string; name: string; args: string; time: number }[]
}

/** A live surface node and the record uuids that produced it (compaction shadowing). */
interface LiveNode {
  seq: number
  uuids: string[]
}

/** A `compact_boundary` waiting for its `isCompactSummary` user record. */
interface PendingCompaction {
  compactionId: string | undefined
  shadowedSeqs: number[]
  trigger: string | undefined
  preTokens: number | undefined
  postTokens: number | undefined
  durationMs: number | undefined
}

function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value.input_tokens)
  const cacheRead = asNumber(value.cache_read_input_tokens)
  const cacheWrite = asNumber(value.cache_creation_input_tokens)
  const output = asNumber(value.output_tokens)
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined && output === undefined) {
    return undefined
  }
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(output === undefined ? {} : { outputTokens: output }),
  }
}

function promptOf(usage: Usage | undefined): number {
  if (usage === undefined) return 0
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

function stringifyArgs(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {}) ?? '{}'
  } catch {
    return '{}'
  }
}

/** Rendered line count: '' is 0, a trailing newline closes its own line. */
function countLines(text: string): number {
  if (text === '') return 0
  let lines = 0
  for (const ch of text) if (ch === '\n') lines += 1
  return text.endsWith('\n') ? lines : lines + 1
}

/**
 * A model id without its variant suffix. The `model` attachment names the
 * routed variant (`claude-opus-5[1m]`) while every response names the base id
 * (`claude-opus-5`); they are the same model, so a switch must not be logged
 * between them.
 */
function baseModel(model: string): string {
  return model.replace(/\[[^\]]*\]\s*$/, '')
}

function sameModel(a: string, b: string): boolean {
  return a === b || baseModel(a) === baseModel(b)
}

/** Claude prices an image at `ceil(width * height / 750)` tokens. */
function imageTokensOf(width: number, height: number): number {
  return Math.ceil((width * height) / 750)
}

/** Image dimensions off a `toolUseResult.file.dimensions` record, when recorded. */
function dimensionsOf(value: unknown): { width: number; height: number } | null {
  if (!isRecord(value)) return null
  const width = asNumber(value.width) ?? asNumber(value.displayWidth) ?? asNumber(value.originalWidth)
  const height = asNumber(value.height) ?? asNumber(value.displayHeight) ?? asNumber(value.originalHeight)
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return null
  return { width, height }
}

/** Added/removed lines of a `structuredPatch` / `bashEditDiff` hunk list, or null when absent. */
function hunkDelta(hunks: unknown): { added: number; removed: number } | null {
  const list = asArray(hunks)
  if (list === undefined) return null
  let added = 0
  let removed = 0
  let seen = false
  for (const hunk of list) {
    if (!isRecord(hunk)) continue
    const lines = asArray(hunk.lines)
    if (lines === undefined) continue
    seen = true
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return seen ? { added, removed } : null
}

function firstPath(args: Record<string, unknown> | null): string | undefined {
  if (args === null) return undefined
  for (const key of ['file_path', 'filePath', 'notebook_path', 'path']) {
    const value = asString(args[key])
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => (block.type === 'text' && block.text !== undefined ? [block.text] : [])).join('\n')
}

class ClaudeSynthesizer implements EventSynthesizer {
  readonly kind = 'claude' as const

  private readonly child: boolean
  private seq = 1
  private lastTime = 0
  private turn = 0
  private step = 0

  private open: OpenGroup | undefined
  private stepOpen = false
  /** Time of the last model INPUT record (human prompt or tool_result) — the step's start. */
  private stepStartTime: number | null = null
  private readonly seenRequestIds = new Set<string>()

  private readonly pendingCalls = new Map<string, PendingCall>()
  private readonly pendingSpawns = new Map<string, PendingSpawn>()
  private readonly children = new Map<string, AgentSpawn>()

  private live: LiveNode[] = []
  private pendingCompaction: PendingCompaction | undefined

  private headerSeen = false
  private lastSystem: string | undefined
  private lastTools: unknown[] = []
  private lastHeaderModel: string | undefined
  private lastWindow: number | undefined
  private maxPrompt = 0

  private model: string | undefined
  private version: string | undefined
  private reportedCostUsd: number | undefined
  private aiTitle: string | undefined
  private summaryTitle: string | undefined
  private firstPrompt: string | undefined

  constructor(private readonly file: SessionFileRef) {
    this.child = file.role === 'child'
  }

  push(line: string): readonly TimelineEvent[] {
    const out: TimelineEvent[] = []
    try {
      this.consume(line, out)
    } catch {
      // A synthesizer must never throw: a hostile or truncated record yields
      // whatever it produced before the failure (usually nothing).
    }
    return out
  }

  meta(): SynthMeta {
    const label = this.labelOf()
    return {
      // A transcript usually ENDS on the last block record of its last
      // response — nothing follows to close the group — so an open group alone
      // cannot mean "running" or every finished subagent would pulse forever.
      // A group whose newest block carried a non-null `stop_reason` has stopped
      // generating; what keeps the agent live after that is an unanswered tool
      // call (which `stop_reason: 'tool_use'` implies and `pendingCalls` proves).
      running: (this.open !== undefined && !this.open.settled) || this.pendingCalls.size > 0,
      children: this.children,
      provider: PROVIDER,
      ...(this.model === undefined ? {} : { model: this.model }),
      // The window is always inferable (see `windowOf`), even before the first
      // response — the Session Info card needs a figure, not a blank.
      contextWindow: this.windowOf(),
      ...(label === undefined ? {} : { label }),
      ...(this.reportedCostUsd === undefined ? {} : { reportedCostUsd: this.reportedCostUsd }),
      ...(this.version === undefined ? {} : { version: this.version }),
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  private consume(line: string, out: TimelineEvent[]): void {
    const record = parseJsonLine(line)
    if (!isRecord(record)) return
    const type = asString(record.type)
    if (type === undefined) return
    // A `isSidechain` record inside a MAIN transcript is a subagent's own
    // conversation; that subagent has its own file and its own fold.
    if (record.isSidechain === true && !this.child) return
    const version = asString(record.version)
    if (version !== undefined && version !== '') this.version = version
    const time = this.timeOf(record)

    switch (type) {
      case 'assistant':
        this.onAssistant(record, time, out)
        return
      case 'user':
        this.closeGroup(out)
        this.onUser(record, time, out)
        return
      case 'attachment':
        this.closeGroup(out)
        this.onAttachment(record, time, out)
        return
      case 'system':
        this.closeGroup(out)
        this.onSystem(record, time, out)
        return
      case 'cost-state': {
        // The session-cost rollup is written after the answer settles, so it
        // closes the open group like any other non-assistant record — which
        // also flushes the final response a transcript would otherwise end on.
        this.closeGroup(out)
        const cost = asNumber(record.totalCostUSD)
        if (cost !== undefined) this.reportedCostUsd = cost
        return
      }
      case 'ai-title': {
        const title = asString(record.aiTitle)
        if (title !== undefined && title !== '') this.aiTitle = title
        return
      }
      case 'summary': {
        const summary = asString(record.summary)
        if (summary !== undefined && summary !== '') this.summaryTitle = summary
        return
      }
      default:
        // queue-operation, mode, permission-mode, last-prompt, bridge-session,
        // atis-latch, pr-link, file-history-*: not model context.
        return
    }
  }

  private timeOf(record: Record<string, unknown>): number {
    const time = parseTime(record.timestamp)
    if (time !== null) {
      this.lastTime = time
      return time
    }
    return this.lastTime
  }

  private emit(
    out: TimelineEvent[],
    type: string,
    time: number,
    data?: Record<string, unknown>,
    surfaceOp?: unknown,
  ): TimelineEvent {
    const event: TimelineEvent = { type, seq: this.seq, time }
    this.seq += 1
    if (data !== undefined) event.data = data
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    out.push(event)
    return event
  }

  // ---------------------------------------------------------------------------
  // assistant — per-block records grouped by requestId
  // ---------------------------------------------------------------------------

  /**
   * One API response is N consecutive `assistant` records sharing `requestId`
   * (and `message.id`), each carrying one `apiBlockIndex` and the response's
   * usage. Verified on real transcripts: `usage` is identical across the group
   * except for `output_tokens`, which grows monotonically — so the LAST usage
   * seen is the authoritative one.
   *
   * The group is closed by a different requestId or by any non-assistant
   * record. `stop_reason` is deliberately NOT a terminator: in the sampled
   * transcripts 604 of 809 non-final records already carry a non-null
   * `stop_reason` ('tool_use' / 'end_turn'), so closing on it would shred
   * multi-block responses into one request per block.
   */
  private onAssistant(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const message = isRecord(record.message) ? record.message : undefined
    const requestId = asString(record.requestId) ?? asString(message?.id) ?? asString(record.uuid)
    if (requestId === undefined) return
    if (this.open !== undefined && this.open.requestId !== requestId) this.closeGroup(out)

    let group = this.open
    if (group === undefined) {
      const continuation = this.seenRequestIds.has(requestId)
      if (!continuation) {
        if (this.stepOpen) this.emit(out, 'step/end', this.lastTime)
        this.step += 1
        this.stepStartTime ??= time
        this.emit(out, 'step/start', this.stepStartTime)
        this.stepOpen = true
      }
      group = {
        requestId,
        continuation,
        turn: this.turn,
        step: this.step,
        blocks: [],
        settled: false,
        blockTimes: [],
        uuids: [],
        stepStart: this.stepStartTime ?? time,
        lastTime: time,
        usage: undefined,
        model: undefined,
        toolCalls: [],
      }
      this.open = group
      this.seenRequestIds.add(requestId)
    }

    group.lastTime = time
    // Liveness read only — never a group terminator (see OpenGroup.settled).
    group.settled = asString(message?.stop_reason) !== undefined
    const uuid = asString(record.uuid)
    if (uuid !== undefined) group.uuids.push(uuid)
    const model = asString(message?.model)
    if (model !== undefined && model !== '') {
      group.model = model
      // Keep the more specific id a `model` attachment already established
      // (`claude-opus-5[1m]` over the response's plain `claude-opus-5`): the
      // window heuristic reads the variant marker off it.
      if (this.model === undefined || !sameModel(this.model, model)) this.model = model
    }
    const usage = usageOf(message?.usage)
    if (usage !== undefined) group.usage = usage

    const raw = message?.content
    const items: readonly unknown[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : asArray(raw) ?? []
    for (const item of items) {
      if (!isRecord(item)) continue
      switch (item.type) {
        case 'thinking':
          group.blocks.push({ type: 'reasoning', text: asString(item.thinking) ?? '' })
          group.blockTimes.push(time)
          break
        case 'text':
          group.blocks.push({ type: 'text', text: asString(item.text) ?? '' })
          group.blockTimes.push(time)
          break
        case 'tool_use': {
          const callId = asString(item.id)
          if (callId === undefined) break
          const name = asString(item.name) ?? 'tool'
          const args = stringifyArgs(item.input)
          group.blocks.push({ type: 'tool-call', name, arguments: args, callId })
          group.blockTimes.push(time)
          group.toolCalls.push({ callId, name, args, time })
          this.pendingCalls.set(callId, { name, args: isRecord(item.input) ? item.input : null, time })
          if (SUBAGENT_TOOLS.has(name)) this.rememberSpawn(callId, item.input, time)
          break
        }
        case 'image':
          group.blocks.push({ type: 'image' })
          group.blockTimes.push(time)
          break
        default:
          break
      }
    }
  }

  private closeGroup(out: TimelineEvent[]): void {
    const group = this.open
    if (group === undefined) return
    this.open = undefined

    // A model switch has no durable event in this transcript: the header the
    // fold compares against is synthesized here, from the response's own model.
    this.emitModelHeader(group.model, group.stepStart, out)

    const data: Record<string, unknown> = {
      message: { content: group.blocks },
      turn: group.turn,
      step: group.step,
    }
    // Dedup: a continuation run re-reports the SAME provider usage; booking it
    // twice would double the session's prompt/output totals.
    if (group.usage !== undefined && !group.continuation) data.usage = group.usage
    const stream = this.streamOf(group)
    if (stream.length > 0) data.stream = stream

    const event = this.emit(out, 'assistant/message', group.lastTime, data)
    if (group.blocks.length > 0) this.live.push({ seq: event.seq, uuids: [...group.uuids] })

    if (group.usage !== undefined && !group.continuation) {
      this.maxPrompt = Math.max(this.maxPrompt, promptOf(group.usage))
    }
    this.emitContext(group.lastTime, out)

    for (const call of group.toolCalls) {
      this.emit(out, 'tool/call', call.time, { callId: call.callId, name: call.name, arguments: call.args })
      const planMode = PLAN_MODE_TOOLS[call.name]
      if (planMode !== undefined) this.emit(out, 'plan/mode', call.time, { active: planMode })
    }

    if (this.pendingCalls.size === 0 && this.stepOpen) {
      this.emit(out, 'step/end', group.lastTime)
      this.stepOpen = false
    }
  }

  /**
   * TTFT DECISION — no fabricated first-token time.
   *
   * Claude Code writes one `assistant` record per content block, stamped when
   * the block COMPLETES, not when its first token arrived. Evidence (timestamp
   * deltas only, 12 local transcripts, 896 responses): for responses whose
   * first block is `thinking`, `ts[0] − <previous input record>.timestamp` has
   * median 4964 ms (p25 3092 ms, p75 8874 ms), and successive block records
   * inside one response are 1403 ms apart at the median. Those are block
   * DURATIONS, not model latencies — a first-token stamp would sit far below a
   * second.
   *
   * So the embedded stream carries `block-start` chunks ONLY (no token delta):
   * block i is marked as starting when block i-1 completed (block 0 at the step
   * start). `firstTokenTimeOfStream` then returns undefined and the timing
   * card's TTFT / generation split stays honestly unattributed for this
   * harness, instead of being filled with a number the transcript never
   * recorded.
   */
  private streamOf(group: OpenGroup): StreamRecord[] {
    const stream: StreamRecord[] = []
    for (const [index, block] of group.blocks.entries()) {
      // `ContentBlock['type']` widens to `string & {}`, so the marker vocabulary
      // is re-proved rather than narrowed.
      const blockType: 'reasoning' | 'text' | 'tool-call' | undefined
        = block.type === 'reasoning' ? 'reasoning'
          : block.type === 'text' ? 'text'
            : block.type === 'tool-call' ? 'tool-call'
              : undefined
      if (blockType === undefined) continue
      const previous = index === 0 ? group.stepStart : group.blockTimes[index - 1]
      stream.push({
        type: 'chunk',
        time: previous ?? group.stepStart,
        chunk: { type: 'block-start', blockType },
      })
    }
    return stream
  }

  // ---------------------------------------------------------------------------
  // user
  // ---------------------------------------------------------------------------

  private onUser(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const message = isRecord(record.message) ? record.message : undefined
    const raw = message?.content
    const items = asArray(raw) ?? []
    const results = items.filter((item): item is Record<string, unknown> =>
      isRecord(item) && item.type === 'tool_result')

    if (results.length > 0) {
      for (const result of results) this.onToolResult(result, record, time, out);
      this.stepStartTime = time
      if (this.pendingCalls.size === 0 && this.open === undefined && this.stepOpen) {
        this.emit(out, 'step/end', time)
        this.stepOpen = false
      }
      return
    }

    const content: ContentBlock[] = typeof raw === 'string'
      ? [{ type: 'text', text: raw }]
      : this.blocksOf(items, undefined)

    if (record.isCompactSummary === true) {
      this.onCompactSummary(record, content, time, out)
      this.stepStartTime = time
      return
    }

    const text = textOf(content)
    if (record.isMeta === true) {
      this.inject(record, content, time, { kind: 'meta', form: 'context' }, out)
      this.stepStartTime = time
      return
    }
    const injected = classifyInjectedUser(record, text)
    if (injected !== null) {
      this.inject(record, content, time, { kind: injected, form: 'context' }, out)
      this.stepStartTime = time
      return
    }

    // A genuine human prompt opens a turn.
    this.turn += 1
    this.step = 0
    if (this.firstPrompt === undefined && text.trim() !== '') this.firstPrompt = titleFrom(text)
    const event = this.emit(out, 'user/message', time, { content, source: { kind: 'user' } satisfies MessageSource })
    this.trackNode(event.seq, record)
    this.stepStartTime = time
  }

  private onToolResult(
    block: Record<string, unknown>,
    record: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
  ): void {
    const callId = asString(block.tool_use_id)
    if (callId === undefined) return
    const call = this.pendingCalls.get(callId)
    this.pendingCalls.delete(callId)
    const meta = record.toolUseResult
    const raw = block.content
    const content: ContentBlock[] = typeof raw === 'string'
      ? [{ type: 'text', text: raw }]
      : this.blocksOf(asArray(raw) ?? [], meta)
    const isError = block.is_error === true

    const data: Record<string, unknown> = {
      message: {
        content: [{ type: 'tool-result', toolCallId: callId, isError, content } satisfies ContentBlock],
        source: { callId },
      },
      error: isError,
    }
    if (meta !== undefined) data.meta = meta
    const ops = call === undefined ? [] : fileOpsOf(call.name, call.args, meta)
    if (ops.length > 0) data.fileOps = ops

    const event = this.emit(out, 'tool/result', time, data)
    this.trackNode(event.seq, record)
    this.resolveSpawn(callId, meta, time)
  }

  private inject(
    record: Record<string, unknown>,
    content: readonly ContentBlock[],
    time: number,
    source: MessageSource,
    out: TimelineEvent[],
  ): void {
    if (content.length === 0) return
    const event = this.emit(out, 'user/message', time, { content, source })
    this.trackNode(event.seq, record)
  }

  // ---------------------------------------------------------------------------
  // attachment — the injected-context channel
  // ---------------------------------------------------------------------------

  private onAttachment(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const attachment = isRecord(record.attachment) ? record.attachment : undefined
    if (attachment === undefined) return
    const type = asString(attachment.type) ?? 'attachment'

    if (type === 'prompt_snapshot') {
      this.onPromptSnapshot(attachment, time, out)
      return
    }
    if (type === 'model') {
      this.onModelAttachment(attachment, time, out)
      return
    }

    const text = renderedTextOf(record, attachment)
    if (type === 'plan_mode_exit') {
      // The plan-mode flip is durable even when the attachment rendered nothing.
      if (text !== '') this.injectAttachment(record, attachment, type, text, time, out)
      this.emit(out, 'plan/mode', time, { active: false })
      return
    }
    if (text === '') return
    this.injectAttachment(record, attachment, type, text, time, out)
  }

  private injectAttachment(
    record: Record<string, unknown>,
    attachment: Record<string, unknown>,
    type: string,
    text: string,
    time: number,
    out: TimelineEvent[],
  ): void {
    const source = attachmentSource(type, attachment)
    this.inject(record, [{ type: 'text', text }], time, source, out)
  }

  /**
   * `prompt_snapshot` is the only record that carries the system prompt and the
   * tool schemas. `tools` is absent on roughly half the snapshots (a
   * prompt-only refresh); the last known list is repeated so the header epoch
   * never loses the schemas it already reported.
   */
  private onPromptSnapshot(attachment: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const parts = asArray(attachment.systemPrompt) ?? []
    const system = parts.filter((part): part is string => typeof part === 'string').join('\n\n')
    const rawTools = asArray(attachment.tools)
    if (rawTools !== undefined) {
      this.lastTools = rawTools.flatMap(tool => {
        if (!isRecord(tool)) return []
        const name = asString(tool.name)
        if (name === undefined) return []
        const description = asString(tool.description)
        return [{
          name,
          ...(description === undefined ? {} : { description }),
          ...(tool.schema === undefined ? {} : { parameters: tool.schema }),
        }]
      })
    }
    if (system !== '') this.lastSystem = system
    const reason = this.headerSeen ? 'change' : 'initial'
    this.headerSeen = true
    this.emitHeader(time, reason, this.model, out)
  }

  /** A `model` attachment is the authoritative mid-session model switch. */
  private onModelAttachment(attachment: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const identity = isRecord(attachment.identity) ? attachment.identity : undefined
    const modelId = asString(identity?.modelId)
    if (modelId === undefined || modelId === '') return
    this.model = modelId
    this.emitHeader(time, 'change', modelId, out)
    this.emitContext(time, out)
  }

  /**
   * Emit a header epoch. `header.system` repeats the last known prompt on
   * purpose: the fold clears its system nodes when an envelope-sourced header
   * omits `system`, so a model-change header that dropped the field would
   * silently zero the System Prompt card.
   */
  private emitHeader(time: number, reason: 'initial' | 'change', model: string | undefined, out: TimelineEvent[]): void {
    const header: Record<string, unknown> = {
      tools: this.lastTools,
      config: { provider: PROVIDER, ...(model === undefined ? {} : { model }) },
    }
    if (this.lastSystem !== undefined) header.system = this.lastSystem
    this.emit(out, 'request/header', time, { header, reason })
    if (model !== undefined) this.lastHeaderModel = model
    this.headerSeen = true
  }

  private emitModelHeader(model: string | undefined, time: number, out: TimelineEvent[]): void {
    if (model === undefined) return
    if (this.lastHeaderModel !== undefined && sameModel(model, this.lastHeaderModel)) return
    this.emitHeader(time, 'change', model, out)
  }

  // ---------------------------------------------------------------------------
  // system
  // ---------------------------------------------------------------------------

  private onSystem(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const subtype = asString(record.subtype)
    if (subtype === 'compact_boundary') {
      this.onCompactBoundary(record, time, out)
      return
    }
    if (subtype === 'turn_duration') {
      // The turn is over; close the step it ended so the timing card books it.
      if (this.stepOpen && this.pendingCalls.size === 0) {
        this.emit(out, 'step/end', time)
        this.stepOpen = false
      }
      return
    }
    // stop_hook_summary, away_summary and other subtypes carry no model context.
  }

  /**
   * `compact_boundary` lands FIRST, immediately followed by the
   * `isCompactSummary` user record that replaces the dropped surface (verified
   * on real transcripts). The fold arms the shadow claim on the metering event
   * and consumes it on the next surface event, so the two must stay adjacent.
   */
  private onCompactBoundary(record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const meta = isRecord(record.compactMetadata) ? record.compactMetadata : undefined
    const preservedRecord = isRecord(meta?.preservedMessages) ? meta.preservedMessages : undefined
    const preserved = new Set(
      (asArray(preservedRecord?.allUuids) ?? []).filter((uuid): uuid is string => typeof uuid === 'string'),
    )
    const shadowed: number[] = []
    const kept: LiveNode[] = []
    for (const node of this.live) {
      if (node.uuids.some(uuid => preserved.has(uuid))) kept.push(node)
      else shadowed.push(node.seq)
    }
    this.live = kept

    const preTokens = asNumber(meta?.preTokens)
    const postTokens = asNumber(meta?.postTokens)
    const dropped = asNumber(meta?.cumulativeDroppedTokens)
    const delta = preTokens !== undefined && postTokens !== undefined ? preTokens - postTokens : undefined
    const shadowedTokenCount = delta !== undefined && delta > 0 ? delta : dropped ?? 0

    this.emit(out, 'compaction/summary', time, { shadowedSeqs: shadowed, shadowedTokenCount })
    this.pendingCompaction = {
      compactionId: asString(record.uuid),
      shadowedSeqs: shadowed,
      trigger: asString(meta?.trigger),
      preTokens,
      postTokens,
      durationMs: asNumber(meta?.durationMs),
    }
  }

  private onCompactSummary(
    record: Record<string, unknown>,
    content: readonly ContentBlock[],
    time: number,
    out: TimelineEvent[],
  ): void {
    const pending = this.pendingCompaction
    this.pendingCompaction = undefined
    const source: MessageSource = {
      kind: 'plugin',
      form: 'compaction',
      plugin: 'compaction',
      ...(pending?.compactionId === undefined ? {} : { compactionId: pending.compactionId }),
    }
    const data: Record<string, unknown> = { content, source }
    if (pending !== undefined) {
      data.compaction = {
        ...(pending.trigger === undefined ? {} : { trigger: pending.trigger }),
        ...(pending.preTokens === undefined ? {} : { preTokens: pending.preTokens }),
        ...(pending.postTokens === undefined ? {} : { postTokens: pending.postTokens }),
        ...(pending.durationMs === undefined ? {} : { durationMs: pending.durationMs }),
      }
    }
    const seqs = pending?.shadowedSeqs ?? []
    const surfaceOp = seqs.length > 0
      ? { op: 'replace', startSeq: Math.min(...seqs), endSeq: Math.max(...seqs) }
      : undefined
    const event = this.emit(out, 'user/message', time, data, surfaceOp)
    this.trackNode(event.seq, record)
  }

  // ---------------------------------------------------------------------------
  // Children, context window, content
  // ---------------------------------------------------------------------------

  private rememberSpawn(callId: string, input: unknown, time: number): void {
    const args = isRecord(input) ? input : undefined
    const label = asString(args?.description) ?? asString(args?.prompt) ?? 'subagent'
    const agentType = asString(args?.subagent_type)
    const model = asString(args?.model)
    this.pendingSpawns.set(callId, {
      callId,
      label: titleFrom(label),
      startedAt: time,
      ...(agentType === undefined ? {} : { agentType }),
      ...(model === undefined ? {} : { model }),
    })
  }

  private resolveSpawn(callId: string, meta: unknown, time: number): void {
    const spawn = this.pendingSpawns.get(callId)
    if (spawn === undefined) return
    this.pendingSpawns.delete(callId)
    if (!isRecord(meta)) return
    const agentId = asString(meta.agentId)
    if (agentId === undefined || agentId === '') return
    const resolved = asString(meta.resolvedModel) ?? spawn.model
    const label = asString(meta.description) ?? spawn.label
    this.children.set(agentId, {
      key: agentId,
      label: titleFrom(label),
      callId: spawn.callId,
      startedAt: spawn.startedAt,
      completedAt: time,
      ...(spawn.agentType === undefined ? {} : { agentType: spawn.agentType }),
      ...(resolved === undefined ? {} : { model: resolved }),
    })
  }

  /**
   * ASSUMPTION — the context window is not recorded anywhere in a Claude Code
   * transcript. It is inferred: a model id carrying the `[1m]` extended-window
   * marker, or any observed request whose billed prompt (input + cacheRead +
   * cacheWrite) already exceeds the standard 200k window, means the session ran
   * on the 1M window; otherwise 200k. The figure is emitted only when it
   * changes, so a session that crosses the threshold logs one route change.
   */
  private windowOf(): number {
    if (this.model !== undefined && this.model.includes('[1m]')) return LARGE_WINDOW
    return this.maxPrompt > SMALL_WINDOW ? LARGE_WINDOW : SMALL_WINDOW
  }

  private emitContext(time: number, out: TimelineEvent[]): void {
    const window = this.windowOf()
    if (window === this.lastWindow) return
    this.lastWindow = window
    this.emit(out, 'request/context', time, {
      contextWindow: window,
      provider: PROVIDER,
      ...(this.model === undefined ? {} : { model: this.model }),
    })
  }

  private blocksOf(items: readonly unknown[], meta: unknown): ContentBlock[] {
    const blocks: ContentBlock[] = []
    for (const item of items) {
      if (!isRecord(item)) continue
      if (item.type === 'text') {
        blocks.push({ type: 'text', text: asString(item.text) ?? '' })
      } else if (item.type === 'image') {
        blocks.push(imageBlockOf(meta))
      }
    }
    return blocks
  }

  /** Remember which record uuid produced which surface node (compaction shadowing). */
  private trackNode(seq: number, record: Record<string, unknown>): void {
    const uuid = asString(record.uuid)
    this.live.push({ seq, uuids: uuid === undefined ? [] : [uuid] })
  }

  private labelOf(): string | undefined {
    if (this.child) return this.firstPrompt
    return this.aiTitle ?? this.summaryTitle ?? this.firstPrompt
  }
}

// -----------------------------------------------------------------------------
// Attachments
// -----------------------------------------------------------------------------

/**
 * The injected text of an attachment record. Verified on real transcripts: the
 * rendered text lives on the RECORD (`record.rendered[].content`), a sibling of
 * `attachment`, not inside the attachment object. Hook and reminder
 * attachments carry no `rendered` array at all, so their own `content` / `text`
 * string is the fallback (the design's "no rendered text" rule would otherwise
 * drop every hook injection, which the harness really does send to the model).
 */
function renderedTextOf(record: Record<string, unknown>, attachment: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['rendered', 'renderedInHumanTurn']) {
    for (const source of [record, attachment]) {
      for (const item of asArray(source[key]) ?? []) {
        if (!isRecord(item)) continue
        const content = asString(item.content)
        if (content !== undefined && content !== '') parts.push(content)
      }
    }
  }
  if (parts.length > 0) return parts.join('\n')
  const direct = asString(attachment.content) ?? asString(attachment.text) ?? asString(attachment.banner)
  return direct === undefined ? '' : direct.trim() === '' ? '' : direct
}

/**
 * The provenance of one attachment injection. `kind` is the attachment type
 * (skills excepted, which ride the fold's own skill vocabulary) and `name` the
 * producer identity. `plugin` mirrors `name` when it says more than the type:
 * the fold's `injectionSourceName` reads `plugin` then `kind`, so without the
 * mirror the events card would label every file attachment "file".
 */
function attachmentSource(type: string, attachment: Record<string, unknown>): MessageSource {
  if (type === 'skill_listing') return { kind: 'skill-catalog', form: 'context', name: 'skills' }
  if (type === 'invoked_skills') {
    const skills = asArray(attachment.skills) ?? []
    const names = skills.flatMap(skill => {
      const name = isRecord(skill) ? asString(skill.name) : undefined
      return name === undefined || name === '' ? [] : [name]
    })
    return { kind: 'skill-invocation', form: 'context', name: names.length > 0 ? names.join(', ') : 'skills' }
  }
  const name = attachmentName(type, attachment)
  return {
    kind: type,
    form: 'context',
    name,
    ...(name === type ? {} : { plugin: name }),
  }
}

function attachmentName(type: string, attachment: Record<string, unknown>): string {
  if (type === 'instructions') {
    const paths = (asArray(attachment.files) ?? []).flatMap(file => {
      const path = isRecord(file) ? asString(file.path) : undefined
      return path === undefined || path === '' ? [] : [path]
    })
    if (paths.length > 0) return paths.join(', ')
  }
  if (type === 'file' || type === 'edited_text_file' || type === 'compact_file_reference') {
    const path = asString(attachment.displayPath) ?? asString(attachment.filename)
    if (path !== undefined && path !== '') return path
  }
  if (type.startsWith('hook_')) {
    const hook = asString(attachment.hookName)
    if (hook !== undefined && hook !== '') return hook
  }
  return type
}

// -----------------------------------------------------------------------------
// Images
// -----------------------------------------------------------------------------

/**
 * An image content block. A `Read` of an image records the dimensions the
 * harness actually sent (`toolUseResult.file.dimensions`), so the block states
 * Claude's own price — `ceil(width * height / 750)` tokens — instead of letting
 * the fold's generic estimator guess. Pasted images carry no dimensions and
 * stay plain.
 */
function imageBlockOf(meta: unknown): ContentBlock {
  const file = isRecord(meta) ? meta.file : undefined
  const dims = isRecord(file) ? dimensionsOf(file.dimensions) : null
  if (dims === null) return { type: 'image' }
  return {
    type: 'image',
    attachment: { width: dims.width, height: dims.height },
    tokens: imageTokensOf(dims.width, dims.height),
  }
}

// -----------------------------------------------------------------------------
// File ops
// -----------------------------------------------------------------------------

/**
 * The file operations one settled tool call performed, handed to the fold as
 * `tool/result` `data.fileOps`. Claude's own result metadata is richer than
 * anything derivable from the arguments alone (exact read windows, real diff
 * hunks, the files a `Bash` command edited), so the fold uses these records
 * instead of its argument-only `opsOfCall` derivation.
 *
 * MCP tools (`mcp__server__tool`) never produce rows: their file semantics are
 * unknown to this harness.
 */
function fileOpsOf(tool: string, args: Record<string, unknown> | null, meta: unknown): FileOpInput[] {
  if (tool.startsWith('mcp__')) return []
  const result = isRecord(meta) ? meta : null
  switch (tool) {
    case 'Read':
      return readOps(args, result)
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return writeOps(args, result)
    case 'Glob':
    case 'Grep':
      return searchOps(args, result)
    case 'Bash':
      return bashOps(result)
    default:
      return []
  }
}

function readOps(args: Record<string, unknown> | null, result: Record<string, unknown> | null): FileOpInput[] {
  const file = isRecord(result?.file) ? result.file : undefined
  const path = firstPath(args) ?? asString(file?.filePath)
  if (path === undefined) return []
  const start = asNumber(file?.startLine)
  const count = asNumber(file?.numLines)
  const window = start !== undefined && count !== undefined ? { start, count } : undefined
  return [{
    kind: 'read',
    path,
    added: 0,
    removed: 0,
    ...(window === undefined ? {} : { read: window }),
  }]
}

function writeOps(args: Record<string, unknown> | null, result: Record<string, unknown> | null): FileOpInput[] {
  const path = firstPath(args) ?? asString(result?.filePath)
  if (path === undefined) return []
  const patched = hunkDelta(result?.structuredPatch)
  if (patched !== null) return [{ kind: 'write', path, added: patched.added, removed: patched.removed }]
  return [{ kind: 'write', path, ...argsDelta(args) }]
}

/** The line footprint an edit/write call states in its own arguments. */
function argsDelta(args: Record<string, unknown> | null): { added: number; removed: number } {
  if (args === null) return { added: 0, removed: 0 }
  const edits = asArray(args.edits)
  if (edits !== undefined) {
    let added = 0
    let removed = 0
    for (const edit of edits) {
      if (!isRecord(edit)) continue
      added += countLines(asString(edit.new_string) ?? '')
      removed += countLines(asString(edit.old_string) ?? '')
    }
    return { added, removed }
  }
  const newText = asString(args.new_string) ?? asString(args.new_source) ?? asString(args.content) ?? ''
  const oldText = asString(args.old_string) ?? asString(args.old_source) ?? ''
  return { added: countLines(newText), removed: countLines(oldText) }
}

function searchOps(args: Record<string, unknown> | null, result: Record<string, unknown> | null): FileOpInput[] {
  const pattern = asString(args?.pattern)
  const path = asString(args?.path)
  const target = path ?? pattern
  const ops: FileOpInput[] = []
  if (target !== undefined && target !== '') {
    ops.push({
      kind: 'search',
      path: target,
      added: 0,
      removed: 0,
      ...(path === undefined ? { pattern: true as const } : {}),
      ...(pattern === undefined ? {} : { detail: pattern }),
    })
  }
  const names = asArray(result?.filenames) ?? asArray(result?.paths) ?? []
  for (const name of names.slice(0, MAX_SEARCH_ROWS)) {
    if (typeof name !== 'string' || name === '') continue
    ops.push({
      kind: 'search',
      path: name,
      added: 0,
      removed: 0,
      ...(pattern === undefined ? {} : { detail: pattern }),
    })
  }
  return ops
}

/** A `Bash` command the harness detected as editing files reports a real diff. */
function bashOps(result: Record<string, unknown> | null): FileOpInput[] {
  const diff = isRecord(result?.bashEditDiff) ? result.bashEditDiff : undefined
  if (diff === undefined) return []
  const ops: FileOpInput[] = []
  for (const file of asArray(diff.files) ?? []) {
    if (!isRecord(file)) continue
    const path = asString(file.filePath)
    if (path === undefined || path === '') continue
    const delta = hunkDelta(file.hunks) ?? { added: 0, removed: 0 }
    ops.push({ kind: 'write', path, added: delta.added, removed: delta.removed })
  }
  if (ops.length > 0) return ops
  for (const path of asArray(diff.changedFiles) ?? []) {
    if (typeof path !== 'string' || path === '') continue
    ops.push({ kind: 'write', path, added: 0, removed: 0 })
  }
  return ops
}

export function createClaudeSynthesizer(file: SessionFileRef): EventSynthesizer {
  return new ClaudeSynthesizer(file)
}
