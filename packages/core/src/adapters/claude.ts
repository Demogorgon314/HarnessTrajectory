/**
 * Claude Code transcript adapter.
 *
 * Reads the JSONL Claude Code writes under `~/.claude/projects/<slug>/<sessionId>.jsonl`
 * (one record per line) and folds it incrementally into the harness-agnostic
 * trajectory contract.
 *
 * Subagents: every `Agent` (formerly `Task`) tool call spawns a child
 * transcript (`<sessionId>/subagents/agent-<agentId>.jsonl`, older layouts
 * `agent-<id>.jsonl` beside the session, older still `isSidechain` records in
 * the main file). Child records are bound to the parent call that spawned
 * them, in order of certainty: the `toolUseId` from the child's `.meta.json`,
 * the `agentId` the parent's tool result reports, the synthetic tool result a
 * fork carries in its first message, then the prompt text. Bound children
 * contribute their tool calls as sub-calls of the parent record; their prompts
 * and assistant output stay in their own transcript, which the server can
 * serve on its own (`role: 'main'` plus `agent` facts) for the subagent view.
 */

import type {
  AssistantBlock, AssistantRequestConfig, AssistantRequestView, ContentBlock, ConversationLocation,
  ImageAttachmentRef, TokenUsage,
} from '../contract.ts'
import type {
  AgentFileMeta, ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun, SubagentStatus,
} from '../session.ts'
import { asArray, asString, isRecord, parseJsonLine, parseTime } from '../jsonl.ts'
import { DataUrlImageStore, TrajectoryAssembler, normalizeImageMediaType, titleFrom } from './shared.ts'

const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task'])
const TURN_END_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'max_tokens', 'stop_sequence'])
/** Virtual file key prefix for `isSidechain` records written into the main transcript. */
const SIDECHAIN_PREFIX = ' sidechain:'

/** One API response being accumulated from its per-block lines. */
interface OpenRequest {
  /** A stop marker made this response visible; later sibling blocks update it. */
  published?: boolean
  requestId: string
  messageId: string | undefined
  seq: number
  turn: number
  step: number
  blocks: AssistantBlock[]
  firstTime: number
  lastTime: number
  stepStartTime: number | null
  usage: TokenUsage | undefined
  model: string | undefined
  reasoningEffort: string | undefined
  error: string | undefined
}

/** Where a nested transcript hangs in the parent ledger. */
interface Nesting {
  parentCallId: string
  turn: number
  step: number
}

interface FileState {
  /** Records nest under a parent call instead of forming turns. */
  readonly child: boolean
  /** An agent transcript served as a session of its own. */
  readonly standalone: boolean
  /** Transcript file id, or `null` for sidechain records inside the main file. */
  readonly fileId: string | null
  agentId: string | null
  toolUseId: string | null
  fork: boolean
  sawPrompt: boolean
  nesting: Nesting | undefined
  open: OpenRequest | undefined
  readonly requestsById: Map<string, OpenRequest>
  lastInputTime: number | null
  lastTime: number | null
  toolCalls: number
}

/** Parent-side view of one `Agent` tool call. */
interface AgentCall {
  callId: string
  turn: number
  step: number
  time: number
  prompt: string | null
  description: string | null
  agentType: string | null
  model: string | null
  agentId: string | null
  /** A child transcript has been bound to this call. */
  claimed: boolean
  fileKey: string | null
  status: SubagentStatus
  endedAt: number | null
}

