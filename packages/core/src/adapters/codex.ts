/**
 * Codex rollout adapter: folds `~/.codex/sessions/**\/rollout-*.jsonl` lines
 * into the harness-agnostic trajectory contract.
 *
 * Verified against codex-cli 0.147–0.153 rollouts. Each line is
 * `{ timestamp, ordinal?, type, payload }`; the mapping is documented inline.
 *
 * Tool terminal status comes from `event_msg.item_completed` (`item.status` /
 * `exit_code`) — the output text is only the fallback heuristic. An item is
 * attributed to its call by exact id, then a unique
 * command match against pending and recently settled calls, then the lone
 * open call; a late item flips the already settled node (`markError`).
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

/** A subagent thread nested under one synthetic tool call per run in the parent ledger. */
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
  /** A run boundary passed (its `task_complete`/`turn_aborted`); new activity reopens it. */
  completed: boolean
  /** Count of runs: the nth run's ledger call is `subagent:<fileId>#<n>`. */
  runs: number
  /** `session_meta.subagent_history_start_ordinal`: records below it are the PARENT's inherited history, not the child's own activity. */
  historyStartOrdinal: number | undefined
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
 * internal context, skill catalogs, guardian review prompts). Classification
 * ports `core/src/context/contextual_user_message.rs`: the persisted
 * `internal_chat_message_metadata_passthrough.content_item_kinds` annotation
 * wins; legacy records fall back to each fragment's exact start/end markers —
 * never "any XML tag", or real prompts like `<question>…</question>` would be
 * mistaken for injected context.
 */

type ContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay'

interface ContextMarker {
  readonly start: string
  readonly end: string
  readonly label: string
  readonly form: ContextForm
}

/**
 * Marked fragments — each `ContextualUserFragment`'s `type_markers()`
 * (context-fragments/src/fragment.rs, core/src/context/*). `matches_marked_text`
 * is a case-insensitive starts/ends check on the trimmed text; a fragment with
 * an empty marker never matches by text, so unmarked kinds only classify via
 * `content_item_kinds`.
 */
const CONTEXT_MARKERS: readonly ContextMarker[] = [
  { start: '# AGENTS.md instructions', end: '</INSTRUCTIONS>', label: 'agents-md', form: 'instructions' },
  { start: '<environment_context>', end: '</environment_context>', label: 'environment-context', form: 'snapshot' },
  { start: '<skill>', end: '</skill>', label: 'skill', form: 'catalog' },
  { start: '<user_shell_command>', end: '</user_shell_command>', label: 'user-shell-command', form: 'notice' },
  { start: '<turn_aborted>', end: '</turn_aborted>', label: 'turn-aborted', form: 'notice' },
  { start: '<subagent_notification>', end: '</subagent_notification>', label: 'subagent-notification', form: 'relay' },
  { start: '<recommended_plugins>', end: '</recommended_plugins>', label: 'recommended-plugins', form: 'catalog' },
  { start: '<goal_context>', end: '</goal_context>', label: 'internal-context', form: 'snapshot' },
]

/** `matches_marked_text`: trim, then ASCII-insensitive prefix + suffix. */
function matchesMarkedText(start: string, end: string, text: string): boolean {
  if (start === '' || end === '') return false
  const trimmed = text.trim()
  const head = trimmed.slice(0, start.length)
  const tail = trimmed.slice(Math.max(0, trimmed.length - end.length))
  return head.toLowerCase() === start.toLowerCase() && tail.toLowerCase() === end.toLowerCase()
}

// `<codex_internal_context source="[a-z][a-z0-9_]*">…</codex_internal_context>`
// (internal_model_context.rs) — the source attribute is part of the marker.
const INTERNAL_CONTEXT = /^<codex_internal_context source="[a-z][a-z0-9_]*">/
// `<external_KEY>…</external_KEY>` — the closing tag must name the same key
// (context-fragments/src/additional_context.rs).
const EXTERNAL_CONTEXT = /^<external_([A-Za-z0-9_-]+)>/
// `<hook_prompt hook_run_id="…">…</hook_prompt>`
// (protocol/src/items.rs `parse_hook_prompt_fragment`).
const HOOK_PROMPT = /^<hook_prompt\b[^>]*\bhook_run_id="[^"]+"/

/** Unmarked fragments matched by exact prefixes (legacy warnings + guardian relay). */
const CONTEXT_PREFIXES: readonly { prefix: string; end?: string; label: string; form: ContextForm }[] = [
  { prefix: 'Warning: apply_patch was requested via ', end: 'Use the apply_patch tool instead of exec_command.', label: 'warning', form: 'notice' },
  { prefix: 'Warning: Your account was flagged for potentially high-risk cyber activity', label: 'warning', form: 'notice' },
  { prefix: 'Warning: The maximum number of unified exec processes you can keep open is', label: 'warning', form: 'notice' },
  // Guardian review prompts are assembled from fixed fragments
  // (guardian-context/src/composition.rs, guardian-context/src/profile.rs).
  { prefix: 'The following is the Codex agent history', label: 'guardian-history', form: 'relay' },
  { prefix: 'The Codex agent has requested the following', label: 'guardian-action', form: 'relay' },
  { prefix: 'Assess the exact planned action below', label: 'guardian-action', form: 'relay' },
  { prefix: 'Planned action JSON:', label: 'guardian-action', form: 'relay' },
  { prefix: 'Reviewed Codex session id:', label: 'guardian-session', form: 'relay' },
  { prefix: 'Some conversation entries were omitted.', label: 'guardian-transcript', form: 'relay' },
]

