/**
 * Transcript record → searchable documents, one extractor per harness.
 *
 * Verified on 2026-09-14 against the transcripts on this machine: Claude Code
 * 2.1.270 (`~/.claude/projects`, main and `subagents/agent-*.jsonl`), Codex
 * 0.153.4 rollouts (`~/.codex/sessions`), Kimi Code protocol 1.5
 * (`~/.kimi-code/sessions`, `agents/<id>/wire.jsonl`) and Grok Build
 * (`~/.grok/sessions`, `<session>/updates.jsonl`).
 *
 * - **Claude**: `{type, timestamp (ISO), message:{content}}`. A human prompt is
 *   a `user` record whose `message.content` is a **string**; an array means
 *   `tool_result` blocks, which are the harness answering itself. Tool results
 *   are not indexed (see below). 2.1.x no longer writes `<system-reminder>` as
 *   its own record: it is a text block inside a tool result, and injected
 *   context arrives as `type:"attachment"` records, which carry no `message`
 *   and are skipped. Images are `{type:'image', source:{data}}` — never a
 *   `text` field.
 * - **Codex**: `{timestamp (ISO), ordinal, type, payload}`. Only `response_item`
 *   carries content; `event_msg` mirrors it and `session_meta` holds the system
 *   prompt, so both are skipped. `custom_tool_call` (the `exec` sandbox) is the
 *   dominant call and its `input` is raw **JavaScript**, not JSON;
 *   `function_call.arguments` is a JSON **string**. `*_output` items are not
 *   indexed. `reasoning` keeps its real text in `encrypted_content`, which is
 *   opaque and skipped; only `summary[]`/`content[]` are indexed.
 *   `role:'developer'` is injection.
 * - **Kimi**: `{type, time (epoch MILLISECONDS), agentId, …payload}` with the
 *   payload inlined at the top level. Loop events nest one level deeper under
 *   `event`. `message.origin` — never the text — decides human vs injected.
 *   `tool.result` records are not indexed. Argument keys are `path`, not
 *   `file_path`. No image blocks exist in the corpus.
 * - **Grok**: the `{timestamp (epoch SECONDS), method, params}` envelope that
 *   `parseGrokLine` unwraps; `params._meta.agentTimestampMs` is the millisecond
 *   stamp. `content` on a message chunk is a single object, not an array. Tool
 *   names come from `update._meta['x.ai/tool']`, else `title`; arguments from
 *   `rawInput`. `tool_call_update` results are not indexed; `rawOutput.output`
 *   can be an array of raw byte integers. The server's own synthetic sidecar
 *   line is skipped.
 * - **Devin**: `{t:'devin.msg', msg}` wraps a raw `chat_message`;
 *   `devin.session`/`devin.tool` sidecars and `role:'tool'` outputs are not
 *   indexed. Human vs injected is `metadata.is_user_input`, the same
 *   structural flag the adapter and meta scanner read.
 *
 * The rules that are the same everywhere: the human/injected split reuses the
 * classifier the meta scanner and the adapters use, image blocks are skipped,
 * embedded base64 runs are stripped (the surrounding prose is kept), and each
 * document is capped at 16 KB. **Tool outputs are never indexed**: stdout and
 * command results are 73% of the unique text on the reference corpus, and the
 * searchable record of what a tool *did* is its call — the command, paths,
 * patterns, and the `content`/`old_string`/`new_string` of writes and edits.
 * Searching inside an open trajectory is unaffected: that index is built
 * client-side from the loaded records.
 *
 * Never throws: an unknown or malformed record yields no documents.
 */

import {
  asArray, asNumber, asString, classifyInjectedUser, devinMessageClass, grokMessageClass,
  codexHumanPromptText, codexReasoningText, isRecord, kimiMessageClass, kimiTitleText,
  parseDevinLine, parseGrokLine,
  parseJsonLine, parseTime, GROK_SIDECAR_METHOD, type HarnessKind, type SearchRole,
} from '@harness-trajectory/core'

/** One document before the indexer stamps it with its line number. */
export interface SearchDocDraft {
  role: SearchRole
  text: string
  timeMs?: number
}

/** Longest text stored per document, in UTF-16 code units. */
export const MAX_DOC_CHARS = 16 * 1024

