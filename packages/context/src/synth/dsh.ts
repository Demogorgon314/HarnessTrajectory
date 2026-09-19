/**
 * DeepSeek Harness session log (`$DSH_HOME/sessions/<--encoded-cwd-->/<id>/
 * session[.vN].jsonl[.zstd]`) → fold events. The fold was vendored FROM dsh
 * and consumes this vocabulary natively, so the synthesizer is nearly a
 * pass-through: it keeps the logged `seq`, `time`, and `surfaceOp` UNCHANGED
 * (replace ranges and `shadowedSeqs` address log seqs, and the fold reads
 * both endpoint spellings) and drops every event type the fold has no case
 * for — approvals, dispatch bookkeeping, retries, titles — since none of
 * them carry model-visible context.
 *
 * The only transforms:
 *  - v0/v1 packed stream rows (`reasoning-chunks`/`text-chunks`/
 *    `tool-call-chunks` with `seq0`/`time0`) expand into the N
 *    `assistant/chunk` events they stand for; v2+ embeds the same records in
 *    `assistant/message.data.stream`, which the fold reads itself.
 *  - `assistant/message` gets `requestInput` attached: dsh usage buckets are
 *    disjoint, so reported input is `inputTokens + cacheRead + cacheWrite`.
 *  - `image/offload` re-emits each targeted `user/message`/`tool/result`
 *    node as a `replay` replacement at a FRESH seq just past the offload
 *    event: the original keeps its seq and content (requests before the
 *    offload still reconstruct its image), the projected copy is the
 *    effective boundary. Selected images keep their durable `offloaded`
 *    mark in retained state and project to upstream's text placeholder,
 *    so the fold's image count and token estimate drop the payload
 *    exactly like the real request projection. Producer claims name
 *    original seqs, so replace ranges and `shadowedSeqs` are translated
 *    onto the copy currently live before the fold applies them.
 *
 * Children: a dsh child session id IS its file id, so `childKeyOf` needs no
 * dsh branch — a continuable background run binds when the parent's
 * `tool/result` text is exactly `started subagent <childSessionId>`.
 */

import {
  asArray, asNumber, asString, isRecord, parseJsonLine,
  dshReplaceRange, dshSubagentIdOf, dshTextOf, dshToolResultOf, dshUserClass,
  expandDshStreamRun, parseDshLine, titleFrom,
  type SessionFileRef,
} from '@harness-trajectory/core'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'
import { disjointInput, setRequestInput, type InputEvent } from './requestInput.ts'

/** The event types the fold has a case for; everything else drops. */
const FOLD_TYPES = new Set([
  'request/header',
  'request/context',
  'system/message',
  'step/start',
  'step/end',
  'user/message',
  'tool/call',
  'tool/result',
  'assistant/message',
  'assistant/attempt',
  'assistant/chunk',
  'tool/ptc-dispatch',
  'tool/code-dispatch',
  'plan/mode',
  'compaction/summary',
  'compaction/prune',
])

/** One `tool/call` waiting for its `tool/result` — kept for child binding and `running`. */
interface PendingCall {
  name: string
  arguments: unknown
  time: number
}

/**
 * The retained payload of a live surface node an `image/offload` may still
 * target, keyed by the event seq that produced it. Projected offloaded
 * images keep their `offloaded: true` mark durably so repeated offloads
 * count every occurrence (indexes span already-offloaded images). This is
 * a bounded content cache — eviction only loses offload targeting, never
 * the seq identity in `liveSeqs`.
 */
interface Offloadable {
  type: 'user/message' | 'tool/result'
  data: Record<string, unknown>
  toolName?: string
}

/** Bound on retained image-bearing nodes — an evicted node only loses offload targeting. */
const OFFLOADABLE_MAX = 256

/** Port of upstream `contentHasImage`: any image block, walking tool-result nesting. */
function contentHasImage(content: unknown): boolean {
  return (asArray(content) ?? []).some(block =>
    isRecord(block) && (block['type'] === 'image'
      || (block['type'] === 'tool-result' && contentHasImage(block['content']))))
}

/**
 * Immutable application of one offload target's `imageIndexes`, mirroring
 * upstream `offloadMessageImages`: depth-first zero-based indexes mark the
 * selected blocks `offloaded: true`; undefined when a selected occurrence is
 * missing or already offloaded.
 */