/** Guardian transcript sentinels — whole-line markers like `>>> TRANSCRIPT START`. */
const GUARDIAN_SENTINEL = /^>>> (?:TRANSCRIPT (?:DELTA )?(?:START|END)|APPROVAL REQUEST (?:START|END))\s*$/
/** Guardian transcript entries — `[1] user: …`, `[94] tool exec result: …`. */
const GUARDIAN_ENTRY = /^\[\d+\] (?:user|assistant|tool)\b/

/**
 * The text-level fallback: does one `input_text` item look like an injected
 * fragment? Mirrors `is_standard_contextual_user_text` plus the legacy
 * warnings; anything unmatched is a person's prompt.
 */
function classifyUserText(text: string): UserMessageClass {
  const trimmed = text.trim()
  for (const marker of CONTEXT_MARKERS) {
    if (matchesMarkedText(marker.start, marker.end, trimmed)) {
      return { kind: 'context', label: marker.label, form: marker.form }
    }
  }
  if (INTERNAL_CONTEXT.test(trimmed) && trimmed.endsWith('</codex_internal_context>')) {
    return { kind: 'context', label: 'internal-context', form: 'snapshot' }
  }
  const external = EXTERNAL_CONTEXT.exec(trimmed)
  if (external !== null && trimmed.endsWith(`</external_${external[1]}>`)) {
    return { kind: 'context', label: 'external-context', form: 'notice' }
  }
  if (HOOK_PROMPT.test(trimmed) && trimmed.endsWith('</hook_prompt>')) {
    return { kind: 'context', label: 'hook-prompt', form: 'notice' }
  }
  for (const { prefix, end, label, form } of CONTEXT_PREFIXES) {
    if (trimmed.startsWith(prefix) && (end === undefined || trimmed.endsWith(end))) {
      return { kind: 'context', label, form }
    }
  }
  if (GUARDIAN_SENTINEL.test(trimmed) || GUARDIAN_ENTRY.test(trimmed)) {
    return { kind: 'context', label: 'guardian-transcript', form: 'relay' }
  }
  return { kind: 'human' }
}

/** Whether a single Codex `input_text` item is a person's prompt rather than injected context. */
export function isCodexHumanPrompt(text: string): boolean {
  return classifyUserText(text).kind === 'human'
}

/** One content item of a user-role message with its provenance classification. */
export interface CodexUserItem {
  /** The raw `content[]` element. */
  readonly item: Record<string, unknown>
  /** `input_text` text; `''` for media items. */
  readonly text: string
  /** Person-authored input, versus an injected context fragment. */
  readonly human: boolean
  /** Injected-fragment label — the marker name or `content_item_kinds` value. */
  readonly label?: string
  readonly form?: 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay'
}

/**
 * `content_item_kinds` values Codex counts as user-authored
 * (`is_user_authorization_message`): `user.*` items, plus the empty/unknown
 * kinds and media-preparation placeholders that replace real user input.
 */
function isUserContentKind(kind: string): boolean {
  return kind.startsWith('user.')
    || kind === ''
    || kind === 'unknown'
    || kind === 'images.preparation_error'
    || kind === 'images.unsupported'
    || kind === 'audio.unsupported'
}

function contextItem(item: Record<string, unknown>, text: string, label: string): CodexUserItem {
  return { item, text, human: false, label, form: 'notice' }
}

/**
 * Classify every content item of a user-role `message` payload, in order. The
 * persisted `content_item_kinds` annotation classifies by position when it
 * covers every content item; otherwise each `input_text` item falls back to
 * its text markers (the legacy un-annotated format). Items that are not
 * `input_text` are never contextual fragments — media is user input unless an
 * annotation says otherwise.
 */
export function codexUserItems(payload: Record<string, unknown>): CodexUserItem[] {
  const content = asArray(payload['content']) ?? []
  const meta = payload['internal_chat_message_metadata_passthrough']
  const kinds = isRecord(meta) ? asArray(meta['content_item_kinds']) : undefined
  const annotated = kinds !== undefined && kinds.length > 0 && kinds.length === content.length
  const items: CodexUserItem[] = []
  for (let i = 0; i < content.length; i += 1) {
    const item = content[i]
    if (!isRecord(item)) continue
    const text = asString(item['text']) ?? ''
    if (annotated) {
      const kind = asString(kinds[i]) ?? ''
      items.push(isUserContentKind(kind)
        ? { item, text, human: true }
        : contextItem(item, text, kind === '' ? 'context' : kind))
      continue
    }
    if (asString(item['type']) !== 'input_text') {
      items.push({ item, text, human: true })
      continue
    }
    const cls = classifyUserText(text)
    items.push(cls.kind === 'human'
      ? { item, text, human: true }
      : { item, text, human: false, label: cls.label, form: cls.form })
  }
  return items
}

/**
 * The joined text of a user message's human items — its countable, searchable
 * prompt — or null when the message carries none. An image-only message counts
 * as human input but contributes no text.
 */
export function codexHumanPromptText(payload: Record<string, unknown>): string | null {
  const human = codexUserItems(payload).filter(item => item.human)
  if (human.length === 0) return null
  return human.map(item => item.text).filter(text => text !== '').join('\n')
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
  // Unified-exec puts the exit code after Chunk ID / Wall time, before Output.
  // Stop at the first non-header line so quoted output cannot become status.
  for (const line of text.trimStart().split('\n')) {
    const exited = /^Process exited with code (-?\d+)\s*$/.exec(line)
    if (exited !== null) return Number(exited[1]) !== 0
    if (!/^(?:Chunk ID: \S+|Wall time: [\d.]+ seconds)\s*$/.test(line)) break
  }
  return /^\s*(?:Error:|error:|Script failed|Traceback \(most recent call last\))/.test(text)
}

