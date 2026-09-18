/**
 * pi coding agent transcript (`~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl`)
 * → fold events. One instance per file; pi has no subagents.
 *
 * Verified against pi 0.85.1 (`packages/coding-agent` session-manager) and 9
 * real transcripts. Shape notes:
 *
 *   - Line 1 is a `session` header; every other entry is
 *     `{type, id (8 hex), parentId: string|null, timestamp: ISO}`.
 *   - TRAP: entry `timestamp` is ISO; nested `message.timestamp` is epoch
 *     MILLISECONDS. All instants below read the entry stamp.
 *   - `usage` buckets are DISJOINT (`input` excludes cacheRead/cacheWrite);
 *     `reasoning` ⊂ `output`, `cacheWrite1h` ⊂ `cacheWrite`.
 *   - The model-visible context is the parentId path from the latest entry to
 *     the root — `PiSessionTree.contextEntries` (a port of pi's
 *     `buildContextEntries`) is the ONLY source of truth. Rendered surfaces
 *     are never consulted: a branch replays the events each path entry
 *     originally emitted (`emitted`), and a compaction re-keeps the path
 *     range even when the current surface holds replay copies — it may also
 *     WIDEN it, replaying originals for entries the surface already dropped.
 *     The PROMPT replays the compacted entry list while the ROUTE
 *     (provider/model/thinking) reads the FULL parent path, the split pi's
 *     `buildSessionContext` makes.
 *   - Compaction keeps `[summary, path entries from firstKeptEntryId up to the
 *     compaction, then everything after]` — in FILE order the kept entries
 *     precede the compaction entry, so they are re-emitted as replay copies
 *     behind the summary. Its `systemMessage` is a COMPLETE prompt checkpoint:
 *     it replaces the replayed state, never applies as a delta.
 *   - Sessions written by older pi carry NO system messages; everything works
 *     without one. `custom` entries are extension state, never context.
 *   - pi records no turn boundaries and no per-block times: every human `user`
 *     message opens a turn, and no `stream` is embedded (TTFT stays unknown).
 *   - The context window is never recorded; it is never inferred.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import {
  asArray, asNumber, asString, isRecord, isPiHumanPrompt, parsePiLine, PiPromptState,
  PiSessionTree, resolvePiContextState, titleFrom,
  type PiContextState,
} from '@harness-trajectory/core'
import type { ContentBlock, MessageSource, TimelineEvent } from '../fold/event.ts'
import type { FileOpRecord } from '../shared/types.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'
import { restoreSurface } from './surfaceRestore.ts'
import { disjointInput, setRequestInput } from './requestInput.ts'

/** The `tool/result` `data.fileOps` element the fold consumes. */
type FileOpInput = Omit<FileOpRecord, 'seq' | 'tool' | 'time' | 'err'>

/** pi usage of one model call, in the fold's disjoint-bucket vocabulary. */
interface Usage {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** The 1h-TTL SUBSET of `cacheWriteTokens`. */
  cacheWrite1hTokens?: number
  outputTokens?: number
}

/** One `toolCall` block waiting for its `toolResult`. */
interface PendingCall {
  name: string
  args: Record<string, unknown> | null
  time: number
}

/** A live surface node and the entry id that produced it (tree bookkeeping). */
interface LiveNode {
  seq: number
  entryId?: string
}

/** pi `usage` → the fold's disjoint buckets. */
function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value.input)
  const cacheRead = asNumber(value.cacheRead)
  const cacheWrite = asNumber(value.cacheWrite)
  const cacheWrite1h = asNumber(value.cacheWrite1h)
  const output = asNumber(value.output)
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined && output === undefined) {
    return undefined
  }
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1hTokens: cacheWrite1h }),
    ...(output === undefined ? {} : { outputTokens: output }),
  }
}

/** The USD total a usage record reports, when it is a finite number. */
function costTotalOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const cost = isRecord(value.cost) ? value.cost : undefined
  const total = asNumber(cost?.total)
  return total !== undefined && Number.isFinite(total) ? total : undefined
}

function stringifyArgs(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {})
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

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => (block.type === 'text' && block.text !== undefined ? [block.text] : [])).join('\n')
}