function markOffloadedImages(content: unknown, indexes: readonly number[]): unknown[] | undefined {
  const blocks = asArray(content)
  if (blocks === undefined) return undefined
  const state = { imageIndex: 0, selected: 0 }
  const visit = (items: readonly unknown[]): unknown[] | null => {
    let next: unknown[] | undefined
    for (const [index, block] of items.entries()) {
      let projected = block
      if (isRecord(block) && block['type'] === 'image') {
        if (state.imageIndex === indexes[state.selected]) {
          if (block['offloaded'] === true) return null
          projected = { ...block, offloaded: true }
          state.selected += 1
        }
        state.imageIndex += 1
      } else if (isRecord(block) && block['type'] === 'tool-result' && Array.isArray(block['content'])) {
        const inner = visit(block['content'] as unknown[])
        if (inner === null) return null
        if (inner !== block['content']) projected = { ...block, content: inner }
      }
      if (projected !== block) next ??= items.slice(0, index)
      next?.push(projected)
    }
    return next ?? [...items]
  }
  const result = visit(blocks)
  return result !== null && state.selected === indexes.length ? result : undefined
}

/**
 * Upstream's deterministic placeholder for a request-limit image omission
 * (no local normalized copy resolved): the model-visible text a serialized
 * request carries in place of the durable attachment.
 */
function offloadedImageText(attachment: unknown): string {
  const ref = isRecord(attachment) ? attachment : undefined
  const id = asString(ref?.['attachmentId']) ?? ''
  const name = asString(ref?.['name'])
  const identity = name === undefined ? id : `${JSON.stringify(name)} (${id})`
  return `[image omitted to fit request image limits; ${identity}.`
    + ' No local normalized image path is available; ask the user to attach it again if needed.]'
}

/** Model-visible content projection: marked image blocks become their text placeholders. */
function projectOffloaded(content: unknown): unknown {
  const blocks = asArray(content)
  if (blocks === undefined) return content
  let next: unknown[] | undefined
  for (const [index, block] of blocks.entries()) {
    let projected = block
    if (isRecord(block) && block['type'] === 'image' && block['offloaded'] === true) {
      projected = { type: 'text', text: offloadedImageText(block['attachment']) }
    } else if (isRecord(block) && block['type'] === 'tool-result' && Array.isArray(block['content'])) {
      const inner = projectOffloaded(block['content'])
      if (inner !== block['content']) projected = { ...block, content: inner }
    }
    if (projected !== block) next ??= blocks.slice(0, index)
    next?.push(projected)
  }
  return next ?? content
}

class DshSynthesizer implements EventSynthesizer {
  readonly kind = 'dsh' as const

  private model: string | undefined
  private provider: string | undefined
  private contextWindow: number | undefined
  private sessionTitle: string | undefined
  private firstPrompt: string | undefined
  private descriptorLabel: string | undefined
  private stepOpen = false
  private readonly pendingCalls = new Map<string, PendingCall>()
  private readonly children = new Map<string, AgentSpawn>()
  private readonly offloadable = new Map<number, Offloadable>()
  /**
   * Original event seq → seq of the copy currently occupying its surface
   * slot. Separate from the `offloadable` cache: the map answers "which
   * node does a producer claim actually remove", so it is released only
   * when that node truly leaves the surface — a cache eviction must never
   * strand a live copy behind an untranslated claim.
   */
  private readonly liveSeqs = new Map<number, number>()

  push(line: string): readonly InputEvent[] {
    const out: InputEvent[] = []
    try {
      this.consume(line, out)
    } catch {
      // A synthesizer must never throw: a malformed record yields nothing.
    }
    return out
  }

