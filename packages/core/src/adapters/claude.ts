/**
 * Claude Code transcript adapter.
 *
 * Reads the JSONL Claude Code writes under `~/.claude/projects/<slug>/<sessionId>.jsonl`
 * (one record per line) and folds it incrementally into the harness-agnostic
 * trajectory contract. Subagent transcripts (`agent-*.jsonl` files, or records
 * flagged `isSidechain`) nest their tool calls under the parent `Agent` call.
 */

import type {
  AssistantBlock, AssistantRequestConfig, AssistantRequestView, ContentBlock, ConversationLocation,
  ImageAttachmentRef, TokenUsage,
} from '../contract.ts'
import type { ParsedSessionMeta, SessionFileRef, SessionParser } from '../session.ts'
import { asArray, asString, isRecord, parseJsonLine, parseTime } from '../jsonl.ts'
import { DataUrlImageStore, TrajectoryAssembler, normalizeImageMediaType, titleFrom } from './shared.ts'

const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task'])
const TURN_END_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'max_tokens', 'stop_sequence'])
/** Virtual file key for `isSidechain` records written into the main transcript. */
const SIDECHAIN_FILE = ' sidechain'

/** One API response being accumulated from its per-block lines. */
interface OpenRequest {
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
  readonly child: boolean
  nesting: Nesting | undefined
  open: OpenRequest | undefined
  lastInputTime: number | null
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

function promptOfArgs(argsRaw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return isRecord(parsed) ? asString(parsed.prompt) : undefined
  } catch {
    return undefined
  }
}

function textOfContent(content: readonly ContentBlock[]): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
}

class ClaudeParser implements SessionParser {
  readonly kind = 'claude' as const
  readonly images = new DataUrlImageStore()

  private readonly assembler = new TrajectoryAssembler()
  private readonly files = new Map<string, FileState>()
  private readonly turnSeqs = new Map<number, number[]>()
  private readonly closedTurns = new Set<number>()
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

  push(line: string, file: SessionFileRef): void {
    const record = parseJsonLine(line)
    if (!isRecord(record)) return
    const type = asString(record.type)
    if (type === undefined) return
    const time = this.recordTime(record)
    this.observeMeta(record, time)
    const state = this.stateFor(file, record)
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
    if (results.length > 0) {
      this.finalize(state)
      for (const item of results) this.onToolResult(item, record, time, state)
      state.lastInputTime = time
      return
    }
    const content: ContentBlock[] = typeof rawContent === 'string'
      ? [{ type: 'text', text: rawContent }]
      : this.contentBlocks(items ?? [])
    this.finalize(state)
    if (record.isCompactSummary === true) {
      this.onCompaction(content, time, state)
      return
    }
    if (record.isMeta === true) {
      this.pushContext(content, time, { kind: 'meta' }, 'meta', state)
      return
    }
    const text = textOfContent(content)
    const injected = classifyInjectedUser(record, text)
    if (injected !== null) {
      // Harness-injected user messages (task notifications, slash-command
      // expansions, local command output) steer the model without being a
      // human prompt: keep them as context so they neither open a turn nor
      // count as prompts.
      this.finalize(state)
      this.pushContext(content, time, { kind: 'meta', origin: injected }, injected, state)
      state.lastInputTime = time
      return
    }
    if (state.child) {
      this.attachChild(state, text)
      state.lastInputTime = time
      if (state.nesting !== undefined) return
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
    const raw = block.content
    const content: ContentBlock[] = typeof raw === 'string'
      ? [{ type: 'text', text: raw }]
      : this.contentBlocks(asArray(raw) ?? [])
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(callId, {
      seq,
      time,
      content,
      isError: block.is_error === true,
      ...(record.toolUseResult === undefined ? {} : { meta: record.toolUseResult }),
    })
    if (topLevel && state.nesting === undefined) {
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
    let open = state.open
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
    }
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
      this.finalize(state)
    }
  }

  private onCompaction(content: readonly ContentBlock[], time: number, state: FileState): void {
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

  private pushContext(
    content: readonly ContentBlock[],
    time: number,
    source: unknown,
    label: string,
    state: FileState,
  ): void {
    if (state.nesting !== undefined) return
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
  // Request finalization
  // -------------------------------------------------------------------------

  private finalize(state: FileState): void {
    const open = state.open
    if (open === undefined) return
    state.open = undefined
    if (state.nesting !== undefined) {
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
    this.assembler.pushNode({
      kind: 'assistant',
      seq: open.seq,
      ...(open.messageId === undefined ? {} : { messageId: open.messageId }),
      time: open.lastTime,
      turn: open.turn,
      step: open.step,
      blocks: open.blocks,
      ...(open.usage === undefined ? {} : { usage: open.usage }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      timing: {
        stepStartTime: open.stepStartTime,
        firstTokenTime: open.firstTime,
        completedTime: open.lastTime,
      },
    })
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
    if (state.nesting !== undefined || this.turn <= 0) return
    this.closedTurns.add(this.turn)
    const location = this.turnLocation(this.turn)
    for (const seq of this.turnSeqs.get(this.turn) ?? []) this.assembler.locations.set(seq, location)
    this.assembler.touch()
  }

  // -------------------------------------------------------------------------
  // Files and nesting
  // -------------------------------------------------------------------------

  private stateFor(file: SessionFileRef, record: Record<string, unknown>): FileState {
    const child = file.role === 'child'
    const key = child ? file.id : (record.isSidechain === true ? SIDECHAIN_FILE : file.id)
    let state = this.files.get(key)
    if (state === undefined) {
      state = { child: child || key === SIDECHAIN_FILE, nesting: undefined, open: undefined, lastInputTime: null }
      this.files.set(key, state)
    }
    return state
  }

  /** Bind a subagent transcript to the parent call it answers, by prompt text first. */
  private attachChild(state: FileState, prompt: string): void {
    const tools = this.assembler.tools
    const candidates = tools.pendingIds()
      .map(id => tools.pendingCall(id))
      .filter((call): call is NonNullable<typeof call> =>
        call !== undefined && SUBAGENT_TOOL_NAMES.has(call.name) && call.parentCallId === undefined)
    const match = candidates.find(call => promptOfArgs(call.argsRaw) === prompt) ?? candidates[0]
    if (match === undefined) {
      state.nesting = undefined
      return
    }
    state.nesting = { parentCallId: match.callId, turn: match.turn, step: match.step }
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

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
