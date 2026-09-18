/** Building blocks shared by the harness adapters. */

import type {
  AssistantBlock, ContentBlock, ConversationLocation, ConversationNode, ImageAttachmentRef,
  ImageMediaType, PartialAssistant, RequestView, RunningToolCall, SourceLineIndex, SourceLineTarget,
  SystemPromptNode, ToolCallBlock, ToolResultNode, ToolSchema, TrajectorySnapshot,
} from '../contract.ts'
import type { ImageStore } from '../session.ts'

/** Monotonic event sequence shared by every record an adapter emits. */
export class SequenceCounter {
  private value = 0
  /** @param onNext - notified for every allocated seq, to bind it to its source line. */
  constructor(private readonly onNext?: (seq: number) => void) {}
  next(): number {
    this.value += 1
    this.onNext?.(this.value)
    return this.value
  }
  get current(): number {
    return this.value
  }
}

/**
 * How far `targetAt` walks back for the nearest preceding record. A run of
 * lines that folds into nothing is a handful long in every harness (grok's
 * stream deltas are the longest), so a wider gap than this is a line that does
 * not belong to the visible trajectory at all.
 */
const LINE_FALLBACK_WINDOW = 4096

interface FileLines {
  readonly targets: Map<number, SourceLineTarget>
  /** Highest line of this file the parser has been fed. */
  max: number
}

/**
 * Line bookkeeping for one fold, maintained by {@link TrajectoryAssembler}.
 *
 * Adapters do not talk to it: it listens to the three moments that already run
 * through the assembler — a seq is allocated, a node is pushed, a tool call
 * starts or completes — so a record is bound to the line that CREATED it even
 * when the node is emitted several lines later (Claude closes an assistant step
 * on the following record; Kimi flushes its loop events after the response).
 *
 * One line maps to at most one record: the first one it produced. A tool call
 * wins over a plain node on the same line, because `complete()` runs before the
 * result node is pushed.
 */
export class SourceLineTable implements SourceLineIndex {
  private readonly files = new Map<string, FileLines>()
  /** The first file fed, which is the main transcript of the view. */
  private primary: string | undefined
  private currentFile: string | undefined
  private currentLine = -1
  /** Line each allocated seq was created on. */
  private readonly seqOrigin = new Map<number, { file: string; line: number }>()
  /** Lines of calls still waiting for their result, by call id. */
  private readonly callLines = new Map<string, { file: string; line: number }[]>()

  /** Start folding one raw line; a negative index means "not a line of the file". */
  begin(fileId: string, line: number): void {
    this.currentFile = fileId
    this.currentLine = line
    if (line < 0) return
    this.primary ??= fileId
    const state = this.fileState(fileId)
    if (line > state.max) state.max = line
  }

  /** A seq was allocated while folding the current line. */
  noteSeq(seq: number): void {
    const file = this.currentFile
    if (file === undefined || this.currentLine < 0) return
    this.seqOrigin.set(seq, { file, line: this.currentLine })
  }

  /** A node was pushed: its line is the one its seq was allocated on. */
  noteNode(seq: number): void {
    const origin = this.seqOrigin.get(seq)
    if (origin === undefined) return
    this.claim(origin.file, origin.line, { kind: 'seq', seq })
  }

  /** A tool call was emitted on the current line; it resolves when the result lands. */
  noteCallStart(callId: string): void {
    const file = this.currentFile
    if (file === undefined || this.currentLine < 0) return
    const lines = this.callLines.get(callId) ?? []
    lines.push({ file, line: this.currentLine })
    this.callLines.set(callId, lines)
  }

  /** The result landed on the current line: both it and the call's lines name the call. */
  noteCallComplete(callId: string): void {
    const target: SourceLineTarget = { kind: 'call', callId }
    for (const origin of this.callLines.get(callId) ?? []) this.claim(origin.file, origin.line, target)
    this.callLines.delete(callId)
    if (this.currentFile !== undefined && this.currentLine >= 0) {
      this.claim(this.currentFile, this.currentLine, target)
    }
  }

  targetAt(line: number, fileId?: string): SourceLineTarget | undefined {
    const key = fileId ?? this.primary
    if (key === undefined || line < 0) return undefined
    const state = this.files.get(key)
    // Past the fold: the caller keeps waiting instead of landing on the tail.
    if (state === undefined || line > state.max) return undefined
    const exact = state.targets.get(line)
    if (exact !== undefined) return exact
    const floor = Math.max(0, line - LINE_FALLBACK_WINDOW)
    for (let at = line - 1; at >= floor; at -= 1) {
      const target = state.targets.get(at)
      if (target !== undefined) return target
    }
    return undefined
  }

