/**
 * OpenCode adapter: folds the virtual line stream the server's OpencodeSource
 * materializes out of `opencode.db` into the trajectory contract.
 *
 * Verified against opencode 1.18.31 (`packages/schema/src/v1/session.ts`,
 * `packages/core/src/session/sql.ts`) and a 1.18.x local store
 * (`~/.local/share/opencode/opencode.db`). The store is one SQLite database
 * (WAL); the source emits the V1 `message`/`part` projection — the V2 tables
 * (`session_message`, `session_v2`, `session_input`) are ignored.
 *
 * Traps:
 *  - Every wire `time` is epoch MILLISECONDS (row `time_created`/
 *    `time_updated`; message/part data `time.{created,completed,start,end}`).
 *  - `tokens` buckets are DISJOINT: `input` excludes cache read/write, and
 *    `output` excludes `reasoning` — unlike pi, where reasoning ⊂ output.
 *    `opencodeUsage` re-folds them into the contract's buckets.
 *  - A user message's `summary.diffs` blob (~500 KB of session diffs) is
 *    stripped by the source before the line is emitted.
 *  - Prune mutates completed tool parts in place (`state.time.compacted`):
 *    the output left the model context but the row stays; the source reports
 *    it on an `opencode.prune` sidecar.
 *  - Compaction is a user message carrying a `compaction` part, then an
 *    assistant message with `summary: true` whose text is the summary; an
 *    unfinished or errored summary compacts nothing.
 *  - Human vs injected input is structural (`opencodeUserClass`): synthetic
 *    text parts, `compaction` parts, file/agent/subtask parts — never text
 *    matching.
 *  - A `tool` part's `state.metadata.sessionId` binds a subagent child
 *    session (spawned by `task` or plugin tools); `metadata.background`
 *    means the result only acknowledges the launch.
 */

import type {
  AssistantBlock, AssistantMessageNode, AssistantProvenanceView, AssistantRequestConfig,
  CompactionRequestView, ContentBlock, ContextMessageNode, ConversationLocation, ImageAttachmentRef,
  ModelRetryNode, TokenUsage, TrajectorySnapshot,
} from '../contract.ts'
import { asArray, asNumber, asString, isRecord, parseJsonLine } from '../jsonl.ts'
import type {
  ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun, SubagentStatus,
} from '../session.ts'
import { DataUrlImageStore, TrajectoryAssembler, titleFrom } from './shared.ts'

/** One child session ref carried by the session sidecar. */
export interface OpencodeChildRef {
  readonly id: string
  readonly title: string | null
  readonly agent: string | null
  readonly parentID: string | null
}

/**
 * One parsed line of an opencode stream. `time` is epoch ms. `msg`/`part` are
 * the V1 `data` JSON minus `id`/`sessionID`/`messageID` (those ride the
 * envelope).
 */
export type OpencodeRecord =
  | {
    readonly tag: 'session'
    readonly time: number | null
    readonly session: Record<string, unknown>
    readonly children: readonly OpencodeChildRef[]
  }
  | {
    readonly tag: 'message'
    readonly time: number | null
    readonly id: string
    readonly msg: Record<string, unknown>
    /** Authored parts; populated only for `role: 'user'` headers. */
    readonly parts: readonly Record<string, unknown>[]
  }
  | {
    readonly tag: 'part'
    readonly time: number | null
    readonly id: string
    readonly messageID: string
    readonly part: Record<string, unknown>
  }
  | {
    readonly tag: 'finish'
    readonly time: number | null
    readonly id: string
    readonly msg: Record<string, unknown>
  }
  | {
    readonly tag: 'prune'
    readonly time: number | null
    readonly id: string
    readonly messageID: string
    readonly callID: string | null
  }

/**
 * How a `role: 'user'` message reached the context: authored input, the
 * compaction trigger (a `compaction` part), or an all-synthetic injection
 * (compaction-continue, background results, plan reminders). Shared by the
 * adapter, the context synthesizer, the meta scanner and the search
 * extractor, so the four never disagree.
 */
export type OpencodeUserClass =
  | { readonly kind: 'human' }
  | { readonly kind: 'compaction' }
  | { readonly kind: 'injection'; readonly name: string }

