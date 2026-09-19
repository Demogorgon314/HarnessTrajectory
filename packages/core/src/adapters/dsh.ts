/**
 * DeepSeek Harness session-log trajectory adapter.
 *
 * Folds the event stream decoded by `dsh-protocol.ts` (which owns the wire
 * shapes and traps) into the trajectory contract, incrementally and per file.
 *
 * Traps beyond the protocol level:
 *  - `request/header` lands AFTER `step/start` and is NOT re-logged when
 *    unchanged, so every request inherits the effective config/prompt
 *    snapshot; `promptChange` records only what the header itself changed.
 *    `reason:'initial'` marks a fresh session's first header; a resumed
 *    session's first header only re-states the effective request.
 *  - The system prompt is `request/header.data.header.system` (a string) in
 *    v0/v1 and `system/message` surface nodes in v3; an appended node after
 *    an earlier nonempty one is an in-history UPDATE the next header must
 *    not report again, and an empty node that replaces the prompt's node
 *    clears it.
 *  - `tool/ptc-dispatch-start`/`tool/ptc-dispatch` (legacy `code-dispatch*`)
 *    are the nested calls `run_code` performs; they bind via
 *    `parentCallId`/`subCallId` and never re-enter model context.
 *  - `image/offload` targets surface nodes by `targets[].seq` and image
 *    indexes — trajectory keeps the durable record; the context
 *    synthesizer owns the model-visible projection.
 *  - A child session is a SEPARATE log whose header carries
 *    `origin:'subagent'`; the parent's continuable background result text is
 *    exactly `started subagent <childSessionId>` — the only binding the
 *    transcript records (foreground runs return output, no id). Parent and
 *    child streams interleave arbitrarily: binding must preserve a terminal
 *    status the child already published.
 */

import type {
  AssistantBlock, AssistantProvenanceView, AssistantRequestConfig, AssistantRequestView,
  CommandNode, ContentBlock, ConversationLocation,
  ConversationPromptSnapshot, ImageAttachmentRef, KnownContextForm, LlmFailure,
  RequestPromptChange, TokenUsage, ToolSchema,
} from '../contract.ts'
import type {
  ImageStore, ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun, SubagentStatus,
} from '../session.ts'
import { asArray, asNumber, asString, isRecord, parseJsonLine } from '../jsonl.ts'
import {
  dshFirstTokenTime, dshReplaceRange, dshSubagentIdOf, dshTextOf, dshToolResultOf, dshUsageOf,
  dshUserClass, expandDshStreamRun, isDshTokenChunk, parseDshLine,
  type DshEvent, type DshHeader, type DshRecord,
} from './dsh-protocol.ts'
import { TrajectoryAssembler, normalizeImageMediaType, textOf, titleFrom } from './shared.ts'

/** `blobref:` image store: dsh attachment ids are content hashes, so the URL names the blob, not the bytes. */
class DshImageStore implements ImageStore {
  private readonly urls = new Map<string, string>()

  add(attachmentId: string, mediaType: string): void {
    this.urls.set(attachmentId, `blobref:${mediaType};${attachmentId}`)
  }

  get(attachmentId: string): string | undefined {
    return this.urls.get(attachmentId)
  }

  keys(): IterableIterator<string> {
    return this.urls.keys()
  }
}

interface AgentRun {
  agentId: string
  fileId: string | null
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

interface OpenCompaction {
  startSeq: number
  startedAt: number
  turn: number | null
  shadowedItemCount: number | null
  shadowedTokenCount: number | null
  summary: readonly ContentBlock[] | undefined
  usage: TokenUsage | undefined
  provenance: AssistantProvenanceView | undefined
}

const KNOWN_FORMS = new Set<KnownContextForm>(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])

function stringifyArgs(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}

function failureOf(value: unknown): LlmFailure {
  const record = isRecord(value) ? value : undefined
  const status = asNumber(record?.status)
  return {
    message: asString(record?.message) ?? 'error',
    code: asString(record?.code) ?? 'error',
    ...(status === undefined ? {} : { status }),
  }
}

class DshParser implements SessionParser {
  readonly kind = 'dsh' as const
  readonly images = new DshImageStore()

  private readonly assembler = new TrajectoryAssembler()
  private readonly turnSeqs = new Map<number, number[]>()
  private readonly closedTurns = new Set<number>()
  private readonly runs = new Map<string, AgentRun>()
  private readonly childCalls = new Set<string>()
  /** `tool/call` id → facts a later `started subagent <id>` result binds from. */
  private readonly calls = new Map<string, { name: string; argsRaw: string; time: number }>()
  private readonly retries = new Map<string, {
    provider: string; retry: number; maxRetries: number; delayMs: number; failure: LlmFailure
  }>()
  private readonly commandSeqs = new Map<string, number>()

  private turn = 0
  private step = 0
  private turnOpen = false
  private stepOpen = false
  private turnHasHumanPrompt = false
  private stepStartTime: number | null = null
  private firstTokenTime: number | null = null
  private partialBlocks: AssistantBlock[] | null = null
  private openRequest: AssistantRequestView | null = null
  private openCompaction: OpenCompaction | null = null

  /** Surviving v3 `system/message` nodes in surface-position order. */
  private readonly systemNodes: { position: number; seq: number; text: string }[] = []
  /** Replacement event seq → the surface position it inherited (a replace re-takes its span's start). */
  private readonly systemPositions = new Map<number, number>()
  private currentPromptText = ''
  /** Event seq of the surviving node `effectivePrompt` was derived from. */
  private effectiveSurvivingSeq: number | undefined
  /**
   * The effective system prompt's anchor: assembler seq and time of the event
   * that established it, plus the `update` flag — true only for a v3 node
   * appended while an earlier nonempty node survived (an in-history update
   * the next header must not report again).
   */
  private effectivePrompt: { seq: number; time: number; update: boolean } | undefined
  /** Any earlier committed prompt node — drives the `update` display flag. */
  private promptNodeSeen = false
  /**
   * Latest prompt state every new request inherits. A v3 in-history update
   * commits into `system` at node-commit time, exactly as upstream's
   * system-message header fact becomes the next header's `previous`.
   */
  private lastPromptSnapshot: ConversationPromptSnapshot | undefined
  /** Change computed by a `request/header` that arrived while no request was open. */
  private heldChange: RequestPromptChange | undefined
  private requestConfig: AssistantRequestConfig | undefined
  private readonly schemaByName = new Map<string, ToolSchema>()

