/**
 * DeepSeek Harness session-log wire protocol.
 *
 * Decodes the append-only event log dsh writes under
 * `$DSH_HOME/sessions/<--encoded-cwd-->/<session-id>/session[.vN].jsonl[.zstd]`
 * (`~/.dsh` when unset; verified against checkout writer
 * `SESSION_FORMAT_VERSION = 3`, release `dsh-v0.1.5-alpha.1`; the local corpus
 * holds v0 and v3). Line 1 is a `{"type":"session"}` header; every later line
 * is an event envelope `{type, seq, time, data, surfaceOp?, sourceEventSeqs?}`.
 * The trajectory adapter, context synthesizer, meta scanner, and search
 * extractor all share this module's decoders so no layer re-derives wire
 * shapes on its own.
 *
 * Traps:
 *  - `time`, `time0`, `createdAt` are epoch MILLISECONDS (never ISO, never
 *    seconds — do not run them through `parseTime`).
 *  - v0/v1 stream deltas are PACKED: `reasoning-chunks` / `text-chunks` /
 *    `tool-call-chunks` rows carry `{seq0, time0, data:{index, dt, texts|args}}`
 *    and stand for N `assistant/chunk` events at `time0 + cumulative dt`
 *    (`dt[i]` is the gap between member i and i+1; member 0 is at time0).
 *    v2+ moves the same records into `assistant/message.data.stream` /
 *    `assistant/attempt.data.stream` WITHOUT seqs.
 *  - `surfaceOp` is the bare string `'append'` by default; replace is spelled
 *    `{op:'replace', startSeq, endSeq}` in v3 and `{op:'replace', start, end}`
 *    in v0/v1 — read both.
 *  - `usage` buckets are DISJOINT: `inputTokens` excludes
 *    `cacheReadTokens`/`cacheWriteTokens`; `reasoningTokens` ⊂ `outputTokens`.
 *  - `sourceEventSeqs` may compress consecutive runs of ≥3 into `[start,end]`
 *    pairs mixed with plain numbers — expand on read.
 *  - A `user/message` whose `source.kind` is not `'user'` is injected
 *    context; one carrying a replace surfaceOp is a compaction summary.
 *  - A `tool/result` names its call via `message.source.callId`, falling
 *    back to the `tool-result` block's `toolCallId`.
 *  - A child session is a SEPARATE log whose header carries
 *    `origin:'subagent'`; the parent's continuable background result text is
 *    exactly `started subagent <childSessionId>` — the only binding the
 *    transcript records (foreground runs return output, no id).
 */

import type { TokenUsage } from '../contract.ts'
import { asArray, asNumber, asString, isRecord, parseJsonLine } from '../jsonl.ts'

/** The `type:"session"` header record (line 1). */
export interface DshHeader {
  version: number
  id: string
  createdAt: number | null
  cwd?: string
  parentSession?: string
  isSeeded: boolean
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}

/** One event-envelope line. `sourceEventSeqs` is already run-expanded. */
export interface DshEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

/** A v0/v1 packed stream row (`reasoning-chunks` | `text-chunks` | `tool-call-chunks` with `seq0`/`time0`). */
export interface DshStreamRun {
  type: 'reasoning-chunks' | 'text-chunks' | 'tool-call-chunks'
  seq0: number
  time0: number
  data: Record<string, unknown>
}

export type DshRecord =
  | { tag: 'header'; header: DshHeader }
  | { tag: 'event'; event: DshEvent }
  | { tag: 'run'; run: DshStreamRun }

const RUN_TYPES = new Set(['reasoning-chunks', 'text-chunks', 'tool-call-chunks'])

/** Cap on expanding a `sourceEventSeqs` run pair — hostile `[0, 1e9]` stays hostile-cheap. */
const SOURCE_SEQ_RUN_MAX = 100_000

function expandSourceSeqs(value: unknown): number[] | undefined {
  const raw = asArray(value)
  if (raw === undefined) return undefined
  const seqs: number[] = []
  for (const item of raw) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      seqs.push(item)
    } else if (Array.isArray(item)) {
      const [start, end] = item as unknown[]
      if (typeof start === 'number' && typeof end === 'number'
        && Number.isFinite(start) && Number.isFinite(end)
        && end >= start && end - start < SOURCE_SEQ_RUN_MAX) {
        for (let seq = start; seq <= end; seq += 1) seqs.push(seq)
      }
    }
  }
  return seqs
}

