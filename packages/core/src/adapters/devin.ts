/**
 * Devin CLI adapter: folds the virtual line stream the server's DevinSource
 * materializes out of `sessions.db` into the trajectory contract.
 *
 * Verified against the devin 1.x store (`refinery_schema_history` ≤ 17). The
 * store is a persistent message forest — the source already decided chain
 * membership and deduplicated render copies, so this file sees one ordered
 * `devin.msg` line per logical message plus two synthetic record kinds:
 *
 * - `{t:'devin.session', …}` — the `sessions` row (title/cwd/model/agent_mode,
 *   `createdAt` ms) plus the discovered subagent list `[{id, fileId}]`.
 * - `{t:'devin.msg', node, parent, time, msg}` — one `chat_message`; `time` is
 *   epoch ms (`msg.metadata.created_at`, else the row's seconds stamp).
 * - `{t:'devin.tool', id, time, call, update}` — one `tool_call_state` row:
 *   the ACP `ToolCall` and its `ToolCallUpdate` (title/kind/locations/status),
 *   re-sent when the row changes.
 *
 * Load-bearing details of `chat_message`:
 *
 * - Human vs injected input is `msg.metadata.is_user_input === true` — the
 *   structural flag `devinMessageClass` reads, never the text.
 * - Per-call metrics live in `metadata.metrics` (`input_tokens`,
 *   `output_tokens`, `cache_read_tokens`, `ttft_ms`, `total_time_ms`);
 *   `metadata.created_at`/`started_generation_at` are ISO stamps with
 *   millisecond precision (the row stamp is only seconds).
 * - A tool result is a `role:'tool'` node keyed by `tool_call_id`; its
 *   `metadata.extensions` carry `chisel/tool_result_meta.success`,
 *   `chisel/tool_call_timing.duration_ms`, and for `run_subagent` the binding
 *   fields `subagent/agent_id`, `subagent/chain_node_id`,
 *   `subagent/profile_name`, `subagent/model`. A background spawn result
 *   carries `subagent/agent_id` only — the chain id arrives later on a
 *   completion notification — so a run can exist with `fileId: null` until
 *   the sidecar's agent list or a child file ref supplies the real file id;
 *   the agent id is never a usable stream id on its own.
 * - `tool_calls` entries are flat `{id, name, arguments}` (not the OpenAI
 *   `{function:{…}}` nesting); both spellings are accepted.
 * - A `system` node carrying `extensions['devin-rs/summary']` is a compaction:
 *   `content` is the summary text plus the kept `<conversation_history>` tail,
 *   and it folds as a compaction node + request, not a system-prompt update.
 */

import type {
  AssistantBlock, AssistantMessageNode, CompactionRequestView, ContentBlock,
  ContextMessageNode, ImageAttachmentRef, KnownContextForm, TokenUsage, TrajectorySnapshot,
} from '../contract.ts'
import { asArray, asNumber, asString, isRecord, parseJsonLine } from '../jsonl.ts'
import type {
  ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun, SubagentStatus,
} from '../session.ts'
import { DataUrlImageStore, TrajectoryAssembler, titleFrom } from './shared.ts'

/** Devin's provider tag: Cognition's own CLI, SWE-* models. */
const DEVIN_PROVIDER = 'cognition'

/** Wire name of the subagent-spawn tool. */
const SPAWN_TOOL = 'run_subagent'

/** `tool_call_update.status` values that carry a result rather than progress. */
const TERMINAL_TOOL_STATUS: ReadonlySet<string> = new Set(['completed', 'failed'])

/**
 * One parsed line of a devin stream. `time` is epoch ms. `msg` is the raw
 * `chat_message` record; `call`/`update` are the ACP tool objects.
 */