  meta(): SynthMeta {
    const label = this.sessionTitle ?? this.firstPrompt ?? this.descriptorLabel
    return {
      running: this.stepOpen || this.pendingCalls.size > 0,
      children: this.children,
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.contextWindow === undefined ? {} : { contextWindow: this.contextWindow }),
      ...(label === undefined ? {} : { label }),
    }
  }

  private consume(line: string, out: InputEvent[]): void {
    const record = parseDshLine(line)
    if (record === null) return
    if (record.tag === 'header') return
    if (record.tag === 'run') {
      for (const event of expandDshStreamRun(record.run)) {
        out.push({ type: 'assistant/chunk', seq: event.seq, time: event.time, data: event.data })
      }
      return
    }
    const event = record.event
    let data = event.data
    // Producer claims name ORIGINAL event seqs; a replayed offload copy
    // carries the offload's seq instead. Translate every claim onto the
    // copy actually live, then release the bookkeeping the claim removes:
    // originals the claim names, and live copies the translated claim
    // covers (either side means the node is gone from the surface).
    const replaced = dshReplaceRange(event.surfaceOp)
    let surfaceOp = event.surfaceOp
    if (replaced !== null) {
      const start = this.liveSeqOf(replaced.start)
      const end = this.liveSeqOf(replaced.end)
      if (start !== replaced.start || end !== replaced.end) {
        surfaceOp = { op: 'replace', startSeq: start, endSeq: end }
      }
      this.releaseClaimedRange(replaced.start, replaced.end, start, end)
    }
    const shadowed = asArray(data['shadowedSeqs'])
    if (shadowed !== undefined) {
      const named = new Set<number>()
      const live = new Set<number>()
      const translated = shadowed.map(seq => {
        if (typeof seq !== 'number') return seq
        named.add(seq)
        const liveSeq = this.liveSeqOf(seq)
        live.add(liveSeq)
        return liveSeq
      })
      data = { ...data, shadowedSeqs: translated }
      this.releaseClaimedSeqs(named, live)
    }
    switch (event.type) {
      case 'request/header': {
        const header = isRecord(data['header']) ? data['header'] : undefined
        const config = isRecord(header?.['config']) ? header['config'] : undefined
        this.provider = asString(config?.['provider']) ?? this.provider
        this.model = asString(config?.['model']) ?? this.model
        break
      }
      case 'request/context':
        this.provider = asString(data['provider']) ?? this.provider
        this.model = asString(data['model']) ?? this.model
        this.contextWindow = asNumber(data['contextWindow']) ?? this.contextWindow
        break
      case 'session/title': {
        const title = asString(data['title'])
        if (title !== undefined && title !== '') this.sessionTitle = title
        break
      }
      case 'subagent/descriptor': {
        const label = asString(data['label'])
        if (label !== undefined && label !== '') this.descriptorLabel ??= label
        break
      }
      case 'user/message':
        if (this.firstPrompt === undefined && dshUserClass(event) === 'human') {
          const text = dshTextOf(data['content'])
          if (text.trim() !== '') this.firstPrompt = titleFrom(text)
        }
        if (contentHasImage(data['content'])) this.retainOffloadable(event.seq, { type: 'user/message', data })
        break
      case 'step/start':
        this.stepOpen = true
        break
      case 'step/end':
        this.stepOpen = false
        break
      case 'tool/call': {
        const callId = asString(data['callId'])
        if (callId !== undefined) {
          this.pendingCalls.set(callId, {
            name: asString(data['name']) ?? 'tool',
            arguments: data['arguments'],
            time: event.time,
          })
        }
        break
      }
      case 'tool/result': {
        const { callId, result } = dshToolResultOf(data)
        const call = callId === undefined ? undefined : this.pendingCalls.get(callId)
        if (callId !== undefined) this.pendingCalls.delete(callId)
        const childId = dshSubagentIdOf(dshTextOf(result?.['content']))
        if (childId !== undefined) {
          const spawn: AgentSpawn = {
            key: childId,
            label: call === undefined ? '' : this.callDescription(call) ?? '',
            ...(callId === undefined ? {} : { callId }),
            ...(call === undefined ? {} : { startedAt: call.time }),
          }
          this.children.set(childId, spawn)
        }
        const message = isRecord(data['message']) ? data['message'] : undefined
        if (contentHasImage(message?.['content'])) {
          this.retainOffloadable(event.seq, {
            type: 'tool/result', data,
            ...(call === undefined ? {} : { toolName: call.name }),
          })
        }
        break
      }
      case 'image/offload': {
        const targets = asArray(data['targets']) ?? []
        for (const [index, target] of targets.entries()) {
          if (!isRecord(target)) continue
          const seq = asNumber(target['seq'])
          const held = seq === undefined ? undefined : this.offloadable.get(seq)
          const indexes = (asArray(target['imageIndexes']) ?? [])
            .filter((imageIndex): imageIndex is number => typeof imageIndex === 'number'
              && Number.isInteger(imageIndex) && imageIndex >= 0)
          if (seq === undefined || held === undefined || indexes.length === 0) continue
          const marked = markOffloadedImages(this.heldContent(held), indexes)
          if (marked === undefined) continue
          this.writeHeldContent(held, marked)
          // The projected copy is a NEW node just past the offload event:
          // its seq bounds where the offload takes effect — requests
          // before it still reconstruct the original image (kept under
          // its own seq, archived with this one as `gone`), later ones
          // see the placeholder. `replay` keeps the fold from re-booking
          // the copy's inputs, tool timing, and file ops.
          const replaySeq = event.seq + (index + 1) / (targets.length + 1)
          out.push({
            type: held.type,
            seq: replaySeq,
            time: event.time,
            data: this.projectedData(held),
            surfaceOp: { op: 'replace', startSeq: this.liveSeqOf(seq), endSeq: this.liveSeqOf(seq) },
          })
          this.liveSeqs.set(seq, replaySeq)
        }
        break
      }
      default:
        break
    }
    if (!FOLD_TYPES.has(event.type)) return
    const input: InputEvent = {
      type: event.type,
      seq: event.seq,
      time: event.time,
      data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    }
    if (event.type === 'assistant/message') {
      setRequestInput(input, disjointInput(data['usage'], this.model))
    }
    out.push(input)
  }

  /** The seq of the copy currently occupying `seq`'s surface slot. */
  private liveSeqOf(seq: number): number {
    return this.liveSeqs.get(seq) ?? seq
  }

  private retainOffloadable(seq: number, held: Offloadable): void {
    if (this.offloadable.size >= OFFLOADABLE_MAX) {
      const oldest = this.offloadable.keys().next()
      if (!oldest.done) this.offloadable.delete(oldest.value)
    }
    this.offloadable.set(seq, held)
  }

  /**
   * Release bookkeeping for a replace range: originals the claim names and
   * live copies the translated span covers are both gone from the surface.
   */
  private releaseClaimedRange(origStart: number, origEnd: number, liveStart: number, liveEnd: number): void {
    for (const [original, live] of this.liveSeqs) {
      const named = original >= origStart && original <= origEnd
      const covered = live >= liveStart && live <= liveEnd
      if (named || covered) {
        this.liveSeqs.delete(original)
        this.offloadable.delete(original)
      }
    }
    for (const seq of [...this.offloadable.keys()]) {
      if (seq >= origStart && seq <= origEnd) this.offloadable.delete(seq)
    }
  }

  /** Release bookkeeping for a seq claim: originals named and live copies covered. */
  private releaseClaimedSeqs(named: ReadonlySet<number>, live: ReadonlySet<number>): void {
    for (const [original, liveSeq] of this.liveSeqs) {
      if (named.has(original) || live.has(liveSeq)) {
        this.liveSeqs.delete(original)
        this.offloadable.delete(original)
      }
    }
    for (const seq of named) this.offloadable.delete(seq)
  }

  /** The content blocks an offload indexes — `data.content`, or `data.message.content` for a tool result. */
  private heldContent(held: Offloadable): unknown {
    return held.type === 'tool/result'
      ? (isRecord(held.data['message']) ? held.data['message']['content'] : undefined)
      : held.data['content']
  }

  /** Commit newly marked blocks into the retained payload (offloaded marks accumulate across offloads). */
  private writeHeldContent(held: Offloadable, content: readonly unknown[]): void {
    if (held.type === 'tool/result') {
      const message = isRecord(held.data['message']) ? held.data['message'] : {}
      held.data = { ...held.data, message: { ...message, content } }
    } else {
      held.data = { ...held.data, content }
    }
  }

  /**
   * The replay event's data: the retained payload with every marked image
   * projected to its text placeholder, plus the `tool/result` `source.name`
   * the fold needs once `replay` skips the call pairing.
   */
  private projectedData(held: Offloadable): Record<string, unknown> {
    if (held.type === 'tool/result') {
      const message = isRecord(held.data['message']) ? held.data['message'] : {}
      const source = isRecord(message['source']) ? message['source'] : {}
      return {
        ...held.data,
        message: {
          ...message,
          content: projectOffloaded(this.heldContent(held)),
          source: { ...source, ...(held.toolName === undefined ? {} : { name: held.toolName }) },
        },
        replay: true,
      }
    }
    return { ...held.data, content: projectOffloaded(this.heldContent(held)), replay: true }
  }

  /** The `description` argument of a recorded `tool/call` (subagent task caption). */
  private callDescription(call: PendingCall): string | undefined {
    const raw = typeof call.arguments === 'string'
      ? call.arguments
      : JSON.stringify(call.arguments ?? {})
    const args = parseJsonLine(raw)
    return isRecord(args) ? asString(args['description']) : undefined
  }
}

/**
 * One instance per file; `file.id` of a child file is the child session id,
 * which is exactly the `AgentSpawn.key` the parent's `started subagent <id>`
 * result binds — `childKeyOf` falls through to `file.id` for dsh.
 */
export function createDshSynthesizer(_file: SessionFileRef): EventSynthesizer {
  return new DshSynthesizer()
}
