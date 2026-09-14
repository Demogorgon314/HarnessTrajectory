/** Session discovery and parsing contracts shared by the server and the web client. */

import type { ImageAttachmentRef, TrajectorySnapshot } from './contract.ts'

export type HarnessKind = 'claude' | 'codex' | 'kimi'

export const HARNESS_KINDS: readonly HarnessKind[] = ['claude', 'codex', 'kimi']

/** Facts about a subagent transcript recorded next to it (Claude Code `agent-<id>.meta.json`). */
export interface AgentFileMeta {
  agentId: string
  /** Id of the parent's `Agent` tool call that spawned this transcript. */
  toolUseId?: string
  description?: string
  agentType?: string
  model?: string
  isFork?: boolean
}

/**
 * One JSONL file that contributes to a session: the main transcript or a child
 * (subagent) transcript. A child served on its own (the subagent view) is sent
 * with `role: 'main'` and its `agent` facts, so adapters fold it as a complete
 * transcript rather than nesting it.
 */
export interface SessionFileRef {
  /** Stable identity within the session (main transcript id, or the child's own id). */
  id: string
  role: 'main' | 'child'
  /** Absolute path on the scanned machine. */
  path: string
  /** For a child transcript, the parent transcript id when known. */
  parentId?: string
  /** Subagent facts when this file is (or was served as) an agent transcript. */
  agent?: AgentFileMeta
}

/** Listing row for one child transcript of a session. */
export interface SessionChildSummary {
  file: SessionFileRef
  /** Epoch milliseconds of the last write to the file. */
  updatedAt: number
  bytes: number
}

/** Listing row for the session picker. */
export interface SessionSummary {
  id: string
  kind: HarnessKind
  title: string
  /** Working directory the agent ran in, when recorded. */
  cwd: string | null
  /** Primary model seen in the transcript, when recorded. */
  model: string | null
  /** Epoch milliseconds of the first record, when recorded. */
  startedAt: number | null
  /** Epoch milliseconds of the last write to any file of the session. */
  updatedAt: number
  /** Total bytes across all files of the session. */
  bytes: number
  /** Whether the transcript was written to recently enough to be considered in progress. */
  live: boolean
  /** Number of child (subagent) transcripts attached to this session. */
  childCount: number
  /** Number of human prompts seen. */
  promptCount: number
}

export interface SessionDetail extends SessionSummary {
  files: readonly SessionFileRef[]
  children: readonly SessionChildSummary[]
}

/** Lifecycle of one subagent run as the parent transcript reports it. */
export type SubagentStatus = 'launching' | 'running' | 'completed' | 'failed' | 'stopped'

/** One subagent run seen while parsing a session, joined from the parent's calls and the child's transcript. */
export interface SubagentRun {
  /** Harness id of the run (Claude `agentId`, Codex child thread id). */
  agentId: string
  /** Child transcript file id once one of its lines has been seen. */
  fileId: string | null
  /** Parent tool call that spawned the run, when bound. */
  callId: string | null
  description: string | null
  agentType: string | null
  model: string | null
  status: SubagentStatus
  /** Epoch milliseconds the run was requested (parent call time). */
  startedAt: number | null
  /** Epoch milliseconds the parent learned the run ended. */
  endedAt: number | null
  /** Epoch milliseconds of the last child transcript record. */
  lastTime: number | null
  toolCalls: number
}

/** Session-level facts an adapter learns while parsing. */
export interface ParsedSessionMeta {
  title: string | null
  cwd: string | null
  model: string | null
  startedAt: number | null
  promptCount: number
}

/** Attachment bytes resolved to a data URL, keyed by attachment id. */
export interface ImageStore {
  get(attachmentId: string): string | undefined
  keys(): IterableIterator<string>
}

/**
 * Incremental transcript parser. The server and the browser both feed raw
 * JSONL lines; `snapshot()` returns the current fold, stable between pushes.
 */
export interface SessionParser {
  readonly kind: HarnessKind
  /** Feed one raw JSONL line from one of the session's files. */
  push(line: string, file: SessionFileRef): void
  /** Current trajectory fold; a new object only when something changed. */
  snapshot(): TrajectorySnapshot
  meta(): ParsedSessionMeta
  /** Subagent runs spawned by this session, in launch order. */
  subagents(): readonly SubagentRun[]
  images: ImageStore
  /** Resolve an image reference to a data URL, if the transcript embedded the bytes. */
  imageUrl(attachment: ImageAttachmentRef): string | undefined
}

/** Server-sent live update for one open session. */
export type SessionLiveEvent =
  | { type: 'lines'; file: SessionFileRef; lines: readonly string[] }
  /** A file joined the session or its facts changed; `reset` means it was truncated and must be refolded. */
  | { type: 'file'; file: SessionFileRef; reset?: boolean }
  | { type: 'meta'; summary: SessionSummary; children: readonly SessionChildSummary[] }
  /** Existing content has been replayed; later events are live appends. */
  | { type: 'ready' }