  private claim(file: string, line: number, target: SourceLineTarget): void {
    const state = this.fileState(file)
    if (!state.targets.has(line)) state.targets.set(line, target)
  }

  private fileState(fileId: string): FileLines {
    let state = this.files.get(fileId)
    if (state === undefined) {
      state = { targets: new Map(), max: -1 }
      this.files.set(fileId, state)
    }
    return state
  }
}

/** In-memory image store keyed by attachment id, holding data URLs. */
export class DataUrlImageStore implements ImageStore {
  private readonly urls = new Map<string, string>()
  private counter = 0

  /** Store base64 bytes and return a reference the UI can resolve later. */
  add(base64: string, mediaType: ImageMediaType, name?: string): ImageAttachmentRef {
    this.counter += 1
    const attachmentId = `img-${this.counter}`
    this.urls.set(attachmentId, `data:${mediaType};base64,${base64}`)
    const bytes = Math.floor(base64.length * 3 / 4)
    return { attachmentId, mediaType, bytes, width: 0, height: 0, ...(name === undefined ? {} : { name }) }
  }

  get(attachmentId: string): string | undefined {
    return this.urls.get(attachmentId)
  }

  keys(): IterableIterator<string> {
    return this.urls.keys()
  }

  /**
   * Store an image from the URL a transcript gives it: a `data:` URL (bytes
   * inline) or a `blobref:<mime>;<hash>` (bytes in the agent's blob store,
   * which the client resolves through the server). Unknown shapes yield no
   * attachment.
   */
  addImageUrl(url: string, name?: string, fileId?: string): ImageAttachmentRef | undefined {
    const inline = /^data:([^;,]+);base64,(.*)$/s.exec(url)
    if (inline !== null) return this.add(inline[2] ?? '', normalizeImageMediaType(inline[1]), name)
    if (/^blobref:[^;,]+;[0-9a-f]{16,64}$/.test(url)) {
      const mediaType = normalizeImageMediaType(url.slice('blobref:'.length, url.indexOf(';')))
      this.counter += 1
      const attachmentId = `img-${this.counter}`
      this.urls.set(attachmentId, url)
      return {
        attachmentId, mediaType, bytes: 0, width: 0, height: 0,
        ...(name === undefined ? {} : { name }),
        ...(fileId === undefined ? {} : { fileId }),
      }
    }
    return undefined
  }
}

export function normalizeImageMediaType(value: unknown): ImageMediaType {
  switch (value) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'image/jpeg'
    case 'image/webp':
      return 'image/webp'
    case 'image/gif':
      return 'image/gif'
    default:
      return 'image/png'
  }
}

/** Concatenate the text of every text block. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
}

export function assistantText(blocks: readonly AssistantBlock[]): string {
  return blocks.flatMap(block => (block.kind === 'text' ? [block.text] : [])).join('\n')
}

interface PendingCall {
  readonly call: RunningToolCall
}

/**
 * Tracks tool calls from emission to result and maintains nesting: a call with
 * a parent attaches to the parent's `subCalls`; a top-level call surfaces in
 * `runningCalls` until its result node is emitted.
 */
export class ToolCallTracker {
  private readonly pending = new Map<string, PendingCall>()
  /** Ids of still-pending calls in start order (a Set keeps insertion order). */
  private readonly pendingOrder = new Set<string>()
  private readonly children = new Map<string, ToolCallBlock[]>()
  private readonly parentOf = new Map<string, string>()
  private readonly completed = new Map<string, ToolResultNode>()

  /** Parents with at least one child still running: their nested view must be recomputed per snapshot. */
  private readonly pendingChildren = new Map<string, number>()

  /** @param lines - line bookkeeping, notified when a call starts and when it completes. */
  constructor(private readonly lines?: SourceLineTable) {}

  /** Register an emitted call. */
  start(call: RunningToolCall): void {
    this.lines?.noteCallStart(call.callId)
    this.pending.set(call.callId, { call })
    this.pendingOrder.add(call.callId)
    if (call.parentCallId !== undefined && call.parentCallId !== call.callId) {
      this.parentOf.set(call.callId, call.parentCallId)
      this.pendingChildren.set(call.parentCallId, (this.pendingChildren.get(call.parentCallId) ?? 0) + 1)
    }
  }

