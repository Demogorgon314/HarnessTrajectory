/**
 * Cursor Agent adapter: folds the server-synthesized `cursor.message` /
 * `cursor.session` stream (`cursor://sessions/<agentId>`) into the trajectory
 * contract.
 *
 * Verified against Cursor CLI 2026.09 stores at
 * `~/.cursor/chats/<md5(cwd)>/<agentId>/{meta.json,store.db}` (also
 * `CURSOR_CONFIG_DIR/chats`). The store is one SQLite database per session;
 * this adapter never reads it. The server decodes the protobuf root and
 * emits one settled model message per root field-1 blob id.
 *
 * Format traps:
 * - Model messages carry no timestamps. The server stamps each line from the
 *   turn chain (root field 8): a human prompt's field 25, an assistant step's
 *   earliest item start, a tool result's end. `span` on an assistant line is
 *   that step's window and each tool call's own start/end. With no usable
 *   chain the line falls back to `createdAtMs` then `updatedAtMs`. The
 *   `<timestamp>` tag inside a human turn is display text, not a clock —
 *   `cursorHumanText` strips it for display only.
 * - Human vs injected is structural (`cursorUserClass`): `role === 'user'`
 *   with array `content` and a string `providerOptions.cursor.requestId` is
 *   a human turn. Any other user message is injected (environment, interrupt,
 *   reminder). `role === 'system'` is the system prompt. Never match on text.
 * - `toolCallId` contains a raw newline (`call-…\nfc_…`). It is an opaque id;
 *   never split it.
 * - `reasoning.text` is empty for Grok (signature only) and populated for
 *   Claude. The part is still a reasoning marker. The per-step model is
 *   `reasoning.providerOptions.cursor.modelName`; `lastUsedModel: "default"`
 *   is not a model id.
 * - A tool result prefers the `result` string, then `experimental_content`
 *   text, then JSON. `isError` is
 *   `providerOptions.cursor.highLevelToolCallResult.isError`.
 * - Root field 1 can shrink or rewrite (summary, rewind). The server emits
 *   `file reset` and this parser is recreated; it does not rewind itself.
 */

import type {
  AssistantBlock, AssistantRequestView, ContentBlock, ContextMessageNode, ConversationLocation,
} from '../contract.ts'
import { asArray, asNumber, asString, isRecord, parseJsonLine } from '../jsonl.ts'
import type { ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun } from '../session.ts'
import { DataUrlImageStore, titleFrom, TrajectoryAssembler } from './shared.ts'

export type CursorUserClass = 'human' | 'injection' | 'system'

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
function cursorBag(record: Record<string, unknown>): Record<string, unknown> | undefined {
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
  const requestId = asString(cursorBag(message)?.['requestId'])
  if (Array.isArray(message['content']) && requestId !== undefined) return 'human'
  return 'injection'
}

/** Text of a model message: a string body, or the `text` parts of an array. */
function messageText(message: unknown): string {
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
  return messageText(message)
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
    const name = asString(cursorBag(part)?.['modelName'])
    if (name !== undefined && name !== '') model = name
  }
  return model
}

function usageOf(value: unknown): CursorUsage | undefined {
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
      }
    }
    return null
  } catch {
    return null
  }
}

