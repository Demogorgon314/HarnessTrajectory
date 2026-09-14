/**
 * Codex rollout adapter: folds `~/.codex/sessions/**\/rollout-*.jsonl` lines
 * into the harness-agnostic trajectory contract.
 *
 * Verified against codex-cli 0.147–0.153 rollouts. Each line is
 * `{ timestamp, ordinal?, type, payload }`; the mapping is documented inline.
 */

import type {
  AssistantBlock, AssistantMessageNode, AssistantRequestConfig, AssistantRequestView,
  CompactionRequestView, ContentBlock, ConversationPromptSnapshot, ImageAttachmentRef,
  RequestPromptChange, TokenUsage, TrajectorySnapshot,
} from '../contract.ts'
import { asArray, asNumber, asString, isRecord, parseJsonLine, parseTime } from '../jsonl.ts'
import type { ImageStore, ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun } from '../session.ts'
import { DataUrlImageStore, TrajectoryAssembler, normalizeImageMediaType, textOf, titleFrom } from './shared.ts'

/** One model response in progress: blocks accumulate until an input arrives. */
interface OpenStep {
  turn: number
  step: number
  seq: number
  /** Time of the last input (user/developer message or tool output) before the step. */
  startedAt: number | null
  firstTokenTime: number
  lastTime: number
  blocks: AssistantBlock[]
  usage: TokenUsage | undefined
}

/** A subagent thread nested under one synthetic tool call in the parent ledger. */
interface ChildThread {
  callId: string
  fileId: string
  threadId: string
  label: string
  startedAt: number
  endedAt: number | null
  lastTime: number
  toolCalls: number
  lastAgentMessage: string | null
  completed: boolean
}

interface SystemPrompt {
  text: string
  seq: number
  time: number
}

