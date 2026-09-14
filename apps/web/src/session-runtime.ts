/**
 * Per-session runtime: owns the harness parser, feeds it lines from the live
 * stream, and publishes throttled snapshots the trajectory view subscribes to.
 */

import {
  createSessionParser, EMPTY_TRAJECTORY_SNAPSHOT,
  type HarnessKind, type ImageAttachmentRef, type SessionFileRef, type SessionLiveEvent,
  type SessionParser, type SessionSummary, type TrajectorySnapshot,
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
  error: string | null
  connected: boolean
}

const PUBLISH_INTERVAL_MS = 80

export class SessionRuntime {
  readonly store: SnapshotStore<SessionRuntimeState>
  readonly loadImage: MessageImageLoader
  private parser: SessionParser
  private stream: LiveStream | null = null
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private lineCount = 0
  private closed = false

  constructor(readonly kind: HarnessKind, readonly id: string) {
    this.parser = createSessionParser(kind)
    this.store = createSnapshotStore<SessionRuntimeState>({
      snapshot: EMPTY_TRAJECTORY_SNAPSHOT,
      loading: true,
      lines: 0,
      summary: null,
      error: null,
      connected: false,
    })
    const resolve = (attachment: ImageAttachmentRef): string | undefined => this.parser.imageUrl(attachment)
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
      onError: () => {
        this.patch({ connected: false })
      },
    })
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
        this.resetFileIfReplayed(event.file)
        break
      case 'lines':
        for (const line of event.lines) this.parser.push(line, event.file)
        this.lineCount += event.lines.length
        this.schedulePublish()
        break
      case 'meta':
        this.patch({ summary: event.summary })
        break
      case 'ready':
        this.publish()
        this.patch({ loading: false, connected: true })
        break
    }
  }

  private readonly seenFiles = new Set<string>()

  /** A repeated `file` event means the server reset that file (truncate/rewrite): rebuild from scratch. */
  private resetFileIfReplayed(file: SessionFileRef): void {
    const key = `${file.role}:${file.id}`
    if (!this.seenFiles.has(key)) {
      this.seenFiles.add(key)
      return
    }
    // Rebuilding requires a full replay; the simplest correct move is to reopen the stream.
    this.seenFiles.clear()
    this.parser = createSessionParser(this.kind)
    this.lineCount = 0
    this.stream?.close()
    this.patch({ snapshot: EMPTY_TRAJECTORY_SNAPSHOT, loading: true, lines: 0 })
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
    this.patch({ snapshot: this.parser.snapshot(), lines: this.lineCount })
  }

  private patch(partial: Partial<SessionRuntimeState>): void {
    this.store.update(current => ({ ...current, ...partial }))
  }
}