/** Classify one user message by the structure of its parts. */
export function opencodeUserClass(
  msg: Record<string, unknown>,
  parts: readonly Record<string, unknown>[],
): OpencodeUserClass {
  let authored = false
  for (const part of parts) {
    const type = asString(part['type'])
    if (type === 'compaction') return { kind: 'compaction' }
    if ((type === 'text' && part['synthetic'] !== true)
      || type === 'file' || type === 'agent' || type === 'subtask') {
      authored = true
    }
  }
  if (authored) return { kind: 'human' }
  return { kind: 'injection', name: isCompactionContinue(msg, parts) ? 'compaction-continue' : 'synthetic' }
}

/** `metadata.compaction_continue` marks the synthetic resume after a summary. */
function isCompactionContinue(msg: Record<string, unknown>, parts: readonly Record<string, unknown>[]): boolean {
  const msgMeta = isRecord(msg['metadata']) ? msg['metadata'] : undefined
  if (msgMeta?.['compaction_continue'] === true) return true
  return parts.some(part => {
    const meta = isRecord(part['metadata']) ? part['metadata'] : undefined
    return meta?.['compaction_continue'] === true
  })
}

/**
 * `tokens` of an assistant message → the contract's token buckets. OpenCode's
 * `output` excludes reasoning, so `outputTokens` re-adds it (the contract
 * keeps reasoning a subset of output); `total` is the provider total when
 * known, else the sum of the disjoint buckets.
 */