/** Control characters never reach the index. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/**
 * A run of base64 alphabet this long with no whitespace is an embedded payload
 * (an inline image, an encrypted reasoning blob, a data URL), not prose: it
 * would inflate the trigram index by megabytes and can never be searched for.
 */
const BASE64_RUN = /[A-Za-z0-9+/]{256,}={0,2}/
/** A data-URL prefix; the payload itself is eaten by {@link BASE64_RUN}. */
const DATA_URL_PREFIX = /data:[a-zA-Z0-9.+/-]*;base64,/gi

/** Strip embedded payloads; empty afterwards means the document was only payload. */
function scrub(text: string): string {
  return text
    .replace(BASE64_RUN, ' ')
    .replace(DATA_URL_PREFIX, ' ')
    .replace(CONTROL, ' ')
    .trim()
}

/** Collect the parts of a document, then hand back the trimmed, capped text. */
class DocBuilder {
  private readonly drafts: SearchDocDraft[] = []

  constructor(private readonly timeMs: number | null) {}

  add(role: SearchRole, text: string): void {
    const cleaned = scrub(text)
    if (cleaned === '') return
    this.drafts.push({
      role,
      text: cleaned.length > MAX_DOC_CHARS ? cleaned.slice(0, MAX_DOC_CHARS) : cleaned,
      ...(this.timeMs === null ? {} : { timeMs: this.timeMs }),
    })
  }

  get docs(): SearchDocDraft[] {
    return this.drafts
  }
}

/**
 * Tool arguments worth indexing: the ones that say what a call actually did.
 * A call whose arguments carry none of them falls back to its whole (small)
 * JSON, so an unfamiliar or MCP tool is still searchable.
 */
const TOOL_ARG_KEYS: readonly string[] = [
  // Claude / Kimi / Codex `js` / Grok `run_terminal_command`
  'command', 'cmd', 'script', 'description', 'prompt', 'subagent_type',
  // File paths: Claude and Grok writes use `file_path`, Kimi uses `path`,
  // Grok reads use `target_file`, `list_dir` uses `target_directory`.
  'file_path', 'filePath', 'path', 'target_file', 'target_directory', 'notebook_path',
  'pattern', 'glob', 'query', 'search', 'output_mode', 'url',
  'old_string', 'new_string', 'content', 'body', 'message', 'title', 'plan', 'todos', 'edits',
  // MCP passthrough (Grok `use_tool`, Kimi `mcp__*`) and background-task handles.
  'tool_name', 'tool_input', 'task_id', 'task_ids',
]

const MAX_FALLBACK_ARGS_CHARS = 2_048

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** Arguments as an object, whether the harness recorded them as one or as JSON text. */
function argsRecord(args: unknown): Record<string, unknown> | undefined {
  if (isRecord(args)) return args
  const text = asString(args)
  if (text === undefined) return undefined
  const parsed = parseJsonLine(text)
  return isRecord(parsed) ? parsed : undefined
}

/** `name` plus the arguments that describe the call. */
function renderToolCall(name: string, args: unknown): string {
  const record = argsRecord(args)
  if (record === undefined) {
    const raw = asString(args) ?? ''
    return raw === '' ? name : `${name}\n${raw}`
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (!TOOL_ARG_KEYS.includes(key)) continue
    const rendered = stringifyValue(value)
    if (rendered !== '') parts.push(`${key}: ${rendered}`)
  }
  if (parts.length === 0) {
    const whole = stringifyValue(record)
    if (whole !== '' && whole !== '{}' && whole.length <= MAX_FALLBACK_ARGS_CHARS) parts.push(whole)
  }
  return parts.length === 0 ? name : `${name}\n${parts.join('\n')}`
}

/**
 * Harness-injected boilerplate that rides inside otherwise real content. Claude
 * 2.1.x no longer writes system reminders as their own user record: they are
 * `text` blocks *inside* a `tool_result`, repeated on hundreds of results per
 * session, so they are dropped block by block rather than record by record.
 */
const REMINDER_PREFIX = /^\s*<(?:system-reminder|task-notification)[\s>]/

