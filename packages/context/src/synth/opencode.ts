/**
 * OpenCode → fold events.
 *
 * One instance per virtual stream the server's OpencodeSource materializes
 * out of `opencode.db` — the records `parseOpencodeLine` reads:
 * `opencode.session` sidecar facts, `opencode.message` headers (user headers
 * carry their authored `parts`), `opencode.part` settled assistant parts,
 * `opencode.finish` the assistant's terminal facts, `opencode.prune` a
 * sidecar marking a tool output the compactor cleared.
 *
 * Traps the mapping leans on:
 *
 * - Every time is epoch MILLISECONDS (line `time`, `msg.time.created/
 *   completed`, part `time.start/end`, `state.time.start/end`).
 * - `tokens` buckets are DISJOINT and `output` EXCLUDES `reasoning`; the
 *   fold's `outputTokens` re-adds it (`usageOf` mirrors `opencodeUsage`).
 * - An assistant message is BUFFERED across its parts and emitted only at
 *   `opencode.finish` — `preview()` projects the open message so the live
 *   view is not a step behind; a header arriving while one is open flushes
 *   it with no usage (`requestInput` source 'unknown').
 * - `stream` is synthesized from real part times: a `text-delta` marker at
 *   the earliest part `time.start`, then one `block-start` per block at its
 *   own start.
 * - Compaction is a user message carrying a `compaction` part (it emits
 *   nothing), then a `summary: true` assistant whose text becomes the
 *   summary `user/message`; the retained tail — messages from
 *   `tail_start_id` up to the compaction user — re-emits AFTER the summary
 *   as replay copies, exactly like pi's `onCompaction`. The summary's usage
 *   is never an ordinary sample; its `cost` still adds to `reportedCostUsd`.
 * - `opencode.prune` replaces the referenced live `tool/result` in place:
 *   its content becomes `[Old tool result content cleared]` under a
 *   `replace` op (the surface node keeps its slot; the copy is `replay`).
 */

import {
  asNumber, asString, isRecord, opencodeChildTitle, opencodeTextOf,
  opencodeUserClass, parseOpencodeLine, titleFrom,
  type OpencodeRecord, type SessionFileRef,
} from '@harness-trajectory/core'
import type { ContentBlock, MessageSource, StreamRecord, TimelineEvent } from '../fold/event.ts'
import type { FileOpRecord } from '../shared/types.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'
import { restoreSurface } from './surfaceRestore.ts'
import { disjointInput, setRequestInput } from './requestInput.ts'

const LABEL_MAX = 80

/** What the store writes into a pruned tool part's output. */
const CLEARED_TOOL_OUTPUT = '[Old tool result content cleared]'

/** The `tool/result` `data.fileOps` element the fold consumes. */
type FileOpInput = Omit<FileOpRecord, 'seq' | 'tool' | 'time' | 'err'>

/** OpenCode `tokens` → the fold's disjoint-bucket usage vocabulary. */
interface Usage {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
}

/** One content block plus the instant its first token landed. */
interface BufferedBlock {
  block: ContentBlock
  start: number | null
}

/** A `tool` part waiting for (or already carrying) its settled state. */
interface PendingCall {
  callId: string
  name: string
  args: Record<string, unknown> | null
  argsRaw: string
  start: number
  end: number | null
  output: string | undefined
  isError: boolean | null
  title: string | undefined
}

/** The assistant message currently buffering parts. */
interface OpenAssistant {
  msgId: string
  /** `summary: true` — a compaction summary; never an `assistant/message`. */
  summary: boolean
  stepStart: number
  turn: number
  step: number
  blocks: BufferedBlock[]
  calls: PendingCall[]
}

/** A live surface node and the message id that produced it. */
interface LiveNode {
  seq: number
  msgId?: string
}

/** The compaction a user message armed and a summary must still close. */
interface ArmedCompaction {
  userMsgId: string
  tailStartId: string | null
}

