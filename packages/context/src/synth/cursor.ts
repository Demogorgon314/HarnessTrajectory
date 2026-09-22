/**
 * Cursor Agent stream → fold events. One instance per `cursor://` file.
 *
 * The server emits `cursor.session` (sidecar facts, including the root's
 * context-usage snapshot) and `cursor.message` (one settled Vercel AI SDK
 * `ModelMessage`). There is no per-step token usage. The snapshot's `used` /
 * `window` is projected as a trailing usage-only `assistant/message` via
 * {@link CursorSynthesizer.preview} so the Context dashboard's fill tracks
 * the official occupancy without inventing a prompt on every step.
 * `system_prompt` and `tools` are priced onto those fold categories;
 * `rules`, `mcp`, and `subagents` are injections and `skills` is a skill
 * catalog. `conversation` and `summarized_conversation` are the messages
 * themselves and are not emitted again.
 *
 * Human vs injected reuses `cursorUserClass`. A system message is a
 * `system/message` segment. Tool results bind by the opaque `toolCallId`.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import {
  asArray, asNumber, asString, cursorHumanText, cursorModelOf, cursorUserClass, isRecord, parseCursorLine,
  type CursorStepSpan,
} from '@harness-trajectory/core'
import type { ContentBlock } from '../fold/event.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'
import { setRequestInput } from './requestInput.ts'
import type { InputEvent } from './requestInput.ts'

interface UsageSnapshot {
  used: number
  window: number
}

interface UsageBucket {
  key: string
  tokens: number
}

const ROLE_OVERHEAD = 4
const BLOCK_OVERHEAD = 4

/** A string whose `estimateSystemContent` price is `tokens` (exact for tokens > 4). */
function textForTokens(tokens: number): string {
  if (tokens <= ROLE_OVERHEAD) return ''
  return ' '.repeat((tokens - ROLE_OVERHEAD) * 4)
}

/**
 * One tool definition whose `estimateToolsTotal` price is `tokens`.
 * The store records the tools bucket and not the schema list, so this
 * stand-in exists only to put that official size on the fold (and to mark
 * tool schemas as recorded).
 */
function toolsForTokens(tokens: number): unknown[] {
  const price = (pad: number): number => {
    const tools = [{ name: 'cursor', description: 'x'.repeat(pad) }]
    return Math.ceil(JSON.stringify(tools).length / 4) + ROLE_OVERHEAD
  }
  let low = 0
  let high = Math.max(1, tokens * 4)
  let best = 0
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const priced = price(mid)
    if (priced === tokens) return [{ name: 'cursor', description: 'x'.repeat(mid) }]
    if (priced < tokens) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  for (let pad = Math.max(0, best - 4); pad <= best + 4; pad += 1) {
    if (price(pad) === tokens) return [{ name: 'cursor', description: 'x'.repeat(pad) }]
  }
  return [{ name: 'cursor', description: 'x'.repeat(best) }]
}

function bucketsOf(value: unknown): UsageBucket[] {
  if (!isRecord(value)) return []
  const buckets: UsageBucket[] = []
  for (const item of asArray(value['buckets']) ?? []) {
    if (!isRecord(item)) continue
    const key = asString(item['key'])
    if (key === undefined || key === '') continue
    buckets.push({ key, tokens: asNumber(item['tokens']) ?? 0 })
  }
  return buckets
}

function cursorBag(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const provider = record['providerOptions']
  if (!isRecord(provider)) return undefined
  const cursor = provider['cursor']
  return isRecord(cursor) ? cursor : undefined
}

