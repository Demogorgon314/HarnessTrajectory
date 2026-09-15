/**
 * Lightweight per-harness metadata scanners for the session list. They read
 * the same JSONL lines the full adapters do but only keep listing facts, so
 * the index stays small even with hundreds of transcripts.
 */

import {
  asArray, asString, classifyInjectedUser, grokMessageClass, isCodexHumanPrompt, isRecord, kimiMessageClass,
  kimiTitleText, parseGrokLine, parseJsonLine, parseTime, titleFrom, type HarnessKind,
} from '@harness-trajectory/core'

export interface FileHead {
  /** Transcript identity from the file content (thread id for Codex, session id for Claude). */
  id: string | null
  /** Parent transcript id when this file is a subagent/child thread. */
  parentId: string | null
}

export interface MetaState {
  title: string | null
  aiTitle: string | null
  cwd: string | null
  model: string | null
  startedAt: number | null
  lastTime: number | null
  promptCount: number
}

export function emptyMeta(): MetaState {
  return { title: null, aiTitle: null, cwd: null, model: null, startedAt: null, lastTime: null, promptCount: 0 }
}

export interface MetaScanner {
  readonly state: MetaState
  push(line: string): void
}

/**
 * Scanner for one transcript. `summary` is only read by the grok scanner: it is
 * the parsed `summary.json` sitting beside `updates.jsonl`, which carries the
 * facts grok keeps out of the transcript (GROK-FORMAT §B.1). The caller reads
 * that file — it already does, to decide whether the session is a subagent —
 * so the scanner itself performs no I/O.
 */
export function createMetaScanner(
  kind: HarnessKind,
  summary?: Record<string, unknown> | null,
): MetaScanner {
  switch (kind) {
    case 'claude': return claudeMetaScanner()
    case 'codex': return codexMetaScanner()
    case 'kimi': return kimiMetaScanner()
    case 'grok': return grokMetaScanner(summary ?? null)
  }
}

function noteTime(state: MetaState, value: unknown): void {
  const time = parseTime(value)
  if (time === null) return
  if (state.startedAt === null || time < state.startedAt) state.startedAt = time
  if (state.lastTime === null || time > state.lastTime) state.lastTime = time
}

function claudeMetaScanner(): MetaScanner {
  const state = emptyMeta()
  return {
    state,
    push(line) {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return
      noteTime(state, record['timestamp'])
      if (state.cwd === null) state.cwd = asString(record['cwd']) ?? null
      const type = record['type']
      if (type === 'ai-title') {
        state.aiTitle = asString(record['aiTitle']) ?? state.aiTitle
        return
      }
      if (type === 'summary' && state.title === null) {
        const summary = asString(record['summary'])
        if (summary !== undefined) state.title = titleFrom(summary)
        return
      }
      const message = record['message']
      if (!isRecord(message)) return
      if (type === 'user' && record['isMeta'] !== true && record['isSidechain'] !== true) {
        const content = message['content']
        const text = typeof content === 'string'
          ? content
          : (asArray(content) ?? [])
            .flatMap(block => (isRecord(block) && block['type'] === 'text' ? [asString(block['text']) ?? ''] : []))
            .join('\n')
        const hasToolResult = (asArray(content) ?? []).some(block => isRecord(block) && block['type'] === 'tool_result')
        if (!hasToolResult && text.trim() !== '' && record['isCompactSummary'] !== true
          && classifyInjectedUser(record, text) === null) {
          state.promptCount += 1
          if (state.title === null) state.title = titleFrom(text)
        }
      } else if (type === 'assistant' && state.model === null) {
        state.model = asString(message['model']) ?? null
      }
    },
  }
}

function codexMetaScanner(): MetaScanner {
  const state = emptyMeta()
  return {
    state,
    push(line) {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return
      noteTime(state, record['timestamp'])
      const payload = record['payload']
      if (!isRecord(payload)) return
      switch (record['type']) {
        case 'session_meta':
          state.cwd ??= asString(payload['cwd']) ?? null
          break
        case 'turn_context':
          state.model ??= asString(payload['model']) ?? null
          state.cwd ??= asString(payload['cwd']) ?? null
          break
        case 'response_item':
          if (payload['type'] === 'message' && payload['role'] === 'user') {
            const text = (asArray(payload['content']) ?? [])
              .flatMap(item => (isRecord(item) && item['type'] === 'input_text' ? [asString(item['text']) ?? ''] : []))
              .join('\n')
            if (text.trim() !== '' && isCodexHumanPrompt(text)) {
              state.promptCount += 1
              if (state.title === null) state.title = titleFrom(text)
            }
          }
          break
        default:
          break
      }
    },
  }
}

/** Text of a Kimi `message.content` array (`[{ type: 'text', text }]`). */
function kimiText(content: unknown): string {
  return (asArray(content) ?? [])
    .flatMap(block => (isRecord(block) && block['type'] === 'text' ? [asString(block['text']) ?? ''] : []))
    .join('\n')
}

/** `kimi-code/k3` → `k3`; the display model before the first `llm.request`. */
function aliasTail(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined
  const slash = alias.lastIndexOf('/')
  return slash === -1 ? alias : alias.slice(slash + 1)
}

