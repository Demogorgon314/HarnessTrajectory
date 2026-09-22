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
 *   a human turn, unless `providerOptions.cursor.isSummary` marks a compaction.
 *   Other user messages are injected (environment, interrupt, reminder).
 *   `role === 'system'` is the system prompt. Never match on text.
 * - `toolCallId` contains a raw newline (`call-…\nfc_…`). It is an opaque id;
 *   never split it.
 * - `reasoning.text` is empty for Grok (signature only) and populated for
 *   Claude. The part is still a reasoning marker. The per-step model is
 *   `reasoning.providerOptions.cursor.modelName`; `lastUsedModel: "default"`
 *   is not a model id.
 * - A tool result prefers the `result` string, then `experimental_content`
 *   text, then JSON. `isError` is
 *   `providerOptions.cursor.highLevelToolCallResult.isError`.
 * - Summaries become compaction rows. Kept `replay:true` copies belong only
 *   to Context, not another historical occurrence. A rewind can still reset
 *   the stream and recreate this parser.
 */

import type {
  AssistantBlock, AssistantRequestView, ContentBlock, ContextMessageNode, ConversationLocation,
} from '../contract.ts'
import { asArray, asNumber, asString, isRecord } from '../jsonl.ts'
import type { ParsedSessionMeta, SessionFileRef, SessionParser, SubagentRun } from '../session.ts'
import { DataUrlImageStore, titleFrom, TrajectoryAssembler } from './shared.ts'

import {
  cursorProviderOptions, cursorMessageText, cursorToolResultText, cursorArgsText, cursorUsageOf,
  cursorHumanText, cursorModelOf, cursorUserClass, parseCursorLine, type CursorStepSpan,
} from './cursor-protocol.ts'

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
      else if (!record.replay) this.onMessage(record.message, time, record.span)
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
    const usage = cursorUsageOf(session['usage'])
    if (usage !== undefined && usage.window > 0) this.contextWindow = usage.window
    if (time > 0 && this.startedAt === null) this.startedAt = time
  }

  private onMessage(message: Record<string, unknown>, time: number, span?: CursorStepSpan): void {
    const role = asString(message['role'])
    if (role === 'system' || role === 'user') {
      const classified = cursorUserClass(message)
      if (classified === 'system') this.onSystem(message, time)
      else if (classified === 'summary') this.onSummary(message, time)
      else if (classified === 'human') this.onHuman(message, time)
      else this.onInjection(message, time)
      return
    }
    if (role === 'assistant') this.onAssistant(message, time, span)
    else if (role === 'tool') this.onTool(message, time)
  }

  private onSystem(message: Record<string, unknown>, time: number): void {
    const text = cursorMessageText(message)
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
    const text = cursorMessageText(message)
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

  private onSummary(message: Record<string, unknown>, time: number): void {
    const text = cursorMessageText(message)
    const summary = text.trim() === '' ? null : text
    const seq = this.assembler.seq.next()
    this.assembler.pushNode({
      kind: 'compaction', seq, time, summary,
      summaryEventSeq: summary === null ? null : seq,
      shadowedItemCount: null, shadowedTokenCount: null,
    })
    this.assembler.upsertRequest({
      purpose: 'compaction', turn: this.turn > 0 ? this.turn : null, step: 0,
      startSeq: seq, startedAt: time, completedAt: time, status: 'complete', resultSeq: seq,
      ...(summary === null ? {} : { summary: [{ type: 'text', text: summary }] }),
    })
  }

  private onHuman(message: Record<string, unknown>, time: number): void {
    if (this.turnOpen) this.closeTurn()
    this.turn += 1
    this.step = 0
    this.turnOpen = true
    this.promptCount += 1
    const stripped = cursorHumanText(message)
    const raw = cursorMessageText(message)
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
        const argsRaw = cursorArgsText(part['args'])
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
    const high = cursorProviderOptions(message)?.['highLevelToolCallResult']
    const isError = isRecord(high) && high['isError'] === true
    for (const part of asArray(message['content']) ?? []) {
      if (!isRecord(part) || part['type'] !== 'tool-result') continue
      const callId = asString(part['toolCallId']) ?? asString(message['id'])
      if (callId === undefined) continue
      const text = cursorToolResultText(part)
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