/** Text of a `[{type:'text', text}]` block array; images and reminders are dropped. */
function blockText(content: unknown): string {
  const blocks = asArray(content)
  if (blocks === undefined) {
    const text = asString(content) ?? ''
    return REMINDER_PREFIX.test(text) ? '' : text
  }
  return blocks
    .flatMap((block) => {
      if (!isRecord(block)) return []
      if (asString(block['type']) === 'image') return []
      const text = asString(block['text'])
      if (text === undefined || REMINDER_PREFIX.test(text)) return []
      return [text]
    })
    .join('\n')
}

/** Dispatch one raw JSONL line to its harness extractor. Never throws. */
export function extractSearchDocs(kind: HarnessKind, line: string): SearchDocDraft[] {
  try {
    switch (kind) {
      case 'claude': return claudeDocs(line)
      case 'codex': return codexDocs(line)
      case 'kimi': return kimiDocs(line)
      case 'grok': return grokDocs(line)
      case 'devin': return devinDocs(line)
    }
  } catch {
    return []
  }
}

// -- Claude Code -------------------------------------------------------------

function claudeDocs(line: string): SearchDocDraft[] {
  const record = parseJsonLine(line)
  if (!isRecord(record)) return []
  const builder = new DocBuilder(parseTime(record['timestamp']))
  const type = asString(record['type'])
  // `summary` is a compaction's carried-over title and `ai-title` the generated
  // session name: both are derived text that would match every session.
  if (type !== 'user' && type !== 'assistant') return builder.docs
  const message = record['message']
  if (!isRecord(message)) return builder.docs
  const content = message['content']

  if (type === 'user') {
    const blocks = asArray(content) ?? []
    const results = blocks.filter((block): block is Record<string, unknown> =>
      isRecord(block) && asString(block['type']) === 'tool_result')
    if (results.length > 0) {
      // A tool_result-only turn is the harness replying to itself, not a
      // prompt — and tool outputs are not indexed at all.
      return builder.docs
    }
    const text = typeof content === 'string' ? content : blockText(content)
    if (text.trim() === '') return builder.docs
    if (record['isMeta'] === true || record['isCompactSummary'] === true) return builder.docs
    if (classifyInjectedUser(record, text) !== null) return builder.docs
    // A sidechain record is the task a subagent was given, not something a
    // person typed into this session, so it stays out of the human bucket the
    // prompt count uses.
    builder.add(record['isSidechain'] === true ? 'other' : 'human', text)
    return builder.docs
  }

  for (const block of asArray(content) ?? []) {
    if (!isRecord(block)) continue
    switch (asString(block['type'])) {
      case 'text':
        builder.add('assistant', asString(block['text']) ?? '')
        break
      case 'thinking':
        builder.add('other', asString(block['thinking']) ?? asString(block['text']) ?? '')
        break
      case 'tool_use':
        builder.add('tool', renderToolCall(asString(block['name']) ?? 'tool', block['input']))
        break
      default:
        // `image`, `redacted_thinking`, and anything a newer build adds.
        break
    }
  }
  return builder.docs
}

// -- Codex -------------------------------------------------------------------