/**
 * Readable text of a `reasoning` response item: the `summary[]` item texts,
 * then `content[]` items of type `reasoning_text` or `text` (plaintext the model chose
 * to show; `encrypted_content` is opaque and never decoded). Content texts
 * identical to a summary text are not repeated.
 */
export function codexReasoningText(payload: Record<string, unknown>): string {
  const texts: string[] = []
  for (const item of asArray(payload['summary']) ?? []) {
    if (!isRecord(item)) continue
    const text = asString(item['text'])
    if (text !== undefined && text !== '') texts.push(text)
  }
  for (const item of asArray(payload['content']) ?? []) {
    if (!isRecord(item) || (item['type'] !== 'reasoning_text' && item['type'] !== 'text')) continue
    const text = asString(item['text'])
    if (text !== undefined && text !== '' && !texts.includes(text)) texts.push(text)
  }
  return texts.join('\n\n')
}

/**
 * The command a CommandExecution item ran: `command` is argv, and the shell's
 * `-c` argument (or the bare argv) is what a call's raw arguments contain.
 */
export function codexCommandOf(item: Record<string, unknown>): string | undefined {
  const argv = (asArray(item['command']) ?? []).filter((part): part is string => typeof part === 'string')
  if (argv.length === 0) return undefined
  const dashC = argv.findIndex(part => part === '-c' || part === '-lc' || part === '-cl')
  return dashC >= 0 ? argv[dashC + 1] : argv.join(' ')
}

/** Match a legacy item's full command against decoded shell call arguments. */
export function codexCommandMatches(command: string, argsRaw: string): boolean {
  // Custom/legacy shell tools can carry the command as their entire input.
  if (argsRaw === command) return true
  const args = parseJsonLine(argsRaw)
  if (!isRecord(args)) return false
  const value = args['cmd'] ?? args['command']
  if (typeof value === 'string') return value === command
  if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) return false
  return codexCommandOf({ command: value }) === command
}

/** Canonical task paths identify modern agents; older builds assign nicknames. */
export function codexAgentName(payload: Record<string, unknown>): string | undefined {
  const source = payload['source']
  const subagent = isRecord(source) ? source['subagent'] : undefined
  const spawn = isRecord(subagent) && isRecord(subagent['thread_spawn']) ? subagent['thread_spawn'] : undefined
  for (const value of [payload['agent_path'], spawn?.['agent_path'], payload['agent_nickname'], spawn?.['agent_nickname']]) {
    const name = asString(value)?.trim()
    if (name) return name
  }
  return undefined
}

/** Older agent sources carry descriptions rather than a named agent identity. */
export function codexSubagentLabel(payload: Record<string, unknown>): string | undefined {
  const name = codexAgentName(payload)
  if (name !== undefined) return name
  const source = payload['source']
  const subagent = isRecord(source) ? source['subagent'] : undefined
  if (isRecord(source)) {
    if (isRecord(subagent)) {
      for (const value of Object.values(subagent)) {
        if (typeof value === 'string' && value !== '') return value
      }
      const [firstKey] = Object.keys(subagent)
      if (firstKey !== undefined && firstKey !== 'thread_spawn') return firstKey
    }
    if (typeof subagent === 'string' && subagent !== '') return subagent
  }
  return asString(payload['thread_source'])
    ?? (subagent !== undefined || asString(payload['parent_thread_id']) !== undefined ? 'subagent' : undefined)
}

class CodexParser implements SessionParser {
  readonly kind = 'codex' as const
  readonly images = new DataUrlImageStore()

  private readonly assembler = new TrajectoryAssembler()
  /** Display turn of the records currently streaming in. */
  private turn = 0
  private step = 0
  /** `task_started` opened a turn whose human prompt has not arrived yet. */
  private turnOpenPending = false
  /**
   * A `task_started` turn is still awaiting its `task_complete`/`turn_aborted`:
   * input landing inside it is steering, not a new turn (core/session/turn.rs).
   */
  private turnActive = false
  /** Monotonic counter new turns draw their display number from. */
  private turnCounter = 0
  /** Persisted `turn_id` → display turn, so annotated records join their turn. */
  private readonly turnByTurnId = new Map<string, number>()
  private lastInputTime: number | null = null
  private lastTime = 0
  private open: OpenStep | null = null
  /**
   * `token_usage_record`s that arrived with no open step — usage-only
   * responses such as remote compaction — keyed by `response_id` so the
   * `compacted` record's `compaction_response_id` can claim them.
   */
  private readonly unclaimedUsage = new Map<string, TokenUsage>()
  /**
   * A child thread served standalone keeps its own copy of
   * `subagent_history_start_ordinal` (or gets it early through
   * `SessionFileRef`): records below it are the parent's materialized history.
   */
  private historyStartOrdinal: number | undefined
  private readonly lastRequestSeqByTurn = new Map<number, number>()
  private readonly turnSeqs = new Map<number, number[]>()
  private readonly children = new Map<string, ChildThread>()
  /** Terminal `item_completed` failure seen before the call's output folded. */
  private readonly failedCalls = new Set<string>()
  /** `argsRaw` of the most recently settled calls, for late item attribution (bounded, oldest evicted). */
  private readonly recentSettled = new Map<string, string>()
  /** Calls settled since the newest call opened; resets on every call start. */
  private settledSinceOpen = 0
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

