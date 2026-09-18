/**
 * pi coding agent transcript adapter.
 *
 * Reads the JSONL pi writes under `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl`
 * (`$PI_CODING_AGENT_DIR/sessions` when the env var is set; verified against pi
 * 0.85.1) and folds it incrementally into the harness-agnostic trajectory
 * contract. One file per session; pi has no subagents. A fork writes a NEW
 * independent file whose header carries `parentSession` — treated as its own
 * main session, never a child.
 *
 * Traps:
 *  - Entry `timestamp` is an ISO string; nested `message.timestamp` is epoch
 *    MILLISECONDS. Every record time below reads the entry-level stamp.
 *  - `usage` buckets are DISJOINT (`input` excludes cacheRead/cacheWrite;
 *    `reasoning` is a subset of `output`).
 *  - pi records no turn boundaries: every human `user` message opens a turn.
 *  - The model-visible context is the `parentId` path from the latest entry to
 *    the root (`PiSessionTree.contextEntries`, a port of pi's
 *    `buildContextEntries`). Trajectory shows FILE order while Context follows
 *    the path; on a branch the parser re-resolves the prompt from the parent's
 *    compacted entry list and the route from its FULL path
 *    (`resolvePiContextState`, pi's `buildSessionContext` split).
 *  - A compaction `systemMessage` is a COMPLETE checkpoint of the replayed
 *    prompt — it replaces `PiPromptState`, it is not a delta.
 *  - `toolsRemoved` lands before `toolsAdded` in one system message (pi
 *    `getCurrentTools`), so a same-name pair redefines the tool.
 *  - Sessions written by older pi carry NO system messages at all; everything
 *    works without one.
 *  - `custom` entries are extension state, not model context.
 */

import type {
  AssistantBlock, AssistantRequestConfig, AssistantRequestView, CompactionRequestView,
  ContentBlock, ConversationLocation, ConversationPromptSnapshot, ImageAttachmentRef,
  RequestPromptChange, TokenUsage, ToolSchema,
} from '../contract.ts'
import type { ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun } from '../session.ts'
import { asArray, asNumber, asString, isRecord, parseJsonLine, parseTime } from '../jsonl.ts'
import { DataUrlImageStore, TrajectoryAssembler, normalizeImageMediaType, titleFrom } from './shared.ts'

/** One parsed transcript line: the envelope fields every non-header entry shares. */
export interface PiEntry {
  type: string
  id: string | null
  parentId: string | null
  time: number | null
  record: Record<string, unknown>
}

/** Parse one JSONL line; `null` for malformed, non-object, or type-less input. */
export function parsePiLine(line: string): PiEntry | null {
  const record = parseJsonLine(line)
  if (!isRecord(record)) return null
  const type = asString(record.type)
  if (type === undefined) return null
  return {
    type,
    id: asString(record.id) ?? null,
    parentId: asString(record.parentId) ?? null,
    time: parseTime(record.timestamp),
    record,
  }
}

/** The one shared human-prompt classifier: a `message` entry with `role: 'user'`. */
export function isPiHumanPrompt(entry: PiEntry): boolean {
  if (entry.type !== 'message') return false
  const message = entry.record.message
  return isRecord(message) && message.role === 'user'
}

/** Text of a `content` field: a plain string, or its `text` blocks joined by "\n". */
export function piContentText(content: unknown): string {
  if (typeof content === 'string') return content
  return (asArray(content) ?? [])
    .flatMap(block => (isRecord(block) && block.type === 'text' ? [asString(block.text) ?? ''] : []))
    .join('\n')
}

/**
 * The system-message replay. pi splits the system prompt across `message`
 * entries with `role: 'system'`: text contents accumulate (joined by "\n\n"),
 * `sections` patch by name (`null` deletes, insertion order retained), and
 * `toolsAdded`/`toolsRemoved` mutate the tool list by name — removals land
 * first (pi `getCurrentTools`), so a same-name removal+addition redefines.
 */
export class PiPromptState {
  private readonly texts: string[] = []
  private readonly sections = new Map<string, string>()
  private readonly toolList: ToolSchema[] = []
  private applied = false