function codexDocs(line: string): SearchDocDraft[] {
  const record = parseJsonLine(line)
  if (!isRecord(record)) return []
  const builder = new DocBuilder(parseTime(record['timestamp']))
  const recordType = asString(record['type'])
  const payload = record['payload']
  if (!isRecord(payload)) return builder.docs

  if (recordType === 'realtime_item') {
    if (payload['type'] === 'transcript_segment') {
      const role = payload['role'] === 'user' ? 'human' : payload['role'] === 'assistant' ? 'assistant' : 'other'
      builder.add(role, asString(payload['text']) ?? '')
    }
    return builder.docs
  }

  // Agent traffic and retained answers are top-level records, not response
  // items; `thread_goal_updated` is the one durable `event_msg` with unique
  // user-authored text (the rest mirror response items — indexing them would
  // double the index).
  if (recordType === 'inter_agent_communication') {
    const route = [asString(payload['author']), asString(payload['recipient'])]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' → ')
    builder.add('other', `${route}\n${asString(payload['content']) ?? ''}`)
    return builder.docs
  }
  if (recordType === 'retained_context') {
    if (asString(payload['type']) !== 'verified_answer') return builder.docs
    for (const entry of asArray(payload['questions']) ?? []) {
      if (!isRecord(entry)) continue
      builder.add('other', `${asString(entry['question']) ?? ''}\n${asString(entry['answer']) ?? ''}`)
    }
    return builder.docs
  }
  if (recordType === 'event_msg') {
    if (asString(payload['type']) !== 'thread_goal_updated') return builder.docs
    const goal = payload['goal']
    if (isRecord(goal)) builder.add('other', asString(goal['objective']) ?? '')
    return builder.docs
  }
  if (recordType !== 'response_item') return builder.docs

  switch (asString(payload['type'])) {
    case 'message': {
      const role = asString(payload['role'])
      if (role === 'user') {
        // Environment snapshots, skill catalogs, and guardian relays ride the
        // user role too; `codexHumanPromptText` keeps only the human items.
        const text = codexHumanPromptText(payload)
        if (text !== null && text.trim() !== '') builder.add('human', text)
        break
      }
      const text = (asArray(payload['content']) ?? [])
        .flatMap(item => (isRecord(item) && asString(item['type']) !== 'input_image'
          ? [asString(item['text']) ?? '']
          : []))
        .join('\n')
      if (text.trim() === '') break
      // `developer` is always instruction injection and never a prompt.
      if (role === 'assistant') builder.add('assistant', text)
      break
    }
    case 'reasoning':
      builder.add('other', codexReasoningText(payload))
      break
    case 'function_call':
    case 'custom_tool_call':
      builder.add('tool', renderToolCall(
        asString(payload['name']) ?? 'tool',
        payload['arguments'] ?? payload['input'],
      ))
      break
    case 'local_shell_call':
      builder.add('tool', renderToolCall('local_shell', payload['action']))
      break
    case 'web_search_call':
      builder.add('tool', renderToolCall('web_search', payload['action']))
      break
    case 'image_generation_call':
      builder.add('tool', renderToolCall('image_generation', {
        prompt: payload['revised_prompt'],
      }))
      break
    case 'tool_search_call':
      builder.add('tool', renderToolCall('tool_search', payload['arguments']))
      break
    case 'agent_message': {
      // Inter-agent traffic: sender/recipient + plaintext content parts.
      const route = [asString(payload['author']), asString(payload['recipient'])]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' → ')
      const text = (asArray(payload['content']) ?? [])
        .flatMap(item => (isRecord(item) ? [asString(item['text']) ?? ''] : []))
        .filter(part => part !== '')
        .join('\n')
      builder.add('other', `${route}\n${text}`)
      break
    }
    // `*_output` items carry tool stdout, which is not indexed.
    default:
      // `compaction`/`context_compaction` (encrypted replays),
      // `configuration_update`, and future items.
      break
  }
  return builder.docs
}

// -- Kimi Code ---------------------------------------------------------------

/** Loop events nest their payload under `event`; the adapter flattens it the same way. */
function kimiLoopEvent(record: Record<string, unknown>): Record<string, unknown> {
  const event = record['event']
  return isRecord(event) ? { ...record, ...event } : record
}

function kimiDocs(line: string): SearchDocDraft[] {
  const record = parseJsonLine(line)
  if (!isRecord(record)) return []
  // `time` is epoch milliseconds, not seconds.
  const builder = new DocBuilder(asNumber(record['time']) ?? null)

  if (asString(record['type']) === 'context.append_message') {
    const message = record['message']
    if (!isRecord(message)) return builder.docs
    const role = asString(message['role'])
    if (role === 'assistant') builder.add('assistant', blockText(message['content']))
    // Injections, task notifications, skill activations and compaction
    // summaries are all user-role records; only the origin tells them apart.
    else if (role === 'user' && kimiMessageClass(message['origin']).kind === 'human') {
      // The git brief prepended to a delegated prompt is boilerplate, not the task.
      builder.add('human', kimiTitleText(blockText(message['content'])))
    }
    return builder.docs
  }
  if (asString(record['type']) !== 'context.append_loop_event') return builder.docs

  const event = kimiLoopEvent(record)
  switch (asString(event['type'])) {
    case 'content.part': {
      const part = isRecord(event['part']) ? event['part'] : event
      if (asString(part['type']) === 'think') {
        builder.add('other', asString(part['think']) ?? asString(part['text']) ?? '')
      } else {
        builder.add('assistant', asString(part['text']) ?? '')
      }
      break
    }
    case 'tool.call':
      builder.add('tool', renderToolCall(asString(event['name']) ?? 'tool', event['args']))
      break
    // `tool.result` carries tool stdout, which is not indexed.
    default:
      break
  }
  return builder.docs
}

