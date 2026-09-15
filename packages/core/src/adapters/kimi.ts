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
 *   generation cap — but only on `kind: 'loop'` requests. A `kind: 'compaction'`
 *   request carries no `turnStep` and its `maxTokens` is the summary model's cap
 *   (131072): it must neither open a step nor replace the window.
 * - Human vs injected input is decided by `message.origin`, never by the text
 *   (see `kimiMessageClass`, which the server scanner and the context
 *   synthesizer share). A subagent's delegated prompt is
 *   `{ kind: 'system_trigger', name: 'subagent' }` — the one trigger the CLI
 *   itself displays as a prompt (`isDisplayablePromptOrigin`) — and its text
 *   opens with a `<git-context>` prelude that titles skip (`kimiTitleText`).
 *
 * Subagents live in sibling files: `agents/<agentId>/wire.jsonl`. The parent
 * names a child in exactly two durable places (kimi-code writes no durable
 * spawn record): a `task.started` with `info.kind === 'agent'` (background
 * launches, carrying `info.parentToolCallId`), and the `Agent`/`AgentSwarm`
 * tool RESULT TEXT — a foreground header of `agent_id:` /
 * `actual_subagent_type:` / `status:` lines, or one
 * `<subagent agent_id="…" item="…" outcome="…">` element per swarm item
 * (`agentMentions`). A foreground result arrives AFTER the child's whole
 * transcript, so an unbound child's loop events are buffered per run and
 * replayed into sub-calls when the result finally binds it.
 *
 * Images travel as `{ type: 'image_url', imageUrl: { url } }` parts — in user
 * messages and in `tool.result.output` ARRAYS (ReadMediaFile). The url is an
 * inline `data:` URL below ~4 KB, else a `blobref:<mime>;<sha256>` whose bytes
 * sit in the agent's `blobs/<sha256>` store; the image store keeps the ref and
 * the client resolves it through the server (`DataUrlImageStore.addImageUrl`).
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

/** Tools whose result announces one or more subagents. */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'AgentSwarm'])
/** `step.end.finishReason` values that mean the response did not run to completion. */
const ABORTED_FINISH_REASONS: ReadonlySet<string> = new Set([
  'aborted', 'abort', 'cancelled', 'canceled', 'interrupted', 'error',
])
/** Cap on one run's buffered loop events; past it nesting is lost but counters stay exact. */
const CHILD_BUFFER_MAX = 512

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
 * A missing origin is a person (early records omitted it). A subagent's
 * delegated prompt (`system_trigger`/`subagent`) is the one harness-written
 * prompt the CLI itself displays as one (`isDisplayablePromptOrigin`), so it
 * counts exactly like a human prompt — that is what gives a subagent
 * transcript viewed on its own one prompt and a title. Everything else is
 * harness-injected context that must neither open a turn nor count as a
 * prompt.
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
    case 'system_trigger':
      if (asString(origin['name']) === 'subagent') return { kind: 'human' }
      return { kind: 'injection', name: kind }
    default:
      return { kind: 'injection', name: kind }
  }
}

/** The `<git-context>…</git-context>` prelude a delegated prompt opens with. */
const GIT_CONTEXT_PRELUDE = /^<git-context>[\s\S]*?<\/git-context>\s*/

/**
 * The title-worthy text of a Kimi prompt. The harness prepends a git brief to
 * a subagent's delegated prompt; it is context, not the task, so titles and
 * search documents skip it. Human prompts never carry one.
 */
export function kimiTitleText(text: string): string {
  return text.replace(GIT_CONTEXT_PRELUDE, '')
}

/** One agent a tool result announces, parsed from its text (see the module header). */
export interface KimiAgentMention {
  readonly agentId: string
  readonly description: string | null
  readonly agentType: string | null
  /** Terminal state the result reports, when it reports one. */
  readonly status: SubagentStatus | null
}

/** Launch receipt lines of a single-agent result; `status`/`type` are read from the header only. */
const AGENT_ID_LINE = /^[ \t]*agent_id:[ \t]*(\S+)[ \t]*$/m
const AGENT_TYPE_LINE = /^[ \t]*actual_subagent_type:[ \t]*(\S+)[ \t]*$/m
const AGENT_STATUS_LINE = /^[ \t]*status:[ \t]*(\w+)[ \t]*$/m
/** One single-line `<subagent …>` element per AgentSwarm item. */
const SWARM_ELEMENT = /<subagent\b([^>\n]*)>/g
const SWARM_ATTRIBUTE = /(\w+)="([^"]*)"/g

/**
 * The agents an `Agent`/`AgentSwarm` result announces. Two on-disk shapes: the
 * line-oriented header of a single-agent result (foreground or background),
 * and the XML-ish `<agent_swarm_result>` of a swarm, one `<subagent>` element
 * per item. The header ends at the first blank line: the body is the agent's
 * own text and may quote any of these shapes.
 */
export function agentMentions(output: string): KimiAgentMention[] {
  const mentions: KimiAgentMention[] = []
  const header = output.split(/\n[ \t]*\n/, 1)[0] ?? ''
  const agentId = AGENT_ID_LINE.exec(output)?.[1]
  if (agentId !== undefined) {
    mentions.push({
      agentId,
      description: null,
      agentType: AGENT_TYPE_LINE.exec(header)?.[1] ?? null,
      status: mentionStatus(AGENT_STATUS_LINE.exec(header)?.[1]),
    })
  }
  for (const element of output.matchAll(SWARM_ELEMENT)) {
    const attrs = new Map<string, string>()
    for (const attr of element[1]?.matchAll(SWARM_ATTRIBUTE) ?? []) {
      const [, key, value] = attr
      if (key !== undefined && value !== undefined) attrs.set(key, unescapeXml(value))
    }
    const id = attrs.get('agent_id')
    if (id === undefined || id === '') continue
    mentions.push({
      agentId: id,
      description: attrs.get('item') ?? null,
      agentType: null,
      status: mentionStatus(attrs.get('outcome')),
    })
  }
  return mentions
}