  /** A fresh state with one system message applied (compaction checkpoints). */
  static fromSystemMessage(message: Record<string, unknown>): PiPromptState {
    const state = new PiPromptState()
    state.apply(message)
    return state
  }

  /** Fold one `role: 'system'` message into the running prompt. */
  apply(message: Record<string, unknown>): { systemChanged: boolean; toolsChanged: boolean } {
    const beforeText = this.text()
    const beforeTools = JSON.stringify(this.toolList)
    this.applied = true
    const content = message.content
    if (typeof content === 'string') {
      if (content !== '') this.texts.push(content)
    } else {
      for (const block of asArray(content) ?? []) {
        if (!isRecord(block) || block.type !== 'text') continue
        const text = asString(block.text)
        if (text !== undefined && text !== '') this.texts.push(text)
      }
    }
    const sections = isRecord(message.sections) ? message.sections : undefined
    for (const [name, value] of Object.entries(sections ?? {})) {
      if (value === null) this.sections.delete(name)
      else if (typeof value === 'string') this.sections.set(name, value)
    }
    for (const tool of asArray(message.toolsRemoved) ?? []) {
      const name = isRecord(tool) ? asString(tool.name) : undefined
      if (name === undefined) continue
      const index = this.toolList.findIndex(item => item.name === name)
      if (index >= 0) this.toolList.splice(index, 1)
    }
    for (const tool of asArray(message.toolsAdded) ?? []) {
      if (!isRecord(tool)) continue
      const name = asString(tool.name)
      if (name === undefined) continue
      const schema: ToolSchema = {
        name,
        description: asString(tool.description) ?? '',
        parameters: isRecord(tool.parameters) ? tool.parameters : {},
      }
      const existing = this.toolList.findIndex(item => item.name === name)
      if (existing >= 0) this.toolList[existing] = schema
      else this.toolList.push(schema)
    }
    return {
      systemChanged: this.text() !== beforeText,
      toolsChanged: JSON.stringify(this.toolList) !== beforeTools,
    }
  }

  /** The rendered prompt: contents, then section values in insertion order. */
  text(): string {
    return [...this.texts, ...this.sections.values()].filter(part => part !== '').join('\n\n')
  }

  /** The current tools in first-declaration order — a copy, never the list inside. */
  tools(): readonly ToolSchema[] {
    return [...this.toolList]
  }

  schemaOf(name: string): ToolSchema | undefined {
    return this.toolList.find(tool => tool.name === name)
  }

  /** A deep-enough copy: texts, sections, and tool schemas are immutable here. */
  clone(): PiPromptState {
    const copy = new PiPromptState()
    copy.texts.push(...this.texts)
    for (const [name, value] of this.sections) copy.sections.set(name, value)
    copy.toolList.push(...this.toolList)
    copy.applied = this.applied
    return copy
  }

  /** Whether any system message has been applied yet. */
  get seen(): boolean {
    return this.applied
  }
}

/**
 * The entry tree is the only source of truth for pi's model-visible context:
 * `contextEntries` is a faithful port of pi `buildContextEntries`
 * (`packages/coding-agent/src/core/session-manager.ts`). Rendered surfaces are
 * derived from it, never consulted.
 */
export class PiSessionTree {
  private readonly entries = new Map<string, PiEntry>()

  /** The id of the most recently added entry, or null before the first. */
  lastId: string | null = null

  /** Record one entry. Entries without an id — and the session header — sit out. */
  add(entry: PiEntry): void {
    if (entry.id === null || entry.type === 'session') return
    this.entries.set(entry.id, entry)
    this.lastId = entry.id
  }