// -- Grok Build --------------------------------------------------------------

/** The canonical `x.ai/tool` envelope, when the record carries one. */
function grokToolIdentity(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = update['_meta']
  if (!isRecord(meta)) return undefined
  const identity = meta['x.ai/tool']
  return isRecord(identity) ? identity : undefined
}

function grokDocs(line: string): SearchDocDraft[] {
  const record = parseGrokLine(line)
  // The sidecar is the server's own synthetic line (session facts, system
  // prompt, tool schemas): it is not in the transcript and has no line to open.
  if (record === null || record.method === GROK_SIDECAR_METHOD) return []
  const update = record.update
  if (update === null) return []
  const builder = new DocBuilder(record.time)
  const content = isRecord(update['content']) ? update['content'] : {}

  switch (record.sessionUpdate) {
    case 'user_message_chunk': {
      // The `_meta` flags decide human vs injected, never the text.
      if (grokMessageClass(update)?.kind !== 'human') break
      const contentMeta = isRecord(content['_meta']) ? content['_meta'] : undefined
      // A slash command or an interjection records the typed text as
      // `displayText` and the model-facing frame as `content.text`.
      builder.add('human', asString(contentMeta?.['displayText']) ?? asString(content['text']) ?? '')
      break
    }
    case 'agent_message_chunk':
      builder.add('assistant', asString(content['text']) ?? '')
      break
    case 'agent_thought_chunk':
      builder.add('other', asString(content['text']) ?? '')
      break
    case 'tool_call': {
      const identity = grokToolIdentity(update)
      const name = asString(identity?.['name']) ?? asString(update['title']) ?? asString(update['kind']) ?? 'tool'
      builder.add('tool', renderToolCall(name, identity?.['input'] ?? update['rawInput']))
      break
    }
    // `tool_call_update` carries tool stdout, which is not indexed.
    case 'plan':
      builder.add('other', (asArray(update['entries']) ?? [])
        .flatMap(entry => (isRecord(entry) ? [asString(entry['content']) ?? ''] : []))
        .filter(text => text !== '')
        .join('\n'))
      break
    default:
      break
  }
  return builder.docs
}

// -- Devin CLI ---------------------------------------------------------------

/**
 * Devin's virtual lines wrap the `chat_message` record under `msg`; the
 * `devin.session`/`devin.tool` records are server-synthesized sidecars and
 * never reach the index. Human vs injected is `metadata.is_user_input`, the
 * same structural flag the adapter and meta scanner read.
 */
function devinDocs(line: string): SearchDocDraft[] {
  const record = parseDevinLine(line)
  if (record === null || record.tag !== 'msg') return []
  const builder = new DocBuilder(record.time)
  const msg = record.msg
  switch (asString(msg['role'])) {
    case 'user':
      if (devinMessageClass(msg)?.kind !== 'human') break
      builder.add('human', blockText(msg['content']))
      break
    case 'assistant': {
      builder.add('assistant', blockText(msg['content']))
      const thinking = msg['thinking']
      const thinkText = isRecord(thinking)
        ? asString(thinking['thinking']) ?? ''
        : asString(thinking) ?? ''
      builder.add('other', thinkText)
      for (const call of asArray(msg['tool_calls']) ?? []) {
        if (!isRecord(call)) continue
        const fn = isRecord(call['function']) ? call['function'] : undefined
        const name = asString(call['name']) ?? asString(fn?.['name']) ?? 'tool'
        builder.add('tool', renderToolCall(name, call['arguments'] ?? fn?.['arguments']))
      }
      break
    }
    // `role: 'tool'` messages carry tool stdout, which is not indexed.
    default:
      // `system` prompt segments are harness boilerplate, like codex's
      // session_meta: indexed once per session they would match everything.
      break
  }
  return builder.docs
}