export type DevinRecord =
  | {
    readonly tag: 'session'
    readonly time: number | null
    readonly title: string | null
    readonly cwd: string | null
    readonly model: string | null
    readonly agentMode: string | null
    readonly agents: readonly { id: string; fileId: string }[]
  }
  | {
    readonly tag: 'msg'
    readonly time: number | null
    readonly node: number | null
    readonly parent: number | null
    /** `kept:1` — a summary's ancestor flush: the incoming render's kept context. */
    readonly kept: boolean
    readonly msg: Record<string, unknown>
  }
  | {
    readonly tag: 'tool'
    readonly time: number | null
    readonly id: string
    readonly call: Record<string, unknown> | null
    readonly update: Record<string, unknown> | null
  }

/**
 * How a `role:'user'` node reached the context: `metadata.is_user_input` is
 * the structural flag (typed by the CLI when it reads stdin / accepts input),
 * everything else — hooks, system_guidance, plan reminders — is injected
 * context. Shared by the adapter, the context synthesizer, the server meta
 * scanner and the search extractor, so the four never disagree.
 */
export type DevinMessageClass =
  | { readonly kind: 'human' }
  | { readonly kind: 'injection'; readonly name: string }

export function devinMessageClass(msg: unknown): DevinMessageClass | null {
  if (!isRecord(msg) || asString(msg['role']) !== 'user') return null
  const meta = isRecord(msg['metadata']) ? msg['metadata'] : undefined
  return meta?.['is_user_input'] === true
    ? { kind: 'human' }
    : { kind: 'injection', name: 'user' }
}

/** Parse one line of a devin stream; `null` for blank/malformed input. Never throws. */
export function parseDevinLine(line: string): DevinRecord | null {
  const raw = parseJsonLine(line)
  if (!isRecord(raw)) return null
  const time = asNumber(raw['time']) ?? null
  switch (asString(raw['t'])) {
    case 'devin.session': {
      const agents = (asArray(raw['agents']) ?? []).flatMap(agent => {
        if (!isRecord(agent)) return []
        const id = asString(agent['id'])
        const fileId = asString(agent['fileId'])
        return id === undefined || fileId === undefined ? [] : [{ id, fileId }]
      })
      return {
        tag: 'session',
        time,
        title: asString(raw['title']) ?? null,
        cwd: asString(raw['cwd']) ?? null,
        model: asString(raw['model']) ?? null,
        agentMode: asString(raw['agentMode']) ?? null,
        agents,
      }
    }
    case 'devin.msg': {
      const msg = isRecord(raw['msg']) ? raw['msg'] : undefined
      if (msg === undefined) return null
      return {
        tag: 'msg',
        time,
        node: asNumber(raw['node']) ?? null,
        parent: asNumber(raw['parent']) ?? null,
        kept: raw['kept'] === 1,
        msg,
      }
    }
    case 'devin.tool': {
      const id = asString(raw['id'])
      if (id === undefined) return null
      return {
        tag: 'tool',
        time,
        id,
        call: isRecord(raw['call']) ? raw['call'] : null,
        update: isRecord(raw['update']) ? raw['update'] : null,
      }
    }
    default:
      return null
  }
}

/** `metadata` bag of a `chat_message`. */
function msgMeta(msg: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(msg['metadata']) ? msg['metadata'] : undefined
}

/** `metadata.extensions` bag of a `chat_message`. */
function msgExt(msg: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = msgMeta(msg)
  return isRecord(meta?.['extensions']) ? meta['extensions'] : undefined
}

/** `metadata.metrics` → the contract's token buckets (snake_case on the wire). */
function msgUsage(msg: Record<string, unknown>): TokenUsage | undefined {
  const meta = msgMeta(msg)
  const metrics = isRecord(meta?.['metrics']) ? meta['metrics'] : undefined
  if (metrics === undefined) return undefined
  const input = asNumber(metrics['input_tokens'])
  const output = asNumber(metrics['output_tokens'])
  const cacheRead = asNumber(metrics['cache_read_tokens'])
  // Observed stores write `cache_creation_tokens` (null so far); the
  // `cache_write_tokens` spelling is kept as a forward-compat alias.
  const cacheWrite = asNumber(metrics['cache_write_tokens']) ?? asNumber(metrics['cache_creation_tokens'])
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    totalTokens: (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
  }
}

