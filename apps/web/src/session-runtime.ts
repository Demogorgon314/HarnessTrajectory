/**
 * Per-session runtime: owns the harness parser AND the Context dashboard's
 * fold, feeds both from the live stream, and publishes throttled snapshots the
 * views subscribe to. One runtime serves both tabs, so switching tabs never
 * reopens the stream.
 */

import { ContextSession, type ContextSessionOptions } from '@harness-trajectory/context'
import {
  createSessionParser, EMPTY_TRAJECTORY_SNAPSHOT,
  type HarnessKind, type ImageAttachmentRef, type ParsedSessionMeta, type SessionChildSummary,
  type SessionFileRef, type SessionLiveEvent, type SessionParser, type SessionSummary, type SubagentRun,
  type TrajectorySnapshot,
} from '@harness-trajectory/core'
import { createSnapshotStore, type MessageImageLoader, type SnapshotStore } from '@harness-trajectory/ui'
import { getSession, HttpError, openSessionStream, type LiveStream } from './api.ts'

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
  /** Fold options every ContextSession (re)build keeps — the price-period resolver among them. */
  private readonly contextOptions: ContextSessionOptions
  /** Stream/refold generation: an existence probe applies only to its own. */
  private epoch = 0
  /** Epoch owning the in-flight probe — one probe per disconnect, never global. */
  private probingEpoch: number | null = null

  /**
   * @param fileId - a child transcript id to fold on its own (the subagent
   * view); omitted, the whole session folds with children nested.
   */
  constructor(
    readonly kind: HarnessKind,
    readonly id: string,
    readonly fileId: string | null = null,
    contextOptions?: ContextSessionOptions,
  ) {
    this.contextOptions = contextOptions ?? {}
    this.parser = createSessionParser(kind)
    this.context = new ContextSession(kind, undefined, this.contextOptions)
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
    this.epoch += 1
    this.stream?.close()
    this.stream = openSessionStream(this.kind, this.id, {
      onEvent: event => { this.handle(event) },
      // Any open — the first connect or a retry after a failed attempt —
      // proves the stream alive and voids existence probes started while it
      // was down (`onReconnect` alone misses the first-open case).
      onOpen: () => {
        this.epoch += 1
      },
      onReconnect: () => {
        if (!this.closed) this.rebuild()
      },
      onError: () => {
        this.patch({ connected: false })
        this.probeExistence()
      },
    }, { file: this.fileId ?? undefined })
    this.patch({ connected: true, error: null })
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

  /**
   * EventSource's onerror does not say why the stream failed — a dead child
   * link 404s exactly like a dropped connection. Ask the session detail
   * route: a session or child confirmed missing is a dead end (end loading,
   * close the retry loop, say so); an unreachable server or an answered
   * detail leaves the native reconnect retrying. A late answer drops when the
   * stream has already recovered (epoch moved) or the runtime closed. One
   * probe runs per epoch: an earlier outage's still-unanswered request must
   * not starve a NEW disconnect of its own verdict.
   */
  private probeExistence(): void {
    const epoch = this.epoch
    if (this.probingEpoch === epoch) return
    this.probingEpoch = epoch
    getSession(this.kind, this.id)
      .then(detail => {
        if (this.closed || epoch !== this.epoch) return
        // The session exists: for a child view, "missing" is only true once
        // the announced child list lacks this file; anything else is a
        // transient drop the stream is already retrying through.
        if (this.fileId === null) return
        if (detail.children.some(child => child.file.id === this.fileId)) return
        this.failFatally(`subagent transcript "${this.fileId}" was not found`)
      })
      .catch((error: unknown) => {
        if (this.closed || epoch !== this.epoch) return
        if (error instanceof HttpError && error.status === 404) {
          this.failFatally(`session "${this.id}" was not found`)
        }
        // Any other answer (network down, 5xx): the probe itself could not
        // confirm anything — keep retrying.
      })
      .finally(() => {
        // Only the probe still owning the slot frees it — a newer epoch's
        // probe has already replaced this token.
        if (this.probingEpoch === epoch) this.probingEpoch = null
      })
  }

  /** A confirmed-dead stream: stop the retry loop and surface the cause. */
  private failFatally(message: string): void {
    this.stream?.close()
    this.stream = null
    this.patch({ loading: false, connected: false, error: message })
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
          // One bad record must not drop the rest of the batch: the parser is
          // written not to throw, but a future record shape is contained here
          // the same way `ContextSession.push` already contains it.
          try {
            this.parser.push(line, event.file, event.startLine < 0 ? -1 : event.startLine + at)
          } catch {
            // Skip the line; folding continues with the next record.
          }
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
    this.epoch += 1
    this.parser = createSessionParser(this.kind)
    this.context = new ContextSession(this.kind, undefined, this.contextOptions)
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