  private sessionTitle: string | null = null
  private firstPrompt: string | null = null
  private descriptorLabel: string | null = null
  private cwd: string | null = null
  private model: string | null = null
  private startedAt: number | null = null
  private promptCount = 0

  push(line: string, file: SessionFileRef, lineIndex?: number): void {
    this.assembler.beginLine(file.id, lineIndex)
    const record = parseDshLine(line)
    if (record === null) return
    if (file.role === 'child') {
      this.handleChild(file, record)
      return
    }
    switch (record.tag) {
      case 'header':
        this.onHeader(record.header)
        return
      case 'run':
        for (const event of expandDshStreamRun(record.run)) this.onStreamEvent(event)
        return
      case 'event':
        this.onEvent(record.event)
        return
    }
  }

  snapshot() {
    return this.assembler.snapshot()
  }

  meta(): ParsedSessionMeta {
    return {
      title: this.sessionTitle ?? this.firstPrompt ?? this.descriptorLabel,
      cwd: this.cwd,
      model: this.model,
      startedAt: this.startedAt,
      promptCount: this.promptCount,
    }
  }

  subagents(): readonly SubagentRun[] {
    return [...this.runs.values()].map(run => ({ ...run }))
  }

  imageUrl(attachment: ImageAttachmentRef): string | undefined {
    return this.images.get(attachment.attachmentId)
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  private onHeader(header: DshHeader): void {
    if (header.cwd !== undefined && header.cwd !== '') this.cwd = header.cwd
    if (header.createdAt !== null) this.startedAt = header.createdAt
  }

  private onEvent(event: DshEvent): void {
    this.startedAt ??= event.time
    const data = event.data
    switch (event.type) {
      case 'turn/start':
        this.turn = asNumber(data['turn']) ?? this.turn + 1
        this.step = 0
        this.turnOpen = true
        this.stepOpen = false
        this.turnHasHumanPrompt = false
        return
      case 'turn/end':
        this.onTurnEnd(event)
        return
      case 'step/start':
        this.onStepStart(event)
        return
      case 'step/end':
        this.stepOpen = false
        return
      case 'system/message':
        this.onSystemMessage(event)
        return
      case 'request/header':
        this.onRequestHeader(event)
        return
      case 'request/context':
        this.model ??= asString(data['model']) ?? null
        return
      case 'user/message':
        this.onUserMessage(event)
        return
      case 'assistant/message':
        this.onAssistantMessage(event)
        return
      case 'assistant/attempt':
        this.firstTokenTime ??= dshFirstTokenTime(data['stream']) ?? null
        return
      case 'assistant/chunk':
        this.onStreamEvent(event)
        return
      case 'tool/call':
        this.onToolCall(event)
        return
      case 'tool/result':
        this.onToolResult(event)
        return
      case 'tool/ptc-dispatch-start':
      case 'tool/code-dispatch-start':
        this.onDispatchStart(event)
        return
      case 'tool/ptc-dispatch':
      case 'tool/code-dispatch':
        this.onDispatchSettle(event)
        return
      case 'compaction/start':
        this.onCompactionStart(event)
        return
      case 'compaction/summary':
        this.onCompactionSummary(event)
        return
      case 'compaction/end':
        this.onCompactionEnd(event)
        return
      case 'llm/retry':
        this.onRetry(event)
        return
      case 'llm/retry-started':
        this.onRetryStarted(event)
        return
      case 'command/run':
        this.onCommandRun(event)
        return
      case 'command/done':
        this.onCommandDone(event)
        return
      case 'session/title': {
        const title = asString(data['title'])
        if (title !== undefined && title !== '') this.sessionTitle = title
        return
      }
      case 'subagent/descriptor':
        // A standalone child view: the parent's label is the title fallback.
        this.descriptorLabel ??= asString(data['label']) ?? null
        return
      default:
        // permission/preset, approvals, agent/inbox/spliced, goal, todo, hooks,
        // teams, dispatches, and anything newer fold into nothing.
        return
    }
  }

  // -------------------------------------------------------------------------
  // Turns and steps
  // -------------------------------------------------------------------------

  private onTurnEnd(event: DshEvent): void {
    const data = event.data
    const reason = isRecord(data['reason']) ? data['reason'] : undefined
    const kind = asString(reason?.['kind'])
    if (kind !== 'completed' && this.openRequest !== null && this.openRequest.status === 'running') {
      // The turn settled without a response: the in-flight request failed.
      const failure = isRecord(reason?.['error']) ? failureOf(reason?.['error']) : undefined
      this.assembler.upsertRequest({
        ...this.openRequest,
        status: 'error',
        completedAt: event.time,
        error: failure?.message ?? kind ?? 'error',
        ...(failure === undefined ? {} : { errorCode: failure.code }),
      })
      this.openRequest = null
      this.partialBlocks = null
      this.assembler.partial = null
    }
    if (kind === 'error') {
      const failure = isRecord(reason?.['error']) ? reason['error'] : undefined
      const code = asString(failure?.['code'])
      const seq = this.assembler.seq.next()
      this.locate(seq)
      this.assembler.pushNode({
        kind: 'turn-error',
        seq,
        time: event.time,
        turn: this.turn,
        step: this.step,
        message: asString(failure?.['message']) ?? 'error',
        ...(code === undefined ? {} : { code }),
      })
    } else if (kind === 'max-tokens') {
      const seq = this.assembler.seq.next()
      this.locate(seq)
      this.assembler.pushNode({
        kind: 'turn-max-tokens',
        seq,
        time: event.time,
        turn: this.turn,
        step: this.step,
      })
    }
    this.closeTurn()
  }

  private onStepStart(event: DshEvent): void {
    const data = event.data
    this.step = asNumber(data['step']) ?? this.step + 1
    this.stepOpen = true
    this.stepStartTime = event.time
    this.firstTokenTime = null
    const startSeq = this.assembler.seq.next()
    const request: AssistantRequestView = {
      purpose: 'assistant',
      startSeq,
      startedAt: event.time,
      completedAt: null,
      status: 'running',
      turn: this.turn,
      step: this.step,
      ...(this.requestConfig === undefined ? {} : { requestConfig: this.requestConfig }),
      ...(this.lastPromptSnapshot === undefined ? {} : { prompt: this.lastPromptSnapshot }),
      ...(this.heldChange === undefined ? {} : { promptChange: this.heldChange }),
    }
    this.heldChange = undefined
    this.openRequest = request
    this.assembler.upsertRequest(request)
    this.partialBlocks = []
    this.assembler.partial = { turn: this.turn, step: this.step, blocks: this.partialBlocks }
    this.assembler.touch()
  }

  private locate(seq: number): void {
    if (this.assembler.locations.has(seq)) return
    if (this.turn <= 0 || !this.turnOpen) {
      this.assembler.locations.set(seq, { kind: 'session' })
      return
    }
    const seqs = this.turnSeqs.get(this.turn) ?? []
    seqs.push(seq)
    this.turnSeqs.set(this.turn, seqs)
    const status = this.closedTurns.has(this.turn) ? 'closed' as const : 'open' as const
    const location: ConversationLocation = this.stepOpen
      ? { kind: 'step', turn: { turn: this.turn, status }, step: { step: this.step } }
      : { kind: 'turn', turn: { turn: this.turn, status } }
    this.assembler.locations.set(seq, location)
  }

  private closeTurn(): void {
    this.turnOpen = false
    this.stepOpen = false
    if (this.turn <= 0) return
    this.closedTurns.add(this.turn)
    for (const seq of this.turnSeqs.get(this.turn) ?? []) {
      const prev = this.assembler.locations.get(seq)
      if (prev?.kind === 'step') {
        this.assembler.locations.set(seq, {
          kind: 'step',
          turn: { turn: this.turn, status: 'closed' },
          step: prev.step,
        })
      } else if (prev?.kind === 'turn') {
        this.assembler.locations.set(seq, {
          kind: 'turn',
          turn: { turn: this.turn, status: 'closed' },
        })
      }
    }
    this.assembler.touch()
  }

  // -------------------------------------------------------------------------
  // Prompt state
  // -------------------------------------------------------------------------

  /**
   * Fold one v0/v1 `header.system` commit: the header-carried prompt is the
   * effective node anchored at the header itself. It never counts as an
   * in-history update, so a later header still reports the change.
   */
  private applyHeaderPrompt(text: string, time: number): void {
    if (text === this.currentPromptText) return
    this.currentPromptText = text
    const seq = this.assembler.seq.next()
    this.effectivePrompt = { seq, time, update: false }
    if (text === '') return
    this.assembler.systemPrompts.push({
      seq,
      time,
      turn: this.turn,
      step: this.step,
      text,
      update: this.promptNodeSeen,
    })
    this.promptNodeSeen = true
    this.assembler.touch()
  }

  /**
   * Fold one `system/message` surface event, mirroring upstream's
   * `inspectSystemPrompt`: the effective prompt is the LAST nonempty
   * surviving node in surface order — a replacement re-takes its span's
   * start position, it does not move to the tail. An appended node becomes
   * the effective anchor with `update` set when earlier nonempty text
   * survived; a replacement that falls back to an older node (or clears
   * the prompt) re-anchors a non-update node at this event.
   */
  private onSystemMessage(event: DshEvent): void {
    const message = isRecord(event.data['message']) ? event.data['message'] : undefined
    const text = dshTextOf(message?.['content'])
    const range = dshReplaceRange(event.surfaceOp)
    let position = event.seq
    if (range !== null) {
      position = this.systemPositions.get(range.start) ?? range.start
      const end = this.systemPositions.get(range.end) ?? range.end
      for (let index = this.systemNodes.length - 1; index >= 0; index -= 1) {
        const node = this.systemNodes[index]
        if (node !== undefined && node.position >= position && node.position <= end) {
          this.systemNodes.splice(index, 1)
        }
      }
      for (const [seq, pos] of this.systemPositions) {
        if (pos >= position && pos <= end) this.systemPositions.delete(seq)
      }
      this.systemPositions.set(event.seq, position)
    }
    const update = event.surfaceOp === 'append'
      && this.systemNodes.some(node => node.text !== '')
    this.systemNodes.push({ position, seq: event.seq, text })
    this.systemNodes.sort((a, b) => a.position - b.position)
    const surviving = this.systemNodes.findLast(node => node.text !== '')
    if (surviving?.seq === this.effectiveSurvivingSeq) return
    this.effectiveSurvivingSeq = surviving?.seq
    const seq = this.assembler.seq.next()
    if (surviving !== undefined && surviving.seq === event.seq) {
      // The just-appended node is effective; nonempty text gets a display
      // node, and a genuine in-history update also commits into the prompt
      // the next header diffs against.
      const changed = text !== this.currentPromptText
      this.currentPromptText = text
      this.effectivePrompt = { seq, time: event.time, update }
      if (text !== '') {
        this.assembler.systemPrompts.push({
          seq,
          time: event.time,
          turn: this.turn,
          step: this.step,
          text,
          update,
        })
        this.promptNodeSeen = true
        this.assembler.touch()
        if (update && changed && this.lastPromptSnapshot !== undefined) {
          this.lastPromptSnapshot = { ...this.lastPromptSnapshot, system: text }
        }
      }
    } else {
      // A replacement fell back to an older survivor or cleared the prompt:
      // anchor at this event with update=false so the next header reports it.
      this.currentPromptText = surviving?.text ?? ''
      this.effectivePrompt = { seq, time: event.time, update: false }
    }
    // The effective prompt moved without a header: the in-flight request is
    // still the one this state applies to, so its snapshot moves with it.
    // Requests already settled keep the prompt they were made under.
    const prompt = this.openRequest?.prompt
    if (this.openRequest !== null && prompt !== undefined && prompt.system !== this.currentPromptText) {
      this.openRequest = {
        ...this.openRequest,
        prompt: { ...prompt, system: this.currentPromptText },
      }
      this.assembler.upsertRequest(this.openRequest)
    }
  }

  private requestConfigOf(config: Record<string, unknown> | undefined): AssistantRequestConfig | undefined {
    if (config === undefined) return undefined
    const reasoningEffort = asString(config['reasoningEffort'])
    const maxTokens = asNumber(config['maxTokens'])
    const temperature = asNumber(config['temperature'])
    return {
      provider: asString(config['provider']) ?? '',
      model: asString(config['model']) ?? '',
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(temperature === undefined ? {} : { temperature }),
    }
  }

  /**
   * Fold one `request/header`, mirroring upstream's `inspectRequestPrompt`:
   * the request inherits the effective config/prompt state, and the header
   * reports a `promptChange` only for what it itself changed — an `initial`
   * first header, a system prompt the surface did not already present as an
   * update, or a tool-catalog diff. A resumed session's first header and
   * unchanged repeat headers only re-state the effective request.
   */
  private onRequestHeader(event: DshEvent): void {
    const header = isRecord(event.data['header']) ? event.data['header'] : undefined
    // v0/v1: the system prompt rides the header as a complete string.
    const systemText = asString(header?.['system'])
    if (systemText !== undefined) this.applyHeaderPrompt(systemText, event.time)
    const config = isRecord(header?.['config']) ? header['config'] : undefined
    const requestConfig = this.requestConfigOf(config)
    if (requestConfig !== undefined) this.requestConfig = requestConfig
    this.model ??= asString(config?.['model']) ?? null
    const tools: ToolSchema[] = []
    for (const item of asArray(header?.['tools']) ?? []) {
      if (!isRecord(item)) continue
      const name = asString(item['name'])
      if (name === undefined) continue
      tools.push({
        name,
        description: asString(item['description']) ?? '',
        parameters: isRecord(item['parameters']) ? item['parameters'] : {},
      })
    }
    this.schemaByName.clear()
    for (const tool of tools) this.schemaByName.set(tool.name, tool)
    const snapshot: ConversationPromptSnapshot = {
      config: requestConfig ?? this.requestConfig ?? { provider: '', model: '' },
      system: this.currentPromptText,
      tools,
    }
    const previous = this.lastPromptSnapshot
    let promptChange: RequestPromptChange | undefined
    if (previous !== undefined || asString(event.data['reason']) === 'initial') {
      const systemChanged = previous !== undefined
        && previous.system !== snapshot.system
        && this.effectivePrompt?.update !== true
      const toolsChanged = previous !== undefined
        && JSON.stringify(previous.tools) !== JSON.stringify(snapshot.tools)
      if (previous === undefined || systemChanged || toolsChanged) {
        const origin = this.effectivePrompt !== undefined && (previous === undefined || systemChanged)
          ? this.effectivePrompt
          : { seq: this.assembler.seq.next(), time: event.time }
        promptChange = {
          seq: origin.seq,
          time: origin.time,
          kind: previous === undefined
            ? 'initial'
            : systemChanged && toolsChanged ? 'system-and-tools' : systemChanged ? 'system' : 'tools',
          ...(previous === undefined ? {} : { previous }),
        }
      }
    }
    this.lastPromptSnapshot = snapshot
    const fields = {
      ...(this.requestConfig === undefined ? {} : { requestConfig: this.requestConfig }),
      prompt: snapshot,
      ...(promptChange === undefined ? {} : { promptChange }),
    }
    if (this.openRequest !== null) {
      this.openRequest = { ...this.openRequest, ...fields }
      this.assembler.upsertRequest(this.openRequest)
    } else {
      this.heldChange = promptChange
    }
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private onUserMessage(event: DshEvent): void {
    const data = event.data
    const content = this.contentBlocks(data['content'])
    const cls = dshUserClass(event)
    const seq = this.assembler.seq.next()
    this.locate(seq)
    if (cls === 'compaction') {
      this.onCompactionReplace(event, seq, content)
      return
    }
    if (cls === 'injection') {
      const source = isRecord(data['source']) ? data['source'] : undefined
      const form = asString(source?.['form'])
      this.assembler.pushNode({
        kind: 'context',
        seq,
        time: event.time,
        content,
        source: data['source'] ?? null,
        provenance: {
          role: form === 'recall' ? 'recall' : 'inject',
          label: asString(source?.['plugin']) ?? asString(source?.['name']) ?? asString(source?.['kind']) ?? null,
        },
        form: form !== undefined && KNOWN_FORMS.has(form as KnownContextForm) ? form as KnownContextForm : null,
      })
      return
    }
    const text = textOf(content)
    if (this.turnOpen && this.turnHasHumanPrompt) {
      this.assembler.pushNode({
        kind: 'steering',
        messageId: asString(data['id']) ?? String(event.seq),
        seq,
        time: event.time,
        content,
        source: data['source'] ?? null,
      })
      return
    }
    this.turnHasHumanPrompt = true
    this.promptCount += 1
    if (this.firstPrompt === null && text.trim() !== '') this.firstPrompt = titleFrom(text)
    this.assembler.pushNode({
      kind: 'user',
      seq,
      time: event.time,
      content,
      source: data['source'] ?? null,
    })
  }

  private assistantBlocks(raw: unknown): AssistantBlock[] {
    const blocks: AssistantBlock[] = []
    for (const item of asArray(raw) ?? []) {
      if (!isRecord(item)) continue
      switch (item['type']) {
        case 'text':
          blocks.push({ kind: 'text', text: asString(item['text']) ?? '' })
          break
        case 'reasoning':
          blocks.push({ kind: 'reasoning', text: asString(item['text']) ?? '' })
          break
        case 'image': {
          const attachment = this.imageAttachment(item['attachment'])
          if (attachment !== undefined) blocks.push({ kind: 'image', attachment })
          break
        }
        case 'tool-call': {
          const callId = asString(item['id'])
          if (callId === undefined) break
          blocks.push({
            kind: 'tool-call',
            callId,
            name: asString(item['name']) ?? 'tool',
            argsRaw: stringifyArgs(item['arguments']),
          })
          break
        }
        default:
          blocks.push({ kind: 'other', block: item })
      }
    }
    return blocks
  }

  private onAssistantMessage(event: DshEvent): void {
    const data = event.data
    const message = isRecord(data['message']) ? data['message'] : undefined
    if (message === undefined) return
    const turn = asNumber(data['turn']) ?? this.turn
    const step = asNumber(data['step']) ?? this.step
    const blocks = this.assistantBlocks(message['content'])
    const usage = dshUsageOf(data['usage'])
    const source = isRecord(message['source']) ? message['source'] : undefined
    const provider = asString(source?.['provider'])
    const responseModel = asString(source?.['model'])
    const provenance = provider !== undefined && responseModel !== undefined
      ? { provider, model: responseModel }
      : undefined
    const firstToken = dshFirstTokenTime(data['stream']) ?? this.firstTokenTime
    const messageId = asString(message['id'])
    const seq = this.assembler.seq.next()
    this.locate(seq)
    this.assembler.pushNode({
      kind: 'assistant',
      seq,
      time: event.time,
      turn,
      step,
      blocks,
      ...(messageId === undefined ? {} : { messageId }),
      ...(usage === undefined ? {} : { usage }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(this.requestConfig === undefined ? {} : { requestConfig: this.requestConfig }),
      timing: {
        stepStartTime: this.stepStartTime,
        firstTokenTime: firstToken ?? null,
        completedTime: event.time,
      },
      ...(data['interrupted'] === true ? { interrupted: true as const } : {}),
    })
    const request = this.openRequest ?? {
      purpose: 'assistant' as const,
      startSeq: seq,
      startedAt: event.time,
      completedAt: null,
      status: 'running' as const,
      turn,
      step,
      ...(this.requestConfig === undefined ? {} : { requestConfig: this.requestConfig }),
      ...(this.lastPromptSnapshot === undefined ? {} : { prompt: this.lastPromptSnapshot }),
    }
    this.assembler.upsertRequest({
      ...request,
      completedAt: event.time,
      status: 'complete',
      resultSeq: seq,
      ...(usage === undefined ? {} : { usage }),
      ...(provenance === undefined ? {} : { provenance }),
    })
    this.openRequest = null
    this.partialBlocks = null
    this.assembler.partial = null
  }

  /**
   * A v0/v1 stream event (top-level `assistant/chunk` or one member of an
   * expanded packed run): stamps the step's first token and grows the
   * in-flight `partial.blocks` by content index.
   */
  private onStreamEvent(event: DshEvent): void {
    const chunk = event.data['chunk']
    if (!isRecord(chunk)) return
    if (isDshTokenChunk(chunk)) this.firstTokenTime ??= event.time
    const blocks = this.partialBlocks
    if (blocks === null) return
    const index = asNumber(chunk['index']) ?? blocks.length
    switch (chunk['type']) {
      case 'block-start': {
        const blockType = asString(chunk['blockType'])
        const block: AssistantBlock = blockType === 'reasoning'
          ? { kind: 'reasoning', text: '' }
          : blockType === 'tool-call'
            ? { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
            : { kind: 'text', text: '' }
        if (index < blocks.length) blocks[index] = block
        else blocks.push(block)
        break
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const kind = chunk['type'] === 'text-delta' ? 'text' as const : 'reasoning' as const
        const text = asString(chunk['text']) ?? ''
        const existing = index < blocks.length ? blocks[index] : undefined
        if (existing !== undefined && existing.kind === kind) {
          blocks[index] = { ...existing, text: existing.text + text }
        } else {
          blocks.push({ kind, text })
        }
        break
      }
      case 'tool-call-delta': {
        const existing = index < blocks.length ? blocks[index] : undefined
        const id = asString(chunk['id'])
        const name = asString(chunk['name'])
        const delta = asString(chunk['argumentsDelta']) ?? ''
        if (existing !== undefined && existing.kind === 'tool-call') {
          blocks[index] = {
            ...existing,
            callId: existing.callId === '' ? id ?? existing.callId : existing.callId,
            name: existing.name === '' ? name ?? existing.name : existing.name,
            argsRaw: existing.argsRaw + delta,
          }
        } else {
          blocks.push({
            kind: 'tool-call',
            callId: id ?? '',
            name: name ?? '',
            argsRaw: delta,
          })
        }
        break
      }
      default:
        // usage / finish / block-end carry no delta.
        return
    }
    this.assembler.touch()
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private onToolCall(event: DshEvent): void {
    const data = event.data
    const callId = asString(data['callId'])
    if (callId === undefined) return
    const name = asString(data['name']) ?? 'tool'
    const argsRaw = stringifyArgs(data['arguments'])
    this.assembler.tools.start({
      callId,
      name,
      argsRaw,
      turn: this.turn,
      step: this.step,
      time: event.time,
      subCalls: [],
    })
    const schema = this.schemaByName.get(name)
    if (schema !== undefined) this.assembler.callSchemas.set(callId, schema)
    this.calls.set(callId, { name, argsRaw, time: event.time })
    this.assembler.touch()
  }

  private onToolResult(event: DshEvent): void {
    const data = event.data
    const { callId, result } = dshToolResultOf(data)
    if (callId === undefined) return
    const inner = this.contentBlocks(result?.['content'])
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(callId, {
      seq,
      time: event.time,
      content: inner,
      isError: result?.['isError'] === true,
      ...this.dispatchError(data),
      ...(data['meta'] === undefined ? {} : { meta: data['meta'] }),
    })
    if (topLevel) {
      this.locate(seq)
      this.assembler.pushNode(node)
    } else {
      this.assembler.touch()
    }
    this.bindSubagentResult(callId, inner, event.time)
  }

  /**
   * One `run_code` sub-call start (`ptc-dispatch-start`, legacy
   * `code-dispatch-start`): registers the pending call under its parent so
   * the result nests into `subCalls` instead of surfacing top-level.
   */
  private onDispatchStart(event: DshEvent): void {
    const data = event.data
    const subCallId = asString(data['subCallId'])
    if (subCallId === undefined) return
    const name = asString(data['name']) ?? 'tool'
    const argsRaw = stringifyArgs(data['arguments'])
    const parentCallId = asString(data['parentCallId'])
    this.assembler.tools.start({
      callId: subCallId,
      name,
      argsRaw,
      turn: this.turn,
      step: this.step,
      time: event.time,
      ...(parentCallId === undefined ? {} : { parentCallId }),
      subCalls: [],
    })
    const schema = this.schemaByName.get(name)
    if (schema !== undefined) this.assembler.callSchemas.set(subCallId, schema)
    this.calls.set(subCallId, { name, argsRaw, time: event.time })
    this.assembler.touch()
  }

  /**
   * One `run_code` sub-call settlement (`ptc-dispatch`, legacy
   * `code-dispatch`): carries the call details again so a missed start still
   * lands under `parentCallId`; the completion itself nests via the tracker.
   */
  private onDispatchSettle(event: DshEvent): void {
    const data = event.data
    const subCallId = asString(data['subCallId'])
    if (subCallId === undefined) return
    if (!this.assembler.tools.has(subCallId)) this.onDispatchStart(event)
    const inner = this.contentBlocks(data['content'])
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(subCallId, {
      seq,
      time: event.time,
      content: inner,
      isError: data['isError'] === true,
      ...this.dispatchError(data),
    })
    if (topLevel) {
      this.locate(seq)
      this.assembler.pushNode(node)
    } else {
      this.assembler.touch()
    }
    this.bindSubagentResult(subCallId, inner, event.time)
  }

  /** The `{name, code}` view of a `tool/result` or dispatch `error` payload. */
  private dispatchError(data: Record<string, unknown>): { error?: { name: string; code: string } } {
    const error = isRecord(data['error']) ? data['error'] : undefined
    if (error === undefined) return {}
    return {
      error: {
        name: asString(error['name']) ?? 'error',
        code: asString(error['code']) ?? 'error',
      },
    }
  }

  /**
   * A continuable background subagent binds its child session id from the
   * `started subagent <id>` result text. Binding only attaches identity and
   * description: a run whose child stream already published a terminal
   * status keeps it — only the child's own `turn/start` reopens it.
   */
  private bindSubagentResult(callId: string, inner: readonly ContentBlock[], time: number): void {
    const childId = dshSubagentIdOf(textOf(inner))
    if (childId === undefined) return
    const run = this.runFor(childId)
    run.fileId = childId
    run.callId = callId
    const call = this.calls.get(callId)
    run.startedAt ??= call?.time ?? time
    if (call !== undefined) {
      const args = parseJsonLine(call.argsRaw)
      const description = isRecord(args) ? asString(args['description']) : undefined
      if (description !== undefined) run.description ??= description
    }
    if (run.status === 'launching') run.status = 'running'
  }

  // -------------------------------------------------------------------------
  // Compaction
  // -------------------------------------------------------------------------

  private onCompactionStart(event: DshEvent): void {
    const turn = asNumber(event.data['turn']) ?? (this.turnOpen ? this.turn : null)
    const startSeq = this.assembler.seq.next()
    this.openCompaction = {
      startSeq,
      startedAt: event.time,
      turn,
      shadowedItemCount: null,
      shadowedTokenCount: null,
      summary: undefined,
      usage: undefined,
      provenance: undefined,
    }
    this.assembler.upsertRequest({
      purpose: 'compaction',
      startSeq,
      startedAt: event.time,
      completedAt: null,
      status: 'running',
      turn,
      step: 0,
    })
  }

  private onCompactionSummary(event: DshEvent): void {
    const data = event.data
    const shadowedSeqs = asArray(data['shadowedSeqs'])
    const range = isRecord(data['shadowedRange']) ? data['shadowedRange'] : undefined
    const start = asNumber(range?.['start'])
    const end = asNumber(range?.['end'])
    const itemCount = shadowedSeqs?.length
      ?? (start !== undefined && end !== undefined ? end - start + 1 : null)
    const tokenCount = asNumber(data['shadowedTokenCount']) ?? null
    const summary = this.contentBlocks(data['summary'])
    const usage = dshUsageOf(data['usage'])
    const provider = asString(data['provider'])
    const responseModel = asString(data['model'])
    const provenance = provider !== undefined && responseModel !== undefined
      ? { provider, model: responseModel }
      : undefined
    if (this.openCompaction === null) {
      // A summary without an armed start still opens the request so the
      // replacing user/message and compaction/end have somewhere to land.
      const startSeq = this.assembler.seq.next()
      this.openCompaction = {
        startSeq,
        startedAt: event.time,
        turn: this.turnOpen ? this.turn : null,
        shadowedItemCount: itemCount,
        shadowedTokenCount: tokenCount,
        summary,
        usage,
        provenance,
      }
    } else {
      this.openCompaction.shadowedItemCount = itemCount
      this.openCompaction.shadowedTokenCount = tokenCount
      this.openCompaction.summary = summary
      this.openCompaction.usage = usage
      this.openCompaction.provenance = provenance
    }
    const open = this.openCompaction
    this.assembler.upsertRequest({
      purpose: 'compaction',
      startSeq: open.startSeq,
      startedAt: open.startedAt,
      completedAt: null,
      status: 'running',
      turn: open.turn,
      step: 0,
      ...(summary.length === 0 ? {} : { summary }),
      ...(usage === undefined ? {} : { usage }),
      ...(provenance === undefined ? {} : { provenance }),
    })
  }

  /** The replace-op `user/message` that swaps the shadowed range for the summary. */
  private onCompactionReplace(event: DshEvent, seq: number, content: readonly ContentBlock[]): void {
    const text = textOf(content)
    const range = dshReplaceRange(event.surfaceOp)
    const open = this.openCompaction
    const itemCount = open?.shadowedItemCount
      ?? (range === null ? null : range.end - range.start + 1)
    this.assembler.pushNode({
      kind: 'compaction',
      seq,
      time: event.time,
      summary: text === '' ? null : text,
      summaryEventSeq: seq,
      shadowedItemCount: itemCount,
      shadowedTokenCount: open?.shadowedTokenCount ?? null,
    })
    if (open === null) return
    this.assembler.upsertRequest({
      purpose: 'compaction',
      startSeq: open.startSeq,
      startedAt: open.startedAt,
      completedAt: null,
      status: 'running',
      turn: open.turn,
      step: 0,
      replacementSeq: seq,
      resultSeq: seq,
      ...(open.summary === undefined ? {} : { summary: open.summary }),
      ...(open.usage === undefined ? {} : { usage: open.usage }),
      ...(open.provenance === undefined ? {} : { provenance: open.provenance }),
    })
  }

  private onCompactionEnd(event: DshEvent): void {
    const open = this.openCompaction
    if (open === null) return
    this.openCompaction = null
    const error = event.data['error']
    const message = isRecord(error) ? asString(error['message']) : asString(error)
    const previous = this.assembler.findRequest(open.startSeq)
    const replacementSeq = previous !== undefined && previous.purpose === 'compaction'
      ? previous.replacementSeq
      : undefined
    this.assembler.upsertRequest({
      purpose: 'compaction',
      startSeq: open.startSeq,
      startedAt: open.startedAt,
      completedAt: event.time,
      status: error === undefined || error === null ? 'complete' : 'error',
      turn: open.turn,
      step: 0,
      ...(replacementSeq === undefined ? {} : { replacementSeq, resultSeq: replacementSeq }),
      ...(open.summary === undefined ? {} : { summary: open.summary }),
      ...(open.usage === undefined ? {} : { usage: open.usage }),
      ...(open.provenance === undefined ? {} : { provenance: open.provenance }),
      ...(message === undefined || message === null ? {} : { error: message }),
    })
  }

  // -------------------------------------------------------------------------
  // Retries and commands
  // -------------------------------------------------------------------------

  private onRetry(event: DshEvent): void {
    const data = event.data
    const facts = {
      provider: asString(data['provider']) ?? '',
      retry: asNumber(data['retry']) ?? 0,
      maxRetries: asNumber(data['maxRetries']) ?? asNumber(data['retry']) ?? 0,
      delayMs: asNumber(data['delayMs']) ?? 0,
      failure: failureOf(data['failure']),
    }
    const retryId = asString(data['retryId'])
    if (retryId !== undefined) this.retries.set(retryId, facts)
    const seq = this.assembler.seq.next()
    this.locate(seq)
    this.assembler.pushNode({
      kind: 'model-retry',
      seq,
      time: event.time,
      retryState: 'scheduled',
      turn: asNumber(data['turn']) ?? this.turn,
      step: asNumber(data['step']) ?? this.step,
      ...facts,
    })
    if (this.openRequest !== null) {
      this.openRequest = {
        ...this.openRequest,
        retry: facts.retry,
        maxRetries: facts.maxRetries,
        retryDelayMs: facts.delayMs,
      }
      this.assembler.upsertRequest(this.openRequest)
    }
  }

  private onRetryStarted(event: DshEvent): void {
    const data = event.data
    const retryId = asString(data['retryId'])
    const armed = retryId === undefined ? undefined : this.retries.get(retryId)
    const facts = armed ?? {
      provider: asString(data['provider']) ?? '',
      retry: asNumber(data['retry']) ?? 0,
      maxRetries: asNumber(data['retry']) ?? 0,
      delayMs: 0,
      failure: failureOf(undefined),
    }
    const seq = this.assembler.seq.next()
    this.locate(seq)
    this.assembler.pushNode({
      kind: 'model-retry',
      seq,
      time: event.time,
      retryState: 'started',
      turn: asNumber(data['turn']) ?? this.turn,
      step: asNumber(data['step']) ?? this.step,
      ...facts,
    })
  }

  private onCommandRun(event: DshEvent): void {
    const data = event.data
    const commandId = asString(data['commandId'])
    if (commandId === undefined) return
    const seq = this.assembler.seq.next()
    this.locate(seq)
    this.commandSeqs.set(commandId, seq)
    this.assembler.pushNode({
      kind: 'command',
      seq,
      time: event.time,
      commandId,
      name: asString(data['name']) ?? null,
      args: data['args'] === undefined || data['args'] === null ? null : stringifyArgs(data['args']),
      outcome: null,
    })
  }

  private onCommandDone(event: DshEvent): void {
    const data = event.data
    const commandId = asString(data['commandId'])
    if (commandId === undefined) return
    const seq = this.commandSeqs.get(commandId)
    if (seq === undefined) return
    const node = this.assembler.nodes.find(entry => entry.seq === seq)
    if (node === undefined || node.kind !== 'command') return
    const text = asString(data['text'])
    const sourceEventSeq = asNumber(data['sourceEventSeq'])
    const next: CommandNode = {
      ...node,
      outcome: {
        kind: data['kind'] === 'error' ? 'error' : 'success',
        ...(text === undefined ? {} : { text }),
        ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }),
      },
    }
    this.assembler.replaceNode(seq, next)
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  private imageAttachment(raw: unknown): ImageAttachmentRef | undefined {
    const record = isRecord(raw) ? raw : undefined
    const attachmentId = asString(record?.['attachmentId'])
    if (record === undefined || attachmentId === undefined) return undefined
    const mediaType = normalizeImageMediaType(record['mediaType'])
    this.images.add(attachmentId, mediaType)
    const name = asString(record['name'])
    return {
      attachmentId,
      mediaType,
      bytes: asNumber(record['bytes']) ?? 0,
      width: asNumber(record['width']) ?? 0,
      height: asNumber(record['height']) ?? 0,
      ...(name === undefined ? {} : { name }),
    }
  }

  private contentBlocks(raw: unknown): ContentBlock[] {
    if (typeof raw === 'string') return raw === '' ? [] : [{ type: 'text', text: raw }]
    const blocks: ContentBlock[] = []
    for (const item of asArray(raw) ?? []) {
      if (!isRecord(item)) continue
      switch (item['type']) {
        case 'text':
          blocks.push({ type: 'text', text: asString(item['text']) ?? '' })
          break
        case 'reasoning':
          blocks.push({ type: 'reasoning', text: asString(item['text']) ?? '' })
          break
        case 'image': {
          const attachment = this.imageAttachment(item['attachment'])
          if (attachment !== undefined) blocks.push({ type: 'image', attachment })
          break
        }
        case 'file': {
          const attachment = isRecord(item['attachment']) ? item['attachment'] : undefined
          const attachmentId = asString(attachment?.['attachmentId'])
          if (attachmentId === undefined) break
          blocks.push({
            type: 'file',
            attachment: {
              attachmentId,
              name: asString(attachment?.['name']) ?? '',
              bytes: asNumber(attachment?.['bytes']) ?? 0,
            },
          })
          break
        }
        case 'tool-call': {
          const id = asString(item['id'])
          if (id === undefined) break
          blocks.push({
            type: 'tool-call',
            id,
            name: asString(item['name']) ?? 'tool',
            arguments: stringifyArgs(item['arguments']),
          })
          break
        }
        case 'tool-result': {
          const toolCallId = asString(item['toolCallId'])
          if (toolCallId === undefined) break
          blocks.push({
            type: 'tool-result',
            toolCallId,
            content: this.contentBlocks(item['content']),
            ...(item['isError'] === undefined ? {} : { isError: item['isError'] === true }),
          })
          break
        }
        default:
          break
      }
    }
    return blocks
  }

  // -------------------------------------------------------------------------
  // Children
  // -------------------------------------------------------------------------

  /**
   * A child stream contributes counters and status to its parent's run; its
   * own messages stay in the child's standalone view. The run binds directly:
   * a dsh child session id IS its file id.
   */
  private handleChild(file: SessionFileRef, record: DshRecord): void {
    const agentId = file.agent?.agentId ?? file.id
    const run = this.runFor(agentId)
    run.fileId = file.id
    run.description ??= file.agent?.description ?? null
    run.agentType ??= file.agent?.agentType ?? null
    run.model ??= file.agent?.model ?? null
    run.callId ??= file.agent?.toolUseId ?? null
    const time = record.tag === 'event'
      ? record.event.time
      : record.tag === 'run' ? record.run.time0 : record.header.createdAt ?? 0
    run.lastTime = run.lastTime === null ? time : Math.max(run.lastTime, time)
    if (run.status === 'launching') run.status = 'running'
    if (record.tag !== 'event') return
    const event = record.event
    const data = event.data
    switch (event.type) {
      case 'subagent/descriptor':
        run.description ??= asString(data['label']) ?? run.description
        run.model ??= asString(data['agentModel']) ?? run.model
        return
      case 'tool/call': {
        const callId = asString(data['callId'])
        if (callId !== undefined && !this.childCalls.has(callId)) {
          this.childCalls.add(callId)
          run.toolCalls += 1
        }
        return
      }
      case 'turn/start':
        // A continuable subagent's own new turn is the only thing that
        // reopens a finished run — never the parent's late binding result.
        run.status = 'running'
        run.endedAt = null
        return
      case 'turn/end': {
        const reason = isRecord(data['reason']) ? data['reason'] : undefined
        const kind = asString(reason?.['kind'])
        run.status = kind === 'completed' ? 'completed' : kind === 'error' ? 'failed' : 'stopped'
        run.endedAt = event.time
        return
      }
      default:
        return
    }
  }

  private runFor(key: string): AgentRun {
    const existing = this.runs.get(key)
    if (existing !== undefined) return existing
    const run: AgentRun = {
      agentId: key,
      fileId: null,
      callId: null,
      description: null,
      agentType: null,
      model: null,
      status: 'launching',
      startedAt: null,
      endedAt: null,
      lastTime: null,
      toolCalls: 0,
    }
    this.runs.set(key, run)
    return run
  }
}

/** Create an incremental parser for DeepSeek Harness session logs. */
export function createDshParser(): SessionParser {
  return new DshParser()
}
