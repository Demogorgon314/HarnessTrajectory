/**
 * Session source abstraction: the surface the HTTP layer (`app.ts`) and the
 * launcher (`main.ts`) consume, plus the bookkeeping every source shares.
 *
 * Two kinds of sources exist:
 *
 * - {@link SessionIndex} (`index.ts`) — the filesystem source: walks harness
 *   roots, watches `.jsonl` files and tails them by byte offset.
 * - {@link DevinSource} (`devin/source.ts`) — the SQLite source: Devin CLI
 *   keeps its transcript forest in `sessions.db`, so its "files" are virtual
 *   per-chain streams materialized from `message_nodes`.
 *
 * A source is a collection of line streams ("files", one main per session plus
 * child transcripts), session-list metadata, and a per-session pub/sub channel
 * for live appends. `CompositeSource` routes by `HarnessKind` so a process can
 * serve both at once.
 */

import { EventEmitter } from 'node:events'
import type {
  HarnessKind, SessionChildSummary, SessionDetail, SessionFileRef,
  SessionLiveEvent, SessionSummary,
} from '@harness-trajectory/core'
import type { MetaScanner } from './meta.ts'
import type { SearchIndexer } from './search/indexer.ts'
import type { SearchFileKey } from './search/store.ts'

/** A session counts as live when its transcript was written to this recently. */
export const LIVE_WINDOW_MS = 2 * 60_000

/** Chunk size of one `lines` live/replay event. */
export const CHUNK_LINES = 400

export type Subscriber = (event: SessionLiveEvent) => void

export function sessionKey(kind: HarnessKind, id: string): string {
  return `${kind} ${id}`
}

/**
 * What a session source is to the rest of the server. `SessionIndex`
 * implements it for filesystem transcripts; `DevinSource` for the Devin CLI
 * SQLite store; `CompositeSource` multiplexes several sources by kind.
 *
 * Events: sources are event emitters; `'change'` fires with `(kind, id)` when
 * a session's content or listing facts moved, `'error'` with the failure.
 */
export interface SessionSource extends EventEmitter {
  /** Initial discovery sweep; resolves when existing sessions are visible. */
  start(): Promise<void>
  stop(): void
  /** Sessions with a main transcript, newest activity first. */
  list(): SessionSummary[]
  get(kind: HarnessKind, id: string): SessionDetail | undefined
  /** Whether a session has a child transcript with this id. */
  hasChild(kind: HarnessKind, id: string, fileId: string): boolean
  /**
   * Replay the existing content of every file of a session as `file`/`lines`
   * events (main + children merged chronologically), then a `meta` event. With
   * `fileId`, only that child transcript is replayed, served as the main file
   * of its own view.
   */
  readAll(
    kind: HarnessKind,
    id: string,
    emit: (event: SessionLiveEvent) => void,
    fileId?: string,
  ): Promise<void>
  /** Receive live `file`/`lines`/`meta` events for one session. */
  subscribe(kind: HarnessKind, id: string, subscriber: Subscriber): () => void
  /** Listing facts for one session, for search result grouping. */
  facts(
    kind: HarnessKind,
    id: string,
  ): { title: string; cwd?: string; updatedAt?: number } | undefined
  /**
   * Absolute path of one offloaded attachment blob, when the harness has a
   * blob store (Kimi). Sources without one omit it.
   */
  blobPath?(kind: HarnessKind, id: string, fileId: string, hash: string): string | null
  /**
   * The paths this source feeds to the search index, read after `start()`
   * resolves. A {@link CompositeSource} aggregates them so one
   * `finishBackfill` sees every source's live set; a standalone source can
   * omit it (its own backfill already ran).
   */
  livePaths?(): Iterable<string>
}

/**
 * The entry shape {@link SessionBook} tracks: one line stream of a session.
 * Filesystem transcripts extend it with byte cursors; virtual (DB-backed)
 * streams carry their own watermarks.
 */
export interface SourceEntry {
  kind: HarnessKind
  /**
   * Stream identity. For filesystem sources the absolute transcript path; for
   * virtual streams a stable `kind:`-namespaced URI (`devin://<session>/…`).
   * Either way it keys the search index's `files` table, so it must be unique
   * and stable across restarts.
   */
  path: string
  ref: SessionFileRef
  /** Owning session id (`ref.id` for main files, the parent id for children). */
  sessionId: string
  /** Stream size in the source's own terms (bytes for files, emitted bytes for virtual streams). */
  size: number
  mtimeMs: number
  /** Records emitted so far — also the 0-based index the next one gets in the search index. */
  lines: number
  meta: MetaScanner | null
}

