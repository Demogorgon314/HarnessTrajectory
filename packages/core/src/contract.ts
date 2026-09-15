/**
 * Harness-agnostic conversation contract.
 *
 * These shapes are a dsh-free port of the deepseek-harness `ui-conversation`
 * contract (`records.ts` and `request-inspection.ts`). Adapters for concrete
 * harnesses (Claude Code, Codex) emit these nodes; the trajectory UI folds them
 * into turns, groups, and cells without knowing where they came from.
 */

// ---------------------------------------------------------------------------
// Content blocks (model-facing message parts)
// ---------------------------------------------------------------------------

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Reference to a durable image; bytes are resolved through an image loader. */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: {
    width: number
    height: number
  }
}

export interface FileAttachmentRef {
  attachmentId: string
  name: string
  bytes: number
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
}

export interface FileBlock {
  type: 'file'
  attachment: FileAttachmentRef
}

export interface ToolCallContentBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

export interface ToolResultContentBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | FileBlock
  | ToolCallContentBlock
  | ToolResultContentBlock

/**
 * Token accounting for one model call. Counts are disjoint: `inputTokens` is
 * uncached input only; cached input is reported as `cacheReadTokens` and
 * `cacheWriteTokens`.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Assistant request facts
// ---------------------------------------------------------------------------

export interface AssistantRequestConfig {
  provider: string
  model: string
  purpose?: string
  thinking?: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
}

export interface AssistantProvenanceView {
  provider: string
  model: string
}

export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'image'; attachment: ImageAttachmentRef }
  | { kind: 'tool-call'; callId: string; name: string; argsRaw: string }
  | { kind: 'other'; block: unknown }

export interface AssistantTiming {
  stepStartTime: number | null
  firstTokenTime: number | null
  completedTime: number
}

// ---------------------------------------------------------------------------
// Conversation nodes
// ---------------------------------------------------------------------------

export interface UserMessageNode {
  kind: 'user'
  seq: number
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

export interface AssistantMessageNode {
  kind: 'assistant'
  seq: number
  messageId?: string
  time: number
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
  usage?: TokenUsage | undefined
  provenance?: AssistantProvenanceView
  requestConfig?: AssistantRequestConfig
  timing?: AssistantTiming
  interrupted?: true
}

/** A user message that arrived while the model was still working on the turn. */
export interface SteeringMessageNode {
  kind: 'steering'
  messageId: string
  seq: number
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

export type ContextRole = 'inject' | 'recall'

export interface ContextProvenanceView {
  role: ContextRole
  label: string | null
}

export type KnownContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'

/** Non-human input injected into the model context (hooks, attachments, notices). */
export interface ContextMessageNode {
  kind: 'context'
  seq: number
  time: number
  content: readonly ContentBlock[]
  source: unknown
  provenance: ContextProvenanceView
  form: KnownContextForm | null
}

export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
}

export interface ModelRetryNode {
  kind: 'model-retry'
  seq: number
  time: number
  retryState: 'scheduled' | 'started' | 'cancelled'
  turn: number
  step: number
  provider: string
  retry: number
  maxRetries: number
  delayMs: number
  failure: LlmFailure
}

export interface TurnErrorNode {
  kind: 'turn-error'
  seq: number
  time: number
  turn: number
  step: number
  message: string
  code?: string
}

export interface TurnMaxTokensNode {
  kind: 'turn-max-tokens'
  seq: number
  time: number
  turn: number
  step: number
}

export interface ToolResultNode {
  kind: 'tool-result'
  seq: number
  time: number
  callId: string
  parentCallId?: string
  call: { name: string; argsRaw: string } | null
  callTime: number | null
  content: readonly ContentBlock[]
  isError: boolean
  error?: { name: string; code: string }
  meta?: unknown
  subCalls: readonly ToolCallBlock[]
}

export interface CompactionSummaryNode {
  kind: 'compaction'
  seq: number
  time: number
  summary: string | null
  summaryEventSeq: number | null
  shadowedItemCount: number | null
  shadowedTokenCount: number | null
}

export interface UnknownSurfaceNode {
  kind: 'unknown'
  seq: number
  time: number
  type: string
  data: unknown
}

export interface CommandNode {
  kind: 'command'
  seq: number
  time: number
  commandId: string
  name: string | null
  args: string | null
  outcome: {
    kind: 'success' | 'error'
    text?: string
    sourceEventSeq?: number
  } | null
}

export type ConversationNode =
  | UserMessageNode
  | AssistantMessageNode
  | SteeringMessageNode
  | ContextMessageNode
  | ModelRetryNode
  | TurnErrorNode
  | TurnMaxTokensNode
  | ToolResultNode
  | CommandNode
  | CompactionSummaryNode
  | UnknownSurfaceNode

/** A tool call the model emitted whose result has not arrived yet. */
export interface RunningToolCall {
  callId: string
  parentCallId?: string
  name: string
  argsRaw: string
  turn: number
  step: number
  time: number
  subCalls: readonly ToolCallBlock[]
}

export type ToolCallBlock = RunningToolCall | ToolResultNode

