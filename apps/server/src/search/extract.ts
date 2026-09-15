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
 *   `tool_result` blocks, which are the harness answering itself. A
 *   `tool_result`'s own `content` is again either a string or a block array.
 *   2.1.x no longer writes `<system-reminder>` as its own record: it is a text
 *   block inside a tool result, and injected context arrives as
 *   `type:"attachment"` records, which carry no `message` and are skipped.
 *   Images are `{type:'image', source:{data}}` — never a `text` field.
 * - **Codex**: `{timestamp (ISO), ordinal, type, payload}`. Only `response_item`
 *   carries content; `event_msg` mirrors it and `session_meta` holds the system
 *   prompt, so both are skipped. `custom_tool_call` (the `exec` sandbox) is the
 *   dominant call and its `input` is raw **JavaScript**, not JSON;
 *   `function_call.arguments` is a JSON **string**. Outputs are an array of
 *   `{type:'input_text', text}` blocks, or a JSON string. `reasoning` keeps its
 *   real text in `encrypted_content`, which is opaque and skipped; only
 *   `summary[]`/`content[]` are indexed. `role:'developer'` is injection.
 * - **Kimi**: `{type, time (epoch MILLISECONDS), agentId, …payload}` with the
 *   payload inlined at the top level. Loop events nest one level deeper under
 *   `event`. `message.origin` — never the text — decides human vs injected.
 *   `tool.result.output` is always a plain string. Argument keys are `path`,
 *   not `file_path`. No image blocks exist in the corpus.
 * - **Grok**: the `{timestamp (epoch SECONDS), method, params}` envelope that
 *   `parseGrokLine` unwraps; `params._meta.agentTimestampMs` is the millisecond
 *   stamp. `content` on a message chunk is a single object, not an array. Tool
 *   names come from `update._meta['x.ai/tool']`, else `title`; arguments from
 *   `rawInput`. Results are `content[]` blocks of `{type:'content',
 *   content:{text}}` or `{type:'diff', path, oldText, newText}` — never
 *   `rawOutput`, whose `output` can be an array of raw byte integers. The
 *   server's own synthetic sidecar line is skipped.
 *
 * The rules that are the same everywhere: the human/injected split reuses the
 * classifier the meta scanner and the adapters use, image blocks are skipped,
 * embedded base64 runs are stripped (the surrounding prose is kept), and each
 * document is capped — 16 KB for prose, 4 KB for tool output, which is the
 * bulk of every transcript — so one `Write` of a large file cannot dominate
 * the index.
 *
 * Never throws: an unknown or malformed record yields no documents.
 */

import {
  asArray, asNumber, asString, classifyInjectedUser, grokMessageClass, isCodexHumanPrompt,
  isRecord, kimiMessageClass, parseGrokLine, parseJsonLine, parseTime,
  GROK_SIDECAR_METHOD, type HarnessKind, type SearchRole,
} from '@harness-trajectory/core'

/** One document before the indexer stamps it with its line number. */
export interface SearchDocDraft {
  role: SearchRole
  text: string
  timeMs?: number
}

/** Longest text stored per document, in UTF-16 code units. */
export const MAX_DOC_CHARS = 16 * 1024

/**
 * Longest text stored per tool-*output* document. Tool output is the bulk of
 * every transcript (~95% of indexed text on the reference corpus), so it gets
 * a tighter cap than prose: the head still answers "which session ran this"
 * queries, and the rest is re-readable in the session itself.
 */
export const MAX_TOOL_OUTPUT_CHARS = 4 * 1024

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

  add(role: SearchRole, text: string, maxChars: number = MAX_DOC_CHARS): void {
    const cleaned = scrub(text)
    if (cleaned === '') return
    this.drafts.push({
      role,
      text: cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned,
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
      // A tool_result-only turn is the harness replying to itself, not a prompt.
      for (const result of results) builder.add('tool', blockText(result['content']), MAX_TOOL_OUTPUT_CHARS)
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

/** Codex wraps a tool's output in `{"output": "...", "metadata": {...}}` more often than not. */
function codexOutputText(output: unknown): string {
  if (Array.isArray(output)) return blockText(output)
  const text = asString(output)
  if (text === undefined) return isRecord(output) ? (asString(output['output']) ?? '') : ''
  const parsed = parseJsonLine(text)
  if (isRecord(parsed)) return asString(parsed['output']) ?? text
  return text
}

/** `reasoning` items carry their text in `summary[]`, `content[]`, or both. */
function codexReasoningText(payload: Record<string, unknown>): string {
  return [...(asArray(payload['summary']) ?? []), ...(asArray(payload['content']) ?? [])]
    .flatMap(item => (isRecord(item) ? [asString(item['text']) ?? ''] : []))
    .filter(text => text !== '')
    .join('\n')
}

function codexDocs(line: string): SearchDocDraft[] {
  const record = parseJsonLine(line)
  if (!isRecord(record)) return []
  const builder = new DocBuilder(parseTime(record['timestamp']))
  // `event_msg` mirrors the response items and `session_meta` holds the system
  // prompt; indexing either would double or flood the index.
  if (asString(record['type']) !== 'response_item') return builder.docs
  const payload = record['payload']
  if (!isRecord(payload)) return builder.docs

  switch (asString(payload['type'])) {
    case 'message': {
      const text = (asArray(payload['content']) ?? [])
        .flatMap(item => (isRecord(item) && asString(item['type']) !== 'input_image'
          ? [asString(item['text']) ?? '']
          : []))
        .join('\n')
      if (text.trim() === '') break
      const role = asString(payload['role'])
      if (role === 'assistant') builder.add('assistant', text)
      // Environment snapshots, skill catalogs, and compaction replays ride the
      // user role too; `isCodexHumanPrompt` is the shared classifier for them.
      // `developer` is always instruction injection and never a prompt.
      else if (role === 'user' && isCodexHumanPrompt(text)) builder.add('human', text)
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
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
      builder.add('tool', codexOutputText(payload['output']), MAX_TOOL_OUTPUT_CHARS)
      break
    default:
      // `compaction` (an encrypted replay), `web_search_call`, and future items.
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
      builder.add('human', blockText(message['content']))
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
    case 'tool.result': {
      const result = isRecord(event['result']) ? event['result'] : {}
      const note = asString(result['note']) ?? ''
      const output = asString(result['output']) ?? ''
      builder.add('tool', note === '' ? output : `${output}\n${note}`, MAX_TOOL_OUTPUT_CHARS)
      break
    }
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

/** Result blocks of a terminal `tool_call_update`; images are dropped, diffs kept as paths. */
function grokResultText(update: Record<string, unknown>): string {
  const parts: string[] = []
  for (const item of asArray(update['content']) ?? []) {
    if (!isRecord(item)) continue
    if (asString(item['type']) === 'diff') {
      const path = asString(item['path'])
      const newText = asString(item['newText']) ?? ''
      parts.push(`${path ?? ''}\n${newText}`)
      continue
    }
    const inner = isRecord(item['content']) ? item['content'] : item
    if (asString(inner['type']) === 'image') continue
    const text = asString(inner['text'])
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/** `tool_call_update.status` values that carry a result rather than a progress merge. */
const GROK_TERMINAL_STATUS: ReadonlySet<string> = new Set(['completed', 'failed'])

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
    case 'tool_call_update': {
      const status = asString(update['status'])
      if (status === undefined || !GROK_TERMINAL_STATUS.has(status)) break
      builder.add('tool', grokResultText(update), MAX_TOOL_OUTPUT_CHARS)
      break
    }
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