function textOf(message: Record<string, unknown>): string {
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

function usageOf(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const used = asNumber(value['used'])
  const window = asNumber(value['window'])
  if (used === undefined && window === undefined) return undefined
  return { used: used ?? 0, window: window ?? 0 }
}

function resultText(part: Record<string, unknown>): string {
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

class CursorSynthesizer implements EventSynthesizer {
  readonly kind = 'cursor' as const
  private seq = 0
  private lastTime = 0
  private turn = 0
  private step = 0
  private pending = new Set<string>()
  private model: string | undefined
  private contextWindow: number | undefined
  private usage: UsageSnapshot | undefined
  private label: string | undefined
  private headerModel: string | undefined
  private sentWindow: number | undefined
  private buckets: UsageBucket[] = []
  private bucketsSent = false
  private systemBucket: number | undefined
  private toolSchemas: unknown[] = []
  private readonly children = new Map<string, AgentSpawn>()

  constructor(_file: SessionFileRef) {}

  push(line: string): readonly InputEvent[] {
    const out: InputEvent[] = []
    try {
      const record = parseCursorLine(line)
      if (record === null) return out
      const time = this.timeOf(record.time)
      if (record.tag === 'session') this.onSession(record.session, time, out)
      else this.onMessage(record.message, time, record.span, out)
    } catch {
      return []
    }
    return out
  }

  /**
   * Trailing usage checkpoint. Empty content so the fold books the official
   * `used` count as the latest request prompt and adds no surface node.
   * Reading this does not mutate the synthesizer.
   */
  preview(): readonly InputEvent[] {
    const usage = this.usage
    if (usage === undefined) return []
    const event: InputEvent = {
      type: 'assistant/message',
      seq: this.seq + 1,
      time: this.lastTime,
      data: {
        usage: { inputTokens: usage.used },
        message: { content: [] },
        ...(this.turn > 0 ? { turn: this.turn, step: this.step } : {}),
      },
    }
    setRequestInput(event, {
      source: 'reported',
      tokens: usage.used,
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(usage.window > 0
        ? { window: { tokens: usage.window, source: 'recorded' as const, kind: 'usable' as const } }
        : {}),
    })
    return [event]
  }

  meta(): SynthMeta {
    return {
      running: this.pending.size > 0,
      children: this.children,
      provider: 'cursor',
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.contextWindow === undefined ? {} : { contextWindow: this.contextWindow }),
      ...(this.label === undefined ? {} : { label: this.label }),
    }
  }

  private timeOf(stamp: number | null): number {
    if (stamp !== null) {
      this.lastTime = stamp
      return stamp
    }
    return this.lastTime
  }

  private emit(out: InputEvent[], type: string, time: number, data?: Record<string, unknown>): InputEvent {
    this.seq += 1
    const event: InputEvent = { type, seq: this.seq, time, ...(data === undefined ? {} : { data }) }
    out.push(event)
    return event
  }

  private onSession(session: Record<string, unknown>, time: number, out: InputEvent[]): void {
    const title = asString(session['title'])?.trim()
    if (title !== undefined && title !== '') this.label = title
    const model = asString(session['model'])
    if (model !== undefined && model !== '' && model !== 'default') this.model = model
    const usage = usageOf(session['usage'])
    if (usage !== undefined) {
      this.usage = usage
      if (usage.window > 0) this.contextWindow = usage.window
    }
    this.buckets = bucketsOf(session['usage'])
    const tools = this.buckets.find(bucket => bucket.key === 'tools')
    if (tools !== undefined && tools.tokens > ROLE_OVERHEAD) this.toolSchemas = toolsForTokens(tools.tokens)
    const system = this.buckets.find(bucket => bucket.key === 'system_prompt')
    if (system !== undefined && system.tokens > ROLE_OVERHEAD) this.systemBucket = system.tokens
    if (this.model !== undefined && this.model !== this.headerModel) {
      const reason = this.headerModel === undefined ? 'initial' : 'change'
      this.headerModel = this.model
      this.emitHeader(out, time, reason)
    } else if (this.toolSchemas.length > 0 && this.headerModel === undefined) {
      this.headerModel = ''
      this.emitHeader(out, time, 'initial')
    }
    this.emitBucketNodes(time, out)
    if (this.systemBucket !== undefined) this.emitSystemSize(time, out)
    if (this.contextWindow !== undefined && this.contextWindow !== this.sentWindow) {
      this.sentWindow = this.contextWindow
      this.emit(out, 'request/context', time, {
        contextWindow: this.contextWindow,
        ...(this.model === undefined ? {} : { model: this.model }),
        provider: 'cursor',
      })
    }
  }

  private emitHeader(out: InputEvent[], time: number, reason: 'initial' | 'change'): void {
    this.emit(out, 'request/header', time, {
      header: {
        ...(this.toolSchemas.length === 0 ? {} : { tools: this.toolSchemas }),
        config: {
          provider: 'cursor',
          ...(this.model === undefined || this.model === '' ? {} : { model: this.model }),
        },
      },
      reason,
    })
  }

  /** Official system-prompt size. The last system node is the one the fold shows. */
  private emitSystemSize(time: number, out: InputEvent[]): void {
    const tokens = this.systemBucket
    if (tokens === undefined || tokens <= ROLE_OVERHEAD) return
    this.emit(out, 'system/message', time, {
      message: { content: [{ type: 'text', text: textForTokens(tokens) }] },
    })
  }

  /**
   * Envelope buckets that are not the transcript. `conversation` and
   * `summarized_conversation` are the messages themselves.
   */
  private emitBucketNodes(time: number, out: InputEvent[]): void {
    if (this.bucketsSent) return
    this.bucketsSent = true
    for (const bucket of this.buckets) {
      if (bucket.tokens <= ROLE_OVERHEAD + BLOCK_OVERHEAD) continue
      if (bucket.key !== 'rules' && bucket.key !== 'mcp' && bucket.key !== 'subagents' && bucket.key !== 'skills') continue
      const stated = bucket.tokens - ROLE_OVERHEAD - BLOCK_OVERHEAD
      const content: ContentBlock[] = [{ type: 'text', text: bucket.key, tokens: stated }]
      if (bucket.key === 'skills') {
        this.emit(out, 'user/message', time, {
          content,
          source: { kind: 'skill-catalog', name: 'skills' },
        })
      } else {
        this.emit(out, 'user/message', time, {
          content,
          source: { kind: 'plugin', plugin: 'cursor', form: 'notice', name: bucket.key },
        })
      }
    }
  }

  private onMessage(message: Record<string, unknown>, time: number, span: CursorStepSpan | undefined, out: InputEvent[]): void {
    const role = asString(message['role'])
    if (role === 'system') {
      const text = textOf(message)
      if (text !== '') {
        this.emit(out, 'system/message', time, { message: { content: [{ type: 'text', text }] } })
      }
      this.emitSystemSize(time, out)
      return
    }
    if (role === 'user') {
      const classified = cursorUserClass(message)
      if (classified === 'human') this.onHuman(message, time, out)
      else this.onInjection(message, time, out)
      return
    }
    if (role === 'assistant') this.onAssistant(message, time, span, out)
    else if (role === 'tool') this.onTool(message, time, out)
  }

  private onHuman(message: Record<string, unknown>, time: number, out: InputEvent[]): void {
    this.turn += 1
    this.step = 0
    const stripped = cursorHumanText(message)
    const text = stripped !== '' ? stripped : textOf(message)
    if (this.label === undefined && text.trim() !== '') this.label = text.trim().slice(0, 80)
    const content: ContentBlock[] = text === '' ? [] : [{ type: 'text', text }]
    this.emit(out, 'user/message', time, { content, source: { kind: 'user' } })
  }

  private onInjection(message: Record<string, unknown>, time: number, out: InputEvent[]): void {
    const text = textOf(message)
    if (text === '') return
    this.emit(out, 'user/message', time, {
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'cursor', form: 'notice' },
    })
  }

  private onAssistant(
    message: Record<string, unknown>,
    time: number,
    span: CursorStepSpan | undefined,
    out: InputEvent[],
  ): void {
    const parts = asArray(message['content'])
    if (parts === undefined) return
    if (this.turn === 0) this.turn = 1
    this.step += 1
    const model = cursorModelOf(message)
    if (model !== undefined) this.model = model
    const blocks: ContentBlock[] = []
    const calls: Array<{ callId: string; name: string; args: unknown }> = []
    for (const part of parts) {
      if (!isRecord(part)) continue
      const type = asString(part['type'])
      if (type === 'reasoning') {
        blocks.push({ type: 'reasoning', text: asString(part['text']) ?? '' })
      } else if (type === 'text') {
        const text = asString(part['text']) ?? ''
        if (text !== '') blocks.push({ type: 'text', text })
      } else if (type === 'tool-call') {
        const callId = asString(part['toolCallId'])
        if (callId === undefined) continue
        calls.push({ callId, name: asString(part['toolName']) ?? 'tool', args: part['args'] })
      }
    }
    const start = span?.start ?? time
    const end = span === undefined ? time : Math.max(span.end, start)
    this.emit(out, 'step/start', start)
    if (blocks.length > 0) {
      const stream = (span?.blocks ?? []).map(block => ({
        type: 'chunk',
        time: block.start,
        chunk: { type: 'block-start', blockType: block.kind },
      }))
      const event = this.emit(out, 'assistant/message', end, {
        message: { content: blocks },
        turn: this.turn,
        step: this.step,
        ...(stream.length === 0 ? {} : { stream }),
      })
      setRequestInput(event, { source: 'unknown', ...(this.model === undefined ? {} : { model: this.model }) })
    }
    for (const call of calls) {
      this.pending.add(call.callId)
      const args = typeof call.args === 'string' ? call.args : stringify(call.args)
      const callStart = span?.calls.find(item => item.id === call.callId)?.start ?? start
      this.emit(out, 'tool/call', callStart, { callId: call.callId, name: call.name, arguments: args })
    }
    this.emit(out, 'step/end', end)
  }

  private onTool(message: Record<string, unknown>, time: number, out: InputEvent[]): void {
    const high = cursorBag(message)?.['highLevelToolCallResult']
    const isError = isRecord(high) && high['isError'] === true
    for (const part of asArray(message['content']) ?? []) {
      if (!isRecord(part) || part['type'] !== 'tool-result') continue
      const callId = asString(part['toolCallId']) ?? asString(message['id'])
      if (callId === undefined) continue
      this.pending.delete(callId)
      const text = resultText(part)
      const name = asString(part['toolName']) ?? 'tool'
      this.emit(out, 'tool/result', time, {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError,
            content: text === '' ? [] : [{ type: 'text', text }],
          } satisfies ContentBlock],
          source: { callId, name },
        },
        ...(isError ? { error: true } : {}),
      })
    }
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

export function createCursorSynthesizer(file: SessionFileRef): EventSynthesizer {
  return new CursorSynthesizer(file)
}