/** A terminal status a result text can report; anything else leaves the run's lifecycle alone. */
function mentionStatus(value: string | undefined): SubagentStatus | null {
  switch (value) {
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'aborted':
    case 'killed':
    case 'stopped':
    case 'cancelled':
    case 'canceled':
      return 'stopped'
    default:
      return null
  }
}

/** The four escapes kimi-code's `escapeXmlAttribute` applies, undone (the ampersand last). */
function unescapeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
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
  /** Loop events seen before the parent call was known; replayed into sub-calls on binding. */
  buffered: BufferedChildEvent[]
}

/** One loop event of a not-yet-bound child transcript. */
interface BufferedChildEvent {
  event: Record<string, unknown>
  time: number
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

function contentBlocks(
  items: readonly unknown[],
  images?: DataUrlImageStore,
  fileId?: string,
): ContentBlock[] {
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
    // `{ type: 'image_url', imageUrl: { url, name? } }` — the only media part
    // kimi writes (ReadMediaFile results, image attachments).
    if (type === 'image_url' && images !== undefined) {
      const imageUrl = isRecord(item['imageUrl']) ? item['imageUrl'] : undefined
      const url = asString(imageUrl?.['url'])
      if (url === undefined) continue
      const attachment = images.addImageUrl(url, asString(imageUrl?.['name']), fileId)
      if (attachment !== undefined) blocks.push({ type: 'image', attachment })
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
  /** The main transcript's file id, which main-flow image attachments are attributed to. */
  private mainFileId: string | null = null

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
    this.mainFileId ??= file.id
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
    // A compaction request is no loop step: it has no `turnStep`, and its
    // `maxTokens` is the summary model's cap, not the context window. Folding
    // it like a loop request would open a phantom step (an empty assistant
    // node at the compaction boundary) and corrupt the window figure.
    if (asString(record['kind']) === 'compaction') return
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
      : contentBlocks(asArray(raw) ?? [], this.images, this.mainFileId ?? undefined)
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
    const text = kimiTitleText(textOf(content))
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
      ...this.resultBlocks(result['output']),
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

  /** A result's `output`: a plain string, or a content-part array (ReadMediaFile images). */
  private resultBlocks(output: unknown): ContentBlock[] {
    if (typeof output === 'string') return [{ type: 'text', text: output }]
    return contentBlocks(asArray(output) ?? [], this.images, this.mainFileId ?? undefined)
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
    // The child's first lines can outrun this record: replay what they buffered.
    if (run.callId !== null) this.flushChildBuffer(run)
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
   * Bind the agent(s) an `Agent`/`AgentSwarm` result announces (`agentMentions`
   * parses the two on-disk shapes). The child's transcript usually streamed in
   * BEFORE this result — a foreground result is written only when the run ends
   * — so the run typically exists already and binding fills its facts; the
   * events it buffered are then replayed under this call. A run already bound
   * (a `task.started` won the race, or this is an `Agent(resume=…)` result
   * naming the same child again) keeps its first binding.
   */
  private bindAgentFromResult(argsRaw: string, callId: string, output: string, time: number): void {
    const mentions = agentMentions(output)
    if (mentions.length === 0) return
    const args: unknown = parseJsonLine(argsRaw)
    const fallbackDescription = isRecord(args)
      ? asString(args['description']) ?? (asString(args['prompt'])?.slice(0, 80) ?? null)
      : null
    const fallbackType = isRecord(args) ? asString(args['subagent_type']) ?? null : null
    for (const mention of mentions) {
      const run = this.runFor(mention.agentId, time)
      if (run.callId !== null) continue
      run.callId = callId
      run.description ??= mention.description ?? fallbackDescription
      run.agentType ??= mention.agentType ?? fallbackType
      if (run.status === 'launching') run.status = 'running'
      if (mention.status !== null) {
        run.status = mention.status
        run.endedAt ??= time
      }
      this.flushChildBuffer(run)
    }
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
      buffered: [],
    }
    this.runs.set(agentId, run)
    return run
  }

  /**
   * A child transcript contributes its counters and, when the parent call is
   * known, its tool calls as sub-calls of that call. Its prompts and assistant
   * text stay in the child's own view, which the server serves standalone.
   *
   * While the parent call is NOT known (a foreground `Agent` result is written
   * only when the run ends), the loop events are buffered, so the bind that
   * arrives later can still nest them.
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
    if (asString(event['type']) === 'tool.call') run.toolCalls += 1
    if (run.callId === null) {
      if (run.buffered.length < CHILD_BUFFER_MAX) run.buffered.push({ event, time })
      return
    }
    this.applyChildLoopEvent(file.id, run, event, time)
  }

  /** Replay the events an unbound child buffered, nesting them under the now-known parent call. */
  private flushChildBuffer(run: AgentRun): void {
    const buffered = run.buffered
    run.buffered = []
    for (const { event, time } of buffered) this.applyChildLoopEvent(run.agentId, run, event, time)
  }

  private applyChildLoopEvent(
    fileId: string,
    run: AgentRun,
    event: Record<string, unknown>,
    time: number,
  ): void {
    switch (asString(event['type'])) {
      case 'tool.call': {
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
        const output = result['output']
        this.emitToolResult({
          callId,
          time,
          content: typeof output === 'string'
            ? [{ type: 'text', text: output }]
            : contentBlocks(asArray(output) ?? [], this.images, fileId),
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