/**
 * Kimi wire records are `{ type, time, agentId, ...payload }` with the payload
 * fields at the top level; `time` is epoch milliseconds.
 */
function kimiMetaScanner(): MetaScanner {
  const state = emptyMeta()
  return {
    state,
    push(line) {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return
      noteTime(state, record['time'])
      switch (record['type']) {
        case 'metadata':
          noteTime(state, record['created_at'])
          break
        case 'profile.bind': {
          const environment = record['environmentDisclosure']
          if (isRecord(environment)) state.cwd ??= asString(environment['cwd']) ?? null
          state.model ??= aliasTail(asString(record['modelAlias'])) ?? null
          break
        }
        case 'llm.request':
          // `provider` here is the wire protocol ('openai'), never the vendor.
          state.model ??= asString(record['model']) ?? null
          break
        case 'context.append_message': {
          const message = record['message']
          if (!isRecord(message) || message['role'] !== 'user') break
          // Human vs injected/task/skill/plugin/compaction is decided by the origin, never by text.
          if (kimiMessageClass(message['origin']).kind !== 'human') break
          // A delegated prompt's `<git-context>` prelude is not its title.
          const text = kimiTitleText(kimiText(message['content']))
          if (text.trim() === '') break
          state.promptCount += 1
          if (state.title === null) state.title = titleFrom(text)
          break
        }
        default:
          break
      }
    },
  }
}

/** Text of a grok `user_message_chunk`: the typed form when one was recorded (GROK-FORMAT §F.4). */
function grokChunkText(update: Record<string, unknown>): string {
  const content = update['content']
  if (!isRecord(content)) return ''
  const meta = isRecord(content['_meta']) ? content['_meta'] : undefined
  return asString(meta?.['displayText']) ?? asString(content['text']) ?? ''
}

/**
 * Grok keeps the session's title, cwd, model and creation instant in
 * `summary.json` beside `updates.jsonl` rather than in it (GROK-FORMAT §B.1),
 * so the scanner takes that object from its caller and then only counts prompts.
 *
 * `session_summary` is the harness's own generated title, so it lands on
 * `aiTitle` the way Claude's `ai-title` record does — verbatim, like Kimi's
 * `state.json` title, so the listing and the live sync agree; the first human
 * prompt stays the fallback for a directory whose `summary.json` is not written
 * yet (grok writes it last — GROK-DESIGN §1).
 */
function grokMetaScanner(summary: Record<string, unknown> | null): MetaScanner {
  const state = emptyMeta()
  if (summary !== null) {
    const title = asString(summary['session_summary'])?.trim()
    if (title !== undefined && title !== '') state.aiTitle = title
    const info = isRecord(summary['info']) ? summary['info'] : undefined
    state.cwd = asString(info?.['cwd']) ?? null
    state.model = asString(summary['current_model_id']) ?? null
    // `created_at` is RFC 3339 with microsecond precision; `parseTime` reads it as epoch ms.
    noteTime(state, summary['created_at'])
  }
  return {
    state,
    push(line) {
      const record = parseGrokLine(line)
      if (record === null) return
      noteTime(state, record.time)
      const update = record.update
      if (update === null) return
      // The model of the turn rides on the user chunk; it is the only in-band
      // source when `summary.json` has not been written yet.
      if (record.sessionUpdate === 'user_message_chunk') {
        const chunkMeta = isRecord(update['_meta']) ? update['_meta'] : undefined
        state.model ??= asString(chunkMeta?.['modelId']) ?? null
      } else if (record.sessionUpdate === 'model_changed') {
        state.model ??= asString(update['model_id']) ?? null
        return
      }
      // Human vs injected is decided by the `_meta` flags, never by the text.
      if (grokMessageClass(update)?.kind !== 'human') return
      // The prompt counts even when it carries no text (an image-only prompt),
      // exactly as the adapter and the context synthesizer count it; the text
      // only serves as the title fallback.
      state.promptCount += 1
      const text = grokChunkText(update)
      if (state.title === null && text.trim() !== '') state.title = titleFrom(text)
    },
  }
}

/** Read identity facts from the first record of a transcript. */
export function readHead(kind: HarnessKind, firstLine: string): FileHead {
  // Kimi identity is path-derived (`session_<id>/agents/<agentId>/wire.jsonl`); nothing to probe.
  // Grok's is too (`<encoded-cwd>/<session-id>/updates.jsonl`), and its parent link lives in the
  // parent's `subagents/<id>/meta.json`, not in the first record (GROK-FORMAT §D.4).
  if (kind === 'kimi' || kind === 'grok') return { id: null, parentId: null }
  const record = parseJsonLine(firstLine)
  if (!isRecord(record)) return { id: null, parentId: null }
  if (kind === 'codex') {
    const payload = record['payload']
    if (record['type'] === 'session_meta' && isRecord(payload)) {
      return {
        id: asString(payload['id']) ?? asString(payload['session_id']) ?? null,
        parentId: asString(payload['parent_thread_id']) ?? null,
      }
    }
    return { id: null, parentId: null }
  }
  return { id: asString(record['sessionId']) ?? null, parentId: null }
}