  get(id: string): PiEntry | undefined {
    return this.entries.get(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** The root→leaf parentId path; null/unknown leaf → []. Cycle-guarded. */
  pathTo(leafId: string | null): PiEntry[] {
    if (leafId === null) return []
    const path: PiEntry[] = []
    const seen = new Set<string>()
    let cursor = this.entries.get(leafId)
    while (cursor !== undefined && cursor.id !== null && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      path.push(cursor)
      cursor = cursor.parentId === null ? undefined : this.entries.get(cursor.parentId)
    }
    return path.reverse()
  }

  /**
   * pi `buildContextEntries`: the path, except the latest compaction replaces
   * the summarized prefix — `[compaction, path entries from firstKeptEntryId
   * up to the compaction minus system messages, entries after the compaction]`.
   * A firstKeptEntryId not on the path keeps nothing from before.
   */
  contextEntries(leafId: string | null): PiEntry[] {
    const path = this.pathTo(leafId)
    let compaction: PiEntry | null = null
    for (const entry of path) {
      if (entry.type === 'compaction') compaction = entry
    }
    if (compaction === null) return path
    const compactionIndex = path.findIndex(entry => entry.id === compaction.id)
    if (compactionIndex < 0) return path
    const firstKeptEntryId = asString(compaction.record.firstKeptEntryId)
    const context: PiEntry[] = [compaction]
    let foundFirstKept = false
    for (let index = 0; index < compactionIndex; index += 1) {
      const entry = path[index]
      if (entry === undefined) continue
      if (entry.id === firstKeptEntryId) foundFirstKept = true
      if (foundFirstKept && !isSystemMessageEntry(entry)) context.push(entry)
    }
    context.push(...path.slice(compactionIndex + 1))
    return context
  }
}

function isSystemMessageEntry(entry: PiEntry): boolean {
  if (entry.type !== 'message') return false
  const message = entry.record.message
  return isRecord(message) && message.role === 'system'
}

/** The route/prompt state of one context path, per pi `getSessionContextSettings`. */
export interface PiContextState {
  prompt: PiPromptState
  provider: string | undefined
  model: string | undefined
  thinking: string | undefined
}

/**
 * Re-derive the prompt and route of one leaf, split the way pi's
 * `buildSessionContext` splits them: the PROMPT replays the compacted entry
 * list (`contextEntries` — system messages in order, a compaction
 * `systemMessage` is a COMPLETE checkpoint that replaces the replayed state),
 * while the ROUTE (provider/model/thinking) reads the FULL parent path
 * (`getSessionContextSettings` over `buildSessionPath`) — a compaction that
 * summarizes away a `model_change` or `thinking_level_change` does not forget it.
 */
export function resolvePiContextState(tree: PiSessionTree, leafId: string | null): PiContextState {
  let prompt = new PiPromptState()
  for (const entry of tree.contextEntries(leafId)) {
    if (entry.type === 'compaction') {
      const systemMessage = isRecord(entry.record.systemMessage) ? entry.record.systemMessage : undefined
      if (systemMessage !== undefined) prompt = PiPromptState.fromSystemMessage(systemMessage)
    } else if (isSystemMessageEntry(entry)) {
      const message = isRecord(entry.record.message) ? entry.record.message : undefined
      if (message !== undefined) prompt.apply(message)
    }
  }
  let provider: string | undefined
  let model: string | undefined
  let thinking: string | undefined
  for (const entry of tree.pathTo(leafId)) {
    switch (entry.type) {
      case 'message': {
        const message = isRecord(entry.record.message) ? entry.record.message : undefined
        if (message !== undefined && message.role === 'assistant') {
          provider = asString(message.provider) ?? provider
          model = asString(message.model) ?? model
        }
        break
      }
      case 'model_change':
        provider = asString(entry.record.provider) ?? provider
        model = asString(entry.record.modelId) ?? model
        break
      case 'thinking_level_change':
        thinking = asString(entry.record.thinkingLevel) ?? thinking
        break
      default:
        break
    }
  }
  return { prompt, provider, model, thinking }
}

interface PendingPromptChange {
  seq: number
  time: number
  kind: RequestPromptChange['kind']
  text: string
  tools: readonly ToolSchema[]
  previous: ConversationPromptSnapshot | undefined
}

class PiParser implements SessionParser {
  readonly kind = 'pi' as const
  readonly images = new DataUrlImageStore()

  private readonly assembler = new TrajectoryAssembler()
  private readonly turnSeqs = new Map<number, number[]>()
  private readonly closedTurns = new Set<number>()
  private readonly tree = new PiSessionTree()
  private prompt = new PiPromptState()
  private turn = 0
  private step = 0
  private turnOpen = false
  private lastTime = 0
  private lastInputTime: number | null = null
  private sessionTitle: string | null = null
  private firstPrompt: string | null = null
  private cwd: string | null = null
  private model: string | null = null
  private provider: string | null = null
  private thinking: string | null = null
  private startedAt: number | null = null
  private promptCount = 0
  private lastPromptText: string | null = null
  private lastPromptSnapshot: ConversationPromptSnapshot | undefined
  private pendingPrompt: PendingPromptChange | undefined
  private currentModel: string | null = null

  push(line: string, file: SessionFileRef, lineIndex?: number): void {
    this.assembler.beginLine(file.id, lineIndex)
    const entry = parsePiLine(line)
    if (entry === null) return
    const time = entry.time ?? this.lastTime
    if (entry.time !== null) this.lastTime = entry.time
    if (this.startedAt === null && entry.time !== null) this.startedAt = entry.time
    if (entry.type === 'session') {
      this.onHeader(entry.record)
      return
    }
    // The Trajectory stays in file order, but an entry that branches off an
    // earlier parent inherits the ROUTE and PROMPT of the parent's path.
    const previousLastId = this.tree.lastId
    this.tree.add(entry)
    if (entry.parentId !== previousLastId) this.restoreContextState(entry.parentId, time)
    switch (entry.type) {
      case 'message':
        this.onMessage(entry, time)
        return
      case 'model_change': {
        const provider = asString(entry.record.provider)
        const modelId = asString(entry.record.modelId)
        if (provider !== undefined) this.provider = provider
        if (modelId !== undefined) {
          if (this.model === null) this.model = modelId
          this.currentModel = modelId
        }
        return
      }
      case 'thinking_level_change':
        this.thinking = asString(entry.record.thinkingLevel) ?? this.thinking
        return
      case 'session_info': {
        const name = asString(entry.record.name)
        if (name !== undefined && name !== '') this.sessionTitle = name
        return
      }
      case 'compaction':
        this.onCompaction(entry, time)
        return
      case 'branch_summary':
        this.onBranchSummary(entry, time)
        return
      case 'custom_message':
        this.onCustomMessage(entry.record, time)
        return
      default:
        // custom (extension state), label, and anything newer: not conversation.
        return
    }
  }

  snapshot() {
    return this.assembler.snapshot()
  }

  meta(): ParsedSessionMeta {
    return {
      title: this.sessionTitle ?? this.firstPrompt,
      cwd: this.cwd,
      model: this.model,
      startedAt: this.startedAt,
      promptCount: this.promptCount,
    }
  }

  subagents(): readonly SubagentRun[] {
    return []
  }

  imageUrl(attachment: ImageAttachmentRef): string | undefined {
    return this.images.get(attachment.attachmentId)
  }

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  private onHeader(record: Record<string, unknown>): void {
    const cwd = asString(record.cwd)
    if (cwd !== undefined && cwd !== '') this.cwd = cwd
  }

  private onMessage(entry: PiEntry, time: number): void {
    const message = isRecord(entry.record.message) ? entry.record.message : undefined
    if (message === undefined) return
    switch (asString(message.role)) {
      case 'system':
        this.onSystemMessage(message, time)
        return
      case 'user':
        this.onUser(entry, message, time)
        return
      case 'assistant':
        this.onAssistant(entry, message, time)
        return
      case 'toolResult':
        this.onToolResult(message, time)
        return
      case 'bashExecution':
        this.onBashExecution(message, time)
        return
      case 'custom':
        this.onCustomMessage(message, time)
        return
      default:
        // branchSummary/compactionSummary roles never appear as entries.
        return
    }
  }

  private onSystemMessage(message: Record<string, unknown>, time: number): void {
    this.notePromptChange(this.prompt.apply(message), time)
  }

  /**
   * A branch (or an explicit `parentId: null` root) re-derives the prompt and
   * route from the parent's context path — pi's `buildContextEntries` plus
   * `getSessionContextSettings` — so prompt state added on an abandoned branch
   * cannot leak into the next request.
   */
  private restoreContextState(parentId: string | null, time: number): void {
    const resolved = resolvePiContextState(this.tree, parentId)
    const previous = this.lastPromptSnapshot
    const text = resolved.prompt.text()
    const tools = resolved.prompt.tools()
    const systemChanged = previous === undefined ? resolved.prompt.seen : text !== previous.system
    const toolsChanged = previous === undefined
      ? tools.length > 0
      : JSON.stringify(tools) !== JSON.stringify(previous.tools)
    this.prompt = resolved.prompt
    this.provider = resolved.provider ?? null
    this.currentModel = resolved.model ?? null
    if (this.model === null) this.model = resolved.model ?? null
    this.thinking = resolved.thinking ?? null
    this.pendingPrompt = undefined
    this.notePromptChange({ systemChanged, toolsChanged }, time)
  }

  /** Queue the prompt change for the next assistant request and record the prompt node. */
  private notePromptChange(change: { systemChanged: boolean; toolsChanged: boolean }, time: number): void {
    if (!change.systemChanged && !change.toolsChanged) return
    const seq = this.assembler.seq.next()
    const kind = this.lastPromptSnapshot === undefined
      ? 'initial'
      : change.systemChanged && change.toolsChanged ? 'system-and-tools'
        : change.systemChanged ? 'system' : 'tools'
    const text = this.prompt.text()
    if (change.systemChanged && text !== '' && text !== this.lastPromptText) {
      this.lastPromptText = text
      this.assembler.systemPrompts.push({
        seq,
        time,
        turn: this.turn,
        step: this.step,
        text,
        update: this.lastPromptSnapshot !== undefined,
      })
      this.assembler.touch()
    }
    this.pendingPrompt = {
      seq,
      time,
      kind,
      text,
      tools: this.prompt.tools(),
      previous: this.lastPromptSnapshot,
    }
  }

  private onUser(entry: PiEntry, message: Record<string, unknown>, time: number): void {
    if (this.turnOpen) this.closeTurn()
    this.turn += 1
    this.step = 0
    this.turnOpen = true
    this.promptCount += 1
    const content = this.contentBlocks(message.content)
    const text = content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
    if (this.firstPrompt === null && text.trim() !== '') this.firstPrompt = titleFrom(text)
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'user',
      seq,
      time,
      content,
      source: { kind: 'user', entryId: entry.id },
    })
    this.lastInputTime = time
  }