type UserMessageClass =
  | { readonly kind: 'human' }
  | { readonly kind: 'context'; readonly label: string; readonly form: 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' }

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s

/**
 * Codex writes non-human context as user-role messages (environment snapshots,
 * internal context, skill catalogs, compaction replays). Those start with an
 * XML-ish tag or a known preamble; everything else is a human prompt.
 */
/** Whether a Codex user-role message is a person's prompt rather than injected context. */
export function isCodexHumanPrompt(text: string): boolean {
  return classifyUserText(text).kind === 'human'
}

function classifyUserText(text: string): UserMessageClass {
  const trimmed = text.trimStart()
  const tag = /^<([A-Za-z_][\w-]*)/.exec(trimmed)
  if (tag !== null) {
    const name = tag[1] ?? ''
    if (name === 'image') return { kind: 'human' }
    const lower = name.toLowerCase()
    const form = lower.includes('instruction')
      ? 'instructions'
      : lower.includes('plugin') || lower.includes('skill')
        ? 'catalog'
        : lower.includes('context') || lower.includes('date') || lower.includes('cwd')
          ? 'snapshot'
          : 'notice'
    return { kind: 'context', label: name, form }
  }
  if (/^The following is the Codex agent history/.test(trimmed)) {
    return { kind: 'context', label: 'history', form: 'relay' }
  }
  if (/^Here is a list of /.test(trimmed)) {
    return { kind: 'context', label: 'catalog', form: 'catalog' }
  }
  return { kind: 'human' }
}

function mapUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value['input_tokens'])
  const output = asNumber(value['output_tokens'])
  if (input === undefined && output === undefined) return undefined
  const cached = asNumber(value['cached_input_tokens'])
  const cacheWrite = asNumber(value['cache_write_input_tokens'])
  const reasoning = asNumber(value['reasoning_output_tokens'])
  const total = asNumber(value['total_tokens'])
  return {
    inputTokens: Math.max(0, (input ?? 0) - (cached ?? 0)),
    outputTokens: output ?? 0,
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** Conservative failure detection for tool outputs. */
function outputLooksFailed(payload: Record<string, unknown>, text: string): boolean {
  const status = asString(payload['status'])
  if (status === 'failed' || status === 'error') return true
  return /^\s*(?:Error:|error:|Script failed|Traceback \(most recent call last\))/.test(text)
}

function subagentLabel(payload: Record<string, unknown>): string {
  const source = payload['source']
  if (isRecord(source)) {
    const subagent = source['subagent']
    if (isRecord(subagent)) {
      for (const value of Object.values(subagent)) {
        if (typeof value === 'string' && value !== '') return value
      }
      const [firstKey] = Object.keys(subagent)
      if (firstKey !== undefined) return firstKey
    }
    if (typeof subagent === 'string' && subagent !== '') return subagent
  }
  return asString(payload['thread_source']) ?? 'subagent'
}

class CodexParser implements SessionParser {
  readonly kind = 'codex' as const
  readonly images = new DataUrlImageStore()

  private readonly assembler = new TrajectoryAssembler()
  private turn = 0
  private step = 0
  /** `task_started` opened a turn whose human prompt has not arrived yet. */
  private turnOpenPending = false
  private lastInputTime: number | null = null
  private lastTime = 0
  private open: OpenStep | null = null
  private readonly lastRequestSeqByTurn = new Map<number, number>()
  private readonly turnSeqs = new Map<number, number[]>()
  private readonly children = new Map<string, ChildThread>()
  private systemPrompt: SystemPrompt | null = null
  private systemPromptAttached = false
  private provider = 'openai'
  private model: string | null = null
  private effort: string | null = null
  private cwd: string | null = null
  private startedAt: number | null = null
  private title: string | null = null
  private promptCount = 0

  get store(): ImageStore {
    return this.images
  }

  push(line: string, file: SessionFileRef): void {
    const record = parseJsonLine(line)
    if (!isRecord(record)) return
    const time = parseTime(record['timestamp']) ?? this.lastTime
    if (time > this.lastTime) this.lastTime = time
    const type = asString(record['type'])
    if (type === undefined) return
    const payload = isRecord(record['payload']) ? record['payload'] : {}
    if (file.role === 'child') {
      this.handleChild(file, type, payload, time)
      return
    }
    switch (type) {
      case 'session_meta':
        this.handleSessionMeta(payload, time)
        return
      case 'turn_context':
        this.handleTurnContext(payload)
        return
      case 'event_msg':
        this.handleEvent(payload, time)
        return
      case 'response_item':
        this.handleResponseItem(payload, time)
        return
      case 'token_usage_record':
        this.attachUsage(mapUsage(payload['usage']), true)
        return
      case 'compacted':
        this.handleCompaction(asString(payload['message']) ?? '', time)
        return
      default:
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
    return [...this.children.values()].map(child => ({
      agentId: child.threadId,
      fileId: child.fileId,
      callId: child.callId,
      description: child.label,
      agentType: null,
      model: null,
      status: child.completed ? 'completed' : 'running',
      startedAt: child.startedAt,
      endedAt: child.endedAt,
      lastTime: child.lastTime,
      toolCalls: child.toolCalls,
    }))
  }

  imageUrl(attachment: ImageAttachmentRef): string | undefined {
    return this.images.get(attachment.attachmentId)
  }

  // ---------------------------------------------------------------------------
  // Main transcript
  // ---------------------------------------------------------------------------

  private handleSessionMeta(payload: Record<string, unknown>, time: number): void {
    this.startedAt ??= parseTime(payload['timestamp']) ?? time
    this.cwd ??= asString(payload['cwd']) ?? null
    const provider = asString(payload['model_provider'])
    if (provider !== undefined && provider !== '') this.provider = provider
    const instructions = payload['base_instructions']
    const text = isRecord(instructions) ? asString(instructions['text']) : asString(instructions)
    if (text !== undefined && text !== '' && this.systemPrompt === null) {
      this.systemPrompt = { text, seq: this.assembler.seq.next(), time }
    }
  }

  private handleTurnContext(payload: Record<string, unknown>): void {
    const model = asString(payload['model'])
    if (model !== undefined && model !== '') this.model = model
    const effort = asString(payload['effort']) ?? asString(payload['reasoning_effort'])
    if (effort !== undefined && effort !== '') this.effort = effort
    this.cwd ??= asString(payload['cwd']) ?? null
  }

  private handleEvent(payload: Record<string, unknown>, time: number): void {
    switch (asString(payload['type'])) {
      case 'task_started': {
        this.closeOpenStep('complete')
        this.completeStaleChildren(time)
        this.turn += 1
        this.step = 0
        this.turnOpenPending = true
        this.lastInputTime = parseTime(payload['started_at']) ?? time
        return
      }
      case 'task_complete': {
        this.closeOpenStep('complete')
        this.completeStaleChildren(time)
        this.closeTurn(this.turn)
        this.turnOpenPending = false
        return
      }
      case 'turn_aborted': {
        const reason = asString(payload['reason'])
        this.closeOpenStep('error', reason === undefined ? 'Turn aborted' : `Turn aborted (${reason})`)
        this.completeStaleChildren(time)
        const turn = Math.max(1, this.turn)
        const seq = this.assembler.seq.next()
        this.assembler.pushNode({
          kind: 'turn-error',
          seq,
          time,
          turn,
          step: this.step,
          message: reason === undefined ? 'Turn aborted' : `Turn aborted (${reason})`,
          code: 'turn_aborted',
        })
        this.locate(seq, turn)
        this.closeTurn(this.turn)
        this.turnOpenPending = false
        return
      }
      case 'token_count': {
        const info = payload['info']
        if (isRecord(info)) this.attachUsage(mapUsage(info['last_token_usage']), false)
        return
      }
      default:
        return
    }
  }

  private handleResponseItem(payload: Record<string, unknown>, time: number): void {
    switch (asString(payload['type'])) {
      case 'message':
        this.handleMessage(payload, time)
        return
      case 'reasoning': {
        const text = reasoningText(payload)
        if (text === '') return
        this.appendBlock({ kind: 'reasoning', text }, time)
        return
      }
      case 'custom_tool_call':
      case 'function_call':
      case 'local_shell_call':
        this.handleToolCall(payload, time, undefined)
        return
      case 'custom_tool_call_output':
      case 'function_call_output':
      case 'local_shell_call_output':
        this.closeOpenStep('complete')
        this.handleToolOutput(payload, time)
        this.lastInputTime = time
        return
      case 'compaction':
        this.handleCompaction('', time)
        return
      default:
        return
    }
  }

  private handleMessage(payload: Record<string, unknown>, time: number): void {
    const role = asString(payload['role'])
    const items = asArray(payload['content']) ?? []
    if (role === 'assistant') {
      for (const item of items) {
        if (!isRecord(item)) continue
        const text = asString(item['text'])
        if (text !== undefined && text !== '') this.appendBlock({ kind: 'text', text }, time)
      }
      return
    }
    const content = this.contentBlocks(items)
    if (role === 'developer') {
      this.pushContext(content, 'developer', 'instructions', time)
      return
    }
    if (role !== 'user') return
    const hasImage = content.some(block => block.type === 'image')
    const classified = hasImage ? { kind: 'human' as const } : classifyUserText(textOf(content))
    if (classified.kind === 'context') {
      this.pushContext(content, classified.label, classified.form, time)
      return
    }
    this.closeOpenStep('complete')
    if (!this.turnOpenPending) {
      this.completeStaleChildren(time)
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
    this.lastInputTime = time
  }

  private pushContext(
    content: readonly ContentBlock[],
    label: string,
    form: 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay',
    time: number,
  ): void {
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({
      kind: 'context',
      seq,
      time,
      content,
      source: { kind: 'plugin', plugin: label },
      provenance: { role: 'inject', label },
      form,
    })
    if (this.turn > 0) this.locate(seq, this.turn)
    this.lastInputTime = time
  }

  private handleToolCall(
    payload: Record<string, unknown>,
    time: number,
    parentCallId: string | undefined,
  ): void {
    const callId = asString(payload['call_id']) ?? asString(payload['id'])
    if (callId === undefined) return
    const type = asString(payload['type'])
    const name = type === 'local_shell_call'
      ? 'local_shell'
      : (asString(payload['name']) ?? 'tool')
    const argsRaw = type === 'local_shell_call'
      ? JSON.stringify(payload['action'] ?? null)
      : (asString(payload['input']) ?? asString(payload['arguments'])
        ?? (payload['input'] === undefined && payload['arguments'] === undefined
          ? ''
          : JSON.stringify(payload['input'] ?? payload['arguments'])))
    if (parentCallId === undefined) {
      this.appendBlock({ kind: 'tool-call', callId, name, argsRaw }, time)
    }
    const step = parentCallId === undefined ? (this.open?.step ?? this.step) : this.step
    this.assembler.tools.start({
      callId,
      ...(parentCallId === undefined ? {} : { parentCallId }),
      name,
      argsRaw,
      turn: Math.max(1, this.turn),
      step,
      time,
      subCalls: [],
    })
    this.assembler.touch()
  }

  private handleToolOutput(payload: Record<string, unknown>, time: number): void {
    const callId = asString(payload['call_id'])
    if (callId === undefined) return
    const output = payload['output']
    const content = typeof output === 'string'
      ? [{ type: 'text' as const, text: output }]
      : this.contentBlocks(asArray(output) ?? [])
    const text = textOf(content)
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(callId, {
      seq,
      time,
      content,
      isError: outputLooksFailed(payload, text),
    })
    if (topLevel) {
      this.assembler.pushNode(node)
      this.locate(seq, Math.max(1, this.turn))
    } else {
      this.assembler.touch()
    }
  }

  private handleCompaction(message: string, time: number): void {
    this.closeOpenStep('complete')
    const seq = this.assembler.seq.next()
    const summary = message.trim() === '' ? null : message
    this.assembler.pushNode({
      kind: 'compaction',
      seq,
      time,
      summary,
      summaryEventSeq: summary === null ? null : seq,
      shadowedItemCount: null,
      shadowedTokenCount: null,
    })
    const request: CompactionRequestView = {
      purpose: 'compaction',
      turn: this.turn > 0 ? this.turn : null,
      step: 0,
      startSeq: seq,
      startedAt: time,
      completedAt: time,
      status: 'complete',
      resultSeq: seq,
      ...(summary === null ? {} : { summary: [{ type: 'text', text: summary }] }),
      ...(this.model === null ? {} : {
        provenance: { provider: this.provider, model: this.model },
        requestConfig: this.requestConfig(),
      }),
    }
    this.assembler.upsertRequest(request)
    this.lastInputTime = time
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  private appendBlock(block: AssistantBlock, time: number): void {
    const open = this.ensureStep(time)
    open.blocks.push(block)
    if (time > open.lastTime) open.lastTime = time
    this.assembler.partial = { turn: open.turn, step: open.step, blocks: [...open.blocks] }
    this.assembler.touch()
  }

  private ensureStep(time: number): OpenStep {
    if (this.open !== null) return this.open
    if (this.turn === 0) {
      this.turn = 1
      this.step = 0
    }
    this.turnOpenPending = false
    this.step += 1
    const open: OpenStep = {
      turn: this.turn,
      step: this.step,
      seq: this.assembler.seq.next(),
      startedAt: this.lastInputTime,
      firstTokenTime: time,
      lastTime: time,
      blocks: [],
      usage: undefined,
    }
    this.open = open
    this.assembler.partial = { turn: open.turn, step: open.step, blocks: [] }
    this.assembler.touch()
    return open
  }

  private closeOpenStep(status: 'complete' | 'error', error?: string): void {
    const open = this.open
    if (open === null) return
    this.open = null
    const provenance = this.model === null ? undefined : { provider: this.provider, model: this.model }
    const requestConfig = this.model === null ? undefined : this.requestConfig()
    const node: AssistantMessageNode = {
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
        firstTokenTime: open.firstTokenTime,
        completedTime: open.lastTime,
      },
      ...(status === 'error' ? { interrupted: true as const } : {}),
    }
    this.assembler.pushNode(node)
    this.locate(open.seq, open.turn)
    const prompt = this.initialPrompt(requestConfig)
    const request: AssistantRequestView = {
      purpose: 'assistant',
      turn: open.turn,
      step: open.step,
      startSeq: open.seq,
      startedAt: open.startedAt ?? open.firstTokenTime,
      completedAt: open.lastTime,
      status,
      resultSeq: open.seq,
      ...(error === undefined ? {} : { error, errorCode: 'turn_aborted' }),
      ...(open.usage === undefined ? {} : { usage: open.usage }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      ...(prompt === undefined ? {} : prompt),
    }
    this.assembler.upsertRequest(request)
    this.lastRequestSeqByTurn.set(open.turn, open.seq)
    this.assembler.partial = null
    this.assembler.touch()
  }

  /** The base instructions ride the first assistant request as its prompt snapshot. */
  private initialPrompt(
    requestConfig: AssistantRequestConfig | undefined,
  ): { prompt: ConversationPromptSnapshot; promptChange: RequestPromptChange } | undefined {
    if (this.systemPrompt === null || this.systemPromptAttached) return undefined
    this.systemPromptAttached = true
    return {
      prompt: {
        config: requestConfig ?? { provider: this.provider, model: this.model ?? '' },
        system: this.systemPrompt.text,
        tools: [],
      },
      promptChange: { seq: this.systemPrompt.seq, time: this.systemPrompt.time, kind: 'initial' },
    }
  }

  private requestConfig(): AssistantRequestConfig {
    return {
      provider: this.provider,
      model: this.model ?? '',
      ...(this.effort === null ? {} : { reasoningEffort: this.effort }),
    }
  }

  /**
   * Attach usage to the open step, or (fallback) to the most recently closed
   * step of the current turn. `authoritative` records replace an existing
   * value; fallbacks only fill a gap.
   */
  private attachUsage(usage: TokenUsage | undefined, authoritative: boolean): void {
    if (usage === undefined) return
    if (this.open !== null) {
      if (authoritative || this.open.usage === undefined) this.open.usage = usage
      return
    }
    const seq = this.lastRequestSeqByTurn.get(this.turn)
    if (seq === undefined) return
    const request = this.assembler.findRequest(seq)
    if (request === undefined || (!authoritative && request.usage !== undefined)) return
    this.assembler.upsertRequest({ ...request, usage })
    const node = this.assembler.nodes.find(item => item.seq === seq)
    if (node !== undefined && node.kind === 'assistant') {
      this.assembler.replaceNode(seq, { ...node, usage })
    }
  }

  // ---------------------------------------------------------------------------
  // Turn locations
  // ---------------------------------------------------------------------------

  private locate(seq: number, turn: number): void {
    const status = this.assembler.locations.get(seq)
    if (status !== undefined) return
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

  // ---------------------------------------------------------------------------
  // Content
  // ---------------------------------------------------------------------------

  private contentBlocks(items: readonly unknown[]): ContentBlock[] {
    const blocks: ContentBlock[] = []
    for (const item of items) {
      if (!isRecord(item)) continue
      const type = asString(item['type'])
      if (type === 'input_image' || type === 'image') {
        const image = this.imageBlock(item)
        if (image !== undefined) blocks.push(image)
        continue
      }
      const text = asString(item['text'])
      if (text !== undefined) blocks.push({ type: 'text', text })
    }
    return blocks
  }

  private imageBlock(item: Record<string, unknown>): ContentBlock | undefined {
    const url = asString(item['image_url']) ?? asString(item['url'])
    const match = url === undefined ? null : DATA_URL.exec(url)
    if (match !== null) {
      const [, mediaType = '', data = ''] = match
      return { type: 'image', attachment: this.images.add(data, normalizeImageMediaType(mediaType)) }
    }
    const data = asString(item['data'])
    if (data !== undefined) {
      return {
        type: 'image',
        attachment: this.images.add(data, normalizeImageMediaType(item['media_type'] ?? item['mime_type'])),
      }
    }
    if (url !== undefined) return { type: 'text', text: url }
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Child (subagent) transcripts
  // ---------------------------------------------------------------------------

  private handleChild(
    file: SessionFileRef,
    type: string,
    payload: Record<string, unknown>,
    time: number,
  ): void {
    let child = this.children.get(file.id)
    if (child === undefined) {
      const label = type === 'session_meta' ? subagentLabel(payload) : 'subagent'
      const threadId = (type === 'session_meta' ? asString(payload['id']) : undefined) ?? file.id
      const callId = `subagent:${file.id}`
      child = {
        callId, fileId: file.id, threadId, label, startedAt: time, endedAt: null, lastTime: time, toolCalls: 0,
        lastAgentMessage: null, completed: false,
      }
      this.children.set(file.id, child)
      const name = `subagent:${label}`
      const argsRaw = JSON.stringify({ threadId, source: label })
      this.assembler.tools.start({
        callId,
        name,
        argsRaw,
        turn: Math.max(1, this.turn),
        step: this.step,
        time,
        subCalls: [],
      })
      this.attachSyntheticCall(callId, name, argsRaw)
      this.assembler.touch()
    }
    if (child.completed) return
    child.lastTime = Math.max(child.lastTime, time)
    if (type === 'response_item') {
      switch (asString(payload['type'])) {
        case 'message': {
          if (asString(payload['role']) !== 'assistant') return
          const text = (asArray(payload['content']) ?? [])
            .flatMap(item => (isRecord(item) ? [asString(item['text']) ?? ''] : []))
            .filter(part => part !== '')
            .join('\n')
          if (text !== '') child.lastAgentMessage = text
          return
        }
        case 'custom_tool_call':
        case 'function_call':
        case 'local_shell_call':
          child.toolCalls += 1
          this.handleToolCall(payload, time, child.callId)
          return
        case 'custom_tool_call_output':
        case 'function_call_output':
        case 'local_shell_call_output':
          this.handleToolOutput(payload, time)
          return
        default:
          return
      }
    }
    if (type === 'event_msg') {
      const eventType = asString(payload['type'])
      if (eventType === 'task_complete') {
        const last = asString(payload['last_agent_message'])
        if (last !== undefined && last !== '') child.lastAgentMessage = last
        this.completeChild(child, time)
      } else if (eventType === 'turn_aborted') {
        this.completeChild(child, time)
      }
    }
  }

  /** A child's report is an input to the parent: it ends the open step like a tool output. */
  private completeChild(child: ChildThread, time: number): void {
    if (child.completed) return
    child.completed = true
    child.endedAt = time
    this.closeOpenStep('complete')
    this.lastInputTime = time
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(child.callId, {
      seq,
      time,
      content: child.lastAgentMessage === null ? [] : [{ type: 'text', text: child.lastAgentMessage }],
      isError: false,
    })
    if (topLevel) {
      this.assembler.pushNode(node)
      this.locate(seq, Math.max(1, this.turn))
    } else {
      this.assembler.touch()
    }
  }

  /**
   * Make the synthetic subagent call look like a call the model emitted, so the
   * ledger nests it under the assistant record that was active when the child
   * thread started (the step still open, else the turn's last assistant node)
   * instead of listing it as an orphan tool record.
   */
  private attachSyntheticCall(callId: string, name: string, argsRaw: string): void {
    const block: AssistantBlock = { kind: 'tool-call', callId, name, argsRaw }
    if (this.open !== null) {
      this.open.blocks.push(block)
      this.assembler.partial = {
        turn: this.open.turn, step: this.open.step, blocks: [...this.open.blocks],
      }
      return
    }
    for (let index = this.assembler.nodes.length - 1; index >= 0; index -= 1) {
      const node = this.assembler.nodes[index]
      if (node === undefined) continue
      if (node.kind === 'user') break
      if (node.kind === 'assistant') {
        this.assembler.replaceNode(node.seq, { ...node, blocks: [...node.blocks, block] })
        return
      }
    }
  }

  /** A turn boundary in the parent closes children that never reported completion. */
  private completeStaleChildren(time: number): void {
    for (const child of this.children.values()) {
      if (!child.completed) this.completeChild(child, time)
    }
  }
}

function reasoningText(payload: Record<string, unknown>): string {
  const summary = asArray(payload['summary']) ?? []
  return summary
    .flatMap(item => (isRecord(item) ? [asString(item['text']) ?? ''] : []))
    .filter(text => text !== '')
    .join('\n\n')
}

/** Create the incremental Codex rollout parser. */
export function createCodexParser(): SessionParser {
  return new CodexParser()
}