/** `tokens` of an assistant message → the fold's disjoint usage buckets. */
function usageOf(tokens: unknown): Usage | undefined {
  if (!isRecord(tokens)) return undefined
  const input = asNumber(tokens['input'])
  const output = asNumber(tokens['output'])
  const reasoning = asNumber(tokens['reasoning'])
  const cache = isRecord(tokens['cache']) ? tokens['cache'] : undefined
  const cacheRead = asNumber(cache?.['read'])
  const cacheWrite = asNumber(cache?.['write'])
  if (input === undefined && output === undefined && reasoning === undefined
    && cacheRead === undefined && cacheWrite === undefined) {
    return undefined
  }
  const out = (output ?? 0) + (reasoning ?? 0)
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(out === 0 && output === undefined ? {} : { outputTokens: out }),
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

/** Rendered line count: '' is 0, a trailing newline closes its own line. */
function countLines(text: string): number {
  if (text === '') return 0
  let lines = 0
  for (const ch of text) if (ch === '\n') lines += 1
  return text.endsWith('\n') ? lines : lines + 1
}

function msgTime(msg: Record<string, unknown>, key: 'created' | 'completed'): number | undefined {
  const time = isRecord(msg['time']) ? msg['time'] : undefined
  return asNumber(time?.[key])
}

/**
 * File operations read off a tool part's `state.input` (opencode's built-ins
 * are lowercase; `read`/`write`/`edit` carry `filePath`, `glob`/`grep` carry
 * `pattern` + optional `path`, `list` carries `path`).
 */
function fileOpsOf(name: string, args: Record<string, unknown> | null): FileOpInput[] {
  if (args === null) return []
  const filePath = asString(args['filePath'])
  const path = filePath ?? asString(args['path'])
  switch (name) {
    case 'read': {
      if (path === undefined || path === '') return []
      const limit = asNumber(args['limit'])
      return [{
        kind: 'read', path, added: 0, removed: 0,
        ...(limit === undefined ? {} : { read: { count: limit, est: true as const } }),
      }]
    }
    case 'write': {
      if (path === undefined || path === '') return []
      return [{ kind: 'write', path, added: countLines(asString(args['content']) ?? ''), removed: 0 }]
    }
    case 'edit': {
      if (path === undefined || path === '') return []
      return [{
        kind: 'write', path,
        added: countLines(asString(args['newString']) ?? ''),
        removed: countLines(asString(args['oldString']) ?? ''),
      }]
    }
    case 'glob':
    case 'grep': {
      const pattern = asString(args['pattern'])
      const target = path !== undefined && path !== '' ? path : pattern
      if (target === undefined || target === '') return []
      return [{
        kind: 'search', path: target, added: 0, removed: 0,
        ...(path === undefined || path === '' ? { pattern: true as const } : {}),
        ...(pattern === undefined || pattern === '' || path === undefined || path === '' ? {} : { detail: pattern }),
      }]
    }
    case 'list': {
      if (path === undefined || path === '') return []
      return [{ kind: 'search', path, added: 0, removed: 0 }]
    }
    default:
      return []
  }
}

class OpencodeSynthesizer implements EventSynthesizer {
  readonly kind = 'opencode' as const

  private seq = 1
  private lastTime = 0
  private turn = 0
  private step = 0
  private stepStartTime: number | null = null
  private open: OpenAssistant | null = null
  private compaction: ArmedCompaction | null = null

  /** The current surface: one item per surface event, in surface order. */
  private live: LiveNode[] = []
  /** seq → the CURRENT event of each live node (original or replay copy). */
  private readonly bySeq = new Map<number, TimelineEvent>()
  /** msgId → the ORIGINAL surface events that message emitted; never mutated. */
  private readonly emitted = new Map<string, TimelineEvent[]>()
  /** Every message id seen, in stream order — the retained-tail boundary map. */
  private readonly messageOrder: string[] = []
  /** User message ids seen — a late part riding one is a user part, not an assistant block. */
  private readonly userIds = new Set<string>()
  /** callId → the live `tool/result` it produced, for `opencode.prune`. */
  private readonly resultSeqs = new Map<string, { seq: number; msgId: string; isError: boolean; name: string }>()

  private readonly children = new Map<string, AgentSpawn>()
  private label: string | undefined
  private firstPrompt: string | undefined
  private version: string | undefined
  private provider: string | undefined
  private model: string | undefined
  /** The last `system` a user message carried; headers repeat it (the fold clears an omitted system). */
  private systemText: string | undefined
  private lastHeaderKey: string | undefined
  private reportedCostUsd: number | undefined

  push(line: string): readonly TimelineEvent[] {
    const out: TimelineEvent[] = []
    try {
      const record = parseOpencodeLine(line)
      if (record === null) return out
      const time = this.timeOf(record.time)
      switch (record.tag) {
        case 'session':
          this.onSession(record)
          return out
        case 'message':
          this.onMessage(record, time, out)
          return out
        case 'part':
          this.onPart(record, time, out)
          return out
        case 'finish':
          this.onFinish(record, time, out)
          return out
        case 'prune':
          this.onPrune(record, time, out)
          return out
      }
    } catch {
      // A synthesizer must never throw: a malformed record yields nothing.
      return out
    }
  }

  /**
   * The events the open message would emit if it finished now — seqs
   * continue after the committed ones, nothing mutates.
   */
  preview(): readonly TimelineEvent[] {
    const open = this.open
    if (open === null || open.summary) return []
    return this.assistantEvents(
      open, this.lastTime, undefined, this.seq, 'unknown',
      open.calls.every(call => call.isError !== null),
    )
  }

  meta(): SynthMeta {
    const label = this.label ?? this.firstPrompt
    return {
      running: this.open !== null,
      children: this.children,
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(label === undefined ? {} : { label }),
      ...(this.version === undefined ? {} : { version: this.version }),
      ...(this.reportedCostUsd === undefined ? {} : { reportedCostUsd: this.reportedCostUsd }),
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

  /** Emit a surface event and book it under its message for the compaction claim/tail. */
  private emitSurface(
    out: TimelineEvent[],
    type: string,
    time: number,
    data: Record<string, unknown>,
    msgId: string,
    surfaceOp?: unknown,
  ): TimelineEvent {
    const event = this.emit(out, type, time, data, surfaceOp)
    this.live.push({ seq: event.seq, msgId })
    this.bySeq.set(event.seq, event)
    const list = this.emitted.get(msgId) ?? []
    list.push(event)
    this.emitted.set(msgId, list)
    return event
  }

  // ---------------------------------------------------------------------------
  // Sidecar + message headers
  // ---------------------------------------------------------------------------

  private onSession(record: Extract<OpencodeRecord, { tag: 'session' }>): void {
    const session = record.session
    const title = asString(session['title'])
    if (title !== undefined && title !== '') this.label = titleFrom(title, LABEL_MAX)
    this.version ??= asString(session['version']) ?? undefined
    const model = isRecord(session['model']) ? session['model'] : undefined
    this.model ??= asString(model?.['id']) ?? asString(model?.['modelID']) ?? undefined
    this.provider ??= asString(model?.['providerID']) ?? undefined
    for (const child of record.children) {
      const spawn: AgentSpawn = {
        key: child.id,
        label: (child.title === null ? '' : opencodeChildTitle(child.title)) || child.id,
        ...(child.agent === null ? {} : { agentType: child.agent }),
      }
      const existing = this.children.get(child.id)
      this.children.set(child.id, existing === undefined ? spawn : { ...existing, ...spawn })
    }
  }

  private onMessage(record: Extract<OpencodeRecord, { tag: 'message' }>, time: number, out: TimelineEvent[]): void {
    this.messageOrder.push(record.id)
    switch (asString(record.msg['role'])) {
      case 'user':
        this.userIds.add(record.id)
        this.onUser(record.id, record.msg, record.parts, time, out)
        return
      case 'assistant':
        this.onAssistantHeader(record.id, record.msg, time, out)
        return
      default:
        return
    }
  }

  private onUser(
    id: string,
    msg: Record<string, unknown>,
    parts: readonly Record<string, unknown>[],
    time: number,
    out: TimelineEvent[],
  ): void {
    const cls = opencodeUserClass(msg, parts)
    // Any new user message ends whatever response was still buffered (the
    // assistant crashed or the source moved on): flush it like a finish
    // with no usage.
    this.flushOpen(time, out)
    if (cls.kind === 'compaction') {
      // The compaction trigger emits nothing itself; the `summary: true`
      // assistant lands the summary and replays the retained tail.
      const part = parts.find(candidate => asString(candidate['type']) === 'compaction')
      this.compaction = { userMsgId: id, tailStartId: asString(part?.['tail_start_id']) ?? null }
      return
    }
    const system = asString(msg['system'])
    if (system !== undefined) this.systemText = system
    if (cls.kind === 'human') {
      this.turn += 1
      this.step = 0
      this.stepStartTime = time
      const text = opencodeTextOf(parts)
      if (this.firstPrompt === undefined && text.trim() !== '') this.firstPrompt = titleFrom(text, LABEL_MAX)
      this.emitSurface(out, 'user/message', time, {
        content: this.userContent(parts),
        source: { kind: 'user' } satisfies MessageSource,
      }, id)
    }
    // Synthetic text parts — inside a human prompt or an injection-only
    // message — are injected context; each folds into its own user/message.
    for (const part of parts) {
      if (asString(part['type']) !== 'text' || part['synthetic'] !== true) continue
      const text = asString(part['text'])
      if (text === undefined) continue
      const meta = isRecord(part['metadata']) ? part['metadata'] : undefined
      const name = meta?.['compaction_continue'] === true ? 'compaction-continue' : 'synthetic'
      this.emitSurface(out, 'user/message', time, {
        content: [{ type: 'text', text }],
        source: { kind: 'inject', form: 'context', name, plugin: name } satisfies MessageSource,
      }, id)
    }
  }

  /** Authored blocks of a human prompt: non-synthetic text and image files. */
  private userContent(parts: readonly Record<string, unknown>[]): ContentBlock[] {
    const content: ContentBlock[] = []
    for (const part of parts) {
      const type = asString(part['type'])
      if (type === 'text' && part['synthetic'] !== true) {
        content.push({ type: 'text', text: asString(part['text']) ?? '' })
      } else if (type === 'file') {
        const mime = asString(part['mime'])
        if (mime !== undefined && mime.startsWith('image/')) content.push({ type: 'image' })
      }
    }
    return content
  }

  // ---------------------------------------------------------------------------
  // Assistant lifecycle
  // ---------------------------------------------------------------------------

  private onAssistantHeader(
    id: string,
    msg: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
  ): OpenAssistant {
    this.flushOpen(time, out)
    const created = msgTime(msg, 'created') ?? time
    this.syncHeader(msg, created, out)
    if (msg['summary'] === true) {
      // A compaction summary buffers like any assistant but is never a step.
      this.open = { msgId: id, summary: true, stepStart: created, turn: this.turn, step: this.step, blocks: [], calls: [] }
      return this.open
    }
    this.step += 1
    this.emit(out, 'step/start', created)
    this.open = {
      msgId: id, summary: false, stepStart: created, turn: Math.max(1, this.turn), step: this.step,
      blocks: [], calls: [],
    }
    return this.open
  }

  /** `request/header` before the first assistant and on every route change. */
  private syncHeader(msg: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const provider = asString(msg['providerID'])
    const model = asString(msg['modelID'])
    if (provider !== undefined) this.provider = provider
    if (model !== undefined) this.model = model
    const key = JSON.stringify({ provider: this.provider ?? null, model: this.model ?? null })
    if (key === this.lastHeaderKey) return
    this.emit(out, 'request/header', time, {
      header: {
        ...(this.systemText === undefined ? {} : { system: this.systemText }),
        config: {
          ...(this.provider === undefined ? {} : { provider: this.provider }),
          ...(this.model === undefined ? {} : { model: this.model }),
        },
      },
      reason: this.lastHeaderKey === undefined ? 'initial' : 'change',
    })
    this.lastHeaderKey = key
  }

  private ensureOpen(msgId: string, msg: Record<string, unknown> | undefined, time: number, out: TimelineEvent[]): OpenAssistant {
    if (this.open !== null && this.open.msgId === msgId) return this.open
    // A part/finish for a message whose header never arrived: open it
    // implicitly (the finish's msg still carries route/times) rather than
    // dropping the content.
    return this.onAssistantHeader(msgId, msg ?? {}, time, out)
  }

  /**
   * Settle the buffered message: exactly what a finish would emit, except no
   * usage exists (requestInput source 'unknown') and the step ends at the
   * interrupting record's time. A buffered summary just disarms.
   */
  private flushOpen(time: number, out: TimelineEvent[]): void {
    const open = this.open
    if (open === null) return
    this.open = null
    if (open.summary) {
      this.compaction = null
      return
    }
    const events = this.assistantEvents(open, time, undefined, this.seq, 'unknown', true)
    this.commitAssistant(open, events, time, out)
  }

  private onPart(record: Extract<OpencodeRecord, { tag: 'part' }>, time: number, out: TimelineEvent[]): void {
    // A part addressed to a known USER message is a late user part (the
    // emission plan's anomaly append) — never an assistant block.
    if (this.userIds.has(record.messageID)) return
    const part = record.part
    const open = this.ensureOpen(record.messageID, undefined, time, out)
    const partTime = isRecord(part['time']) ? part['time'] : undefined
    const start = asNumber(partTime?.['start']) ?? null
    switch (asString(part['type'])) {
      case 'text':
        open.blocks.push({ block: { type: 'text', text: asString(part['text']) ?? '' }, start })
        return
      case 'reasoning':
        open.blocks.push({ block: { type: 'reasoning', text: asString(part['text']) ?? '' }, start })
        return
      case 'tool':
        this.onToolPart(part, open, time)
        return
      default:
        // step-start/step-finish/snapshot/patch/file/agent/subtask/compaction
        // and anything newer: not model-visible blocks.
        return
    }
  }

  private onToolPart(part: Record<string, unknown>, open: OpenAssistant, time: number): void {
    const callID = asString(part['callID'])
    if (callID === undefined) return
    const name = asString(part['tool']) ?? 'tool'
    const state = isRecord(part['state']) ? part['state'] : undefined
    const stateTime = isRecord(state?.['time']) ? state['time'] : undefined
    const start = asNumber(stateTime?.['start']) ?? time
    const end = asNumber(stateTime?.['end']) ?? null
    const argsRaw = stringifyArgs(state?.['input'])
    open.blocks.push({ block: { type: 'tool-call', callId: callID, name, arguments: argsRaw }, start })
    const status = asString(state?.['status'])
    const call: PendingCall = {
      callId: callID,
      name,
      args: isRecord(state?.['input']) ? state['input'] : null,
      argsRaw,
      start,
      end,
      // A part born compacted (pruned before we materialized) yields the
      // cleared marker — same rule OpenCode's filterCompacted applies.
      output: stateTime?.['compacted'] !== undefined
        ? CLEARED_TOOL_OUTPUT
        : status === 'error' ? asString(state?.['error']) : asString(state?.['output']),
      isError: status === 'completed' || status === 'error' ? status === 'error' : null,
      title: asString(state?.['title']),
    }
    open.calls.push(call)
    this.bindSpawn(callID, state, start, end)
  }

  /** `state.metadata.sessionId` binds/enriches the child spawn under the child id. */
  private bindSpawn(
    callID: string,
    state: Record<string, unknown> | undefined,
    start: number,
    end: number | null,
  ): void {
    const metadata = isRecord(state?.['metadata']) ? state['metadata'] : undefined
    const childId = asString(metadata?.['sessionId'])
    if (childId === undefined) return
    const input = isRecord(state?.['input']) ? state['input'] : undefined
    const model = metadata?.['model']
    const existing = this.children.get(childId)
    const agentType = existing?.agentType ?? asString(input?.['subagent_type'])
    const label = existing?.label
      ?? titleFrom(asString(state?.['title']) ?? asString(input?.['description']) ?? childId, LABEL_MAX)
    const modelId = isRecord(model) ? asString(model['modelID']) : asString(model)
    const spawn: AgentSpawn = {
      key: childId,
      label,
      ...(agentType === undefined ? {} : { agentType }),
      callId: callID,
      startedAt: start,
      ...(modelId === undefined ? {} : { model: modelId }),
      // A background result only acknowledges the launch — no completedAt.
      ...(end !== null && metadata?.['background'] !== true ? { completedAt: end } : {}),
    }
    this.children.set(childId, spawn)
  }

  private onFinish(record: Extract<OpencodeRecord, { tag: 'finish' }>, time: number, out: TimelineEvent[]): void {
    // Finishes are assistant-only; one addressed to a user message is noise.
    if (this.userIds.has(record.id)) return
    const msg = record.msg
    const open = this.ensureOpen(record.id, msg, time, out)
    this.open = null
    const completed = msgTime(msg, 'completed') ?? time
    const cost = asNumber(msg['cost'])
    if (cost !== undefined) this.reportedCostUsd = (this.reportedCostUsd ?? 0) + cost
    if (open.summary) {
      // A finish record is terminal by construction (time.completed or an
      // error landed), so only an error disarms — a completed summary that
      // carries no `finish` reason still compacts (same rule the core
      // adapter's completeCompaction keys on).
      if (msg['error'] === undefined) {
        this.emitCompaction(open, completed, out)
      } else {
        this.compaction = null
      }
      return
    }
    const usage = usageOf(msg['tokens'])
    const events = this.assistantEvents(open, completed, usage, this.seq, 'disjoint', true)
    this.commitAssistant(open, events, completed, out)
  }

  /** Append the emitted events and book the surface nodes under the message. */
  private commitAssistant(
    open: OpenAssistant,
    events: TimelineEvent[],
    completed: number,
    out: TimelineEvent[],
  ): void {
    this.seq += events.length
    out.push(...events)
    const results = events.filter(event => event.type === 'tool/result')
    const settled = open.calls.filter(call => call.isError !== null)
    settled.forEach((call, index) => {
      const event = results[index]
      if (event === undefined) return
      this.resultSeqs.set(call.callId, {
        seq: event.seq, msgId: open.msgId, isError: call.isError === true, name: call.name,
      })
    })
    for (const event of events) {
      if (event.type !== 'assistant/message' && event.type !== 'tool/result') continue
      this.live.push({ seq: event.seq, msgId: open.msgId })
      this.bySeq.set(event.seq, event)
      const list = this.emitted.get(open.msgId) ?? []
      list.push(event)
      this.emitted.set(open.msgId, list)
    }
  }

  /**
   * The events one settled assistant message produces, in order:
   * `assistant/message` (usage + synthesized stream), then `tool/call` and
   * `tool/result` per part, then `step/end`. Pure in `baseSeq` — `preview()`
   * calls it with the committed seq without mutating anything.
   */
  private assistantEvents(
    open: OpenAssistant,
    completed: number,
    usage: Usage | undefined,
    baseSeq: number,
    inputSource: 'disjoint' | 'unknown',
    endStep: boolean,
  ): TimelineEvent[] {
    const out: TimelineEvent[] = []
    let seq = baseSeq
    const emit = (type: string, time: number, data?: Record<string, unknown>): TimelineEvent => {
      const event: TimelineEvent = { type, seq, time, ...(data === undefined ? {} : { data }) }
      seq += 1
      out.push(event)
      return event
    }
    const stream = this.streamOf(open, completed)
    const message = emit('assistant/message', completed, {
      message: { content: open.blocks.map(buffered => buffered.block) },
      ...(usage === undefined ? {} : { usage }),
      turn: open.turn,
      step: open.step,
      stream,
    })
    setRequestInput(message, inputSource === 'disjoint'
      ? disjointInput(usage, this.model)
      : { source: 'unknown', ...(this.model === undefined ? {} : { model: this.model }) })
    for (const call of open.calls) {
      emit('tool/call', call.start, { callId: call.callId, name: call.name, arguments: call.argsRaw })
      if (call.isError === null) continue
      const text = call.output ?? ''
      const ops = fileOpsOf(call.name, call.args)
      emit('tool/result', call.end ?? completed, {
        message: {
          content: [{ type: 'tool-result', toolCallId: call.callId, isError: call.isError, content: [{ type: 'text', text }] } satisfies ContentBlock],
          source: { callId: call.callId, name: call.name },
        },
        ...(call.isError ? { error: true } : {}),
        meta: {
          ...(call.end !== null && call.end > call.start ? { durationMs: call.end - call.start } : {}),
          ...(call.title === undefined ? {} : { title: call.title }),
        },
        ...(ops.length === 0 ? {} : { fileOps: ops }),
      })
    }
    if (endStep) emit('step/end', completed)
    return out
  }

  /**
   * The embedded stream the fold reads for first-token time: one `text-delta`
   * marker at the earliest part start (only while it sits inside the step),
   * then a `block-start` per block at that block's own start.
   */
  private streamOf(open: OpenAssistant, completed: number): StreamRecord[] {
    let earliest: number | null = null
    for (const buffered of open.blocks) {
      if (buffered.start !== null && (earliest === null || buffered.start < earliest)) earliest = buffered.start
    }
    const stream: StreamRecord[] = []
    const firstToken = earliest !== null && earliest >= open.stepStart && earliest <= completed ? earliest : null
    if (firstToken !== null) {
      stream.push({ type: 'chunk', time: firstToken, chunk: { type: 'text-delta', text: ' ' } })
    }
    for (const buffered of open.blocks) {
      const blockType = buffered.block.type === 'reasoning' ? 'reasoning'
        : buffered.block.type === 'tool-call' ? 'tool-call' : 'text'
      stream.push({
        type: 'chunk',
        time: buffered.start ?? firstToken ?? completed,
        chunk: { type: 'block-start', blockType },
      })
    }
    return stream
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  /**
   * The `summary: true` assistant landed: shadow every live seq except the
   * retained tail — messages from `tail_start_id` up to but excluding the
   * compaction user message, in stream order — then emit the summary
   * `user/message` carrying the `replace` op over the shadowed range, and
   * re-emit the tail AFTER it as replay copies (live nodes replay their
   * current event; messages already off the surface replay their originals,
   * like pi's `onCompaction`).
   */
  private emitCompaction(
    open: OpenAssistant,
    completed: number,
    out: TimelineEvent[],
  ): void {
    const armed = this.compaction
    this.compaction = null
    const tailIds = new Set<string>()
    if (armed !== null && armed.tailStartId !== null) {
      const order = this.messageOrder
      const start = order.indexOf(armed.tailStartId)
      const stop = order.indexOf(armed.userMsgId)
      if (start >= 0) {
        for (const id of order.slice(start, stop >= 0 ? stop : order.length)) tailIds.add(id)
      }
    }
    const keptLiveSeqs: number[] = []
    const pairs: { msgId: string | undefined; event: TimelineEvent }[] = []
    for (const id of tailIds) {
      const nodes = this.live.filter(node => node.msgId === id)
      if (nodes.length === 0) {
        for (const event of this.emitted.get(id) ?? []) pairs.push({ msgId: id, event })
        continue
      }
      for (const node of nodes) {
        const event = this.bySeq.get(node.seq)
        if (event === undefined) continue
        keptLiveSeqs.push(node.seq)
        pairs.push({ msgId: id, event })
      }
    }
    const shadowed = this.live
      .filter(node => node.msgId === undefined || !tailIds.has(node.msgId))
      .map(node => node.seq)
    this.emit(out, 'compaction/summary', completed, { shadowedSeqs: [...shadowed] })
    const text = open.blocks.flatMap(buffered => (buffered.block.type === 'text' ? [buffered.block.text ?? ''] : [])).join('\n')
    const op = shadowed.length === 0
      ? undefined
      : { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] }
    const summary = this.emitSurface(out, 'user/message', completed, {
      content: text === '' ? [] : [{ type: 'text', text }],
      source: {
        kind: 'plugin', form: 'compaction', plugin: 'compaction',
        ...(armed === null ? {} : { compactionId: armed.userMsgId }),
      } satisfies MessageSource,
    }, open.msgId, op)

    if (pairs.length === 0) {
      this.live = [{ seq: summary.seq, msgId: open.msgId }]
      return
    }
    const events = restoreSurface(
      keptLiveSeqs, pairs.map(pair => pair.event), completed, this.seq, 'compaction',
    )
    out.push(...events)
    this.seq += events.length
    const copies = events.filter(event => event.type !== 'compaction/prune')
    this.live = [
      { seq: summary.seq, msgId: open.msgId },
      ...copies.map((copy, index) => {
        this.bySeq.set(copy.seq, copy)
        const msgId = pairs[index]?.msgId
        return { seq: copy.seq, ...(msgId === undefined ? {} : { msgId }) }
      }),
    ]
  }

  /**
   * `SessionCompaction.prune` cleared one tool part's output: the result
   * leaves the model context while the row stays. Emit the claim and a
   * `replay` copy carrying the cleared marker under a `replace` op; the copy
   * takes the seq's place on the surface.
   */
  private onPrune(record: Extract<OpencodeRecord, { tag: 'prune' }>, time: number, out: TimelineEvent[]): void {
    if (record.callID === null) return
    const found = this.resultSeqs.get(record.callID)
    if (found === undefined) return
    const index = this.live.findIndex(node => node.seq === found.seq)
    if (index < 0) return
    this.emit(out, 'compaction/prune', time, { shadowedSeqs: [found.seq] })
    const copy = this.emit(out, 'tool/result', time, {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: record.callID,
          isError: found.isError,
          content: [{ type: 'text', text: CLEARED_TOOL_OUTPUT }],
        } satisfies ContentBlock],
        source: { callId: record.callID, name: found.name },
      },
      replay: true,
      ...(found.isError ? { error: true } : {}),
    }, { op: 'replace', startSeq: found.seq, endSeq: found.seq })
    const node = this.live[index]
    this.live[index] = { seq: copy.seq, ...(node?.msgId === undefined ? {} : { msgId: node.msgId }) }
    this.bySeq.set(copy.seq, copy)
    this.resultSeqs.set(record.callID, { ...found, seq: copy.seq })
    // The message's original event list now points at the pruned copy, so a
    // later compaction tail replays the cleared result, not the old output.
    const list = this.emitted.get(found.msgId) ?? []
    this.emitted.set(found.msgId, list.map(event => (event.seq === found.seq ? copy : event)))
  }
}

/** Create the synthesizer for one opencode stream (main or one child session). */
export function createOpencodeSynthesizer(_file: SessionFileRef): EventSynthesizer {
  return new OpencodeSynthesizer()
}
