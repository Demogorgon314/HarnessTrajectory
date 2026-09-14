/**
 * Lightweight per-harness metadata scanners for the session list. They read
 * the same JSONL lines the full adapters do but only keep listing facts, so
 * the index stays small even with hundreds of transcripts.
 */

import {
  asArray, asString, classifyInjectedUser, isCodexHumanPrompt, isRecord, kimiMessageClass, parseJsonLine,
  parseTime, titleFrom, type HarnessKind,
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

export function createMetaScanner(kind: HarnessKind): MetaScanner {
  switch (kind) {
    case 'claude': return claudeMetaScanner()
    case 'codex': return codexMetaScanner()
    case 'kimi': return kimiMetaScanner()
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
          const text = kimiText(message['content'])
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

/** Read identity facts from the first record of a transcript. */
export function readHead(kind: HarnessKind, firstLine: string): FileHead {
  // Kimi identity is path-derived (`session_<id>/agents/<agentId>/wire.jsonl`); nothing to probe.
  if (kind === 'kimi') return { id: null, parentId: null }
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