class PiSynthesizer implements EventSynthesizer {
  readonly kind = 'pi' as const

  private seq = 1
  private lastTime = 0
  private turn = 0
  private step = 0
  private stepOpen = false
  /** Time of the last model INPUT record (human prompt or toolResult) — the step's start. */
  private stepStartTime: number | null = null

  private readonly pendingCalls = new Map<string, PendingCall>()
  private readonly children = new Map<string, AgentSpawn>()

  /** The entry tree: pi's only source of truth for the model-visible context. */
  private readonly tree = new PiSessionTree()
  /** entryId → the ORIGINAL surface events that entry emitted; never mutated. */
  private readonly emitted = new Map<string, TimelineEvent[]>()
  /** The current surface: one item per surface event, in surface order. */
  private live: LiveNode[] = []
  /** seq → the CURRENT event of each live node (original or replay copy). */
  private readonly bySeq = new Map<number, TimelineEvent>()

  /** Prompt + route of the CURRENT context path. */
  private state: PiContextState = {
    prompt: new PiPromptState(),
    provider: undefined,
    model: undefined,
    thinking: undefined,
  }
  /** system text + tools + provider/model of the last emitted header. */
  private lastHeaderKey: string | undefined

  private reportedCostUsd: number | undefined
  private sessionName: string | undefined
  private firstPrompt: string | undefined

  push(line: string): readonly TimelineEvent[] {
    const out: TimelineEvent[] = []
    try {
      this.consume(line, out)
    } catch {
      // A synthesizer must never throw: a malformed record yields nothing.
    }
    return out
  }