/**
 * Parse one JSONL line into a header, an event envelope, or a packed stream
 * run; `null` for blank, malformed, non-object, or type-less input.
 */
export function parseDshLine(line: string): DshRecord | null {
  const record = parseJsonLine(line)
  if (!isRecord(record)) return null
  const type = asString(record.type)
  if (type === undefined) return null
  if (type === 'session') {
    const cwd = asString(record.cwd)
    const parentSession = asString(record.parentSession)
    const delegationDepth = asNumber(record.delegationDepth)
    const agentPreset = asString(record.agentPreset)
    const header: DshHeader = {
      version: asNumber(record.version) ?? 0,
      id: asString(record.id) ?? '',
      createdAt: asNumber(record.createdAt) ?? null,
      isSeeded: record.isSeeded === true,
      ...(cwd === undefined ? {} : { cwd }),
      ...(parentSession === undefined ? {} : { parentSession }),
      ...(record.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(delegationDepth === undefined ? {} : { delegationDepth }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    }
    return { tag: 'header', header }
  }
  const seq0 = asNumber(record.seq0)
  const time0 = asNumber(record.time0)
  if (RUN_TYPES.has(type) && seq0 !== undefined && time0 !== undefined) {
    return {
      tag: 'run',
      run: {
        type: type as DshStreamRun['type'],
        seq0,
        time0,
        data: isRecord(record.data) ? record.data : {},
      },
    }
  }
  const sourceEventSeqs = expandSourceSeqs(record.sourceEventSeqs)
  const event: DshEvent = {
    type,
    seq: asNumber(record.seq) ?? -1,
    time: asNumber(record.time) ?? 0,
    data: isRecord(record.data) ? record.data : {},
    ...(record.surfaceOp === undefined ? {} : { surfaceOp: record.surfaceOp }),
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
  return { tag: 'event', event }
}

/**
 * Expand a packed stream run into the `assistant/chunk` events it stands
 * for: member i has `seq0 + i` and `time0 + cumulative dt`, and its chunk is
 * `{type:'*-delta', index, text}` or `{type:'tool-call-delta', index, id,
 * name? (first member only), argumentsDelta}`. Serves both top-level v0 rows
 * (member fields under `data`, seqs from `seq0`) and embedded v2+ stream
 * records (member fields at top level, no seqs — `seq0` defaults to 0 for
 * callers that only need times). A gapless `dt` truncates the expansion.
 */
export function expandDshStreamRun(run: DshStreamRun | Record<string, unknown>): DshEvent[] {
  const time0 = asNumber(run.time0)
  if (time0 === undefined) return []
  const fields: Record<string, unknown> = isRecord(run.data) ? { ...run.data } : {}
  for (const [key, value] of Object.entries(run)) fields[key] = value
  const fragments = asArray(run.type === 'tool-call-chunks' ? fields.args : fields.texts) ?? []
  const dt = asArray(fields.dt) ?? []
  const index = asNumber(fields.index) ?? 0
  const seq0 = asNumber(run.seq0) ?? 0
  const events: DshEvent[] = []
  let time = time0
  for (const [member, fragment] of fragments.entries()) {
    if (member > 0) {
      const gap = asNumber(dt[member - 1])
      if (gap === undefined) break
      time += gap
    }
    const data: Record<string, unknown> = {}
    if (asNumber(fields.turn) !== undefined) data['turn'] = fields.turn
    if (asNumber(fields.step) !== undefined) data['step'] = fields.step
    if (run.type === 'tool-call-chunks') {
      data['chunk'] = {
        type: 'tool-call-delta',
        index,
        id: asString(fields.id) ?? '',
        ...(member === 0 && fields.name !== undefined ? { name: asString(fields.name) ?? '' } : {}),
        argumentsDelta: asString(fragment) ?? '',
      }
    } else {
      data['chunk'] = {
        type: run.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta',
        index,
        text: asString(fragment) ?? '',
      }
    }
    events.push({ type: 'assistant/chunk', seq: seq0 + member, time, data })
  }
  return events
}

/**
 * The inclusive surface range a replace `surfaceOp` covers — v3's
 * `startSeq`/`endSeq` first, then v0's `start`/`end` — or null for `append`
 * and hostile shapes (which the surface treats as appends).
 */
export function dshReplaceRange(surfaceOp: unknown): { start: number; end: number } | null {
  if (!isRecord(surfaceOp) || surfaceOp.op !== 'replace') return null
  const start = asNumber(surfaceOp.startSeq) ?? asNumber(surfaceOp.start)
  const end = asNumber(surfaceOp.endSeq) ?? asNumber(surfaceOp.end)
  if (start === undefined || end === undefined) return null
  return { start, end }
}

export type DshUserClass = 'human' | 'injection' | 'compaction'

/**
 * THE one `user/message` classifier (adapter, synthesizer, meta scanner, and
 * search extractor all share it). Structural only: a replace surfaceOp makes
 * the message a compaction summary; `source.kind === 'user'` makes it human;
 * anything else is injected context.
 */
export function dshUserClass(event: Pick<DshEvent, 'data' | 'surfaceOp'>): DshUserClass {
  if (dshReplaceRange(event.surfaceOp) !== null) return 'compaction'
  const source = isRecord(event.data['source']) ? event.data['source'] : undefined
  return asString(source?.['kind']) === 'user' ? 'human' : 'injection'
}

/**
 * The `tool/result` binding every layer shares: the call id from
 * `message.source.callId` or the `tool-result` block's `toolCallId`, plus the
 * block itself (whose `content`, `isError`, and nested blocks carry the
 * model-visible result).
 */
export function dshToolResultOf(data: Record<string, unknown>): {
  callId: string | undefined
  result: Record<string, unknown> | undefined
} {
  const message = isRecord(data['message']) ? data['message'] : undefined
  const source = isRecord(message?.['source']) ? message?.['source'] : undefined
  const result = (asArray(message?.['content']) ?? [])
    .find(item => isRecord(item) && item['type'] === 'tool-result')
  return {
    callId: asString(source?.['callId']) ?? asString(isRecord(result) ? result['toolCallId'] : undefined),
    result: isRecord(result) ? result : undefined,
  }
}

/** Text of a `content` field: a plain string, or its `text` blocks joined by "\n". */
export function dshTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  return (asArray(content) ?? [])
    .flatMap(block => (isRecord(block) && block.type === 'text' ? [asString(block.text) ?? ''] : []))
    .join('\n')
}

/** dsh usage → contract `TokenUsage`; the disjoint buckets pass through. */
export function dshUsageOf(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value.inputTokens)
  const output = asNumber(value.outputTokens)
  const total = asNumber(value.totalTokens)
  const cacheRead = asNumber(value.cacheReadTokens)
  const cacheWrite = asNumber(value.cacheWriteTokens)
  const reasoning = asNumber(value.reasoningTokens)
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined
  }
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** Whether a stream `chunk` carries model-visible token content. */
export function isDshTokenChunk(chunk: unknown): boolean {
  if (!isRecord(chunk)) return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text !== ''
    case 'tool-call-delta':
      return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '')
        || chunk.name !== undefined
    default:
      return false
  }
}