/** Text of a `chat_message.content` (a string, or ACP content parts). */
function msgText(msg: Record<string, unknown>): string {
  const content = msg['content']
  if (typeof content === 'string') return content
  return (asArray(content) ?? [])
    .flatMap(block => (isRecord(block) && block['type'] === 'text' ? [asString(block['text']) ?? ''] : []))
    .join('\n')
}

function msgTime(msg: Record<string, unknown>, fallback: number | null): number {
  const meta = msgMeta(msg)
  const stamp = asString(meta?.['created_at'])
  if (stamp !== undefined) {
    const parsed = Date.parse(stamp)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback ?? 0
}

/** `tool_calls` entries, normalized to `{id, name, argsRaw}`. */
function toolCallsOf(msg: Record<string, unknown>): { id: string; name: string; argsRaw: string }[] {
  return (asArray(msg['tool_calls']) ?? []).flatMap(call => {
    if (!isRecord(call)) return []
    const fn = isRecord(call['function']) ? call['function'] : undefined
    const id = asString(call['id'])
    const name = asString(call['name']) ?? asString(fn?.['name'])
    const args = call['arguments'] ?? fn?.['arguments']
    if (id === undefined || name === undefined) return []
    return [{
      id,
      name,
      argsRaw: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    }]
  })
}

function subagentStatus(value: string | undefined): SubagentStatus {
  switch (value) {
    case 'completed': return 'completed'
    case 'cancelled':
    case 'canceled':
    case 'stopped': return 'stopped'
    default: return 'failed'
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

interface DevinSpawn {
  callId: string
  task: string | null
  title: string | null
  profile: string | null
  background: boolean
  time: number
}

/** The `Subagent agent_id=<hex>` header a `run_subagent` result opens with. */
const AGENT_ID_PATTERN = /agent_id=([0-9a-f]+)/

class DevinParser implements SessionParser {
  readonly kind = 'devin' as const
  readonly images = new DataUrlImageStore()

  private readonly assembler = new TrajectoryAssembler()
  private turn = 0
  private step = 0
  private lastTime = 0
  private readonly runs = new Map<string, AgentRun>()
  /** run_subagent calls in announcement order, for task-text binding. */
  private readonly spawns: DevinSpawn[] = []
  /** callId → run the spawn was bound to. */
  private readonly runByCall = new Map<string, AgentRun>()
  /** agentId (or placeholder) → child file id, from the session sidecar. */
  private readonly agentFiles = new Map<string, string>()
  /** Child file ids seen, so a late `subagent/*` binding can be applied. */
  private readonly childFiles = new Map<string, { task: string | null; run: AgentRun }>()
  /** Child tool calls already nested under their parent call. */
  private readonly childCalls = new Set<string>()
  /** ACP tool state learned from `devin.tool` lines, attached to result nodes. */
  private readonly acpCalls = new Map<string, { title: string | null; kind: string | null }>()

  private aiTitle: string | null = null
  private firstPromptTitle: string | null = null
  private cwd: string | null = null
  private model: string | null = null
  private agentMode: string | null = null
  private startedAt: number | null = null
  private promptCount = 0
  private systemPromptSeen = false
  /** message_ids already folded in — render copies re-emitted past a summary
   *  boundary are the same message re-entering context, not a new event. */
  private readonly seenMids = new Set<string>()

  push(line: string, file: SessionFileRef, lineIndex?: number): void {
    this.assembler.beginLine(file.id, lineIndex)
    const record = parseDevinLine(line)
    if (record === null) return
    const time = record.time ?? this.lastTime
    if (time > this.lastTime) this.lastTime = time
    if (file.role === 'child') {
      this.handleChild(file, record, time)
      return
    }
    switch (record.tag) {
      case 'session':
        this.handleSession(record)
        return
      case 'tool':
        this.handleToolState(record, time)
        return
      case 'msg':
        this.handleMsg(record.msg, time)
        return
    }
  }

  snapshot(): TrajectorySnapshot {
    return this.assembler.snapshot()
  }

  meta(): ParsedSessionMeta {
    return {
      title: this.aiTitle ?? this.firstPromptTitle,
      cwd: this.cwd,
      model: this.model,
      startedAt: this.startedAt,
      promptCount: this.promptCount,
    }
  }

  subagents(): readonly SubagentRun[] {
    return [...this.runs.values()]
      // A placeholder run keyed by its own file id (compactor/summarizer
      // chains and still-unbound children) is not a subagent until a spawn
      // claims it — either `run_subagent` binds it or the agent id resolves.
      .filter(run => run.callId !== null || run.agentId !== run.fileId)
      .map(run => ({
      agentId: run.agentId,
      // Null while the server has not discovered the chain — the agent id is
      // not a stream id, and opening one would 404 the events route.
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

  // ---------------------------------------------------------------------------

  private handleSession(record: Extract<DevinRecord, { tag: 'session' }>): void {
    if (record.title !== null && record.title !== '') this.aiTitle = record.title
    this.cwd ??= record.cwd
    this.model ??= record.model
    this.agentMode ??= record.agentMode
    if (record.time !== null) this.startedAt ??= record.time
    for (const agent of record.agents) {
      this.agentFiles.set(agent.id, agent.fileId)
      const run = this.runs.get(agent.id)
      if (run !== undefined) run.fileId = agent.fileId
    }
    this.assembler.touch()
  }

  private handleMsg(msg: Record<string, unknown>, time: number): void {
    const mid = asString(msg['message_id'])
    if (mid !== undefined) {
      if (this.seenMids.has(mid)) return
      this.seenMids.add(mid)
    }
    const role = asString(msg['role'])
    const stamp = msgTime(msg, time)
    if (this.startedAt === null && stamp > 0) this.startedAt = stamp
    switch (role) {
      case 'system':
        this.handleSystem(msg, stamp)
        return
      case 'user':
        this.handleUser(msg, stamp)
        return
      case 'assistant':
        this.handleAssistant(msg, stamp)
        return
      case 'tool':
        this.handleResult(msg, stamp)
        return
      default:
        return
    }
  }

  private handleSystem(msg: Record<string, unknown>, time: number): void {
    // Background completion notifications carry the chain binding; the earlier
    // spawn receipt only acknowledges launch and must not end the agent run.
    const ext = msgExt(msg)
    const agentId = asString(ext?.['subagent/agent_id'])
    if (agentId !== undefined && asNumber(ext?.['subagent/chain_node_id']) !== undefined) {
      const run = this.runFor(agentId, time)
      run.status = 'completed'
      run.endedAt = time
      run.agentType = asString(ext?.['subagent/profile_name']) ?? run.agentType
      run.model = asString(ext?.['subagent/model']) ?? run.model
      this.assembler.touch()
    }
    if (ext?.['devin-rs/summary'] !== undefined) {
      this.handleCompaction(msg, time)
      return
    }
    const text = msgText(msg)
    if (text.trim() === '') return
    this.assembler.systemPrompts.push({
      seq: this.assembler.seq.next(),
      time,
      turn: Math.max(1, this.turn),
      step: this.step,
      text,
      update: this.systemPromptSeen,
    })
    this.systemPromptSeen = true
    this.assembler.touch()
  }

  /**
   * A `devin-rs/summary` system node: Devin's file compactor replaced the
   * context with this bundle (summary plus kept conversation tail). The node
   * records no compactor model or token counts, so no provenance/usage.
   */
  private handleCompaction(msg: Record<string, unknown>, time: number): void {
    const text = msgText(msg)
    const summary = text.trim() === '' ? null : text
    const seq = this.assembler.seq.next()
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
    }
    this.assembler.upsertRequest(request)
  }

  private handleUser(msg: Record<string, unknown>, time: number): void {
    const classified = devinMessageClass(msg)
    const text = msgText(msg)
    const content: ContentBlock[] = text === '' ? [] : [{ type: 'text', text }]
    if (classified?.kind === 'human') {
      this.turn += 1
      this.step = 0
      this.promptCount += 1
      if (this.firstPromptTitle === null && text.trim() !== '') this.firstPromptTitle = titleFrom(text)
      const node = {
        kind: 'user' as const,
        seq: this.assembler.seq.next(),
        time,
        content,
        source: msg,
      }
      this.assembler.locations.set(node.seq, { kind: 'turn', turn: { turn: this.turn, status: 'open' } })
      this.assembler.pushNode(node)
      return
    }
    const form: KnownContextForm = 'notice'
    const node: ContextMessageNode = {
      kind: 'context',
      seq: this.assembler.seq.next(),
      time,
      content,
      source: msg,
      provenance: { role: 'inject', label: classified?.name ?? 'user' },
      form,
    }
    this.assembler.pushNode(node)
  }

  private handleAssistant(msg: Record<string, unknown>, time: number): void {
    if (this.turn === 0) this.turn = 1
    this.step += 1
    const meta = msgMeta(msg)
    const blocks: AssistantBlock[] = []
    const thinking = isRecord(msg['thinking']) ? msg['thinking'] : undefined
    const thinkingText = asString(thinking?.['thinking']) ?? asString(msg['thinking'])
    if (thinkingText !== undefined && thinkingText !== '') blocks.push({ kind: 'reasoning', text: thinkingText })
    const text = msgText(msg)
    if (text !== '') blocks.push({ kind: 'text', text })
    const calls = toolCallsOf(msg)
    for (const call of calls) {
      blocks.push({ kind: 'tool-call', callId: call.id, name: call.name, argsRaw: call.argsRaw })
    }
    const usage = msgUsage(msg)
    const model = asString(meta?.['generation_model']) ?? this.model
    if (model !== null) this.model = model
    const startedAt = (() => {
      const stamp = asString(meta?.['started_generation_at'])
      const parsed = stamp === undefined ? Number.NaN : Date.parse(stamp)
      return Number.isNaN(parsed) ? time : parsed
    })()
    const metrics = isRecord(meta?.['metrics']) ? meta['metrics'] : undefined
    const ttft = asNumber(metrics?.['ttft_ms'])
    const seq = this.assembler.seq.next()
    const messageId = asString(msg['message_id'])
    const node: AssistantMessageNode = {
      kind: 'assistant',
      seq,
      ...(messageId === undefined ? {} : { messageId }),
      time,
      turn: this.turn,
      step: this.step,
      blocks,
      ...(usage === undefined ? {} : { usage }),
      provenance: { provider: DEVIN_PROVIDER, model: model ?? 'unknown' },
      timing: {
        stepStartTime: startedAt,
        firstTokenTime: ttft === undefined ? null : startedAt + ttft,
        completedTime: time,
      },
    }
    this.assembler.pushNode(node)
    this.assembler.upsertRequest({
      purpose: 'assistant',
      startSeq: seq,
      turn: this.turn,
      step: this.step,
      startedAt,
      completedAt: time,
      status: 'complete',
      provenance: { provider: DEVIN_PROVIDER, model: model ?? 'unknown' },
      requestConfig: { provider: DEVIN_PROVIDER, model: model ?? 'unknown' },
      ...(usage === undefined ? {} : { usage }),
    })
    for (const call of calls) {
      this.assembler.tools.start({
        callId: call.id,
        name: call.name,
        argsRaw: call.argsRaw,
        turn: this.turn,
        step: this.step,
        time,
        subCalls: [],
      })
      if (call.name === SPAWN_TOOL) {
        const args: unknown = parseJsonLine(call.argsRaw)
        const task = isRecord(args) ? asString(args['task']) ?? null : null
        const title = isRecord(args) ? asString(args['title']) ?? null : null
        const profile = isRecord(args) ? asString(args['profile']) ?? null : null
        const background = isRecord(args) && args['is_background'] === true
        this.spawns.push({ callId: call.id, task, title, profile, background, time })
      }
    }
    this.assembler.touch()
  }

  private handleResult(msg: Record<string, unknown>, time: number): void {
    const callId = asString(msg['tool_call_id'])
    if (callId === undefined) return
    const ext = msgExt(msg)
    const resultMeta = isRecord(ext?.['chisel/tool_result_meta']) ? ext['chisel/tool_result_meta'] : undefined
    const timing = isRecord(ext?.['chisel/tool_call_timing']) ? ext['chisel/tool_call_timing'] : undefined
    const durationMs = asNumber(timing?.['duration_ms'])
    const acp = this.acpCalls.get(callId)
    const text = msgText(msg)
    const isError = resultMeta?.['success'] === false
    const completed = this.assembler.tools.complete(callId, {
      seq: this.assembler.seq.next(),
      time,
      content: text === '' ? [] : [{ type: 'text', text }],
      isError,
      meta: {
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(acp?.kind == null ? {} : { acpKind: acp.kind }),
        ...(acp?.title == null ? {} : { title: acp.title }),
      },
    })
    if (completed.topLevel) this.assembler.pushNode(completed.node)
    else this.assembler.touch()

    // A run_subagent result names its chain in `subagent/*` extensions.
    const agentId = asString(ext?.['subagent/agent_id'])
      ?? (AGENT_ID_PATTERN.exec(text)?.[1])
    if (agentId !== undefined && this.spawnOf(callId) !== undefined) {
      const spawn = this.spawnOf(callId)
      const run = this.runFor(agentId, time)
      run.callId = callId
      run.description = spawn?.title ?? spawn?.task ?? run.description
      run.agentType = asString(ext?.['subagent/profile_name']) ?? spawn?.profile ?? run.agentType
      run.model = asString(ext?.['subagent/model']) ?? run.model
      run.startedAt = spawn?.time ?? run.startedAt
      if (isError || !spawn?.background) {
        run.status = isError ? 'failed' : 'completed'
        run.endedAt = time
      } else if (run.endedAt === null) {
        run.status = 'running'
      }
      const fileId = this.agentFiles.get(agentId)
      if (fileId !== undefined) run.fileId = fileId
      this.runByCall.set(callId, run)
    } else {
      const bound = this.runByCall.get(callId)
      if (bound !== undefined) {
        if (isError || !this.spawnOf(callId)?.background) {
          bound.status = isError ? 'failed' : 'completed'
          bound.endedAt = time
        } else if (bound.endedAt === null) {
          bound.status = 'running'
        }
      }
    }
  }

  /** ACP `tool_call_state`: enrich the call's display facts; settle orphaned calls. */
  private handleToolState(record: Extract<DevinRecord, { tag: 'tool' }>, time: number): void {
    const call = record.call
    const update = record.update
    if (call !== null) {
      const title = asString(call['title']) ?? null
      const kind = asString(call['kind']) ?? null
      this.acpCalls.set(record.id, { title, kind })
      const running = this.assembler.tools.pendingCall(record.id)
      if (running !== undefined && (running.argsRaw === '{}' || running.argsRaw === '')) {
        const rawInput = call['rawInput']
        if (rawInput !== undefined) {
          running.argsRaw = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
        }
      }
    }
    const status = asString(update?.['status'])
    if (status !== undefined && TERMINAL_TOOL_STATUS.has(status) && this.assembler.tools.isPending(record.id)) {
      // The tool node never landed (interrupted session): settle the call so it
      // does not stay "running" forever.
      const content = (asArray(update?.['content']) ?? [])
        .flatMap(block => (isRecord(block) && block['type'] === 'text'
          ? [{ type: 'text' as const, text: asString(block['text']) ?? '' }]
          : []))
      const completed = this.assembler.tools.complete(record.id, {
        seq: this.assembler.seq.next(),
        time,
        content,
        isError: status === 'failed',
      })
      if (completed.topLevel) this.assembler.pushNode(completed.node)
      else this.assembler.touch()
    }
    this.assembler.touch()
  }

  private spawnOf(callId: string): DevinSpawn | undefined {
    return this.spawns.find(spawn => spawn.callId === callId)
  }

  private runFor(key: string, time: number): AgentRun {
    const existing = this.runs.get(key)
    if (existing !== undefined) return existing
    const run: AgentRun = {
      agentId: key,
      fileId: this.agentFiles.get(key) ?? null,
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

  /**
   * A child stream contributes counters and tool calls nested under the bound
   * parent call; its messages stay in the child's own (standalone) view.
   * Binding order: the ref's `agent.agentId` when the source resolved it, else
   * the child's first user text matched against pending spawns' `task`.
   */
  private handleChild(file: SessionFileRef, record: DevinRecord, time: number): void {
    if (record.tag !== 'msg') return
    let child = this.childFiles.get(file.id)
    if (child === undefined) {
      const run = this.bindChild(file, record, time)
      child = { task: null, run }
      this.childFiles.set(file.id, child)
    }
    const run = child.run
    run.lastTime = run.lastTime === null ? time : Math.max(run.lastTime, time)
    if (run.status === 'launching') run.status = 'running'
    const msg = record.msg
    const role = asString(msg['role'])
    // The first user message of a child chain is the delegated task text; it
    // binds the file to its spawn when `agent_id` was not resolved yet.
    if (child.task === null && role === 'user') {
      child.task = msgText(msg)
      this.bindByTask(run, child.task)
    }
    if (role === 'assistant') {
      for (const call of toolCallsOf(msg)) {
        if (this.childCalls.has(call.id)) continue
        this.childCalls.add(call.id)
        run.toolCalls += 1
        if (run.callId === null) continue
        this.assembler.tools.start({
          callId: call.id,
          parentCallId: run.callId,
          name: call.name,
          argsRaw: call.argsRaw,
          turn: Math.max(1, this.turn),
          step: this.step,
          time,
          subCalls: [],
        })
        this.assembler.touch()
      }
      return
    }
    if (role !== 'tool') return
    const callId = asString(msg['tool_call_id'])
    if (callId === undefined || !this.childCalls.has(callId)) return
    const ext = msgExt(msg)
    const resultMeta = isRecord(ext?.['chisel/tool_result_meta']) ? ext['chisel/tool_result_meta'] : undefined
    const text = msgText(msg)
    this.assembler.tools.complete(callId, {
      seq: this.assembler.seq.next(),
      time,
      content: text === '' ? [] : [{ type: 'text', text }],
      isError: resultMeta?.['success'] === false,
    })
    this.assembler.touch()
  }

  /** The run a child file belongs to: by resolved agent id, else by task text, else fresh. */
  private bindChild(file: SessionFileRef, record: Extract<DevinRecord, { tag: 'msg' }>, time: number): AgentRun {
    const agentId = file.agent?.agentId
    if (agentId !== undefined && agentId !== file.id) {
      const run = this.runFor(agentId, time)
      run.fileId = file.id
      // The ref's agent facts (spawn title, call id) backfill a run the
      // result binding has not claimed yet.
      run.description ??= file.agent?.description ?? null
      run.agentType ??= file.agent?.agentType ?? null
      if (run.callId === null && file.agent?.toolUseId !== undefined) {
        run.callId = file.agent.toolUseId
        this.runByCall.set(file.agent.toolUseId, run)
      }
      return run
    }
    // Task-text binding happens on the first user line; until then keep a
    // placeholder run so counters still accumulate.
    const run = this.runFor(file.id, time)
    run.fileId = file.id
    return run
  }

  /** Claim the pending spawn whose `task` argument matches the child's prompt. */
  private bindByTask(run: AgentRun, task: string): void {
    if (run.callId !== null || task.trim() === '') return
    const spawn = [...this.spawns].reverse().find(
      candidate => candidate.task === task && this.runByCall.get(candidate.callId) === undefined,
    )
    if (spawn === undefined) return
    run.callId = spawn.callId
    run.description = spawn.title ?? spawn.task
    run.agentType = spawn.profile
    run.startedAt = run.startedAt ?? spawn.time
    this.runByCall.set(spawn.callId, run)
  }
}

/** Create the incremental Devin `sessions.db` parser. */
export function createDevinParser(): SessionParser {
  return new DevinParser()
}
