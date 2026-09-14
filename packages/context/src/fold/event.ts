/**
 * The fold's input vocabulary (vendored from dsh-context `host/fold.ts`).
 *
 * A synthesizer turns one harness transcript file into a stream of these
 * events; `applyTimeline` folds them. Event types the fold understands (the
 * `data` fields it reads are documented in `fold.ts` next to each case):
 *
 *   request/header      data.header { system?: string, tools?: unknown[], config?: { model?, provider? } }, data.reason?: 'initial'|'change'|'resume'
 *   request/context     data.contextWindow?: number, data.model?: string, data.provider?: string
 *   step/start          (time only)
 *   step/end            (time only)
 *   user/message        data { content: ContentBlock[], source?: MessageSource }, surfaceOp? (replace range for compaction summaries)
 *   tool/call           data { callId: string, name: string, arguments?: string | object }
 *   tool/result         data { message: { content: ContentBlock[], source?: { callId } }, error?: unknown, meta?: unknown, fileOps?: FileOpInput[] }
 *   tool/ops            data { resultSeq: number, tool?: string, err?: boolean, fileOps: FileOpInput[] }
 *                       — a LATE file-op booking for a `tool/result` that already folded. Codex writes a
 *                       share of its `item_completed` records after the tool output line, so the
 *                       synthesizer emits this follow-up instead of deferring every result. The ops are
 *                       filed under `resultSeq` (the result's own seq), so the File Activity rows locate
 *                       on the right node; the event's own seq only orders the stream.
 *   assistant/message   data { message: { content: ContentBlock[] }, usage?: { inputTokens?, cacheReadTokens?, cacheWriteTokens?, outputTokens? }, turn?: number, step?: number, stream?: StreamRecord[] }
 *   plan/mode           data { active: boolean }
 *   compaction/summary  data { shadowedSeqs: number[], shadowedTokenCount?: number }
 *   compaction/prune    data { shadowedSeqs: number[], shadowedTokenCount?: number }
 *
 * `seq` is a strictly increasing integer per file; `time` is epoch milliseconds.
 */
export interface TimelineEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: unknown
}

/** Content block shape the fold prices (dsh content vocabulary). */
export interface ContentBlock {
  type: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'image' | (string & {})
  text?: string
  name?: string
  arguments?: string
  content?: ContentBlock[]
  callId?: string
  toolCallId?: string
  isError?: boolean
  /** Image dimensions when known; the fold prices images from them. */
  attachment?: { width?: number; height?: number } | null
  /**
   * Pre-priced token cost of this block's CONTENT (e.g. a harness-specific
   * image estimate such as Claude's `ceil(w*h/750)`): when it is a finite
   * non-negative number the fold uses it instead of estimating, and still
   * adds the usual per-block overhead on top — exactly how the built-in
   * image branch treats the vision calculator's result. A negative, NaN, or
   * non-numeric value is ignored and the block prices normally.
   */
  tokens?: number
}

/** Provenance of a `user/message`; anything but kind 'user' is an injection. */
export interface MessageSource {
  kind?: string
  form?: string
  name?: string
  plugin?: string
  summary?: string
  compactionId?: string
  changes?: ({ path?: string } | null)[]
  /**
   * `form: 'snapshot'` producers only: the named sections the snapshot
   * carried. The fold previews their names on the surface node. Entries stay
   * nullable — the log is untrusted input.
   */
  sections?: ({ name?: string } | null)[]
}

/**
 * The V2+ embedded stream shape the fold reads for first-token time and the
 * decode split: one `block-start` chunk per content block, in order.
 */
export interface StreamBlockStart {
  type: 'chunk'
  time: number
  chunk: { type: 'block-start'; blockType: 'reasoning' | 'text' | 'tool-call' }
}
export interface StreamTokenChunk {
  type: 'chunk'
  time: number
  chunk: { type: 'text-delta' | 'reasoning-delta'; text: string } | { type: 'tool-call-delta'; name?: string; argumentsDelta?: string }
}
export type StreamRecord = StreamBlockStart | StreamTokenChunk