/** Assistant output still streaming for the current step. */
export interface PartialAssistant {
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
}

// ---------------------------------------------------------------------------
// Request inspection (prompt state and per-request facts)
// ---------------------------------------------------------------------------

export interface ConversationPromptSnapshot {
  config: AssistantRequestConfig
  system: string
  tools: readonly ToolSchema[]
}

/** Known system prompt text at a point in the session. */
export interface SystemPromptNode {
  seq: number
  time: number
  turn: number
  step: number
  text: string
  update: boolean
}

export interface RequestPromptChange {
  seq: number
  time: number
  kind: 'initial' | 'system' | 'tools' | 'system-and-tools'
  previous?: ConversationPromptSnapshot
}

interface RequestViewBase {
  startSeq: number
  startedAt: number
  completedAt: number | null
  status: 'running' | 'complete' | 'error'
  error?: string
  errorCode?: string
  provenance?: AssistantProvenanceView
  requestConfig?: AssistantRequestConfig
  usage?: TokenUsage | undefined
  resultSeq?: number
}

export interface AssistantRequestView extends RequestViewBase {
  purpose: 'assistant'
  turn: number
  step: number
  prompt?: ConversationPromptSnapshot
  promptChange?: RequestPromptChange
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
}

export interface CompactionRequestView extends RequestViewBase {
  purpose: 'compaction'
  turn: number | null
  step: 0
  replacementSeq?: number
  summary?: readonly ContentBlock[]
  rawOutput?: readonly ContentBlock[]
}

export type RequestView = AssistantRequestView | CompactionRequestView

// ---------------------------------------------------------------------------
// Locations (where an event sits in the turn/step structure)
// ---------------------------------------------------------------------------

export interface TurnLocation {
  readonly turn: number
  readonly status: 'open' | 'closed' | 'unknown'
}

export interface StepLocation {
  readonly step: number
}

export type ConversationLocation =
  | { readonly kind: 'session' }
  | { readonly kind: 'turn'; readonly turn: TurnLocation }
  | { readonly kind: 'step'; readonly turn: TurnLocation; readonly step: StepLocation }
  | { readonly kind: 'unresolved' }

// ---------------------------------------------------------------------------
// Trajectory snapshot: everything the ledger and timeline fold over
// ---------------------------------------------------------------------------

/**
 * Which folded record one transcript line produced.
 *
 * A tool call is addressed by its call id rather than by an event seq, because
 * a call and its result fold into ONE record (and a nested call has no
 * top-level node at all): both the line that emitted the call and the line that
 * carried its result point at the same `call` target.
 */
export type SourceLineTarget =
  | { readonly kind: 'seq'; readonly seq: number }
  | { readonly kind: 'call'; readonly callId: string }

/**
 * Where a record came from: resolves a raw transcript line back to the record
 * the fold built from it, so a full-text hit (`SearchHit.line`) can be scrolled
 * to. Lines are 0-based indexes among a file's NON-BLANK lines — the numbering
 * the server's replay and its search index share.
 *
 * The index is a live view of the parser, not a copied snapshot field: its
 * identity never changes, and it only ever grows.
 */
export interface SourceLineIndex {
  /**
   * The record a line produced. The rule, in order:
   *
   * 1. the FIRST record the line created — for a record whose node is emitted
   *    later (an assistant step closed by the following line) this is still the
   *    line that opened it;
   * 2. else the tool record the line belongs to, which binds both the line that
   *    emitted a call and the line that carried its result (and is the only way
   *    a call line resolves at all, since the record exists only once the
   *    result lands);
   * 3. else the nearest preceding record of the same file, which is where the
   *    stream chunks and housekeeping records that fold into nothing land;
   * 4. else nothing. A line the fold has not reached yet always answers
   *    `undefined`, never the tail, so a caller can keep waiting while a replay
   *    streams in.
   *
   * @param line - 0-based index among the file's non-blank lines.
   * @param fileId - transcript the line belongs to; omitted, the first file the
   * parser saw (the main transcript of the view).
   */
  targetAt(line: number, fileId?: string): SourceLineTarget | undefined
}

export interface TrajectorySnapshot {
  /** Complete loaded prompt text whose request header is outside the window. */
  readonly systemPrompts?: readonly SystemPromptNode[]
  readonly eventNodes: readonly ConversationNode[]
  readonly eventLocations: ReadonlyMap<number, ConversationLocation>
  readonly requests: readonly RequestView[]
  readonly callSchemas: ReadonlyMap<string, ToolSchema>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
  /** Line → record map, when the parser was fed line numbers. */
  readonly sourceLines?: SourceLineIndex
}

export const EMPTY_TRAJECTORY_SNAPSHOT: TrajectorySnapshot = Object.freeze({
  eventNodes: [],
  eventLocations: new Map(),
  requests: [],
  callSchemas: new Map(),
  partial: null,
  runningCalls: [],
})

/** Request facts plus the tool schema visible to each call, as the ledger inspects them. */
export interface RequestInspectionSnapshot {
  requests: readonly RequestView[]
  callSchemas: ReadonlyMap<string, ToolSchema>
}