function usageFrom(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = typeof value.input_tokens === 'number' ? value.input_tokens : 0
  const output = typeof value.output_tokens === 'number' ? value.output_tokens : 0
  const cacheRead = value.cache_read_input_tokens
  const cacheWrite = value.cache_creation_input_tokens
  const details = value.output_tokens_details
  const reasoning = isRecord(details) ? details.thinking_tokens : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...(typeof cacheRead === 'number' ? { cacheReadTokens: cacheRead } : {}),
    ...(typeof cacheWrite === 'number' ? { cacheWriteTokens: cacheWrite } : {}),
    ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
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

function textOfContent(content: readonly ContentBlock[]): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** Text of a simple `<tag>value</tag>` element inside harness-injected markup. */
function taggedValue(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return match?.[1]?.trim()
}

function notificationStatus(value: string | undefined): SubagentStatus {
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

class ClaudeParser implements SessionParser {
  readonly kind = 'claude' as const
  readonly images = new DataUrlImageStore()

  private readonly assembler = new TrajectoryAssembler()
  private readonly files = new Map<string, FileState>()
  private readonly turnSeqs = new Map<number, number[]>()
  private readonly closedTurns = new Set<number>()
  /** `Agent` calls in launch order. */
  private readonly agentCalls = new Map<string, AgentCall>()
  private readonly callByAgentId = new Map<string, string>()
  private turn = 0
  private step = 0
  private lastTime = 0
  private aiTitle: string | null = null
  private summaryTitle: string | null = null
  private firstPrompt: string | null = null
  private cwd: string | null = null
  private model: string | null = null
  private startedAt: number | null = null
  private promptCount = 0

  push(line: string, file: SessionFileRef, lineIndex?: number): void {
    this.assembler.beginLine(file.id, lineIndex)
    const record = parseJsonLine(line)
    if (!isRecord(record)) return
    const type = asString(record.type)
    if (type === undefined) return
    const time = this.recordTime(record)
    this.observeMeta(record, time)
    const state = this.stateFor(file, record)
    if (state.child) {
      state.lastTime = time
      if (type === 'fork-context-ref') {
        state.fork = true
        return
      }
      // A child record ahead of its prompt (or after a lost one) can still bind
      // by id; until it binds, nothing from the child may reach the parent ledger.
      if (state.nesting === undefined && type !== 'user' && !this.bindChild(state, '', [])) return
    }
    switch (type) {
      case 'user':
        this.onUser(record, time, state)
        return
      case 'assistant':
        this.onAssistant(record, time, state)
        return
      case 'system':
        this.finalize(state)
        if (record.subtype === 'turn_duration') this.closeTurn(state)
        return
      case 'attachment':
        this.finalize(state)
        this.onAttachment(record, time, state)
        return
      case 'fork-context-ref':
        this.onForkContextRef(record, time, state)
        return
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
        // atis-latch, pr-link, cost-state, file-history-*: not conversation.
        return
    }
  }

  snapshot() {
    return this.assembler.snapshot()
  }

  meta(): ParsedSessionMeta {
    return {
      title: this.aiTitle ?? this.summaryTitle ?? this.firstPrompt,
      cwd: this.cwd,
      model: this.model,
      startedAt: this.startedAt,
      promptCount: this.promptCount,
    }
  }

  subagents(): readonly SubagentRun[] {
    const runs: SubagentRun[] = []
    const seen = new Set<string>()
    for (const call of this.agentCalls.values()) {
      const state = call.fileKey === null ? undefined : this.files.get(call.fileKey)
      if (state?.fileId !== undefined && state.fileId !== null) seen.add(state.fileId)
      runs.push({
        agentId: call.agentId ?? call.callId,
        fileId: state?.fileId ?? null,
        callId: call.callId,
        description: call.description,
        agentType: call.agentType,
        model: call.model,
        status: call.status,
        startedAt: call.time,
        endedAt: call.endedAt,
        lastTime: state?.lastTime ?? null,
        toolCalls: state?.toolCalls ?? 0,
      })
    }
    // Child transcripts whose spawning call is not in this transcript (for
    // example a session resumed after the launch) still deserve a row.
    for (const state of this.files.values()) {
      if (!state.child || state.fileId === null || seen.has(state.fileId) || state.nesting !== undefined) continue
      runs.push({
        agentId: state.agentId ?? state.fileId,
        fileId: state.fileId,
        callId: null,
        description: null,
        agentType: state.fork ? 'fork' : null,
        model: null,
        status: 'running',
        startedAt: null,
        endedAt: null,
        lastTime: state.lastTime,
        toolCalls: state.toolCalls,
      })
    }
    return runs
  }

  imageUrl(attachment: ImageAttachmentRef): string | undefined {
    return this.images.get(attachment.attachmentId)
  }

  // -------------------------------------------------------------------------
  // Record handlers
  // -------------------------------------------------------------------------

  private onUser(record: Record<string, unknown>, time: number, state: FileState): void {
    const message = isRecord(record.message) ? record.message : undefined
    const rawContent = message?.content
    const items = asArray(rawContent)
    const results = (items ?? []).filter(
      (item): item is Record<string, unknown> => isRecord(item) && item.type === 'tool_result',
    )
    const content: ContentBlock[] = typeof rawContent === 'string'
      ? [{ type: 'text', text: rawContent }]
      : this.contentBlocks(items ?? [])
    const text = textOfContent(content)
    const resultIds = results.flatMap(item => (typeof item.tool_use_id === 'string' ? [item.tool_use_id] : []))
    if (state.child && state.nesting === undefined && !this.bindChild(state, text, resultIds)) return
    // A fork's first message carries the parent's own `Agent` tool result
    // ("Fork started"): inherited context, not a result this transcript produced.
    const inherited = state.fork && !state.sawPrompt && results.length > 0
    const own = results.filter(item => !inherited && !(state.child && this.agentCalls.has(asString(item.tool_use_id) ?? '')))
    if (inherited && state.standalone) {
      const blocks = results.flatMap(item => this.resultContent(item.content))
      this.pushContext(blocks, time, { kind: 'meta', origin: 'fork' }, 'fork-context', state)
    }
    if (own.length > 0) {
      this.finalize(state)
      for (const item of own) this.onToolResult(item, record, time, state)
      state.lastInputTime = time
      return
    }
    if (results.length > 0 && !inherited) {
      // Only synthetic results: nothing to record.
      state.lastInputTime = time
      return
    }
    this.finalize(state)
    if (record.isCompactSummary === true) {
      this.onCompaction(content, time, state)
      return
    }
    if (record.isMeta === true) {
      this.pushContext(content, time, { kind: 'meta' }, 'meta', state)
      return
    }
    const injected = classifyInjectedUser(record, text)
    if (injected !== null) {
      // Harness-injected user messages (task notifications, slash-command
      // expansions, local command output) steer the model without being a
      // human prompt: keep them as context so they neither open a turn nor
      // count as prompts.
      if (injected === 'task-notification') this.onTaskNotification(text, time)
      this.pushContext(content, time, { kind: 'meta', origin: injected }, injected, state)
      state.lastInputTime = time
      return
    }
    state.sawPrompt = true
    if (state.child) {
      // The child's prompt is the parent's `Agent` argument; it stays in the child's own view.
      state.lastInputTime = time
      return
    }
    this.turn += 1
    this.step = 0
    this.promptCount += 1
    if (this.firstPrompt === null && text.trim() !== '') this.firstPrompt = titleFrom(text)
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'user',
      seq,
      time,
      content,
      source: {
        kind: 'user',
        ...(isRecord(record.origin) ? { origin: record.origin } : {}),
        ...(typeof record.promptSource === 'string' ? { promptSource: record.promptSource } : {}),
      },
    })
    state.lastInputTime = time
  }

  private onToolResult(
    block: Record<string, unknown>,
    record: Record<string, unknown>,
    time: number,
    state: FileState,
  ): void {
    const callId = asString(block.tool_use_id)
    if (callId === undefined) return
    const content = this.resultContent(block.content)
    const agentCall = state.child ? undefined : this.agentCalls.get(callId)
    if (agentCall !== undefined) this.onAgentResult(agentCall, block, record, time)
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(callId, {
      seq,
      time,
      content,
      isError: block.is_error === true,
      ...(record.toolUseResult === undefined ? {} : { meta: record.toolUseResult }),
    })
    if (topLevel && !state.child) {
      this.locate(seq, this.turn)
      this.assembler.pushNode(node)
    } else {
      this.assembler.touch()
    }
  }

  private onAssistant(record: Record<string, unknown>, time: number, state: FileState): void {
    const message = isRecord(record.message) ? record.message : undefined
    const requestId = asString(record.requestId) ?? asString(message?.id) ?? asString(record.uuid) ?? 'request'
    if (state.open !== undefined && state.open.requestId !== requestId) this.finalize(state)
    const model = asString(message?.model)
    if (this.model === null && model !== undefined) this.model = model
    // A tool result may be persisted between sibling blocks of one request.
    // Reuse that request's identity, sequence and step across the boundary.
    let open = state.open ?? state.requestsById.get(requestId)
    if (open === undefined) {
      const nesting = state.nesting
      const turn = nesting?.turn ?? this.turn
      let step: number
      if (nesting !== undefined) {
        step = nesting.step
      } else {
        this.step += 1
        step = this.step
      }
      open = {
        requestId,
        messageId: asString(message?.id),
        seq: nesting === undefined ? this.assembler.seq.next() : 0,
        turn,
        step,
        blocks: [],
        firstTime: time,
        lastTime: time,
        stepStartTime: state.lastInputTime,
        usage: undefined,
        model: undefined,
        reasoningEffort: undefined,
        error: undefined,
      }
      state.open = open
      state.requestsById.set(requestId, open)
    }
    state.open = open
    open.lastTime = time
    if (model !== undefined) open.model = model
    const effort = asString(record.effort) ?? asString(record.perTurnEffort)
    if (effort !== undefined) open.reasoningEffort = effort
    const usage = usageFrom(message?.usage)
    if (usage !== undefined) open.usage = usage
    const rawContent = message?.content
    const items: readonly unknown[] = typeof rawContent === 'string'
      ? [{ type: 'text', text: rawContent }]
      : asArray(rawContent) ?? []
    let sawToolUse = false
    // A fork's transcript opens with a copy of the parent's assistant message
    // (the fork point); its tool use belongs to the parent, not to this run.
    const inheritedCalls = state.fork && !state.sawPrompt
    for (const item of items) {
      if (!isRecord(item)) continue
      switch (item.type) {
        case 'thinking':
          open.blocks.push({ kind: 'reasoning', text: asString(item.thinking) ?? '' })
          break
        case 'text':
          open.blocks.push({ kind: 'text', text: asString(item.text) ?? '' })
          break
        case 'tool_use': {
          const callId = asString(item.id)
          if (callId === undefined) break
          sawToolUse = true
          const name = asString(item.name) ?? 'tool'
          const argsRaw = stringifyArgs(item.input)
          open.blocks.push({ kind: 'tool-call', callId, name, argsRaw })
          if (inheritedCalls || (state.child && this.assembler.tools.has(callId))) break
          this.assembler.tools.start({
            callId,
            ...(state.nesting === undefined ? {} : { parentCallId: state.nesting.parentCallId }),
            name,
            argsRaw,
            turn: open.turn,
            step: open.step,
            time,
            subCalls: [],
          })
          state.toolCalls += 1
          if (!state.child && SUBAGENT_TOOL_NAMES.has(name)) {
            this.onAgentCall(callId, item.input, open.turn, open.step, time)
          }
          break
        }
        case 'image': {
          const block = this.imageBlock(item)
          if (block !== undefined) open.blocks.push({ kind: 'image', attachment: block.attachment })
          break
        }
        default:
          open.blocks.push({ kind: 'other', block: item })
      }
    }
    if (record.isApiErrorMessage === true) {
      const text = open.blocks.flatMap(block => (block.kind === 'text' ? [block.text] : [])).join('\n')
      open.error = text === '' ? 'API error' : text
      this.finalize(state)
      return
    }
    if (state.nesting === undefined) {
      this.assembler.partial = { turn: open.turn, step: open.step, blocks: [...open.blocks] }
      this.assembler.upsertRequest(this.requestView(open, 'running'))
    }
    this.assembler.touch()
    const stop = asString(message?.stop_reason)
    if ((stop !== undefined && TURN_END_STOP_REASONS.has(stop)) || (stop === 'tool_use' && sawToolUse)) {
      this.finalize(state, true)
    }
  }

  private onCompaction(content: readonly ContentBlock[], time: number, state: FileState): void {
    if (state.child) return
    const requestSeq = this.assembler.seq.next()
    const seq = this.assembler.seq.next()
    const summary = textOfContent(content)
    this.assembler.upsertRequest({
      purpose: 'compaction',
      startSeq: requestSeq,
      startedAt: time,
      completedAt: time,
      status: 'complete',
      turn: this.turn > 0 ? this.turn : null,
      step: 0,
      resultSeq: seq,
      replacementSeq: seq,
      summary: content,
    })
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'compaction',
      seq,
      time,
      summary: summary === '' ? null : summary,
      summaryEventSeq: seq,
      shadowedItemCount: null,
      shadowedTokenCount: null,
    })
    state.lastInputTime = time
  }

  private onAttachment(record: Record<string, unknown>, time: number, state: FileState): void {
    const attachment = isRecord(record.attachment) ? record.attachment : undefined
    if (attachment === undefined) return
    const text = asString(attachment.content)
    if (text === undefined || text.trim() === '') return
    const label = asString(attachment.hookName) ?? asString(attachment.type) ?? 'attachment'
    this.pushContext([{ type: 'text', text }], time, { kind: 'attachment', name: label }, label, state)
  }

  /** A fork's first line: which parent message it branched from and how much context it inherits. */
  private onForkContextRef(record: Record<string, unknown>, time: number, state: FileState): void {
    state.fork = true
    if (!state.standalone) return
    const parent = asString(record.parentSessionId)
    const length = typeof record.contextLength === 'number' ? record.contextLength : null
    const text = [
      'Forked from the parent session',
      parent === undefined ? '' : ` ${parent}`,
      length === null ? '' : `, inheriting ${length} context items`,
      '.',
    ].join('')
    this.pushContext([{ type: 'text', text }], time, { kind: 'meta', origin: 'fork' }, 'fork-context-ref', state)
  }

  private pushContext(
    content: readonly ContentBlock[],
    time: number,
    source: unknown,
    label: string,
    state: FileState,
  ): void {
    if (state.child) return
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'context',
      seq,
      time,
      content,
      source,
      provenance: { role: 'inject', label },
      form: 'notice',
    })
    state.lastInputTime = time
  }

  // -------------------------------------------------------------------------
  // Subagent bookkeeping
  // -------------------------------------------------------------------------

  private onAgentCall(callId: string, input: unknown, turn: number, step: number, time: number): void {
    const args = isRecord(input) ? input : {}
    this.agentCalls.set(callId, {
      callId,
      turn,
      step,
      time,
      prompt: asString(args.prompt) ?? null,
      description: asString(args.description) ?? null,
      agentType: asString(args.subagent_type) ?? null,
      model: asString(args.model) ?? null,
      agentId: null,
      claimed: false,
      fileKey: null,
      status: 'launching',
      endedAt: null,
    })
  }

  /** The parent's tool result for an `Agent` call: a launch receipt (async) or the final report (sync). */
  private onAgentResult(
    call: AgentCall,
    block: Record<string, unknown>,
    record: Record<string, unknown>,
    time: number,
  ): void {
    const meta = isRecord(record.toolUseResult) ? record.toolUseResult : undefined
    const agentId = asString(meta?.agentId)
    if (agentId !== undefined) this.claim(call, agentId)
    call.model ??= asString(meta?.resolvedModel) ?? null
    call.description ??= asString(meta?.description) ?? null
    if (meta?.status === 'async_launched' || meta?.isAsync === true) {
      if (call.status === 'launching') call.status = 'running'
      return
    }
    if (call.endedAt === null) {
      call.status = block.is_error === true ? 'failed' : 'completed'
      call.endedAt = time
    }
  }

  /** `<task-notification>` in the parent: a background agent stopped. */
  private onTaskNotification(text: string, time: number): void {
    const taskId = taggedValue(text, 'task-id')
    const toolUseId = taggedValue(text, 'tool-use-id')
    const callId = toolUseId ?? (taskId === undefined ? undefined : this.callByAgentId.get(taskId))
    const call = callId === undefined ? undefined : this.agentCalls.get(callId)
    if (call === undefined) return
    if (taskId !== undefined) this.claim(call, taskId)
    call.status = notificationStatus(taggedValue(text, 'status'))
    call.endedAt = time
  }

  private claim(call: AgentCall, agentId: string): void {
    call.agentId ??= agentId
    call.claimed = true
    this.callByAgentId.set(agentId, call.callId)
  }

  /**
   * Bind a child transcript to the parent call it answers. Returns false when
   * no call can be identified yet; the caller then drops the record.
   */
  private bindChild(state: FileState, prompt: string, resultIds: readonly string[]): boolean {
    let call: AgentCall | undefined
    if (state.toolUseId !== null) call = this.agentCalls.get(state.toolUseId)
    if (call === undefined && state.agentId !== null) {
      const callId = this.callByAgentId.get(state.agentId)
      if (callId !== undefined) call = this.agentCalls.get(callId)
    }
    for (const id of resultIds) {
      if (call !== undefined) break
      call = this.agentCalls.get(id)
    }
    if (call === undefined) {
      const unclaimed = [...this.agentCalls.values()].filter(candidate => !candidate.claimed)
      if (prompt !== '') call = unclaimed.findLast(candidate => candidate.prompt === prompt)
      // Last resort: the newest launch nobody has answered yet.
      call ??= unclaimed.findLast(candidate => this.assembler.tools.isPending(candidate.callId))
    }
    if (call === undefined) return false
    state.nesting = { parentCallId: call.callId, turn: call.turn, step: call.step }
    call.claimed = true
    call.fileKey = this.fileKeyOf(state)
    if (state.agentId !== null) this.claim(call, state.agentId)
    if (call.status === 'launching') call.status = 'running'
    return true
  }

  private fileKeyOf(state: FileState): string | null {
    for (const [key, candidate] of this.files) {
      if (candidate === state) return key
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Request finalization
  // -------------------------------------------------------------------------

  private finalize(state: FileState, retain = false): void {
    const open = state.open
    if (open === undefined) return
    if (!retain) state.open = undefined
    if (state.child) {
      // Nested transcripts contribute only their tool calls; the parent's
      // tool_result carries the subagent's report.
      this.assembler.touch()
      return
    }
    this.assembler.partial = null
    this.locate(open.seq, open.turn)
    if (open.error !== undefined) {
      this.assembler.pushNode({
        kind: 'turn-error',
        seq: open.seq,
        time: open.lastTime,
        turn: open.turn,
        step: open.step,
        message: open.error,
      })
      this.assembler.upsertRequest(this.requestView(open, 'error'))
      return
    }
    const provenance = open.model === undefined ? undefined : { provider: 'anthropic', model: open.model }
    const requestConfig = this.requestConfig(open)
    const node = {
      kind: 'assistant',
      seq: open.seq,
      ...(open.messageId === undefined ? {} : { messageId: open.messageId }),
      time: open.lastTime,
      turn: open.turn,
      step: open.step,
      blocks: [...open.blocks],
      ...(open.usage === undefined ? {} : { usage: open.usage }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      timing: {
        stepStartTime: open.stepStartTime,
        firstTokenTime: null,
        completedTime: open.lastTime,
      },
    } as const
    if (open.published) this.assembler.replaceNode(open.seq, node)
    else this.assembler.pushNode(node)
    open.published = true
    this.assembler.upsertRequest(this.requestView(open, 'complete'))
  }

  private requestView(open: OpenRequest, status: 'running' | 'complete' | 'error'): AssistantRequestView {
    const provenance = open.model === undefined ? undefined : { provider: 'anthropic', model: open.model }
    const requestConfig = this.requestConfig(open)
    return {
      purpose: 'assistant',
      startSeq: open.seq,
      startedAt: open.stepStartTime ?? open.firstTime,
      completedAt: status === 'running' ? null : open.lastTime,
      status,
      turn: open.turn,
      step: open.step,
      resultSeq: open.seq,
      ...(status === 'error' && open.error !== undefined ? { error: open.error } : {}),
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      ...(open.usage === undefined ? {} : { usage: open.usage }),
    }
  }

  private requestConfig(open: OpenRequest): AssistantRequestConfig | undefined {
    if (open.model === undefined) return undefined
    return {
      provider: 'anthropic',
      model: open.model,
      ...(open.reasoningEffort === undefined ? {} : { reasoningEffort: open.reasoningEffort }),
    }
  }

  // -------------------------------------------------------------------------
  // Turn structure
  // -------------------------------------------------------------------------

  private locate(seq: number, turn: number): void {
    if (this.assembler.locations.has(seq)) return
    if (turn <= 0) {
      this.assembler.locations.set(seq, { kind: 'session' })
      return
    }
    const seqs = this.turnSeqs.get(turn) ?? []
    seqs.push(seq)
    this.turnSeqs.set(turn, seqs)
    this.assembler.locations.set(seq, this.turnLocation(turn))
  }

  private turnLocation(turn: number): ConversationLocation {
    return { kind: 'turn', turn: { turn, status: this.closedTurns.has(turn) ? 'closed' : 'open' } }
  }

  private closeTurn(state: FileState): void {
    if (state.child || this.turn <= 0) return
    this.closedTurns.add(this.turn)
    const location = this.turnLocation(this.turn)
    for (const seq of this.turnSeqs.get(this.turn) ?? []) this.assembler.locations.set(seq, location)
    this.assembler.touch()
  }

  // -------------------------------------------------------------------------
  // Files and nesting
  // -------------------------------------------------------------------------

  private stateFor(file: SessionFileRef, record: Record<string, unknown>): FileState {
    const agent: AgentFileMeta | undefined = file.agent
    const standalone = file.role === 'main' && agent !== undefined
    const recordAgentId = asString(record.agentId)
    let key = file.id
    let child = file.role === 'child'
    if (!child && !standalone && record.isSidechain === true) {
      key = `${SIDECHAIN_PREFIX}${recordAgentId ?? ''}`
      child = true
    }
    let state = this.files.get(key)
    if (state === undefined) {
      state = {
        child,
        standalone,
        fileId: child && key.startsWith(SIDECHAIN_PREFIX) ? null : file.id,
        agentId: agent?.agentId ?? null,
        toolUseId: agent?.toolUseId ?? null,
        fork: agent?.isFork === true,
        sawPrompt: false,
        nesting: undefined,
        open: undefined,
        requestsById: new Map(),
        lastInputTime: null,
        lastTime: null,
        toolCalls: 0,
      }
      this.files.set(key, state)
    }
    if (child) {
      state.agentId ??= recordAgentId ?? null
      if (agent?.toolUseId !== undefined) state.toolUseId ??= agent.toolUseId
    }
    return state
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  private resultContent(raw: unknown): ContentBlock[] {
    return typeof raw === 'string'
      ? [{ type: 'text', text: raw }]
      : this.contentBlocks(asArray(raw) ?? [])
  }

  private contentBlocks(items: readonly unknown[]): ContentBlock[] {
    const blocks: ContentBlock[] = []
    for (const item of items) {
      if (!isRecord(item)) continue
      if (item.type === 'text') {
        blocks.push({ type: 'text', text: asString(item.text) ?? '' })
      } else if (item.type === 'image') {
        const block = this.imageBlock(item)
        if (block !== undefined) blocks.push(block)
      }
    }
    return blocks
  }

  private imageBlock(item: Record<string, unknown>): Extract<ContentBlock, { type: 'image' }> | undefined {
    const source = isRecord(item.source) ? item.source : undefined
    const data = asString(source?.data)
    if (source?.type !== 'base64' || data === undefined) return undefined
    const attachment = this.images.add(data, normalizeImageMediaType(source.media_type))
    return { type: 'image', attachment }
  }

  // -------------------------------------------------------------------------
  // Meta
  // -------------------------------------------------------------------------

  private recordTime(record: Record<string, unknown>): number {
    const time = parseTime(record.timestamp)
    if (time !== null) {
      this.lastTime = time
      return time
    }
    return this.lastTime
  }

  private observeMeta(record: Record<string, unknown>, time: number): void {
    if (this.startedAt === null && parseTime(record.timestamp) !== null) this.startedAt = time
    if (this.cwd === null) {
      const cwd = asString(record.cwd)
      if (cwd !== undefined && cwd !== '') this.cwd = cwd
    }
  }
}

/** Create an incremental parser for Claude Code transcripts. */
export function createClaudeParser(): SessionParser {
  return new ClaudeParser()
}

/** Tags Claude Code wraps around non-human user content (commands, local output, reminders). */
const INJECTED_USER_TAGS = [
  'command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-stderr',
  'local-command-caveat', 'bash-input', 'bash-stdout', 'bash-stderr', 'system-reminder',
  'task-notification',
]

/**
 * Label for a user record that the harness injected rather than a person typed,
 * or `null` for a genuine human prompt.
 */
export function classifyInjectedUser(record: Record<string, unknown>, text: string): string | null {
  const origin = isRecord(record.origin) ? asString(record.origin['kind']) : undefined
  if (origin !== undefined && origin !== 'human') return origin
  const tag = /^\s*<([A-Za-z][\w-]*)[\s>]/.exec(text)
  if (tag !== null && INJECTED_USER_TAGS.includes(tag[1] ?? '')) return tag[1] ?? 'injected'
  return null
}