export function opencodeUsage(tokens: unknown): TokenUsage | undefined {
  if (!isRecord(tokens)) return undefined
  const input = asNumber(tokens['input'])
  const output = asNumber(tokens['output'])
  const reasoning = asNumber(tokens['reasoning'])
  const cache = isRecord(tokens['cache']) ? tokens['cache'] : undefined
  const cacheRead = asNumber(cache?.['read'])
  const cacheWrite = asNumber(cache?.['write'])
  const total = asNumber(tokens['total'])
  if (input === undefined && output === undefined && reasoning === undefined
    && cacheRead === undefined && cacheWrite === undefined && total === undefined) {
    return undefined
  }
  return {
    inputTokens: input ?? 0,
    outputTokens: (output ?? 0) + (reasoning ?? 0),
    totalTokens: total ?? (input ?? 0) + (output ?? 0) + (reasoning ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** Non-synthetic text of a part list, joined by "\n". */
export function opencodeTextOf(parts: readonly Record<string, unknown>[]): string {
  return parts
    .flatMap(part => (asString(part['type']) === 'text' && part['synthetic'] !== true
      ? [asString(part['text']) ?? '']
      : []))
    .join('\n')
}

const SUBAGENT_SUFFIX = /\s*\(@[^()\n]+ subagent\)\s*$/

/** A child session's generated title minus its decorations. */
export function opencodeChildTitle(title: string): string {
  return title.replace(SUBAGENT_SUFFIX, '').replace(/^Background:\s*/, '')
}

/** Parse one line of an opencode stream; `null` for blank/malformed input. Never throws. */
export function parseOpencodeLine(line: string): OpencodeRecord | null {
  const raw = parseJsonLine(line)
  if (!isRecord(raw)) return null
  const time = asNumber(raw['time']) ?? null
  switch (asString(raw['t'])) {
    case 'opencode.session': {
      const session = isRecord(raw['session']) ? raw['session'] : undefined
      if (session === undefined) return null
      const children = (asArray(raw['children']) ?? []).flatMap(child => {
        if (!isRecord(child)) return []
        const id = asString(child['id'])
        if (id === undefined) return []
        const ref: OpencodeChildRef = {
          id,
          title: asString(child['title']) ?? null,
          agent: asString(child['agent']) ?? null,
          parentID: asString(child['parentID']) ?? null,
        }
        return [ref]
      })
      return { tag: 'session', time, session, children }
    }
    case 'opencode.message': {
      const id = asString(raw['id'])
      const msg = isRecord(raw['msg']) ? raw['msg'] : undefined
      if (id === undefined || msg === undefined) return null
      const parts = (asArray(raw['parts']) ?? []).filter(isRecord)
      return { tag: 'message', time, id, msg, parts }
    }
    case 'opencode.part': {
      const id = asString(raw['id'])
      const messageID = asString(raw['messageID'])
      const part = isRecord(raw['part']) ? raw['part'] : undefined
      if (id === undefined || messageID === undefined || part === undefined) return null
      return { tag: 'part', time, id, messageID, part }
    }
    case 'opencode.finish': {
      const id = asString(raw['id'])
      const msg = isRecord(raw['msg']) ? raw['msg'] : undefined
      if (id === undefined || msg === undefined) return null
      return { tag: 'finish', time, id, msg }
    }
    case 'opencode.prune': {
      const id = asString(raw['id'])
      const messageID = asString(raw['messageID'])
      if (id === undefined || messageID === undefined) return null
      return { tag: 'prune', time, id, messageID, callID: asString(raw['callID']) ?? null }
    }
    default:
      return null
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

/** The assistant message currently accumulating parts. */
interface OpenAssistant {
  readonly msgId: string
  /** Seq allocated at the header; the finish reuses it for the folded node. */
  readonly requestSeq: number
  readonly turn: number
  readonly step: number
  readonly startedAt: number
  /** `summary: true` — a compaction summary, folded into the compaction request. */
  readonly summary: boolean
  readonly provenance: AssistantProvenanceView | undefined
  readonly requestConfig: AssistantRequestConfig | undefined
  readonly blocks: AssistantBlock[]
  firstTokenTime: number | null
}

class OpencodeParser implements SessionParser {
  readonly kind = 'opencode' as const
  readonly images = new DataUrlImageStore()

  private readonly assembler = new TrajectoryAssembler()
  private readonly turnSeqs = new Map<number, number[]>()
  private readonly closedTurns = new Set<number>()
  private turn = 0
  private step = 0
  private turnOpen = false
  private lastTime = 0
  private open: OpenAssistant | null = null
  /** startSeq of the compaction request armed by a compaction user message. */
  private compactionSeq: number | null = null
  private readonly runs = new Map<string, AgentRun>()
  private readonly runByCall = new Map<string, AgentRun>()
  /** child session id → its stream file id (itself; children are sessions). */
  private readonly agentFiles = new Map<string, string>()
  private readonly childCalls = new Set<string>()
  /** User message ids seen — a late part riding one is a user part, not an assistant block. */
  private readonly userIds = new Set<string>()

  private aiTitle: string | null = null
  private firstPrompt: string | null = null
  private cwd: string | null = null
  private model: string | null = null
  private startedAt: number | null = null
  private promptCount = 0

  push(line: string, file: SessionFileRef, lineIndex?: number): void {
    this.assembler.beginLine(file.id, lineIndex)
    const record = parseOpencodeLine(line)
    if (record === null) return
    const time = record.time ?? this.lastTime
    if (time > this.lastTime) this.lastTime = time
    if (this.startedAt === null && record.time !== null) this.startedAt = record.time
    if (file.role === 'child') {
      this.handleChild(file, record, time)
      return
    }
    switch (record.tag) {
      case 'session':
        this.handleSession(record)
        return
      case 'message':
        this.handleMessage(record, time)
        return
      case 'part':
        this.handlePart(record, time)
        return
      case 'finish':
        this.handleFinish(record, time)
        return
      case 'prune':
        // The part's output left the model context; the folded call stays —
        // the context layer rewrites the surface, not the trajectory.
        return
    }
  }

  snapshot(): TrajectorySnapshot {
    return this.assembler.snapshot()
  }

  meta(): ParsedSessionMeta {
    return {
      title: this.aiTitle ?? this.firstPrompt,
      cwd: this.cwd,
      model: this.model,
      startedAt: this.startedAt,
      promptCount: this.promptCount,
    }
  }

  subagents(): readonly SubagentRun[] {
    return [...this.runs.values()].map(run => ({
      agentId: run.agentId,
      fileId: run.fileId,
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

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  private handleSession(record: Extract<OpencodeRecord, { tag: 'session' }>): void {
    const session = record.session
    const title = asString(session['title'])
    if (title !== undefined && title !== '') this.aiTitle = title
    this.cwd ??= asString(session['directory']) ?? null
    const model = isRecord(session['model']) ? session['model'] : undefined
    this.model ??= asString(model?.['id']) ?? asString(model?.['modelID']) ?? null
    if (record.time !== null) this.startedAt ??= record.time
    for (const child of record.children) {
      this.agentFiles.set(child.id, child.id)
      const run = this.runs.get(child.id)
      if (run !== undefined) run.fileId = child.id
    }
    this.assembler.touch()
  }

  private handleMessage(record: Extract<OpencodeRecord, { tag: 'message' }>, time: number): void {
    switch (asString(record.msg['role'])) {
      case 'assistant':
        this.handleAssistantHeader(record.id, record.msg, time)
        return
      case 'user':
        this.userIds.add(record.id)
        this.handleUserMessage(record.msg, record.parts, time)
        return
      default:
        return
    }
  }

  private handleUserMessage(msg: Record<string, unknown>, parts: readonly Record<string, unknown>[], time: number): void {
    const classified = opencodeUserClass(msg, parts)
    if (classified.kind === 'compaction') {
      const seq = this.assembler.seq.next()
      const request: CompactionRequestView = {
        purpose: 'compaction',
        startSeq: seq,
        startedAt: time,
        completedAt: null,
        status: 'running',
        turn: this.turn > 0 ? this.turn : null,
        step: 0,
      }
      this.assembler.upsertRequest(request)
      this.compactionSeq = seq
      return
    }
    if (classified.kind === 'injection') {
      const content = this.userContent(parts, true)
      if (content.length === 0) return
      const seq = this.assembler.seq.next()
      this.locate(seq, this.turn)
      this.assembler.pushNode({
        kind: 'context',
        seq,
        time,
        content,
        source: msg,
        provenance: { role: 'inject', label: classified.name },
        form: 'notice',
      })
      return
    }
    if (this.turnOpen) this.closeTurn()
    this.turn += 1
    this.step = 0
    this.turnOpen = true
    this.promptCount += 1
    const text = opencodeTextOf(parts)
    if (this.firstPrompt === null && text.trim() !== '') this.firstPrompt = titleFrom(text)
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'user',
      seq,
      time,
      content: this.userContent(parts, false),
      source: msg,
    })
    // Appended reminders and notices inside a human prompt are injected
    // context; each synthetic text part folds into its own node.
    for (const part of parts) {
      if (asString(part['type']) !== 'text' || part['synthetic'] !== true) continue
      const partText = asString(part['text'])
      if (partText === undefined) continue
      const meta = isRecord(part['metadata']) ? part['metadata'] : undefined
      const ctx: ContextMessageNode = {
        kind: 'context',
        seq: this.assembler.seq.next(),
        time,
        content: [{ type: 'text', text: partText }],
        source: msg,
        provenance: {
          role: 'inject',
          label: meta?.['compaction_continue'] === true ? 'compaction-continue' : 'synthetic',
        },
        form: 'notice',
      }
      this.locate(ctx.seq, this.turn)
      this.assembler.pushNode(ctx)
    }
  }

  /** Authored content blocks: text plus files (images inline, others as refs). */
  private userContent(parts: readonly Record<string, unknown>[], syntheticToo: boolean): ContentBlock[] {
    const content: ContentBlock[] = []
    for (const part of parts) {
      switch (asString(part['type'])) {
        case 'text': {
          if (!syntheticToo && part['synthetic'] === true) break
          content.push({ type: 'text', text: asString(part['text']) ?? '' })
          break
        }
        case 'file': {
          const mime = asString(part['mime'])
          const url = asString(part['url'])
          const name = asString(part['filename']) ?? url
          const image = mime !== undefined && mime.startsWith('image/') && url !== undefined
            ? this.images.addImageUrl(url, asString(part['filename']))
            : undefined
          if (image !== undefined) content.push({ type: 'image', attachment: image })
          else {
            content.push({
              type: 'file',
              attachment: {
                attachmentId: asString(part['id']) ?? `file-${content.length}`,
                name: name ?? 'file',
                bytes: 0,
              },
            })
          }
          break
        }
        default:
          break
      }
    }
    return content
  }

  // -------------------------------------------------------------------------
  // Assistant lifecycle
  // -------------------------------------------------------------------------

  private handleAssistantHeader(id: string, msg: Record<string, unknown>, time: number): OpenAssistant {
    // A header while another message is still open means that one never
    // finished: settle its request as incomplete and start over.
    this.flushOpen(time)
    if (this.turn === 0) this.turn = 1
    const created = msgTime(msg, 'created') ?? time
    if (msg['summary'] === true) {
      this.open = {
        msgId: id, requestSeq: this.compactionSeq ?? this.assembler.seq.next(),
        turn: this.turn, step: this.step, startedAt: created,
        summary: true, provenance: undefined, requestConfig: undefined,
        blocks: [], firstTokenTime: null,
      }
      return this.open
    }
    this.step += 1
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    const provider = asString(msg['providerID'])
    const model = asString(msg['modelID'])
    if (model !== undefined) this.model ??= model
    const provenance = provider !== undefined && model !== undefined ? { provider, model } : undefined
    const variant = asString(msg['variant'])
    const requestConfig = provider !== undefined || model !== undefined
      ? {
        provider: provider ?? '',
        model: model ?? '',
        ...(variant === undefined ? {} : { thinking: variant }),
      }
      : undefined
    this.assembler.upsertRequest({
      purpose: 'assistant',
      startSeq: seq,
      startedAt: created,
      completedAt: null,
      status: 'running',
      turn: this.turn,
      step: this.step,
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
    })
    this.open = {
      msgId: id, requestSeq: seq, turn: this.turn, step: this.step, startedAt: created,
      summary: false, provenance, requestConfig, blocks: [], firstTokenTime: null,
    }
    this.assembler.partial = { turn: this.turn, step: this.step, blocks: this.open.blocks }
    this.assembler.touch()
    return this.open
  }

  private ensureOpen(messageID: string, time: number, msg?: Record<string, unknown>): OpenAssistant {
    if (this.open !== null && this.open.msgId === messageID) return this.open
    // A part/finish for a message whose header never arrived (or was flushed):
    // fold it under its own step rather than dropping the content.
    return this.handleAssistantHeader(messageID, msg ?? {}, time)
  }

  /** Settle the open message's request as incomplete; used by the next header. */
  private flushOpen(time: number): void {
    const open = this.open
    if (open === null) return
    this.open = null
    this.assembler.partial = null
    if (open.summary) {
      if (this.compactionSeq !== null) {
        this.assembler.upsertRequest({
          purpose: 'compaction', startSeq: this.compactionSeq, startedAt: open.startedAt,
          completedAt: time, status: 'error', error: 'incomplete',
          turn: this.turn > 0 ? this.turn : null, step: 0,
        })
        this.compactionSeq = null
      }
    } else {
      this.assembler.upsertRequest({
        purpose: 'assistant', startSeq: open.requestSeq, startedAt: open.startedAt,
        completedAt: time, status: 'error', error: 'incomplete',
        turn: open.turn, step: open.step,
        ...(open.provenance === undefined ? {} : { provenance: open.provenance }),
        ...(open.requestConfig === undefined ? {} : { requestConfig: open.requestConfig }),
      })
    }
    this.assembler.touch()
  }

  private handlePart(record: Extract<OpencodeRecord, { tag: 'part' }>, time: number): void {
    // A part addressed to a known USER message is a late user part (the
    // emission plan's anomaly append) — never an assistant block.
    if (this.userIds.has(record.messageID)) return
    const part = record.part
    const open = this.ensureOpen(record.messageID, time)
    const partTime = isRecord(part['time']) ? part['time'] : undefined
    const start = asNumber(partTime?.['start'])
    if (start !== undefined && (open.firstTokenTime === null || start < open.firstTokenTime)) {
      open.firstTokenTime = start
    }
    switch (asString(part['type'])) {
      case 'text':
        open.blocks.push({ kind: 'text', text: asString(part['text']) ?? '' })
        break
      case 'reasoning':
        open.blocks.push({ kind: 'reasoning', text: asString(part['text']) ?? '' })
        break
      case 'tool':
        this.handleToolPart(part, open, time)
        break
      case 'retry':
        this.handleRetryPart(part, open, time)
        break
      case 'step-start':
      case 'step-finish':
      case 'snapshot':
      case 'patch':
      case 'file':
      case 'agent':
      case 'subtask':
      case 'compaction':
        // Bookkeeping parts: the finish line is authoritative for usage and
        // timing; these carry nothing the trajectory shows.
        break
      default:
        open.blocks.push({ kind: 'other', block: part })
        break
    }
    if (!open.summary) this.assembler.partial = { turn: open.turn, step: open.step, blocks: open.blocks }
    this.assembler.touch()
  }

  private handleToolPart(part: Record<string, unknown>, open: OpenAssistant, time: number): void {
    const callID = asString(part['callID'])
    const name = asString(part['tool']) ?? 'tool'
    const state = isRecord(part['state']) ? part['state'] : undefined
    if (callID === undefined) {
      open.blocks.push({ kind: 'other', block: part })
      return
    }
    const stateTime = isRecord(state?.['time']) ? state['time'] : undefined
    const startedAt = asNumber(stateTime?.['start']) ?? time
    const endedAt = asNumber(stateTime?.['end'])
    if (open.firstTokenTime === null || startedAt < open.firstTokenTime) open.firstTokenTime = startedAt
    const argsRaw = stringifyArgs(state?.['input'])
    open.blocks.push({ kind: 'tool-call', callId: callID, name, argsRaw })
    this.assembler.tools.start({
      callId: callID, name, argsRaw, turn: open.turn, step: open.step, time: startedAt, subCalls: [],
    })
    const status = asString(state?.['status'])
    if (status === 'completed' || status === 'error') {
      this.completeTool(callID, state, status === 'error', startedAt, endedAt ?? time, open.turn)
    }
    this.bindSpawn(callID, state, startedAt, endedAt ?? time)
  }

  /** Fold a settled tool part into its result node (content + meta). */
  private completeTool(
    callID: string,
    state: Record<string, unknown> | undefined,
    isError: boolean,
    startedAt: number,
    endedAt: number,
    turn: number,
  ): void {
    const content: ContentBlock[] = []
    if (isError) {
      const error = asString(state?.['error'])
      if (error !== undefined && error !== '') content.push({ type: 'text', text: error })
    } else {
      const output = asString(state?.['output'])
      if (output !== undefined && output !== '') content.push({ type: 'text', text: output })
      for (const attachment of asArray(state?.['attachments']) ?? []) {
        if (!isRecord(attachment)) continue
        const mime = asString(attachment['mime'])
        const url = asString(attachment['url'])
        if (mime === undefined || url === undefined || !mime.startsWith('image/')) continue
        const image = this.images.addImageUrl(url, asString(attachment['filename']))
        if (image !== undefined) content.push({ type: 'image', attachment: image })
      }
    }
    const title = asString(state?.['title'])
    const metadata = isRecord(state?.['metadata']) ? state['metadata'] : undefined
    const completed = this.assembler.tools.complete(callID, {
      seq: this.assembler.seq.next(),
      time: endedAt,
      content,
      isError,
      meta: {
        ...(title === undefined ? {} : { title }),
        ...(endedAt > startedAt ? { durationMs: endedAt - startedAt } : {}),
        ...(metadata === undefined ? {} : { metadata }),
      },
    })
    if (completed.topLevel) {
      this.locate(completed.node.seq, turn)
      this.assembler.pushNode(completed.node)
    } else {
      this.assembler.touch()
    }
  }

  /** A `state.metadata.sessionId` binds this call to a subagent child session. */
  private bindSpawn(
    callID: string,
    state: Record<string, unknown> | undefined,
    startedAt: number,
    endedAt: number,
  ): void {
    const metadata = isRecord(state?.['metadata']) ? state['metadata'] : undefined
    const childId = asString(metadata?.['sessionId'])
    if (childId === undefined) return
    const input = isRecord(state?.['input']) ? state['input'] : undefined
    const run = this.runFor(childId, startedAt)
    run.callId = callID
    run.description = asString(state?.['title']) ?? asString(input?.['description']) ?? run.description
    run.agentType = asString(input?.['subagent_type']) ?? run.agentType
    const model = metadata?.['model']
    run.model = (isRecord(model) ? asString(model['modelID']) : asString(model)) ?? run.model
    run.startedAt = startedAt
    const status = asString(state?.['status'])
    // A background result only acknowledges the launch; the child stream's
    // own finish settles the run.
    if (status === 'error') {
      run.status = 'failed'
      run.endedAt = endedAt
    } else if (metadata?.['background'] === true) {
      run.status = 'running'
    } else {
      run.status = 'completed'
      run.endedAt = endedAt
    }
    this.runByCall.set(callID, run)
  }

  private handleRetryPart(part: Record<string, unknown>, open: OpenAssistant, time: number): void {
    const error = isRecord(part['error']) ? part['error'] : undefined
    const data = isRecord(error?.['data']) ? error['data'] : undefined
    const seq = this.assembler.seq.next()
    this.locate(seq, open.turn)
    const node: ModelRetryNode = {
      kind: 'model-retry',
      seq,
      time,
      retryState: 'scheduled',
      turn: open.turn,
      step: open.step,
      provider: open.requestConfig?.provider ?? '',
      retry: asNumber(part['attempt']) ?? 1,
      maxRetries: 0,
      delayMs: 0,
      failure: {
        message: asString(data?.['message']) ?? asString(error?.['name']) ?? 'retry',
        code: asString(error?.['name']) ?? 'error',
      },
    }
    this.assembler.pushNode(node)
  }

  private handleFinish(record: Extract<OpencodeRecord, { tag: 'finish' }>, time: number): void {
    // Finishes are assistant-only; one addressed to a user message is noise.
    if (this.userIds.has(record.id)) return
    const msg = record.msg
    const open = this.ensureOpen(record.id, time, msg)
    this.open = null
    this.assembler.partial = null
    const usage = opencodeUsage(msg['tokens'])
    const completed = msgTime(msg, 'completed') ?? time
    const error = isRecord(msg['error']) ? msg['error'] : undefined
    const errorName = asString(error?.['name'])
    const errorData = isRecord(error?.['data']) ? error['data'] : undefined
    const errorMessage = asString(errorData?.['message']) ?? errorName
    if (open.summary || msg['summary'] === true) {
      this.completeCompaction(open, msg, usage, errorMessage, completed)
      return
    }
    const aborted = errorName === 'MessageAbortedError'
    const node: AssistantMessageNode = {
      kind: 'assistant',
      seq: open.requestSeq,
      messageId: record.id,
      time,
      turn: open.turn,
      step: open.step,
      blocks: open.blocks,
      ...(usage === undefined ? {} : { usage }),
      ...(open.provenance === undefined ? {} : { provenance: open.provenance }),
      ...(open.requestConfig === undefined ? {} : { requestConfig: open.requestConfig }),
      timing: {
        stepStartTime: msgTime(msg, 'created') ?? open.startedAt,
        firstTokenTime: open.firstTokenTime,
        completedTime: completed,
      },
      ...(aborted ? { interrupted: true as const } : {}),
    }
    this.assembler.pushNode(node)
    this.assembler.upsertRequest({
      purpose: 'assistant',
      startSeq: open.requestSeq,
      startedAt: open.startedAt,
      completedAt: completed,
      status: error === undefined ? 'complete' : 'error',
      turn: open.turn,
      step: open.step,
      resultSeq: node.seq,
      ...(errorMessage === undefined || error === undefined ? {} : { error: errorMessage }),
      ...(errorName === undefined || error === undefined ? {} : { errorCode: errorName }),
      ...(open.provenance === undefined ? {} : { provenance: open.provenance }),
      ...(open.requestConfig === undefined ? {} : { requestConfig: open.requestConfig }),
      ...(usage === undefined ? {} : { usage }),
    })
    if (error !== undefined && !aborted) {
      const errorSeq = this.assembler.seq.next()
      this.locate(errorSeq, open.turn)
      this.assembler.pushNode({
        kind: 'turn-error',
        seq: errorSeq,
        time,
        turn: open.turn,
        step: open.step,
        message: errorMessage ?? 'error',
        ...(errorName === undefined ? {} : { code: errorName }),
      })
    }
    if (asString(msg['finish']) === 'length') {
      const maxSeq = this.assembler.seq.next()
      this.locate(maxSeq, open.turn)
      this.assembler.pushNode({ kind: 'turn-max-tokens', seq: maxSeq, time, turn: open.turn, step: open.step })
    }
    // 'tool-calls' means the model is mid-loop; anything else (and any error)
    // closes the turn.
    if (asString(msg['finish']) !== 'tool-calls' || error !== undefined) {
      if (this.turnOpen && open.turn === this.turn) this.closeTurn()
    }
    this.assembler.touch()
  }

  /** A `summary: true` assistant message completes the armed compaction request. */
  private completeCompaction(
    open: OpenAssistant,
    msg: Record<string, unknown>,
    usage: TokenUsage | undefined,
    errorMessage: string | undefined,
    completed: number,
  ): void {
    const startSeq = this.compactionSeq ?? open.requestSeq
    this.compactionSeq = null
    const summary = open.blocks.flatMap(block => (block.kind === 'text' ? [block.text] : [])).join('\n')
    if (errorMessage !== undefined) {
      this.assembler.upsertRequest({
        purpose: 'compaction', startSeq, startedAt: open.startedAt,
        completedAt: completed, status: 'error', error: errorMessage,
        turn: open.turn > 0 ? open.turn : null, step: 0,
      })
      return
    }
    // The request seq doubles as the node's: the compaction record was opened
    // by the user line, so that line resolves to the summary it produced.
    const request: CompactionRequestView = {
      purpose: 'compaction',
      startSeq,
      startedAt: open.startedAt,
      completedAt: completed,
      status: 'complete',
      turn: open.turn > 0 ? open.turn : null,
      step: 0,
      resultSeq: startSeq,
      replacementSeq: startSeq,
      summary: summary === '' ? [] : [{ type: 'text', text: summary }],
      ...(usage === undefined ? {} : { usage }),
    }
    this.assembler.upsertRequest(request)
    this.locate(startSeq, open.turn)
    this.assembler.pushNode({
      kind: 'compaction',
      seq: startSeq,
      time: completed,
      summary: summary === '' ? null : summary,
      summaryEventSeq: startSeq,
      shadowedItemCount: null,
      shadowedTokenCount: null,
    })
  }

  // -------------------------------------------------------------------------
  // Child streams
  // -------------------------------------------------------------------------

  /**
   * A child stream contributes counters and tool calls nested under the bound
   * parent call; its messages stay in the child's own (standalone) view. The
   * run binds directly: an opencode child session id IS its stream id.
   */
  private handleChild(file: SessionFileRef, record: OpencodeRecord, time: number): void {
    const agentId = file.agent?.agentId ?? file.id
    const run = this.runFor(agentId, time)
    run.fileId = file.id
    run.description ??= file.agent?.description ?? null
    run.agentType ??= file.agent?.agentType ?? null
    run.model ??= file.agent?.model ?? null
    if (run.callId === null && file.agent?.toolUseId !== undefined) {
      run.callId = file.agent.toolUseId
      this.runByCall.set(file.agent.toolUseId, run)
    }
    run.lastTime = run.lastTime === null ? time : Math.max(run.lastTime, time)
    if (run.status === 'launching') run.status = 'running'
    if (record.tag === 'finish') {
      const error = isRecord(record.msg['error']) ? record.msg['error'] : undefined
      if (error !== undefined) {
        run.status = 'failed'
        run.endedAt = time
      } else if (asString(record.msg['finish']) !== 'tool-calls') {
        run.status = 'completed'
        run.endedAt = time
      }
      this.assembler.touch()
      return
    }
    if (record.tag !== 'part') return
    const part = record.part
    if (asString(part['type']) !== 'tool') return
    const callID = asString(part['callID'])
    if (callID === undefined || this.childCalls.has(callID)) return
    this.childCalls.add(callID)
    run.toolCalls += 1
    if (run.callId === null) return
    const state = isRecord(part['state']) ? part['state'] : undefined
    const stateTime = isRecord(state?.['time']) ? state['time'] : undefined
    const startedAt = asNumber(stateTime?.['start']) ?? time
    const endedAt = asNumber(stateTime?.['end']) ?? time
    const argsRaw = stringifyArgs(state?.['input'])
    this.assembler.tools.start({
      callId: callID,
      parentCallId: run.callId,
      name: asString(part['tool']) ?? 'tool',
      argsRaw,
      turn: Math.max(1, this.turn),
      step: this.step,
      time: startedAt,
      subCalls: [],
    })
    const status = asString(state?.['status'])
    if (status === 'completed' || status === 'error') {
      this.completeTool(callID, state, status === 'error', startedAt, endedAt, Math.max(1, this.turn))
    }
    this.assembler.touch()
  }

  private runFor(key: string, time: number): AgentRun {
    const existing = this.runs.get(key)
    if (existing !== undefined) return existing
    const run: AgentRun = {
      agentId: key,
      fileId: this.agentFiles.get(key) ?? key,
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
    this.runs.set(key, run)
    return run
  }

  // -------------------------------------------------------------------------
  // Turns
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

  private closeTurn(): void {
    this.turnOpen = false
    if (this.turn <= 0) return
    this.closedTurns.add(this.turn)
    const location = this.turnLocation(this.turn)
    for (const seq of this.turnSeqs.get(this.turn) ?? []) this.assembler.locations.set(seq, location)
    this.assembler.touch()
  }
}

function msgTime(msg: Record<string, unknown>, key: 'created' | 'completed'): number | undefined {
  const time = isRecord(msg['time']) ? msg['time'] : undefined
  return asNumber(time?.[key])
}

/** Create an incremental parser for OpenCode `opencode.db` streams. */
export function createOpencodeParser(): SessionParser {
  return new OpencodeParser()
}