  private onAssistant(entry: PiEntry, message: Record<string, unknown>, time: number): void {
    this.step += 1
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    const provider = asString(message.provider)
    const model = asString(message.model)
    if (provider !== undefined) this.provider = provider
    if (model !== undefined) {
      if (this.model === null) this.model = model
      this.currentModel = model
    }
    const responseModel = asString(message.responseModel) ?? model
    const provenance = provider !== undefined && responseModel !== undefined
      ? { provider, model: responseModel }
      : undefined
    const requestConfig = this.requestConfig(message)
    const blocks: AssistantBlock[] = []
    for (const item of asArray(message.content) ?? []) {
      if (!isRecord(item)) continue
      switch (item.type) {
        case 'thinking':
          blocks.push({ kind: 'reasoning', text: asString(item.thinking) ?? '' })
          break
        case 'text':
          blocks.push({ kind: 'text', text: asString(item.text) ?? '' })
          break
        case 'toolCall': {
          const callId = asString(item.id)
          if (callId === undefined) break
          const name = asString(item.name) ?? 'tool'
          const argsRaw = stringifyArgs(item.arguments)
          blocks.push({ kind: 'tool-call', callId, name, argsRaw })
          this.assembler.tools.start({
            callId, name, argsRaw, turn: this.turn, step: this.step, time, subCalls: [],
          })
          const schema = this.prompt.schemaOf(name)
          if (schema !== undefined) this.assembler.callSchemas.set(callId, schema)
          break
        }
        default:
          blocks.push({ kind: 'other', block: item })
      }
    }
    const usage = usageOf(message.usage)
    const stopReason = asString(message.stopReason)
    const status = stopReason === 'error' || stopReason === 'aborted' ? 'error' : 'complete'
    const error = stopReason === 'error'
      ? asString(message.errorMessage) ?? 'error'
      : stopReason === 'aborted' ? 'aborted' : undefined
    const promptFields = this.takePendingPrompt(requestConfig)
    const request: AssistantRequestView = {
      purpose: 'assistant',
      startSeq: seq,
      startedAt: this.lastInputTime ?? time,
      completedAt: time,
      status,
      turn: this.turn,
      step: this.step,
      resultSeq: seq,
      ...(error === undefined ? {} : { error }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      ...(usage === undefined ? {} : { usage }),
      ...(promptFields === undefined ? {} : promptFields),
    }
    this.assembler.upsertRequest(request)
    if (blocks.length > 0 || stopReason === 'aborted' || status !== 'error') {
      this.assembler.pushNode({
        kind: 'assistant',
        seq,
        time,
        turn: this.turn,
        step: this.step,
        blocks,
        ...(usage === undefined ? {} : { usage }),
        ...(provenance === undefined ? {} : { provenance }),
        ...(requestConfig === undefined ? {} : { requestConfig }),
        timing: {
          stepStartTime: this.lastInputTime,
          firstTokenTime: null,
          completedTime: time,
        },
        ...(stopReason === 'aborted' ? { interrupted: true as const } : {}),
      })
    } else {
      this.assembler.touch()
    }
    if (stopReason === 'error') {
      const errorSeq = this.assembler.seq.next()
      this.locate(errorSeq, this.turn)
      this.assembler.pushNode({
        kind: 'turn-error',
        seq: errorSeq,
        time,
        turn: this.turn,
        step: this.step,
        message: error ?? 'error',
      })
    } else if (stopReason === 'length') {
      const maxSeq = this.assembler.seq.next()
      this.locate(maxSeq, this.turn)
      this.assembler.pushNode({ kind: 'turn-max-tokens', seq: maxSeq, time, turn: this.turn, step: this.step })
    }
    if (stopReason !== 'toolUse' && this.turnOpen) this.closeTurn()
    this.lastInputTime = time
  }

  /** The prompt change queued by the last system message, attached once. */
  private takePendingPrompt(
    requestConfig: AssistantRequestConfig | undefined,
  ): { prompt: ConversationPromptSnapshot; promptChange: RequestPromptChange } | undefined {
    const pending = this.pendingPrompt
    if (pending === undefined) return undefined
    this.pendingPrompt = undefined
    const prompt: ConversationPromptSnapshot = {
      config: requestConfig ?? { provider: this.provider ?? '', model: this.currentModel ?? '' },
      system: pending.text,
      tools: pending.tools,
    }
    this.lastPromptSnapshot = prompt
    return {
      prompt,
      promptChange: {
        seq: pending.seq,
        time: pending.time,
        kind: pending.kind,
        ...(pending.previous === undefined ? {} : { previous: pending.previous }),
      },
    }
  }

  private requestConfig(message: Record<string, unknown>): AssistantRequestConfig | undefined {
    const provider = asString(message.provider) ?? this.provider ?? undefined
    const model = asString(message.model) ?? this.currentModel ?? undefined
    if (provider === undefined && model === undefined) return undefined
    const thinking = asString(message.providerThinkingLevel) ?? this.thinking ?? undefined
    return {
      provider: provider ?? '',
      model: model ?? '',
      ...(thinking === undefined ? {} : { thinking }),
    }
  }

  private onToolResult(message: Record<string, unknown>, time: number): void {
    const callId = asString(message.toolCallId)
    if (callId === undefined) return
    const content = this.contentBlocks(message.content)
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(callId, {
      seq,
      time,
      content,
      isError: message.isError === true,
      ...(message.details === undefined ? {} : { meta: message.details }),
    })
    if (topLevel) {
      this.locate(seq, this.turn)
      this.assembler.pushNode(node)
    } else {
      this.assembler.touch()
    }
    this.lastInputTime = time
  }

  private onBashExecution(message: Record<string, unknown>, time: number): void {
    const command = asString(message.command) ?? ''
    const output = asString(message.output) ?? ''
    const exitCode = asNumber(message.exitCode)
    const excludeFromContext = message.excludeFromContext === true
    const text = `$ ${command}\n${output}${exitCode === undefined ? '' : `\n[exit ${exitCode}]`}`
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'context',
      seq,
      time,
      content: [{ type: 'text', text }],
      source: {
        kind: 'bash-execution',
        excludeFromContext,
        cancelled: message.cancelled === true,
        truncated: message.truncated === true,
      },
      provenance: { role: 'inject', label: 'bash-execution' },
      form: 'notice',
    })
    if (!excludeFromContext) this.lastInputTime = time
  }

  /** A `custom_message` entry or a `custom` message role: injected model-visible context. */
  private onCustomMessage(record: Record<string, unknown>, time: number): void {
    const customType = asString(record.customType) ?? 'custom'
    const content = this.contentBlocks(record.content)
    if (content.length === 0) return
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'context',
      seq,
      time,
      content,
      source: { kind: 'custom', name: customType },
      provenance: { role: 'inject', label: customType },
      form: 'notice',
    })
    this.lastInputTime = time
  }

  private onCompaction(entry: PiEntry, time: number): void {
    const record = entry.record
    const summary = asString(record.summary) ?? ''
    const usage = usageOf(record.usage)
    const tokensBefore = asNumber(record.tokensBefore)
    const requestSeq = this.assembler.seq.next()
    const seq = this.assembler.seq.next()
    const request: CompactionRequestView = {
      purpose: 'compaction',
      startSeq: requestSeq,
      startedAt: time,
      completedAt: time,
      status: 'complete',
      turn: this.turn > 0 ? this.turn : null,
      step: 0,
      resultSeq: seq,
      replacementSeq: seq,
      summary: [{ type: 'text', text: summary }],
      ...(usage === undefined ? {} : { usage }),
    }
    this.assembler.upsertRequest(request)
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'compaction',
      seq,
      time,
      summary: summary === '' ? null : summary,
      summaryEventSeq: seq,
      shadowedItemCount: null,
      shadowedTokenCount: tokensBefore ?? null,
    })
    const systemMessage = isRecord(record.systemMessage) ? record.systemMessage : undefined
    if (systemMessage !== undefined) {
      // The compaction checkpoint is a COMPLETE prompt (getCurrentSystemMessage),
      // not a delta on the running one.
      const beforeText = this.prompt.text()
      const beforeTools = JSON.stringify(this.prompt.tools())
      this.prompt = PiPromptState.fromSystemMessage(systemMessage)
      this.notePromptChange({
        systemChanged: this.prompt.text() !== beforeText,
        toolsChanged: JSON.stringify(this.prompt.tools()) !== beforeTools,
      }, time)
    }
    this.lastInputTime = time
  }

  private onBranchSummary(entry: PiEntry, time: number): void {
    const summary = asString(entry.record.summary) ?? ''
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'context',
      seq,
      time,
      content: [{ type: 'text', text: summary }],
      source: { kind: 'branch-summary', fromId: asString(entry.record.fromId) ?? null },
      provenance: { role: 'inject', label: 'branch-summary' },
      form: 'recall',
    })
    this.lastInputTime = time
  }

  // -------------------------------------------------------------------------
  // Content, turns
  // -------------------------------------------------------------------------

  private contentBlocks(raw: unknown): ContentBlock[] {
    if (typeof raw === 'string') return raw === '' ? [] : [{ type: 'text', text: raw }]
    const blocks: ContentBlock[] = []
    for (const item of asArray(raw) ?? []) {
      if (!isRecord(item)) continue
      if (item.type === 'text') {
        blocks.push({ type: 'text', text: asString(item.text) ?? '' })
      } else if (item.type === 'image') {
        const data = asString(item.data)
        if (data === undefined) continue
        blocks.push({ type: 'image', attachment: this.images.add(data, normalizeImageMediaType(item.mimeType)) })
      }
    }
    return blocks
  }

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

  private closeTurn(): void {
    this.turnOpen = false
    if (this.turn <= 0) return
    this.closedTurns.add(this.turn)
    const location = this.turnLocation(this.turn)
    for (const seq of this.turnSeqs.get(this.turn) ?? []) this.assembler.locations.set(seq, location)
    this.assembler.touch()
  }
}

/** pi usage: disjoint buckets; `reasoning` is a subset of `output`. */
function usageOf(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value.input)
  const output = asNumber(value.output)
  const total = asNumber(value.totalTokens)
  const cacheRead = asNumber(value.cacheRead)
  const cacheWrite = asNumber(value.cacheWrite)
  const reasoning = asNumber(value.reasoning)
  if (input === undefined && output === undefined) return undefined
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(total === undefined ? {} : { totalTokens: total }),
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

/** Create an incremental parser for pi coding agent transcripts. */
export function createPiParser(): SessionParser {
  return new PiParser()
}