function runFirstTokenTime(record: Record<string, unknown>): number | undefined {
  const time0 = asNumber(record.time0)
  if (time0 === undefined) return undefined
  if (record.type === 'tool-call-chunks' && record.name !== undefined) return time0
  const fragments = asArray(record.type === 'tool-call-chunks' ? record.args : record.texts)
  if (fragments === undefined) return undefined
  const dt = asArray(record.dt) ?? []
  let time = time0
  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) {
      const gap = asNumber(dt[index - 1])
      if (gap === undefined) return undefined
      time += gap
    }
    if (typeof fragment === 'string' && fragment !== '') return time
  }
  return undefined
}

/**
 * The first token's instant inside an embedded v2+/v3 assistant stream
 * (`assistant/message.data.stream`, `assistant/attempt.data.stream`), or
 * undefined when it carries none. Mirrors the fold's `firstTokenTimeOfStream`
 * (reimplemented here — core must not import context).
 */
export function dshFirstTokenTime(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (!isRecord(record)) continue
    if (record.type === 'chunk') {
      const time = asNumber(record.time)
      if (time !== undefined && isDshTokenChunk(record.chunk)) return time
      continue
    }
    const time = runFirstTokenTime(record)
    if (time !== undefined) return time
  }
  return undefined
}

/** The child session id a continuable background subagent result names. */
export function dshSubagentIdOf(resultText: string): string | undefined {
  return /^started subagent (\S+)$/.exec(resultText.trim())?.[1]
}