  meta(): SynthMeta {
    const label = this.sessionName ?? this.firstPrompt
    return {
      running: this.stepOpen || this.pendingCalls.size > 0,
      children: this.children,
      ...(this.state.provider === undefined ? {} : { provider: this.state.provider }),
      ...(this.state.model === undefined ? {} : { model: this.state.model }),
      ...(label === undefined ? {} : { label }),
      ...(this.reportedCostUsd === undefined ? {} : { reportedCostUsd: this.reportedCostUsd }),
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  private consume(line: string, out: TimelineEvent[]): void {
    const entry = parsePiLine(line)
    if (entry === null) return
    const time = this.timeOf(entry.time)
    if (entry.type === 'session') return
    // An entry whose parentId is not the previous entry rewinds the context
    // path: rebase the surface and the prompt/route state from the tree.
    const previousLastId = this.tree.lastId
    this.tree.add(entry)
    if (entry.parentId !== previousLastId) this.rebase(entry.parentId, time, out)

    switch (entry.type) {
      case 'message': {
        const message = isRecord(entry.record.message) ? entry.record.message : undefined
        const role = asString(message?.role)
        if (message === undefined || role === undefined) break
        if (role === 'system') {
          this.onSystemMessage(message, time, out)
        } else if (role === 'user' && isPiHumanPrompt(entry)) {
          this.onUser(entry.id ?? undefined, message, time, out)
        } else if (role === 'assistant') {
          this.onAssistant(entry.id ?? undefined, message, time, out)
        } else if (role === 'toolResult') {
          this.onToolResult(entry.id ?? undefined, message, time, out)
        } else if (role === 'bashExecution') {
          this.onBashExecution(entry.id ?? undefined, message, time, out)
        } else if (role === 'custom') {
          this.onCustomMessage(entry.id ?? undefined, message, time, out)
        }
        break
      }
      case 'model_change': {
        const provider = asString(entry.record.provider)
        const modelId = asString(entry.record.modelId)
        if (provider !== undefined) this.state.provider = provider
        if (modelId !== undefined && modelId !== '') this.state.model = modelId
        // A route change only revises an existing header; the first assistant
        // still opens the 'initial' one when no system message was seen.
        if (this.lastHeaderKey !== undefined) this.syncHeader(time, out)
        break
      }
      case 'thinking_level_change':
        this.state.thinking = asString(entry.record.thinkingLevel) ?? this.state.thinking
        break
      case 'session_info': {
        const name = asString(entry.record.name)
        if (name !== undefined && name !== '') this.sessionName = name
        break
      }
      case 'custom_message':
        this.onCustomMessage(entry.id ?? undefined, entry.record, time, out)
        break
      case 'branch_summary':
        this.onBranchSummary(entry.id ?? undefined, entry.record, time, out)
        break
      case 'compaction':
        this.onCompaction(entry.id, entry.record, time, out)
        break
      default:
        // custom (extension state), label: not model context.
        break
    }
  }

  private timeOf(stamp: number | null): number {
    if (stamp !== null) {
      this.lastTime = stamp
      return stamp
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
  // Header: system message replay + model changes
  // ---------------------------------------------------------------------------

  private onSystemMessage(message: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    this.state.prompt.apply(message)
    this.syncHeader(time, out)
  }

  /** The identity of the current header: rendered prompt + tools + route. */
  private headerKey(): string {
    return JSON.stringify({
      system: this.state.prompt.text(),
      tools: this.state.prompt.tools(),
      provider: this.state.provider ?? null,
      model: this.state.model ?? null,
    })
  }

  /** Emit a header when the path's prompt/route differs from the last one sent. */
  private syncHeader(time: number, out: TimelineEvent[]): void {
    if (this.headerKey() === this.lastHeaderKey) return
    this.emitHeader(time, this.lastHeaderKey === undefined ? 'initial' : 'change', out)
  }

  /** `header.system` repeats the running prompt: the fold clears it when omitted. */
  private emitHeader(time: number, reason: 'initial' | 'change', out: TimelineEvent[]): void {
    const system = this.state.prompt.text()
    const header: Record<string, unknown> = {
      ...(system === '' ? {} : { system }),
      tools: this.state.prompt.tools().map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      config: {
        ...(this.state.provider === undefined ? {} : { provider: this.state.provider }),
        ...(this.state.model === undefined ? {} : { model: this.state.model }),
      },
    }
    this.emit(out, 'request/header', time, { header, reason })
    this.lastHeaderKey = this.headerKey()
  }

  // ---------------------------------------------------------------------------
  // user / assistant / toolResult
  // ---------------------------------------------------------------------------

  private onUser(entryId: string | undefined, message: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    if (this.stepOpen) {
      this.emit(out, 'step/end', time)
      this.stepOpen = false
    }
    this.turn += 1
    this.step = 0
    const content = contentBlocks(message.content)
    const text = textOf(content)
    if (this.firstPrompt === undefined && text.trim() !== '') this.firstPrompt = titleFrom(text)
    const event = this.emit(out, 'user/message', time, {
      content,
      source: { kind: 'user' } satisfies MessageSource,
    })
    this.trackSurface(entryId, event)
    this.stepStartTime = time
  }

  private onAssistant(entryId: string | undefined, message: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const provider = asString(message.provider)
    const model = asString(message.model)
    if (provider !== undefined) this.state.provider = provider
    if (model !== undefined && model !== '') this.state.model = model
    // Old sessions record no system message: the first header is a tools-less
    // route header; a later model switch revises it.
    this.syncHeader(time, out)
    this.emit(out, 'step/start', this.stepStartTime ?? time)
    this.stepOpen = true
    this.step += 1

    const blocks: ContentBlock[] = []
    const toolCalls: { callId: string; name: string; args: string; time: number }[] = []
    for (const item of asArray(message.content) ?? []) {
      if (!isRecord(item)) continue
      switch (item.type) {
        case 'thinking':
          blocks.push({ type: 'reasoning', text: asString(item.thinking) ?? '' })
          break
        case 'text':
          blocks.push({ type: 'text', text: asString(item.text) ?? '' })
          break
        case 'toolCall': {
          const callId = asString(item.id)
          if (callId === undefined) break
          const name = asString(item.name) ?? 'tool'
          const args = stringifyArgs(item.arguments)
          blocks.push({ type: 'tool-call', name, arguments: args, callId })
          toolCalls.push({ callId, name, args, time })
          this.pendingCalls.set(callId, { name, args: isRecord(item.arguments) ? item.arguments : null, time })
          break
        }
        default:
          break
      }
    }
    const usage = usageOf(message.usage)
    const event = this.emit(out, 'assistant/message', time, {
      message: { content: blocks },
      ...(usage === undefined ? {} : { usage }),
      turn: this.turn,
      step: this.step,
    })
    setRequestInput(event, disjointInput(usage, this.state.model))
    this.trackSurface(entryId, event)
    for (const call of toolCalls) {
      this.emit(out, 'tool/call', call.time, { callId: call.callId, name: call.name, arguments: call.args })
    }
    const cost = costTotalOf(message.usage)
    if (cost !== undefined) this.reportedCostUsd = (this.reportedCostUsd ?? 0) + cost
    if (this.pendingCalls.size === 0 && this.stepOpen) {
      this.emit(out, 'step/end', time)
      this.stepOpen = false
    }
  }

  private onToolResult(entryId: string | undefined, message: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const callId = asString(message.toolCallId)
    if (callId === undefined) return
    const call = this.pendingCalls.get(callId)
    this.pendingCalls.delete(callId)
    const content = contentBlocks(message.content)
    const isError = message.isError === true
    const data: Record<string, unknown> = {
      message: {
        content: [{ type: 'tool-result', toolCallId: callId, isError, content } satisfies ContentBlock],
        source: { callId, ...(call === undefined ? {} : { name: call.name }) },
      },
      error: isError,
    }
    if (message.details !== undefined) data.meta = message.details
    const ops = call === undefined ? [] : fileOpsOf(call.name, call.args)
    if (ops.length > 0) data.fileOps = ops
    const event = this.emit(out, 'tool/result', time, data)
    this.trackSurface(entryId, event)
    this.stepStartTime = time
    if (this.pendingCalls.size === 0 && this.stepOpen) {
      this.emit(out, 'step/end', time)
      this.stepOpen = false
    }
  }

  private onBashExecution(entryId: string | undefined, message: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    if (message.excludeFromContext === true) return
    const command = asString(message.command) ?? ''
    const output = asString(message.output) ?? ''
    const event = this.emit(out, 'user/message', time, {
      content: [{ type: 'text', text: `$ ${command}\n${output}` }],
      source: { kind: 'bash-execution', form: 'context', name: 'bash' } satisfies MessageSource,
    })
    this.trackSurface(entryId, event)
    this.stepStartTime = time
  }

  /** A `custom_message` entry or a `custom` message role: injected model-visible context. */
  private onCustomMessage(entryId: string | undefined, record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const customType = asString(record.customType) ?? 'custom'
    const content = contentBlocks(record.content)
    if (content.length === 0) return
    const event = this.emit(out, 'user/message', time, {
      content,
      source: { kind: 'custom', form: 'context', name: customType } satisfies MessageSource,
    })
    this.trackSurface(entryId, event)
    this.stepStartTime = time
  }

  private onBranchSummary(entryId: string | undefined, record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const summary = asString(record.summary) ?? ''
    const event = this.emit(out, 'user/message', time, {
      content: [{ type: 'text', text: summary }],
      source: { kind: 'branch-summary', form: 'context', name: 'branch_summary' } satisfies MessageSource,
    })
    this.trackSurface(entryId, event)
    const cost = costTotalOf(record.usage)
    if (cost !== undefined) this.reportedCostUsd = (this.reportedCostUsd ?? 0) + cost
    this.stepStartTime = time
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  /**
   * `contextEntries(entry.id)` decides the kept range straight from the tree —
   * `[compaction, path entries from firstKeptEntryId up to it, entries after]` —
   * so a second compaction re-keeps a replayed entry and an off-path
   * firstKeptEntryId keeps nothing. The range may also WIDEN (an extension
   * compaction can return any firstKeptEntryId): entries the surface no
   * longer holds replay their ORIGINAL emitted events, like a branch. Kept
   * nodes precede the compaction in FILE order but follow the summary in
   * MODEL order, so they are re-emitted as replay copies in PATH order.
   */
  private onCompaction(entryId: string | null, record: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const desired = this.tree.contextEntries(entryId)
    const liveByEntry = new Map<string, LiveNode[]>()
    for (const node of this.live) {
      if (node.entryId === undefined) continue
      const list = liveByEntry.get(node.entryId) ?? []
      list.push(node)
      liveByEntry.set(node.entryId, list)
    }
    const desiredIds = new Set<string>()
    const pairs: { entryId: string; event: TimelineEvent }[] = []
    const keptLiveSeqs: number[] = []
    for (const desiredEntry of desired) {
      if (desiredEntry.id === null || desiredEntry.id === entryId) continue
      desiredIds.add(desiredEntry.id)
      const nodes = liveByEntry.get(desiredEntry.id) ?? []
      if (nodes.length > 0) {
        for (const node of nodes) {
          const event = this.bySeq.get(node.seq)
          if (event === undefined) continue
          keptLiveSeqs.push(node.seq)
          pairs.push({ entryId: desiredEntry.id, event })
        }
      } else {
        for (const event of this.emitted.get(desiredEntry.id) ?? []) {
          pairs.push({ entryId: desiredEntry.id, event })
        }
      }
    }
    const shadowed = this.live
      .filter(node => node.entryId === undefined || !desiredIds.has(node.entryId))
      .map(node => node.seq)
    const tokensBefore = asNumber(record.tokensBefore)

    this.emit(out, 'compaction/summary', time, {
      shadowedSeqs: shadowed,
      ...(tokensBefore === undefined ? {} : { shadowedTokenCount: tokensBefore }),
    })
    const systemMessage = isRecord(record.systemMessage) ? record.systemMessage : undefined
    if (systemMessage !== undefined) {
      // The checkpoint is a COMPLETE prompt (getCurrentSystemMessage), not a
      // delta on the running one.
      this.state.prompt = PiPromptState.fromSystemMessage(systemMessage)
      this.syncHeader(time, out)
    }
    // Do not spread a long transcript into Math.min/max.
    const surfaceOp = shadowed.length === 0
      ? undefined
      : {
        op: 'replace',
        startSeq: shadowed.reduce((min, seq) => Math.min(min, seq), Infinity),
        endSeq: shadowed.reduce((max, seq) => Math.max(max, seq), -Infinity),
      }
    const summary = asString(record.summary) ?? ''
    const event = this.emit(out, 'user/message', time, {
      content: [{ type: 'text', text: summary }],
      source: {
        kind: 'plugin', form: 'compaction', plugin: 'compaction',
        ...(entryId === null ? {} : { compactionId: entryId }),
      } satisfies MessageSource,
      compaction: { ...(tokensBefore === undefined ? {} : { preTokens: tokensBefore }) },
    }, surfaceOp)
    const summaryNode: LiveNode = { seq: event.seq, ...(entryId === null ? {} : { entryId }) }
    this.bySeq.set(event.seq, event)
    if (entryId !== null) this.emitted.set(entryId, [event])
    const cost = costTotalOf(record.usage)
    if (cost !== undefined) this.reportedCostUsd = (this.reportedCostUsd ?? 0) + cost

    if (pairs.length > 0) {
      // Live nodes prune their current seqs; entries off the surface only
      // contribute events — nothing of theirs is there to prune.
      const events = restoreSurface(
        keptLiveSeqs, pairs.map(pair => pair.event), time, this.seq, 'compaction',
      )
      out.push(...events)
      this.seq += events.length
      const copies = events.filter(copy => copy.type !== 'compaction/prune')
      this.live = [
        summaryNode,
        ...copies.map((copy, index) => {
          this.bySeq.set(copy.seq, copy)
          const pair = pairs[index]
          return {
            seq: copy.seq,
            ...(pair === undefined ? {} : { entryId: pair.entryId }),
          }
        }),
      ]
    } else {
      this.live = [summaryNode]
    }
    this.stepStartTime = time
  }

  // ---------------------------------------------------------------------------
  // Surface bookkeeping
  // ---------------------------------------------------------------------------

  /** Register a surface event under its entry id and onto the live surface. */
  private trackSurface(entryId: string | undefined, event: TimelineEvent): void {
    this.live.push({ seq: event.seq, ...(entryId === undefined ? {} : { entryId }) })
    this.bySeq.set(event.seq, event)
    if (entryId !== undefined) {
      const list = this.emitted.get(entryId) ?? []
      list.push(event)
      this.emitted.set(entryId, list)
    }
  }

  /**
   * An entry whose parentId rewinds the path rebuilds the surface from the
   * tree: each path entry replays the ORIGINAL events it emitted — rendered
   * surfaces are never consulted — and the prompt/route is re-resolved from
   * the path so nothing from the abandoned branch leaks through.
   */
  private rebase(parentId: string | null, time: number, out: TimelineEvent[]): void {
    const desired = this.tree.contextEntries(parentId)
    const pairs = desired.flatMap(entry => {
      const events = entry.id === null ? [] : this.emitted.get(entry.id) ?? []
      return events.map(event => ({ entryId: entry.id ?? undefined, event }))
    })
    // A rewind discards any step still open on the abandoned path.
    if (this.stepOpen) {
      this.emit(out, 'step/end', time)
      this.stepOpen = false
    }
    this.pendingCalls.clear()
    const events = restoreSurface(
      this.live.map(node => node.seq), pairs.map(pair => pair.event), time, this.seq, 'branch',
    )
    out.push(...events)
    this.seq += events.length
    const copies = events.filter(event => event.type !== 'compaction/prune')
    this.live = copies.map((copy, index) => {
      this.bySeq.set(copy.seq, copy)
      const pair = pairs[index]
      return {
        seq: copy.seq,
        ...(pair?.entryId === undefined ? {} : { entryId: pair.entryId }),
      }
    })
    this.state = resolvePiContextState(this.tree, parentId)
    this.syncHeader(time, out)
    this.stepStartTime = time
  }
}

/** A message's content → fold content blocks (text and images). */
function contentBlocks(raw: unknown): ContentBlock[] {
  if (typeof raw === 'string') return raw === '' ? [] : [{ type: 'text', text: raw }]
  const blocks: ContentBlock[] = []
  for (const item of asArray(raw) ?? []) {
    if (!isRecord(item)) continue
    if (item.type === 'text') {
      blocks.push({ type: 'text', text: asString(item.text) ?? '' })
    } else if (item.type === 'image') {
      blocks.push({ type: 'image' })
    }
  }
  return blocks
}

/**
 * File operations read off a tool call's arguments (pi tool results carry no
 * structured file report). pi's built-ins are lowercase: read/write/edit for
 * files, grep/find for searches; bash, ls, and every MCP tool yield nothing.
 */
function fileOpsOf(name: string, args: Record<string, unknown> | null): FileOpInput[] {
  if (args === null) return []
  switch (name) {
    case 'read': {
      const path = asString(args['path'])
      if (path === undefined || path === '') return []
      const limit = asNumber(args['limit'])
      return [{
        kind: 'read', path, added: 0, removed: 0,
        ...(limit === undefined ? {} : { read: { count: limit, est: true as const } }),
      }]
    }
    case 'write': {
      const path = asString(args['path'])
      if (path === undefined || path === '') return []
      return [{ kind: 'write', path, added: countLines(asString(args['content']) ?? ''), removed: 0 }]
    }
    case 'edit': {
      const path = asString(args['path'])
      if (path === undefined || path === '') return []
      return [{
        kind: 'write', path,
        added: countLines(asString(args['newText']) ?? ''),
        removed: countLines(asString(args['oldText']) ?? ''),
      }]
    }
    case 'grep':
    case 'find': {
      const pattern = asString(args['pattern'])
      const path = asString(args['path'])
      const target = path !== undefined && path !== '' ? path : pattern
      if (target === undefined || target === '') return []
      return [{
        kind: 'search', path: target, added: 0, removed: 0,
        ...(path === undefined || path === '' ? { pattern: true as const } : {}),
        ...(pattern === undefined || pattern === '' || path === undefined || path === '' ? {} : { detail: pattern }),
      }]
    }
    default:
      return []
  }
}

export function createPiSynthesizer(_file: SessionFileRef): EventSynthesizer {
  return new PiSynthesizer()
}