  has(callId: string): boolean {
    return this.pending.has(callId) || this.completed.has(callId)
  }

  pendingCall(callId: string): RunningToolCall | undefined {
    return this.pending.get(callId)?.call
  }

  /** Whether the call is still awaiting its result. */
  isPending(callId: string): boolean {
    return this.pending.has(callId)
  }

  /** The parent call id registered for a call, if any. */
  parentIdOf(callId: string): string | undefined {
    return this.parentOf.get(callId)
  }

  /**
   * Complete a call. Returns the result node; the caller pushes it to the
   * node list only when `topLevel` is true (nested results live inside the
   * parent's `subCalls`).
   */
  complete(
    callId: string,
    result: {
      seq: number
      time: number
      content: readonly ContentBlock[]
      isError: boolean
      error?: { name: string; code: string }
      meta?: unknown
    },
  ): { node: ToolResultNode; topLevel: boolean } {
    this.lines?.noteCallComplete(callId)
    const pending = this.pending.get(callId)
    const call = pending?.call
    this.pending.delete(callId)
    this.pendingOrder.delete(callId)
    const parentCallId = call?.parentCallId ?? this.parentOf.get(callId)
    if (pending !== undefined && parentCallId !== undefined) {
      const remaining = (this.pendingChildren.get(parentCallId) ?? 1) - 1
      if (remaining <= 0) this.pendingChildren.delete(parentCallId)
      else this.pendingChildren.set(parentCallId, remaining)
    }
    const node: ToolResultNode = {
      kind: 'tool-result',
      seq: result.seq,
      time: result.time,
      callId,
      ...(parentCallId === undefined ? {} : { parentCallId }),
      call: call === undefined ? null : { name: call.name, argsRaw: call.argsRaw },
      callTime: call?.time ?? null,
      content: result.content,
      isError: result.isError,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.meta === undefined ? {} : { meta: result.meta }),
      subCalls: this.subCallsOf(callId),
    }
    this.completed.set(callId, node)
    if (parentCallId !== undefined) {
      const siblings = this.children.get(parentCallId) ?? []
      this.children.set(parentCallId, [...siblings.filter(block => block.callId !== callId), node])
      // A completed ancestor keeps a stale subCalls array; refresh it.
      this.refreshCompletedAncestors(parentCallId)
      return { node, topLevel: false }
    }
    return { node, topLevel: true }
  }

  /**
   * Flip a COMPLETED call's node to `isError` — a late terminal-status record
   * (codex `item_completed`) arrived after the output folded. Returns false
   * while the call is still pending or unknown.
   */
  markError(callId: string): boolean {
    const done = this.completed.get(callId)
    if (done === undefined || done.isError) return false
    const next = { ...done, isError: true }
    this.completed.set(callId, next)
    const parentCallId = this.parentOf.get(callId)
    if (parentCallId !== undefined) {
      const siblings = this.children.get(parentCallId) ?? []
      this.children.set(parentCallId, siblings.map(block => (block.callId === callId ? next : block)))
      // A completed ancestor keeps a stale subCalls array; refresh it.
      this.refreshCompletedAncestors(parentCallId)
    }
    return true
  }

  private refreshCompletedAncestors(callId: string): void {
    const visited = new Set<string>()
    let current: string | undefined = callId
    while (current !== undefined && !visited.has(current)) {
      visited.add(current)
      const done = this.completed.get(current)
      if (done !== undefined) {
        this.completed.set(current, { ...done, subCalls: this.subCallsOf(current) })
      }
      current = this.parentOf.get(current)
    }
  }

  /**
   * Latest version of a completed node (subCalls may have grown since
   * emission). While a nested call is still running under it, the view is
   * recomputed so an in-flight subagent tool shows before its result lands.
   */
  completedNode(callId: string): ToolResultNode | undefined {
    const done = this.completed.get(callId)
    if (done === undefined || !this.pendingChildren.has(callId)) return done
    return { ...done, subCalls: this.subCallsOf(callId) }
  }

  private subCallsOf(callId: string): readonly ToolCallBlock[] {
    const done = this.children.get(callId) ?? []
    const running: ToolCallBlock[] = []
    for (const id of this.pendingOrder) {
      if (this.parentOf.get(id) === callId) running.push(this.runningView(id))
    }
    return [...done, ...running].sort((left, right) => blockTime(left) - blockTime(right))
  }

  private runningView(callId: string): RunningToolCall {
    const call = this.pending.get(callId)?.call
    if (call === undefined) throw new Error(`ToolCallTracker: "${callId}" is not pending`)
    return { ...call, subCalls: this.subCallsOf(callId) }
  }

  /** Top-level calls still awaiting a result, oldest first, with nested state attached. */
  runningCalls(): readonly RunningToolCall[] {
    const running: RunningToolCall[] = []
    for (const id of this.pendingOrder) {
      if (this.parentOf.get(id) === undefined) running.push(this.runningView(id))
    }
    return running
  }

  /** Every pending call id, including nested ones. */
  pendingIds(): readonly string[] {
    return [...this.pendingOrder]
  }
}

