/** Session discovery and parsing contracts shared by the server and the web client. */

import type { ImageAttachmentRef, TrajectorySnapshot } from './contract.ts'

export type HarnessKind = 'claude' | 'codex'

export const HARNESS_KINDS: readonly HarnessKind[] = ['claude', 'codex']

/** One JSONL file that contributes to a session: the main transcript or a child (subagent) transcript. */
export interface SessionFileRef {
  /** Stable identity within the session (main transcript id, or the child's own id). */
  id: string
  role: 'main' | 'child'
  /** Absolute path on the scanned machine. */
  path: string
  /** For a child transcript, the parent transcript id when known. */
  parentId?: string
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
  images: ImageStore
  /** Resolve an image reference to a data URL, if the transcript embedded the bytes. */
  imageUrl(attachment: ImageAttachmentRef): string | undefined
}

/** Server-sent live update for one open session. */
export type SessionLiveEvent =
  | { type: 'lines'; file: SessionFileRef; lines: readonly string[] }
  | { type: 'file'; file: SessionFileRef }
  | { type: 'meta'; summary: SessionSummary }
  /** Existing content has been replayed; later events are live appends. */
  | { type: 'ready' }
