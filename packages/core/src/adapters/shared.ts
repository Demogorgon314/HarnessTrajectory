/** Building blocks shared by the harness adapters. */

import type {
  AssistantBlock, ContentBlock, ConversationLocation, ConversationNode, ImageAttachmentRef,
  ImageMediaType, PartialAssistant, RequestView, RunningToolCall, SystemPromptNode, ToolCallBlock,
  ToolResultNode, ToolSchema, TrajectorySnapshot,
} from '../contract.ts'
import type { ImageStore } from '../session.ts'

/** Monotonic event sequence shared by every record an adapter emits. */
export class SequenceCounter {
  private value = 0
  next(): number {
    this.value += 1
    return this.value
  }
  get current(): number {
    return this.value
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
  private readonly order: string[] = []
  private readonly children = new Map<string, ToolCallBlock[]>()
  private readonly parentOf = new Map<string, string>()
  private readonly completed = new Map<string, ToolResultNode>()

  /** Parents with at least one child still running: their nested view must be recomputed per snapshot. */
  private readonly pendingChildren = new Map<string, number>()

  /** Register an emitted call. */
  start(call: RunningToolCall): void {
    this.pending.set(call.callId, { call })
    this.order.push(call.callId)
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
    const pending = this.pending.get(callId)
    const call = pending?.call
    this.pending.delete(callId)
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
    const running = this.order
      .filter(id => this.pending.has(id) && this.parentOf.get(id) === callId)
      .map(id => this.runningView(id))
    return [...done, ...running].sort((left, right) => blockTime(left) - blockTime(right))
  }

  private runningView(callId: string): RunningToolCall {
    const call = this.pending.get(callId)?.call
    if (call === undefined) throw new Error(`ToolCallTracker: "${callId}" is not pending`)
    return { ...call, subCalls: this.subCallsOf(callId) }
  }

  /** Top-level calls still awaiting a result, oldest first, with nested state attached. */
  runningCalls(): readonly RunningToolCall[] {
    return this.order
      .filter(id => this.pending.has(id) && this.parentOf.get(id) === undefined)
      .map(id => this.runningView(id))
  }

  /** Every pending call id, including nested ones. */
  pendingIds(): readonly string[] {
    return this.order.filter(id => this.pending.has(id))
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
  readonly seq = new SequenceCounter()
  readonly nodes: ConversationNode[] = []
  readonly requests: RequestView[] = []
  readonly locations = new Map<number, ConversationLocation>()
  readonly callSchemas = new Map<string, ToolSchema>()
  readonly systemPrompts: SystemPromptNode[] = []
  readonly tools = new ToolCallTracker()
  partial: PartialAssistant | null = null
  private revision = 0
  private cached: { revision: number; snapshot: TrajectorySnapshot } | undefined

  touch(): void {
    this.revision += 1
  }

  pushNode(node: ConversationNode): void {
    this.nodes.push(node)
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
    const index = this.requests.findIndex(item => item.startSeq === request.startSeq)
    if (index >= 0) this.requests[index] = request
    else this.requests.push(request)
    this.touch()
  }

  findRequest(startSeq: number): RequestView | undefined {
    return this.requests.find(item => item.startSeq === startSeq)
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
