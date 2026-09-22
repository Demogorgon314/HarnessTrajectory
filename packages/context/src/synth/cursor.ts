/**
 * Cursor Agent stream → fold events. One instance per `cursor://` file.
 *
 * The server emits `cursor.session` (sidecar facts, including the root's
 * context-usage snapshot) and `cursor.message` (one settled Vercel AI SDK
 * `ModelMessage`). There is no per-step token usage. Current occupancy and
 * envelope bucket sizes travel through `meta().contextUsage`, separate from
 * the fold's request/cost history and actual message/schema content.
 * `conversation` and `summarized_conversation` are already in the transcript.
 *
 * Human vs injected reuses `cursorUserClass`. A system message is a
 * `system/message` segment. Tool results bind by the opaque `toolCallId`.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import {
  asArray, asNumber, asString, cursorHumanText, cursorModelOf, cursorUserClass, isRecord, parseCursorLine,
  cursorProviderOptions, cursorMessageText, cursorToolResultText, cursorArgsText, type CursorStepSpan,
} from '@harness-trajectory/core'
import type { ContentBlock } from '../fold/event.ts'
import type { ContextUsage } from '../shared/types.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'
import { setRequestInput } from './requestInput.ts'
import type { InputEvent } from './requestInput.ts'

function usageOf(value: unknown): ContextUsage | undefined {
  if (!isRecord(value)) return undefined
  const used = asNumber(value['used'])
  const window = asNumber(value['window'])
  if (used === undefined || used < 0) return undefined
  const usage: ContextUsage = { used, ...(window !== undefined && window > 0 ? { window } : {}) }
  for (const bucket of asArray(value['buckets']) ?? []) {
    if (!isRecord(bucket)) continue
    const tokens = asNumber(bucket['tokens'])
    if (tokens === undefined || tokens < 0) continue
    switch (bucket['key']) {
      case 'system_prompt': usage.system = tokens; break
      case 'tools': usage.tools = tokens; break
      case 'skills': usage.skill = tokens; break
      case 'rules':
      case 'mcp':
      case 'subagents': usage.inject = (usage.inject ?? 0) + tokens; break
    }
  }
  return usage
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
  private usage: ContextUsage | undefined
  private label: string | undefined
  private headerModel: string | undefined
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

  meta(): SynthMeta {
    return {
      running: this.pending.size > 0,
      children: this.children,
      provider: 'cursor',
      ...(this.usage === undefined ? {} : { contextUsage: this.usage }),
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
    // Each sidecar is a complete snapshot; missing/zero buckets must not retain
    // figures from an earlier root. It is not a historical request measurement.
    const usage = usageOf(session['usage'])
    if (JSON.stringify(usage) !== JSON.stringify(this.usage)) this.usage = usage
    this.contextWindow = this.usage?.window
    if (this.model !== undefined && this.model !== this.headerModel) {
      const reason = this.headerModel === undefined ? 'initial' : 'change'
      this.headerModel = this.model
      this.emitHeader(out, time, reason)
    }
  }

  private emitHeader(out: InputEvent[], time: number, reason: 'initial' | 'change'): void {
    this.emit(out, 'request/header', time, {
      header: {
        config: {
          provider: 'cursor',
          ...(this.model === undefined || this.model === '' ? {} : { model: this.model }),
        },
      },
      reason,
    })
  }

  private onMessage(message: Record<string, unknown>, time: number, span: CursorStepSpan | undefined, out: InputEvent[]): void {
    const role = asString(message['role'])
    if (role === 'system') {
      const text = cursorMessageText(message)
      if (text !== '') {
        this.emit(out, 'system/message', time, { message: { content: [{ type: 'text', text }] } })
      }
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
    const text = stripped !== '' ? stripped : cursorMessageText(message)
    if (this.label === undefined && text.trim() !== '') this.label = text.trim().slice(0, 80)
    const content: ContentBlock[] = text === '' ? [] : [{ type: 'text', text }]
    this.emit(out, 'user/message', time, { content, source: { kind: 'user' } })
  }

  private onInjection(message: Record<string, unknown>, time: number, out: InputEvent[]): void {
    const text = cursorMessageText(message)
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
    // A tool-only assistant response is still one model request. Its empty
    // content records the call without inventing input usage or surface text.
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
    for (const call of calls) {
      this.pending.add(call.callId)
      const args = cursorArgsText(call.args)
      const callStart = span?.calls.find(item => item.id === call.callId)?.start ?? start
      this.emit(out, 'tool/call', callStart, { callId: call.callId, name: call.name, arguments: args })
    }
    this.emit(out, 'step/end', end)
  }

  private onTool(message: Record<string, unknown>, time: number, out: InputEvent[]): void {
    const high = cursorProviderOptions(message)?.['highLevelToolCallResult']
    const isError = isRecord(high) && high['isError'] === true
    for (const part of asArray(message['content']) ?? []) {
      if (!isRecord(part) || part['type'] !== 'tool-result') continue
      const callId = asString(part['toolCallId']) ?? asString(message['id'])
      if (callId === undefined) continue
      this.pending.delete(callId)
      const text = cursorToolResultText(part)
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

export function createCursorSynthesizer(file: SessionFileRef): EventSynthesizer {
  return new CursorSynthesizer(file)
}