/** Per-session bookkeeping record: the main stream plus child streams by file id. */
export interface SourceSession<E extends SourceEntry> {
  kind: HarnessKind
  id: string
  main: E | null
  children: Map<string, E>
}

/**
 * The bookkeeping every source shares and nothing else: session and file
 * membership, subscribers, and the derived `SessionSummary`/`SessionDetail`
 * views. No I/O — sources feed it entries and pull events out of it.
 */
export class SessionBook<E extends SourceEntry> {
  readonly sessions = new Map<string, SourceSession<E>>()
  readonly files = new Map<string, E>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()

  constructor(private readonly now: () => number = Date.now) {}

  sessionFor(kind: HarnessKind, id: string): SourceSession<E> {
    const key = sessionKey(kind, id)
    let session = this.sessions.get(key)
    if (session === undefined) {
      session = { kind, id, main: null, children: new Map() }
      this.sessions.set(key, session)
    }
    return session
  }

  /** Sessions with a main transcript, newest activity first. */
  list(): SessionSummary[] {
    const summaries: SessionSummary[] = []
    for (const session of this.sessions.values()) {
      if (session.main === null) continue
      summaries.push(this.summarize(session))
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  get(kind: HarnessKind, id: string): SessionDetail | undefined {
    const session = this.sessions.get(sessionKey(kind, id))
    if (session === undefined || session.main === null) return undefined
    return {
      ...this.summarize(session),
      files: [session.main.ref, ...[...session.children.values()].map(entry => entry.ref)],
      children: this.childSummaries(session),
    }
  }

  hasChild(kind: HarnessKind, id: string, fileId: string): boolean {
    return this.sessions.get(sessionKey(kind, id))?.children.has(fileId) === true
  }

  facts(kind: HarnessKind, id: string): { title: string; cwd?: string; updatedAt?: number } | undefined {
    const session = this.sessions.get(sessionKey(kind, id))
    if (session === undefined || session.main === null) return undefined
    const summary = this.summarize(session)
    return {
      title: summary.title,
      ...(summary.cwd === null ? {} : { cwd: summary.cwd }),
      updatedAt: summary.updatedAt,
    }
  }

  subscribe(kind: HarnessKind, id: string, subscriber: Subscriber): () => void {
    const key = sessionKey(kind, id)
    let set = this.subscribers.get(key)
    if (set === undefined) {
      set = new Set()
      this.subscribers.set(key, set)
    }
    set.add(subscriber)
    return () => {
      set.delete(subscriber)
      // Only ever drop the set this key still holds: a stream that closes after
      // a later one opened would otherwise unregister the new viewer with it.
      if (set.size === 0 && this.subscribers.get(key) === set) this.subscribers.delete(key)
    }
  }

  /** Keys of the sessions anyone is subscribed to (for source-side polling). */
  subscribedKeys(): IterableIterator<string> {
    return this.subscribers.keys()
  }

  hasSubscribers(kind: HarnessKind, id: string): boolean {
    return this.subscribers.has(sessionKey(kind, id))
  }

  emitTo(session: SourceSession<E>, event: SessionLiveEvent): void {
    const set = this.subscribers.get(sessionKey(session.kind, session.id))
    if (set === undefined) return
    for (const subscriber of set) subscriber(event)
  }

  /**
   * Forget a session and all its files (a devin session turned `hidden`, or
   * was deleted from the store). Subscribers are not notified individually —
   * the next list()/`change` carries its absence.
   */
  dropSession(session: SourceSession<E>): string[] {
    for (const entry of [session.main, ...session.children.values()]) {
      if (entry !== null) this.files.delete(entry.path)
    }
    this.sessions.delete(sessionKey(session.kind, session.id))
    return [session.main, ...session.children.values()]
      .filter((entry): entry is E => entry !== null)
      .map(entry => entry.path)
  }

  childSummaries(session: SourceSession<E>): SessionChildSummary[] {
    return [...session.children.values()].map(entry => ({
      file: entry.ref,
      updatedAt: entry.mtimeMs,
      bytes: entry.size,
    }))
  }

  summarize(session: SourceSession<E>): SessionSummary {
    const main = session.main
    const meta = main?.meta?.state
    const entries = [main, ...session.children.values()]
      .filter((entry): entry is E => entry !== null)
    const latestWrite = Math.max(0, ...entries.map(entry => entry.mtimeMs))
    const updatedAt = Math.max(latestWrite, meta?.lastTime ?? 0)
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    return {
      id: session.id,
      kind: session.kind,
      title: meta?.aiTitle ?? meta?.title ?? session.id,
      cwd: meta?.cwd ?? null,
      model: meta?.model ?? null,
      startedAt: meta?.startedAt ?? null,
      updatedAt,
      bytes,
      live: this.now() - latestWrite < LIVE_WINDOW_MS,
      childCount: session.children.size,
      promptCount: meta?.promptCount ?? 0,
    }
  }
}

/**
 * Fan several sources into one {@link SessionSource}: `list` merges and
 * re-sorts, every per-session call routes by `kind`. Sources with no sessions
 * of a kind must answer `undefined`/`false` so routing stays total.
 */
export class CompositeSource extends EventEmitter implements SessionSource {
  private readonly byKind = new Map<HarnessKind, SessionSource>()

  constructor(
    private readonly sources: readonly SessionSource[],
    private readonly search?: SearchIndexer,
  ) {
    super()
    for (const source of sources) {
      source.on('change', (kind: HarnessKind, id: string) => { this.emit('change', kind, id) })
      source.on('error', (error: unknown) => { this.emit('error', error) })
    }
  }

  private sourceFor(kind: HarnessKind): SessionSource | undefined {
    let source = this.byKind.get(kind)
    if (source !== undefined) return source
    // Sources that can serve a kind are discovered lazily: the fs index knows
    // its kinds from its roots, a DB source from its own configuration.
    for (const candidate of this.sources) {
      if (candidate.list().some(session => session.kind === kind)) {
        source = candidate
        this.byKind.set(kind, source)
        return source
      }
    }
    // Before the first sweep no source lists anything; fall back to the kinds
    // each source claims statically.
    return undefined
  }

  /** Bind kinds explicitly when a source knows what it serves before listing. */
  claim(kind: HarnessKind, source: SessionSource): void {
    this.byKind.set(kind, source)
  }

  /**
   * Start every source, then close the search backfill once with the UNION of
   * live paths — each member's own sweep is assumed `deferBackfill`-deferred,
   * so a DB source's virtual paths are never dropped by the fs index's prune.
   */
  async start(): Promise<void> {
    for (const source of this.sources) await source.start()
    this.search?.finishBackfill(this.livePaths())
  }

  livePaths(): string[] {
    return this.sources.flatMap(source => [...(source.livePaths?.() ?? [])])
  }

  stop(): void {
    for (const source of this.sources) source.stop()
  }

  list(): SessionSummary[] {
    return this.sources.flatMap(source => source.list())
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  get(kind: HarnessKind, id: string): SessionDetail | undefined {
    return this.sourceFor(kind)?.get(kind, id)
  }

  hasChild(kind: HarnessKind, id: string, fileId: string): boolean {
    return this.sourceFor(kind)?.hasChild(kind, id, fileId) === true
  }

  async readAll(
    kind: HarnessKind,
    id: string,
    emit: (event: SessionLiveEvent) => void,
    fileId?: string,
  ): Promise<void> {
    await this.sourceFor(kind)?.readAll(kind, id, emit, fileId)
  }

  subscribe(kind: HarnessKind, id: string, subscriber: Subscriber): () => void {
    return this.sourceFor(kind)?.subscribe(kind, id, subscriber) ?? (() => {})
  }

  facts(kind: HarnessKind, id: string): { title: string; cwd?: string; updatedAt?: number } | undefined {
    return this.sourceFor(kind)?.facts(kind, id)
  }

  blobPath(kind: HarnessKind, id: string, fileId: string, hash: string): string | null {
    return this.sourceFor(kind)?.blobPath?.(kind, id, fileId, hash) ?? null
  }
}

/**
 * How the search index addresses one transcript: the session a hit opens and
 * the `?file=` id that selects this file inside it. For a main file both are the
 * session id; for a child, `fileId` is the child's own ref id.
 */
export function searchKeyOf(entry: SourceEntry): SearchFileKey {
  return { path: entry.path, kind: entry.kind, sessionId: entry.sessionId, fileId: entry.ref.id }
}

/** The ref a child transcript is served with when it is viewed as a session of its own. */
export function standaloneRef(ref: SessionFileRef): SessionFileRef {
  const { parentId: _parentId, ...rest } = ref
  return { ...rest, role: 'main' }
}

/**
 * Narrow a session's live event to one child transcript's own view: events
 * about other files are dropped and the child's ref is served as `main`.
 */
export function scopeToFile(event: SessionLiveEvent, fileId: string): SessionLiveEvent | null {
  switch (event.type) {
    case 'lines':
      return event.file.id === fileId ? { ...event, file: standaloneRef(event.file) } : null
    case 'file':
      return event.file.id === fileId ? { ...event, file: standaloneRef(event.file) } : null
    default:
      return event
  }
}

const TIMESTAMP_PATTERN = /"timestamp"\s*:\s*(?:"([^"]+)"|(\d+(?:\.\d+)?))/
/** Kimi records carry `"time":<epoch ms>` and no `timestamp`; devin lines use the same field. */
const TIME_PATTERN = /"time"\s*:\s*(\d+(?:\.\d+)?)/

/** Epoch milliseconds from a numeric timestamp; values below 1e12 are seconds. */
function epochMs(raw: string | undefined): number | null {
  const numeric = Number(raw)
  if (raw === undefined || !Number.isFinite(numeric)) return null
  return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric)
}

/**
 * Epoch milliseconds of a raw JSONL line's `timestamp` (or Kimi's `time`), or
 * `null`. Grok needs no branch of its own: its envelope's `"timestamp"` is
 * numeric epoch **seconds** and is the first key on the line, while the
 * millisecond stamp is spelled `agentTimestampMs` and never matches either
 * pattern (GROK-FORMAT §C.1). Devin's synthesized lines carry `time` in
 * milliseconds, the same reading Kimi's gets.
 */
export function lineTime(line: string): number | null {
  const match = TIMESTAMP_PATTERN.exec(line)
  if (match === null) return epochMs(TIME_PATTERN.exec(line)?.[1])
  if (match[1] !== undefined) {
    const parsed = Date.parse(match[1])
    return Number.isNaN(parsed) ? null : parsed
  }
  return epochMs(match[2])
}

/**
 * Per-line sort keys: records without a timestamp (housekeeping rows) inherit
 * the previous timestamped line's time so they keep their file position.
 */
export function lineTimes(lines: readonly string[]): number[] {
  const times = new Array<number>(lines.length)
  let last: number | null = null
  for (const [index, line] of lines.entries()) {
    const time = lineTime(line)
    if (time !== null) last = time
    times[index] = last ?? Number.NEGATIVE_INFINITY
  }
  // Leading lines before the first timestamp take that first timestamp.
  const first = times.find(time => time !== Number.NEGATIVE_INFINITY)
  if (first !== undefined) {
    for (let index = 0; index < times.length && times[index] === Number.NEGATIVE_INFINITY; index += 1) {
      times[index] = first
    }
  }
  return times
}

export interface LineSource {
  ref: SessionFileRef
  lines: readonly string[]
  times: readonly number[]
  /**
   * Leading entries of `lines` the server synthesized rather than read (grok's
   * sidecar, devin's session facts). They are in no file, so they take no line
   * index and the entry after them is line 0.
   */
  synthetic?: number
}

/** One replayed run of lines, addressed the way live appends are. */
export interface LineChunk {
  ref: SessionFileRef
  lines: string[]
  /** 0-based index of `lines[0]` among the file's non-blank lines; negative when synthetic. */
  startLine: number
}

/**
 * Stable k-way merge of per-file line sequences by time; earlier sources win
 * ties, so the main transcript precedes children at equal timestamps. Emits
 * runs of consecutive lines from one file, capped at `CHUNK_LINES`; synthetic
 * lines never share a chunk with real ones, so one `startLine` addresses the
 * whole run.
 */
export function* mergeChronologically(sources: readonly LineSource[]): Generator<LineChunk> {
  const cursors = sources.map(() => 0)
  let current: (LineChunk & { source: number; synthetic: boolean }) | null = null
  for (;;) {
    let best = -1
    let bestTime = Number.POSITIVE_INFINITY
    for (const [index, source] of sources.entries()) {
      const cursor = cursors[index] ?? 0
      if (cursor >= source.lines.length) continue
      const time = source.times[cursor] ?? Number.NEGATIVE_INFINITY
      if (best === -1 || time < bestTime) {
        best = index
        bestTime = time
      }
    }
    if (best === -1) break
    const source = sources[best]
    const cursor = cursors[best] ?? 0
    if (source === undefined) break
    const line = source.lines[cursor]
    cursors[best] = cursor + 1
    if (line === undefined) continue
    const skipped = source.synthetic ?? 0
    const synthetic = cursor < skipped
    if (
      current === null || current.source !== best
      || current.synthetic !== synthetic || current.lines.length >= CHUNK_LINES
    ) {
      if (current !== null) yield { ref: current.ref, lines: current.lines, startLine: current.startLine }
      current = {
        ref: source.ref,
        lines: [],
        startLine: synthetic ? -1 : cursor - skipped,
        source: best,
        synthetic,
      }
    }
    current.lines.push(line)
  }
  if (current !== null && current.lines.length > 0) {
    yield { ref: current.ref, lines: current.lines, startLine: current.startLine }
  }
}