  push(line: string, file: SessionFileRef, lineIndex?: number): void {
    this.assembler.beginLine(file.id, lineIndex)
    const record = parseJsonLine(line)
    if (!isRecord(record)) return
    const time = parseTime(record['timestamp']) ?? this.lastTime
    if (time > this.lastTime) this.lastTime = time
    const type = asString(record['type'])
    if (type === undefined) return
    const payload = isRecord(record['payload']) ? record['payload'] : {}
    if (file.role === 'child') {
      this.handleChild(file, type, payload, time, asNumber(record['ordinal']))
      return
    }
    // A child thread opened standalone parses its file as `main`; records
    // below `subagent_history_start_ordinal` are the parent's materialized
    // history, not this thread's activity. `session_meta` itself always
    // parses — it is where the boundary arrives — and the `SessionFileRef`
    // hint covers lineage-base records replayed ahead of it.
    const boundary = file.historyStartOrdinal ?? this.historyStartOrdinal
    if (type === 'session_meta' && boundary !== undefined && asString(payload['id']) !== file.id) return
    if (type !== 'session_meta' && boundary !== undefined) {
      const ordinal = asNumber(record['ordinal'])
      if (ordinal !== undefined && ordinal < boundary) return
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
      case 'realtime_item':
        // Speech is presentation-only. Promoted BEM items already appear as
        // response_items; they must not create another request or prompt.
        if (payload['type'] === 'transcript_segment' && typeof payload['text'] === 'string') {
          const lastInputTime = this.lastInputTime
          this.pushContext([{ type: 'text', text: payload['text'] }], `realtime-${asString(payload['role']) ?? 'unknown'}`, 'notice', time)
          this.lastInputTime = lastInputTime
        }
        return
      case 'token_usage_record': {
        const usage = mapUsage(payload['usage'])
        if (this.open !== null) {
          // The record closes a COMPLETED model response (its `response_id`
          // names it): without a boundary, a continued turn (`end_turn=false`)
          // folds the next response into this step and overwrites its usage.
          this.attachUsage(usage, true)
          this.closeOpenStep('complete')
        } else if (usage !== undefined) {
          // Usage with no open step belongs to a usage-only response — a
          // remote compaction's, claimed later by `compaction_response_id` —
          // or outlived its step. Attaching it to the previous request would
          // overwrite that request's own usage, so it waits here instead.
          const responseId = asString(payload['response_id']) ?? ''
          this.unclaimedUsage.delete(responseId)
          this.unclaimedUsage.set(responseId, usage)
          if (this.unclaimedUsage.size > 32) {
            const oldest = this.unclaimedUsage.keys().next().value
            if (oldest !== undefined) this.unclaimedUsage.delete(oldest)
          }
        }
        return
      }
      case 'compacted':
        this.handleCompaction(payload, time)
        return
      case 'inter_agent_communication':
        this.handleAgentRelay(interAgentText(payload), agentRoute(payload), time)
        return
      case 'world_state':
        this.handleWorldState(payload, time)
        return
      case 'retained_context':
        this.handleRetainedContext(payload, time)
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
    const source = payload['source']
    if (asString(payload['parent_thread_id']) !== undefined || (isRecord(source) && source['subagent'] !== undefined)) {
      this.title ??= codexAgentName(payload) ?? null
    }
    this.startedAt ??= parseTime(payload['timestamp']) ?? time
    this.cwd ??= asString(payload['cwd']) ?? null
    // Persisted as a stringified number (`"24"`) in some builds.
    const rawStart = payload['subagent_history_start_ordinal']
    this.historyStartOrdinal ??= asNumber(rawStart)
      ?? (typeof rawStart === 'string' ? asNumber(Number(rawStart)) : undefined)
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
        this.openTurn(asString(payload['turn_id']))
        this.lastInputTime = parseTime(payload['started_at']) ?? time
        return
      }
      case 'task_complete': {
        this.closeOpenStep('complete')
        this.closeTurn(this.resolveTurn(asString(payload['turn_id'])))
        this.turnActive = false
        this.turnOpenPending = false
        return
      }
      case 'turn_aborted': {
        const reason = asString(payload['reason'])
        this.closeOpenStep('error', reason === undefined ? 'Turn aborted' : `Turn aborted (${reason})`)
        const turn = this.resolveTurn(asString(payload['turn_id']))
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
        this.closeTurn(turn)
        this.turnActive = false
        this.turnOpenPending = false
        return
      }
      case 'token_count': {
        const info = payload['info']
        if (isRecord(info)) this.attachUsage(mapUsage(info['last_token_usage']), false)
        return
      }
      case 'item_completed':
        this.handleItemCompleted(payload)
        return
      case 'thread_rolled_back': {
        // Legacy marker: the last N user turns were dropped from model context
        // (thread_rollout_truncation.rs). The records stay in the ledger; the
        // marker says Codex no longer counts them as live context.
        const numTurns = asNumber(payload['num_turns']) ?? 0
        if (numTurns <= 0) return
        this.closeOpenStep('complete')
        const turn = Math.max(1, this.turn)
        const seq = this.assembler.seq.next()
        this.assembler.pushNode({
          kind: 'turn-error',
          seq,
          time,
          turn,
          step: this.step,
          message: `Rolled back ${numTurns} turn${numTurns === 1 ? '' : 's'}`,
          code: 'thread_rolled_back',
        })
        this.locate(seq, turn)
        return
      }
      case 'thread_settings_applied': {
        // Durable settings snapshot: model/effort/cwd may change mid-thread and
        // attribute every request after this record.
        const settings = payload['thread_settings']
        if (!isRecord(settings)) return
        const model = asString(settings['model'])
        if (model !== undefined && model !== '') this.model = model
        const provider = asString(settings['model_provider_id'])
        if (provider !== undefined && provider !== '') this.provider = provider
        const effort = asString(settings['reasoning_effort'])
        if (effort !== undefined && effort !== '') this.effort = effort
        const cwd = asString(settings['cwd'])
        if (cwd !== undefined && cwd !== '') this.cwd = cwd
        return
      }
      case 'thread_goal_updated': {
        const goal = payload['goal']
        const objective = isRecord(goal) ? asString(goal['objective']) : undefined
        if (objective === undefined || objective === '') return
        this.pushContext(
          [{ type: 'text', text: objective }],
          'thread-goal',
          'notice',
          time,
        )
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
        const text = codexReasoningText(payload)
        if (text === '') return
        this.appendBlock({ kind: 'reasoning', text }, time)
        return
      }
      case 'custom_tool_call':
      case 'function_call':
      case 'local_shell_call':
      case 'tool_search_call':
        this.handleToolCall(payload, time, undefined)
        return
      case 'custom_tool_call_output':
      case 'function_call_output':
      case 'local_shell_call_output':
        this.closeOpenStep('complete')
        this.handleToolOutput(payload, time)
        this.lastInputTime = time
        return
      case 'tool_search_output': {
        this.closeOpenStep('complete')
        // `tool_search_output` carries `tools` (the discovered schemas), not `output`.
        this.handleToolOutput(payload, time, asArray(payload['tools']))
        this.lastInputTime = time
        return
      }
      case 'web_search_call':
        this.handleWebSearch(payload, time)
        return
      case 'image_generation_call':
        this.handleImageGeneration(payload, time)
        return
      case 'agent_message':
        this.handleAgentRelay(agentMessageText(payload), agentRoute(payload), time)
        return
      case 'configuration_update':
        this.handleConfigurationUpdate(payload, time)
        return
      case 'compaction':
      case 'context_compaction':
        this.handleCompaction(payload, time)
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
    if (role === 'developer') {
      this.pushContext(this.contentBlocks(items), 'developer', 'instructions', time)
      return
    }
    if (role !== 'user') return
    // Per-item classification (codex `is_contextual_user_fragment`): injected
    // fragments render as context nodes; human items — and media, which is
    // never a contextual fragment — form the user node. Blocks are built per
    // part: `contentBlocks` registers images, so re-blocking `items` here would
    // add them twice.
    const classified = codexUserItems(payload)
    const contextParts = classified.filter(item => !item.human)
    const humanParts = classified.filter(item => item.human)
    if (humanParts.length === 0) {
      if (contextParts.length === 0) return
      const first = contextParts[0]
      this.pushContext(
        this.contentBlocks(contextParts.map(part => part.item)),
        first?.label ?? 'context',
        first?.form ?? 'notice',
        time,
      )
      return
    }
    for (const part of contextParts) {
      this.pushContext(this.contentBlocks([part.item]), part.label ?? 'context', part.form ?? 'notice', time)
    }
    const humanContent = this.contentBlocks(humanParts.map(part => part.item))
    this.closeOpenStep('complete')
    if (!this.turnOpenPending) {
      const turnId = recordTurnId(payload)
      const mapped = turnId === undefined ? undefined : this.turnByTurnId.get(turnId)
      if (mapped !== undefined) {
        // Annotated input joins the turn its `turn_id` names — steering lands
        // mid-turn, after the turn's first prompt was already counted.
        this.turn = mapped
      } else if (this.turnActive) {
        // Un-annotated input inside an open turn: steering too (the turn's
        // `task_complete` has not been written yet).
        if (turnId !== undefined) this.turnByTurnId.set(turnId, this.turn)
      } else {
        this.turnCounter += 1
        this.turn = this.turnCounter
        if (turnId !== undefined) this.turnByTurnId.set(turnId, this.turn)
        this.step = 0
      }
    }
    this.turnOpenPending = false
    this.promptCount += 1
    const text = humanParts.map(part => part.text).filter(part => part !== '').join('\n')
    if (this.title === null && text.trim() !== '') this.title = titleFrom(text)
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({ kind: 'user', seq, time, content: humanContent, source: { kind: 'user' } })
    this.locate(seq, this.turn)
    this.lastInputTime = time
  }