function stringifyArgs(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function toolResultText(part: Record<string, unknown>): string {
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

class CursorParser implements SessionParser {
  readonly kind = 'cursor' as const
  readonly images = new DataUrlImageStore()
  private readonly assembler = new TrajectoryAssembler()
  private readonly turnSeqs = new Map<number, number[]>()
  private readonly closedTurns = new Set<number>()
  private turn = 0
  private step = 0
  private turnOpen = false
  private promptCount = 0
  private firstPrompt: string | null = null
  private sessionTitle: string | null = null
  private cwd: string | null = null
  private model: string | null = null
  private startedAt: number | null = null
  private contextWindow: number | null = null
  private lastTime = 0
  private readonly callSpans = new Map<string, { start: number; end: number }>()

  push(line: string, file: SessionFileRef, lineIndex?: number): void {
    try {
      this.assembler.beginLine(file.id, lineIndex)
      const record = parseCursorLine(line)
      if (record === null) return
      const time = record.time ?? this.lastTime
      if (record.time !== null) this.lastTime = record.time
      if (record.tag === 'session') this.onSession(record.session, time)
      else this.onMessage(record.message, time, record.span)
    } catch {
      // A malformed record is skipped; the fold stays intact.
    }
  }

  snapshot() {
    return this.assembler.snapshot()
  }

  meta(): ParsedSessionMeta {
    return {
      title: this.sessionTitle ?? this.firstPrompt,
      cwd: this.cwd,
      model: this.model,
      startedAt: this.startedAt,
      promptCount: this.promptCount,
    }
  }

  subagents(): readonly SubagentRun[] {
    return []
  }

  imageUrl(attachment: { attachmentId: string }): string | undefined {
    return this.images.get(attachment.attachmentId)
  }

  private onSession(session: Record<string, unknown>, time: number): void {
    const title = asString(session['title'])?.trim()
    if (title !== undefined && title !== '') this.sessionTitle = title
    const cwd = asString(session['cwd'])
    if (cwd !== undefined && cwd !== '') this.cwd = cwd
    const model = asString(session['model'])
    if (model !== undefined && model !== '' && model !== 'default') this.model = model
    const created = asNumber(session['createdAt'])
    if (created !== undefined) this.startedAt = created
    const usage = usageOf(session['usage'])
    if (usage !== undefined && usage.window > 0) this.contextWindow = usage.window
    if (time > 0 && this.startedAt === null) this.startedAt = time
  }

  private onMessage(message: Record<string, unknown>, time: number, span?: CursorStepSpan): void {
    const role = asString(message['role'])
    if (role === 'system' || role === 'user') {
      const classified = cursorUserClass(message)
      if (classified === 'system') this.onSystem(message, time)
      else if (classified === 'human') this.onHuman(message, time)
      else this.onInjection(message, time)
      return
    }
    if (role === 'assistant') this.onAssistant(message, time, span)
    else if (role === 'tool') this.onTool(message, time)
  }

  private onSystem(message: Record<string, unknown>, time: number): void {
    const text = messageText(message)
    if (text === '') return
    const update = this.assembler.systemPrompts.length > 0
    this.assembler.systemPrompts.push({
      seq: this.assembler.seq.next(),
      time,
      turn: this.turn,
      step: this.step,
      text,
      update,
    })
    this.assembler.touch()
  }

  private onInjection(message: Record<string, unknown>, time: number): void {
    const text = messageText(message)
    if (text === '') return
    const seq = this.assembler.seq.next()
    const node: ContextMessageNode = {
      kind: 'context',
      seq,
      time,
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'cursor' },
      provenance: { role: 'inject', label: 'cursor' },
      form: 'notice',
    }
    this.assembler.pushNode(node)
    if (this.turn > 0) this.locate(seq, this.turn)
  }

  private onHuman(message: Record<string, unknown>, time: number): void {
    if (this.turnOpen) this.closeTurn()
    this.turn += 1
    this.step = 0
    this.turnOpen = true
    this.promptCount += 1
    const stripped = cursorHumanText(message)
    const raw = messageText(message)
    const text = stripped !== '' ? stripped : raw
    if (this.firstPrompt === null && text.trim() !== '') this.firstPrompt = titleFrom(text)
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    this.assembler.pushNode({
      kind: 'user',
      seq,
      time,
      content: text === '' ? [] : [{ type: 'text', text }],
      source: { kind: 'user' },
    })
  }

  private onAssistant(message: Record<string, unknown>, time: number, span?: CursorStepSpan): void {
    const parts = asArray(message['content'])
    if (parts === undefined) return
    if (this.turn === 0) {
      this.turn = 1
      this.turnOpen = true
    }
    this.step += 1
    const model = cursorModelOf(message)
    if (model !== undefined) this.model = model
    const blocks: AssistantBlock[] = []
    for (const part of parts) {
      if (!isRecord(part)) continue
      const type = asString(part['type'])
      if (type === 'reasoning') {
        blocks.push({ kind: 'reasoning', text: asString(part['text']) ?? '' })
      } else if (type === 'text') {
        blocks.push({ kind: 'text', text: asString(part['text']) ?? '' })
      } else if (type === 'tool-call') {
        const callId = asString(part['toolCallId'])
        if (callId === undefined) continue
        const name = asString(part['toolName']) ?? 'tool'
        const argsRaw = stringifyArgs(part['args'])
        blocks.push({ kind: 'tool-call', callId, name, argsRaw })
        const callSpan = span?.calls.find(call => call.id === callId)
        const callStart = callSpan?.start ?? time
        if (callSpan !== undefined) this.callSpans.set(callId, { start: callSpan.start, end: callSpan.end })
        this.assembler.tools.start({
          callId, name, argsRaw, turn: this.turn, step: this.step, time: callStart, subCalls: [],
        })
      } else {
        blocks.push({ kind: 'other', block: part })
      }
    }
    const seq = this.assembler.seq.next()
    this.locate(seq, this.turn)
    const provenance = model === undefined ? undefined : { provider: 'cursor', model }
    const requestConfig = model === undefined && this.contextWindow === null
      ? undefined
      : {
          provider: 'cursor',
          model: model ?? this.model ?? '',
          ...(this.contextWindow === null ? {} : { maxTokens: this.contextWindow }),
        }
    const stepStart = span?.start ?? time
    const stepEnd = span === undefined ? time : Math.max(span.end, stepStart)
    const request: AssistantRequestView = {
      purpose: 'assistant',
      startSeq: seq,
      startedAt: stepStart,
      completedAt: stepEnd,
      status: 'complete',
      turn: this.turn,
      step: this.step,
      resultSeq: seq,
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
    }
    this.assembler.upsertRequest(request)
    this.assembler.pushNode({
      kind: 'assistant',
      seq,
      time: stepEnd,
      turn: this.turn,
      step: this.step,
      blocks,
      ...(provenance === undefined ? {} : { provenance }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      timing: {
        stepStartTime: span === undefined ? null : stepStart,
        firstTokenTime: span === undefined ? null : stepStart,
        completedTime: stepEnd,
      },
    })
    const pending = blocks.some(block => block.kind === 'tool-call')
    if (!pending && this.turnOpen) this.closeTurn()
  }

  private onTool(message: Record<string, unknown>, time: number): void {
    const high = cursorBag(message)?.['highLevelToolCallResult']
    const isError = isRecord(high) && high['isError'] === true
    for (const part of asArray(message['content']) ?? []) {
      if (!isRecord(part) || part['type'] !== 'tool-result') continue
      const callId = asString(part['toolCallId']) ?? asString(message['id'])
      if (callId === undefined) continue
      const text = toolResultText(part)
      const content: ContentBlock[] = text === '' ? [] : [{ type: 'text', text }]
      const seq = this.assembler.seq.next()
      const known = this.callSpans.get(callId)
      const durationMs = known === undefined ? undefined : Math.max(0, time - known.start)
      const { node, topLevel } = this.assembler.tools.complete(callId, {
        seq,
        time,
        content,
        isError,
        ...(durationMs === undefined ? {} : { meta: { durationMs } }),
      })
      if (topLevel) {
        if (this.turn > 0) this.locate(seq, this.turn)
        this.assembler.pushNode(node)
      } else {
        this.assembler.touch()
      }
    }
    if (this.turnOpen && this.assembler.tools.runningCalls().length === 0) this.closeTurn()
  }

  private locate(seq: number, turn: number): void {
    if (this.assembler.locations.has(seq)) return
    const seqs = this.turnSeqs.get(turn) ?? []
    seqs.push(seq)
    this.turnSeqs.set(turn, seqs)
    this.assembler.locations.set(seq, this.turnLocation(turn))
  }

  private turnLocation(turn: number): ConversationLocation {
    return { kind: 'turn', turn: { turn, status: this.closedTurns.has(turn) ? 'closed' : 'open' } }
  }

  private closeTurn(): void {
    this.turnOpen = false
    if (this.turn <= 0) return
    this.closedTurns.add(this.turn)
    const location = this.turnLocation(this.turn)
    for (const seq of this.turnSeqs.get(this.turn) ?? []) this.assembler.locations.set(seq, location)
    this.assembler.touch()
  }
}

/** Create an incremental parser for Cursor Agent `cursor://` streams. */
export function createCursorParser(): SessionParser {
  return new CursorParser()
}
