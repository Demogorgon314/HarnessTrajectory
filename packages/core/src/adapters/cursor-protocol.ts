/** Cursor Agent model-message semantics and virtual-stream contracts. Browser/server safe. */

import { asArray, asNumber, asString, isRecord, parseJsonLine } from '../jsonl.ts'

export type CursorUserClass = 'human' | 'injection' | 'system' | 'summary'

export interface CursorUsageBucket {
  key: string
  label: string
  tokens: number
  chars: number
}

export interface CursorUsage {
  used: number
  window: number
  buckets: readonly CursorUsageBucket[]
}

export interface CursorCallSpan {
  id: string
  start: number
  end: number
}

export interface CursorBlockSpan {
  kind: 'reasoning' | 'text' | 'tool-call'
  start: number
  end: number
}

/** Assistant step window. Absent when the store had no usable turn chain. */
export interface CursorStepSpan {
  start: number
  end: number
  calls: readonly CursorCallSpan[]
  blocks: readonly CursorBlockSpan[]
}

export type CursorRecord =
  | { tag: 'session'; time: number | null; session: Record<string, unknown> }
  | {
    tag: 'message'
    time: number | null
    index: number
    blobId: string
    message: Record<string, unknown>
    span?: CursorStepSpan
    /** A kept copy in a later context epoch; not a new historical occurrence. */
    replay?: boolean
  }

function spanOf(value: unknown): CursorStepSpan | undefined {
  if (!isRecord(value)) return undefined
  const start = asNumber(value['start'])
  const end = asNumber(value['end'])
  if (start === undefined || end === undefined) return undefined
  const calls: CursorCallSpan[] = []
  for (const item of asArray(value['calls']) ?? []) {
    if (!isRecord(item)) continue
    const id = asString(item['id'])
    const callStart = asNumber(item['start'])
    const callEnd = asNumber(item['end'])
    if (id === undefined || callStart === undefined || callEnd === undefined) continue
    calls.push({ id, start: callStart, end: callEnd })
  }
  const blocks: CursorBlockSpan[] = []
  for (const item of asArray(value['blocks']) ?? []) {
    if (!isRecord(item)) continue
    const kind = asString(item['kind'])
    const blockStart = asNumber(item['start'])
    const blockEnd = asNumber(item['end'])
    if (blockStart === undefined || blockEnd === undefined) continue
    if (kind !== 'reasoning' && kind !== 'text' && kind !== 'tool-call') continue
    blocks.push({ kind, start: blockStart, end: blockEnd })
  }
  return { start, end, calls, blocks }
}

const TIMESTAMP_TAG = /^\s*<timestamp>[\s\S]*?<\/timestamp>\s*/
const USER_QUERY_OPEN = /^\s*<user_query>\s*/
const USER_QUERY_CLOSE = /\s*<\/user_query>\s*$/

/** `providerOptions.cursor` when it is an object. */
export function cursorProviderOptions(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const provider = record['providerOptions']
  if (!isRecord(provider)) return undefined
  const cursor = provider['cursor']
  return isRecord(cursor) ? cursor : undefined
}

/**
 * Structural human/injected/system split. Anything that is not a user or
 * system message returns null (assistant, tool, garbage).
 */
export function cursorUserClass(message: unknown): CursorUserClass | null {
  if (!isRecord(message)) return null
  const role = asString(message['role'])
  if (role === 'system') return 'system'
  if (role !== 'user') return null
  if (cursorProviderOptions(message)?.['isSummary'] === true) return 'summary'
  const requestId = asString(cursorProviderOptions(message)?.['requestId'])
  if (Array.isArray(message['content']) && requestId !== undefined) return 'human'
  return 'injection'
}

/** Text of a model message: a string body, or the `text` parts of an array. */
export function cursorMessageText(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = message['content']
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const part of asArray(content) ?? []) {
    if (!isRecord(part) || part['type'] !== 'text') continue
    const text = asString(part['text'])
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Human prompt text for display, titles, and search. Strips Cursor's
 * leading `<timestamp>` tag and the `<user_query>` wrapper. The raw body
 * stays on the wire; this is display-only and is not a classifier.
 */
export function cursorHumanText(message: unknown): string {
  return cursorMessageText(message)
    .replace(TIMESTAMP_TAG, '')
    .replace(USER_QUERY_OPEN, '')
    .replace(USER_QUERY_CLOSE, '')
    .trim()
}

/** Last `reasoning.providerOptions.cursor.modelName` on an assistant message. */
export function cursorModelOf(message: unknown): string | undefined {
  if (!isRecord(message) || message['role'] !== 'assistant') return undefined
  let model: string | undefined
  for (const part of asArray(message['content']) ?? []) {
    if (!isRecord(part) || part['type'] !== 'reasoning') continue
    const name = asString(cursorProviderOptions(part)?.['modelName'])
    if (name !== undefined && name !== '') model = name
  }
  return model
}

export function cursorUsageOf(value: unknown): CursorUsage | undefined {
  if (!isRecord(value)) return undefined
  const used = asNumber(value['used'])
  const window = asNumber(value['window'])
  if (used === undefined && window === undefined) return undefined
  const buckets: CursorUsageBucket[] = []
  for (const item of asArray(value['buckets']) ?? []) {
    if (!isRecord(item)) continue
    const key = asString(item['key'])
    if (key === undefined || key === '') continue
    buckets.push({
      key,
      label: asString(item['label']) ?? key,
      tokens: asNumber(item['tokens']) ?? 0,
      chars: asNumber(item['chars']) ?? 0,
    })
  }
  return { used: used ?? 0, window: window ?? 0, buckets }
}

/** Parse one `cursor.*` line; null for blank or malformed input. Never throws. */
export function parseCursorLine(line: string): CursorRecord | null {
  try {
    const value = parseJsonLine(line)
    if (!isRecord(value)) return null
    const type = asString(value['type'])
    const time = asNumber(value['time']) ?? null
    if (type === 'cursor.session') {
      const session: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        if (key !== 'type' && key !== 'time') session[key] = item
      }
      return { tag: 'session', time, session }
    }
    if (type === 'cursor.message') {
      const message = value['message']
      if (!isRecord(message)) return null
      const span = spanOf(value['span'])
      return {
        tag: 'message',
        time,
        index: asNumber(value['index']) ?? 0,
        blobId: asString(value['blobId']) ?? '',
        message,
        ...(span === undefined ? {} : { span }),
        ...(value['replay'] === true ? { replay: true } : {}),
      }
    }
    return null
  } catch {
    return null
  }
}

export function cursorArgsText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

export function cursorToolResultText(part: Record<string, unknown>): string {
  const result = part['result']
  if (typeof result === 'string') return result
  const texts: string[] = []
  for (const block of asArray(part['experimental_content']) ?? []) {
    if (!isRecord(block) || block['type'] !== 'text') continue
    const text = asString(block['text'])
    if (text !== undefined) texts.push(text)
  }
  if (texts.length > 0) return texts.join('\n')
  if (result === undefined) return ''
  try {
    return JSON.stringify(result)
  } catch {
    return ''
  }
}

export interface CursorSessionFacts {
  agentId: string
  title?: string
  cwd?: string
  workspaceUri?: string
  repoPath?: string
  branch?: string
  client?: string
  mode?: string
  approvalMode?: string
  model?: string
  createdAt?: number
  updatedAt?: number
  usage?: CursorUsage
}