function blockTime(block: ToolCallBlock): number {
  return 'kind' in block ? (block.callTime ?? block.time) : block.time
}

/**
 * Append-only trajectory state with a revision-memoized snapshot. Adapters
 * mutate the fields directly and call `touch()`; `snapshot()` hands out a new
 * object only when the revision moved.
 */
export class TrajectoryAssembler {
  /** Declared first: the counter and the tracker report into it. */
  readonly lines = new SourceLineTable()
  readonly seq = new SequenceCounter((seq) => { this.lines.noteSeq(seq) })
  readonly nodes: ConversationNode[] = []
  readonly requests: RequestView[] = []
  /** `startSeq` → index into `requests`, kept in sync by {@link upsertRequest}. */
  private readonly requestIndex = new Map<number, number>()
  readonly locations = new Map<number, ConversationLocation>()
  readonly callSchemas = new Map<string, ToolSchema>()
  readonly systemPrompts: SystemPromptNode[] = []
  readonly tools = new ToolCallTracker(this.lines)
  partial: PartialAssistant | null = null
  private revision = 0
  private cached: { revision: number; snapshot: TrajectorySnapshot } | undefined

  touch(): void {
    this.revision += 1
  }

  /**
   * Begin folding one raw line of one file. `lineIndex` is the 0-based index
   * among that file's non-blank lines, or `undefined` for a caller that does
   * not number its input (and negative for a synthetic line the server injects,
   * such as grok's sidecar, which is in no file).
   */
  beginLine(fileId: string, lineIndex: number | undefined): void {
    this.lines.begin(fileId, lineIndex ?? -1)
  }

  pushNode(node: ConversationNode): void {
    this.nodes.push(node)
    this.lines.noteNode(node.seq)
    this.touch()
  }

  /** Replace an already pushed node in place (same seq), for example to attach late sub-calls. */
  replaceNode(seq: number, node: ConversationNode): void {
    for (let index = this.nodes.length - 1; index >= 0; index -= 1) {
      if (this.nodes[index]?.seq === seq) {
        this.nodes[index] = node
        this.touch()
        return
      }
    }
  }

  /** Replace a request by its start seq, or append it. */
  upsertRequest(request: RequestView): void {
    const index = this.requestIndex.get(request.startSeq)
    if (index !== undefined) this.requests[index] = request
    else {
      this.requestIndex.set(request.startSeq, this.requests.length)
      this.requests.push(request)
    }
    this.touch()
  }

  findRequest(startSeq: number): RequestView | undefined {
    const index = this.requestIndex.get(startSeq)
    return index === undefined ? undefined : this.requests[index]
  }

  snapshot(): TrajectorySnapshot {
    if (this.cached !== undefined && this.cached.revision === this.revision) {
      return this.cached.snapshot
    }
    // Refresh completed tool nodes whose nested sub-calls changed after emission.
    const eventNodes = this.nodes.map(node => (node.kind === 'tool-result'
      ? (this.tools.completedNode(node.callId) ?? node)
      : node))
    const snapshot: TrajectorySnapshot = {
      ...(this.systemPrompts.length === 0 ? {} : { systemPrompts: [...this.systemPrompts] }),
      eventNodes,
      eventLocations: new Map(this.locations),
      requests: [...this.requests],
      callSchemas: new Map(this.callSchemas),
      partial: this.partial,
      runningCalls: this.tools.runningCalls(),
      // A live view, not a copy: its identity is stable, so it costs nothing per
      // snapshot and never makes an unchanged fold look changed.
      sourceLines: this.lines,
    }
    this.cached = { revision: this.revision, snapshot }
    return snapshot
  }
}

/** Trim a title candidate to one line of bounded length. */
export function titleFrom(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}