  private pushContext(
    content: readonly ContentBlock[],
    label: string,
    form: 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay',
    time: number,
    /** Optional endpoint/route detail (e.g. an agent-message's `author → recipient`). */
    name?: string,
  ): void {
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({
      kind: 'context',
      seq,
      time,
      content,
      source: { kind: 'plugin', plugin: label, ...(name === undefined ? {} : { name }) },
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
    const bare = type === 'local_shell_call'
      ? 'local_shell'
      : type === 'tool_search_call'
        // A tool-search call names no tool; Codex's qualified id is
        // `tool_search.tool_search_tool` (core/tools/tool_namespaces_info.rs).
        ? 'tool_search'
        : (asString(payload['name']) ?? 'tool')
    // `namespace` distinguishes same-named functions across dynamic-tool
    // namespaces (protocol `ToolName` displays as `namespace.name`; the
    // default `functions` namespace stays unqualified).
    const namespace = asString(payload['namespace'])
    const name = namespace === undefined || namespace === '' || namespace === 'functions'
      ? bare
      : `${namespace}.${bare}`
    const argsRaw = type === 'local_shell_call'
      ? JSON.stringify(payload['action'] ?? null)
      : (asString(payload['input']) ?? asString(payload['arguments'])
        ?? (payload['input'] === undefined && payload['arguments'] === undefined
          ? ''
          : JSON.stringify(payload['input'] ?? payload['arguments'])))
    this.settledSinceOpen = 0
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

  private handleToolOutput(
    payload: Record<string, unknown>,
    time: number,
    /** Structured result for outputs that carry no `output` field (tool_search's `tools`). */
    itemsOverride?: readonly unknown[],
  ): void {
    const callId = asString(payload['call_id'])
    const output = payload['output']
    const content: ContentBlock[] = itemsOverride !== undefined
      ? [{ type: 'text', text: stringifyRaw(itemsOverride) ?? '' }]
      : typeof output === 'string'
        ? [{ type: 'text', text: output }]
        : this.contentBlocks(asArray(output) ?? [])
    if (callId === undefined) {
      this.pushContext(content, asString(payload['name']) ?? 'standalone-tool-output', 'notice', time)
      this.lastInputTime = time
      return
    }
    const text = textOf(content)
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(callId, {
      seq,
      time,
      content,
      // An `item_completed` failure beats the output text heuristic.
      isError: this.failedCalls.delete(callId) || outputLooksFailed(payload, text),
    })
    this.noteSettled(callId, node.call?.argsRaw)
    if (topLevel) {
      this.assembler.pushNode(node)
      this.locate(seq, Math.max(1, this.turn))
    } else {
      this.assembler.touch()
    }
  }

  /**
   * `event_msg.item_completed` mirrors a response item and carries the call's
   * TERMINAL status (`item.status`, and `exit_code` for commands) — the only
   * honest failure signal when the output text itself looks fine. The item
   * usually lands between the call and its `function_call_output`, sometimes
   * after the output already folded, in which case the settled node is
   * flipped instead. Current CommandExecution and McpToolCall producers use
   * the call id. Older unmatched items use the compatibility lookup below;
   * ambiguous matches are left alone.
   */
  private handleItemCompleted(payload: Record<string, unknown>): void {
    const item = payload['item']
    if (!isRecord(item)) return
    const kind = asString(item['type'])
    if (kind !== 'CommandExecution' && kind !== 'FileChange' && kind !== 'McpToolCall') return
    const exitCode = asNumber(item['exit_code'])
    const failed = asString(item['status']) === 'failed' || (exitCode !== undefined && exitCode !== 0)
    if (!failed) return
    const callId = this.attributeCompletedItem(item)
    if (callId === undefined) return
    if (this.assembler.tools.isPending(callId)) this.failedCalls.add(callId)
    else if (this.assembler.tools.markError(callId)) this.assembler.touch()
  }

  /**
   * The call an `item_completed` belongs to, when one can be proven — across
   * BOTH pending and recently settled calls, since a late item lands after
   * its own result folded. Order: exact item id → unique command-content
   * match → the lone open call when nothing has settled since it opened.
   */
  private attributeCompletedItem(item: Record<string, unknown>): string | undefined {
    const itemId = asString(item['id'])
    if (itemId !== undefined && this.assembler.tools.has(itemId)) return itemId
    const command = codexCommandOf(item)
    if (command !== undefined) {
      let matched: string | undefined
      for (const callId of this.assembler.tools.pendingIds()) {
        if (!codexCommandMatches(command, this.assembler.tools.pendingCall(callId)?.argsRaw ?? '')) continue
        if (matched !== undefined) return undefined
        matched = callId
      }
      for (const [callId, argsRaw] of this.recentSettled) {
        if (!codexCommandMatches(command, argsRaw)) continue
        if (matched !== undefined) return undefined
        matched = callId
      }
      if (matched !== undefined) return matched
    }
    const running = this.assembler.tools.runningCalls()
    if (running.length === 1 && this.settledSinceOpen === 0) return running[0]?.callId
    return undefined
  }

  /** Remember a settled call for late item attribution (bounded, oldest evicted). */
  private noteSettled(callId: string, argsRaw: string | null | undefined): void {
    if (argsRaw !== undefined && argsRaw !== null) {
      this.recentSettled.delete(callId)
      this.recentSettled.set(callId, argsRaw)
      if (this.recentSettled.size > 64) {
        const oldest = this.recentSettled.keys().next().value
        if (oldest !== undefined) this.recentSettled.delete(oldest)
      }
    }
    this.settledSinceOpen += 1
  }

  /**
   * `web_search_call` is self-contained: the Responses API writes one durable
   * item whose `action` and terminal `status` describe the whole call, so the
   * ledger call completes on arrival instead of waiting for an output item.
   */
  private handleWebSearch(payload: Record<string, unknown>, time: number): void {
    const callId = asString(payload['id'])
    if (callId === undefined) return
    const argsRaw = stringifyRaw(payload['action']) ?? ''
    this.appendBlock({ kind: 'tool-call', callId, name: 'web_search', argsRaw }, time)
    this.assembler.tools.start({
      callId,
      name: 'web_search',
      argsRaw,
      turn: Math.max(1, this.turn),
      step: this.open?.step ?? this.step,
      time,
      subCalls: [],
    })
    const status = asString(payload['status'])
    this.completeSelfContained(callId, [], status, time)
  }

  /**
   * `image_generation_call` likewise arrives complete: `result` is the
   * base64 image itself (empty when generation failed), `revised_prompt`
   * the prompt the backend actually used.
   */
  private handleImageGeneration(payload: Record<string, unknown>, time: number): void {
    const callId = asString(payload['id'])
    if (callId === undefined) return
    const prompt = asString(payload['revised_prompt']) ?? ''
    this.appendBlock(
      { kind: 'tool-call', callId, name: 'image_generation', argsRaw: stringifyRaw({ prompt }) ?? '' },
      time,
    )
    this.assembler.tools.start({
      callId,
      name: 'image_generation',
      argsRaw: prompt,
      turn: Math.max(1, this.turn),
      step: this.open?.step ?? this.step,
      time,
      subCalls: [],
    })
    const result = asString(payload['result'])
    const content: ContentBlock[] = result === undefined || result === ''
      ? []
      : [{ type: 'image', attachment: this.images.add(result, 'image/png') }]
    this.completeSelfContained(callId, content, asString(payload['status']), time)
  }

  /** Settle a self-contained call (web search / image generation carry no output item). */
  private completeSelfContained(
    callId: string,
    content: readonly ContentBlock[],
    status: string | undefined,
    time: number,
  ): void {
    const seq = this.assembler.seq.next()
    const { node, topLevel } = this.assembler.tools.complete(callId, {
      seq,
      time,
      content,
      isError: status === 'failed' || status === 'error' || status === 'incomplete',
    })
    this.noteSettled(callId, node.call?.argsRaw)
    if (topLevel) {
      this.assembler.pushNode(node)
      this.locate(seq, Math.max(1, this.turn))
    } else {
      this.assembler.touch()
    }
  }

  /**
   * Agent-to-agent traffic (`agent_message` response items and the top-level
   * `inter_agent_communication` record) is model-visible context, not human
   * input: it renders as a relay context node naming both endpoints.
   */
  private handleAgentRelay(text: string, route: string, time: number): void {
    if (text === '') return
    this.pushContext(
      [{ type: 'text', text }],
      'agent-message',
      'relay',
      time,
      route === '' ? undefined : route,
    )
  }

  /**
   * `configuration_update` is a durable input control — today it only carries
   * the reasoning effort the backend should apply from this point on
   * (protocol `ConfigurationReasoning`). Update attribution for later steps.
   */
  private handleConfigurationUpdate(payload: Record<string, unknown>, time: number): void {
    const reasoning = payload['reasoning']
    const effort = isRecord(reasoning) ? asString(reasoning['effort']) : undefined
    if (effort === undefined || effort === '') return
    if (effort === this.effort) return
    this.effort = effort
    this.pushContext(
      [{ type: 'text', text: `Reasoning effort set to ${effort}` }],
      'configuration-update',
      'notice',
      time,
    )
  }

  /**
   * `world_state` is a durable snapshot of the standing instructions Codex
   * folds into every request (agents_md, host skills, git state…). Its text is
   * already sized by the injections it mirrors, so the trajectory keeps only a
   * marker naming the snapshot's sections.
   */
  private handleWorldState(payload: Record<string, unknown>, time: number): void {
    const state = payload['state']
    if (!isRecord(state)) return
    const keys = Object.keys(state).filter(key => key !== '')
    if (keys.length === 0) return
    const scope = payload['full'] === false ? 'patch' : 'snapshot'
    this.pushContext(
      [{ type: 'text', text: `World state ${scope}: ${keys.join(', ')}` }],
      'world-state',
      'snapshot',
      time,
    )
  }

  /**
   * `retained_context` checkpoints host-held facts — today only
   * `verified_answer`, the user's accepted `request_user_input` replies
   * (history/retained_context.rs). Model-invisible to Codex, but they are
   * user-authored answers, so the ledger shows them as a relay notice.
   */
  private handleRetainedContext(payload: Record<string, unknown>, time: number): void {
    if (asString(payload['type']) !== 'verified_answer') return
    const lines = (asArray(payload['questions']) ?? [])
      .flatMap(entry => {
        if (!isRecord(entry)) return []
        const question = asString(entry['question']) ?? ''
        const answer = asString(entry['answer']) ?? ''
        return question === '' && answer === '' ? [] : [`Q: ${question}\nA: ${answer}`]
      })
    if (lines.length === 0) return
    this.pushContext(
      [{ type: 'text', text: lines.join('\n\n') }],
      'verified-answer',
      'relay',
      time,
    )
  }

  private handleCompaction(payload: Record<string, unknown>, time: number): void {
    this.closeOpenStep('complete')
    const message = asString(payload['message']) ?? ''
    // A remote compaction's own response writes a `token_usage_record` like
    // any other but produces no step; it was buffered on arrival and is
    // claimed here by `compaction_response_id` (a single outstanding buffer
    // entry is claimed unconditionally — nothing else could own it).
    const responseId = asString(payload['compaction_response_id'])
    let usage = responseId === undefined ? undefined : this.unclaimedUsage.get(responseId)
    if (usage === undefined && this.unclaimedUsage.size === 1) {
      usage = this.unclaimedUsage.values().next().value
      this.unclaimedUsage.clear()
    } else if (responseId !== undefined) {
      this.unclaimedUsage.delete(responseId)
    }
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
      ...(usage === undefined ? {} : { usage }),
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

  /** Open the turn `task_started` names, reusing an id the stream already mapped. */
  private openTurn(turnId: string | undefined): void {
    const mapped = turnId === undefined ? undefined : this.turnByTurnId.get(turnId)
    if (mapped !== undefined) {
      this.turn = mapped
    } else {
      this.turnCounter += 1
      this.turn = this.turnCounter
      if (turnId !== undefined) this.turnByTurnId.set(turnId, this.turn)
    }
    this.step = 0
    this.turnActive = true
    this.turnOpenPending = true
  }

  /** The display turn a completion event names — its own mapping, else the open one. */
  private resolveTurn(turnId: string | undefined): number {
    if (turnId !== undefined) {
      const mapped = this.turnByTurnId.get(turnId)
      if (mapped !== undefined) return mapped
    }
    return Math.max(1, this.turn)
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
    ordinal: number | undefined,
  ): void {
    // Lineage bases replay before the owning header. Neither their identity
    // nor their activity belongs to this child run.
    if (type === 'session_meta' && asString(payload['id']) !== file.id) return
    const boundary = file.historyStartOrdinal ?? this.children.get(file.id)?.historyStartOrdinal
    if (type !== 'session_meta' && boundary !== undefined && ordinal !== undefined && ordinal < boundary) return
    let child = this.children.get(file.id)
    if (child === undefined) {
      const label = type === 'session_meta' ? codexSubagentLabel(payload) ?? 'subagent' : 'subagent'
      const threadId = file.id
      child = {
        callId: `subagent:${file.id}`, fileId: file.id, threadId, label, startedAt: time,
        endedAt: null, lastTime: time, toolCalls: 0, lastAgentMessage: null,
        completed: false, runs: 0, historyStartOrdinal: file.historyStartOrdinal,
      }
      this.children.set(file.id, child)
      this.openChildRun(child, time)
    }
    if (type === 'session_meta') {
      // Persisted as a stringified number (`"24"`) in current rollouts.
      const raw = payload['subagent_history_start_ordinal']
      const start = asNumber(raw) ?? (typeof raw === 'string' ? asNumber(Number(raw)) : undefined)
      if (start !== undefined) child.historyStartOrdinal = start
      return
    }
    // Records below `subagent_history_start_ordinal` are the parent's history
    // inherited into the child's file — materialized for the model, not the
    // child's own activity (thread_history_materialization.rs).
    if (ordinal !== undefined && child.historyStartOrdinal !== undefined
      && ordinal < child.historyStartOrdinal) {
      return
    }
    if (child.completed) {
      // A completed run resumes only when a NEW turn begins (`task_started`)
      // — Codex resumes an existing agent with new input
      // (core/agent/control.rs). Records that arrive between runs are late
      // bookkeeping (`token_count`, `item_completed` mirrors); they update
      // the finished run's stats rather than spawning `…#2`.
      if (type !== 'event_msg' || asString(payload['type']) !== 'task_started') {
        child.lastTime = Math.max(child.lastTime, time)
        return
      }
      child.completed = false
      child.endedAt = null
      this.openChildRun(child, time)
    }
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
        case 'tool_search_call':
          child.toolCalls += 1
          this.handleToolCall(payload, time, child.callId)
          return
        case 'web_search_call':
        case 'image_generation_call':
          // Self-contained calls carry no output item; count them without
          // nesting (their ids never join the child's ledger call).
          child.toolCalls += 1
          return
        case 'custom_tool_call_output':
        case 'function_call_output':
        case 'local_shell_call_output':
          this.handleToolOutput(payload, time)
          return
        case 'tool_search_output':
          this.handleToolOutput(payload, time, asArray(payload['tools']))
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
      } else if (eventType === 'item_completed') {
        this.handleItemCompleted(payload)
      }
    }
  }

  /** Open a ledger call for the child's current run (its `runs`th). */
  private openChildRun(child: ChildThread, time: number): void {
    child.runs += 1
    child.callId = child.runs === 1 ? `subagent:${child.fileId}` : `subagent:${child.fileId}#${child.runs}`
    const name = `subagent:${child.label}`
    const argsRaw = JSON.stringify({ threadId: child.threadId, source: child.label })
    this.assembler.tools.start({
      callId: child.callId,
      name,
      argsRaw,
      turn: Math.max(1, this.turn),
      step: this.step,
      time,
      subCalls: [],
    })
    this.attachSyntheticCall(child.callId, name, argsRaw)
    this.assembler.touch()
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
    this.noteSettled(child.callId, node.call?.argsRaw)
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

}

/** The `turn_id` a response item carries in its passthrough metadata, when annotated. */
function recordTurnId(payload: Record<string, unknown>): string | undefined {
  const meta = payload['internal_chat_message_metadata_passthrough']
  return isRecord(meta) ? asString(meta['turn_id']) : undefined
}

/** Readable text of an `agent_message` item: `input_text` parts joined; encrypted parts drop out. */
function agentMessageText(payload: Record<string, unknown>): string {
  return (asArray(payload['content']) ?? [])
    .flatMap(item => (isRecord(item) && asString(item['type']) === 'input_text'
      ? [asString(item['text']) ?? '']
      : []))
    .filter(text => text !== '')
    .join('\n')
}

/** `author → recipient` of an agent-communication payload (AgentPath strings on the wire). */
function agentRoute(payload: Record<string, unknown>): string {
  const author = asString(payload['author'])
  const recipient = asString(payload['recipient'])
  if (author === undefined && recipient === undefined) return ''
  return `${author ?? '?'} → ${recipient ?? '?'}`
}

/** `inter_agent_communication` carries a plain-string `content` (or only `encrypted_content`). */
function interAgentText(payload: Record<string, unknown>): string {
  return asString(payload['content']) ?? ''
}

function stringifyRaw(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}


/** Create the incremental Codex rollout parser. */
export function createCodexParser(): SessionParser {
  return new CodexParser()
}
