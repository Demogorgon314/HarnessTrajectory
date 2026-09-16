/**
 * Per-session runtime: owns the harness parser AND the Context dashboard's
 * fold, feeds both from the live stream, and publishes throttled snapshots the
 * views subscribe to. One runtime serves both tabs, so switching tabs never
 * reopens the stream.
 */

import { ContextSession } from '@harness-trajectory/context'
import {
  createSessionParser, EMPTY_TRAJECTORY_SNAPSHOT,
  type HarnessKind, type ImageAttachmentRef, type ParsedSessionMeta, type SessionChildSummary,
  type SessionFileRef, type SessionLiveEvent, type SessionParser, type SessionSummary, type SubagentRun,
  type TrajectorySnapshot,
} from '@harness-trajectory/core'
import { createSnapshotStore, type MessageImageLoader, type SnapshotStore } from '@harness-trajectory/ui'
import { openSessionStream, type LiveStream } from './api.ts'

export interface SessionRuntimeState {
  snapshot: TrajectorySnapshot
  /** Existing content is still being replayed from the server. */
  loading: boolean
  /** Lines consumed so far (all files). */
  lines: number
  summary: SessionSummary | null
  /** Session facts the folded transcript itself reports (a subagent view's title lives here). */
  meta: ParsedSessionMeta
  /** Files feeding this view, as announced by the server. */
  files: readonly SessionFileRef[]
  /** Child (subagent) transcripts of the session, whichever file this view folds. */
  children: readonly SessionChildSummary[]
  /** Subagent runs the folded transcript spawned. */
  subagents: readonly SubagentRun[]
  /**
   * Revision of the Context fold (`runtime.context`). The fold is mutable and
   * memoizes its views, so the store carries only its revision: a bump is the
   * signal to re-read `timelineOf`/`headersOf`/`metaOf`.
   */
  contextRevision: number
  error: string | null
  connected: boolean
}

const PUBLISH_INTERVAL_MS = 80

/** Kimi offloads large media into a per-agent blob store; the server serves it by content hash. */
const BLOBREF_PREFIX = 'blobref:'

export class SessionRuntime {
  readonly store: SnapshotStore<SessionRuntimeState>
  readonly loadImage: MessageImageLoader
  /** The Context dashboard's per-file fold, fed the same lines as the parser. */
  context: ContextSession
  private parser: SessionParser
  private stream: LiveStream | null = null
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private lineCount = 0
  private closed = false

  /**
   * @param fileId - a child transcript id to fold on its own (the subagent
   * view); omitted, the whole session folds with children nested.
   */
  constructor(readonly kind: HarnessKind, readonly id: string, readonly fileId: string | null = null) {
    this.parser = createSessionParser(kind)
    this.context = new ContextSession(kind)
    this.store = createSnapshotStore<SessionRuntimeState>({
      snapshot: EMPTY_TRAJECTORY_SNAPSHOT,
      loading: true,
      lines: 0,
      summary: null,
      meta: this.parser.meta(),
      files: [],
      children: [],
      subagents: [],
      contextRevision: 0,
      error: null,
      connected: false,
    })
    const resolve = (attachment: ImageAttachmentRef): string | undefined => {
      const url = this.parser.imageUrl(attachment)
      if (url === undefined || !url.startsWith(BLOBREF_PREFIX)) return url
      // A blobref's bytes sit in the blob store of the transcript that produced
      // the image; the server serves them by content hash.
      const file = attachment.fileId ?? this.fileId ?? this.id
      return `/api/sessions/${encodeURIComponent(this.kind)}/${encodeURIComponent(this.id)}/blob`
        + `?file=${encodeURIComponent(file)}&ref=${encodeURIComponent(url)}`
    }
    this.loadImage = Object.assign(
      async (attachment: ImageAttachmentRef): Promise<string> => {
        const url = resolve(attachment)
        if (url === undefined) throw new Error(`image ${attachment.attachmentId} is not available`)
        return url
      },
      { peek: resolve },
    )
  }

  start(): void {
    // React StrictMode mounts, unmounts, and remounts: a closed runtime must be restartable.
    this.closed = false
    this.stream?.close()
    this.stream = openSessionStream(this.kind, this.id, {
      onEvent: event => { this.handle(event) },
      onReconnect: () => {
        if (!this.closed) this.rebuild()
      },
      onError: () => {
        this.patch({ connected: false })
      },
    }, { file: this.fileId ?? undefined })
    this.patch({ connected: true })
  }

  close(): void {
    this.closed = true
    this.stream?.close()
    this.stream = null
    if (this.publishTimer !== null) {
      clearTimeout(this.publishTimer)
      this.publishTimer = null
    }
  }

  private handle(event: SessionLiveEvent): void {
    if (this.closed) return
    switch (event.type) {
      case 'file':
        if (event.reset === true) this.reset()
        else this.noteFile(event.file)
        break
      case 'lines':
        // The trajectory parser is told where each line sits in its file, so a
        // content-search hit can be resolved back to the record it folded into.
        // A negative `startLine` marks synthetic lines (grok's sidecar) that
        // belong to no line of the file; they stay negative and bind nothing.
        for (const [at, line] of event.lines.entries()) {
          this.parser.push(line, event.file, event.startLine < 0 ? -1 : event.startLine + at)
          this.context.push(line, event.file)
        }
        this.lineCount += event.lines.length
        this.schedulePublish()
        break
      case 'meta':
        this.patch({ summary: event.summary, children: event.children })
        break
      case 'ready':
        this.publish()
        this.patch({ loading: false, connected: true })
        break
    }
  }

  /** A file joined the view or its facts changed (a subagent's sidecar meta arrived late). */
  private noteFile(file: SessionFileRef): void {
    const files = this.store.getSnapshot().files
    const index = files.findIndex(known => known.role === file.role && known.id === file.id)
    const next = index < 0 ? [...files, file] : files.map((known, at) => (at === index ? file : known))
    this.patch({ files: next })
  }

  /**
   * Drop folded state without touching the stream — the server replays the
   * session from the top on a reconnected socket, so the parsers must refold
   * from empty before those events land or every record folds twice.
   */
  private rebuild(): void {
    this.parser = createSessionParser(this.kind)
    this.context = new ContextSession(this.kind)
    this.lineCount = 0
    this.patch({
      snapshot: EMPTY_TRAJECTORY_SNAPSHOT, loading: true, lines: 0, files: [], subagents: [],
      meta: this.parser.meta(),
      contextRevision: this.context.revision,
    })
  }

  /** The server truncated or rewrote a file: rebuild from scratch by reopening the stream. */
  private reset(): void {
    this.rebuild()
    this.stream?.close()
    this.start()
  }

  private schedulePublish(): void {
    if (this.publishTimer !== null) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      this.publish()
    }, PUBLISH_INTERVAL_MS)
  }

  private publish(): void {
    if (this.closed) return
    this.patch({
      snapshot: this.parser.snapshot(),
      lines: this.lineCount,
      meta: this.parser.meta(),
      subagents: this.parser.subagents(),
      contextRevision: this.context.revision,
    })
  }

  private patch(partial: Partial<SessionRuntimeState>): void {
    this.store.update(current => ({ ...current, ...partial }))
  }
}
