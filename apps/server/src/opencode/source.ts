/**
 * OpenCode session source: reads `opencode.db` (SQLite, WAL, written live)
 * and serves each session's transcript as virtual line streams — no
 * materialized JSONL anywhere. Two tiers keep startup off the 340 MB of
 * message/part bodies:
 *
 * - **Catalog tier** (always, at `start()` and on ticks): `session` rows →
 *   `SessionBook` entries plus grouped `COUNT(*)`/`MAX(time_updated)`
 *   touches and a one-time grouped `SUM(length(data))` per session. Listing
 *   facts come from a meta scanner fed ONLY the user header lines
 *   (`json_extract(data,'$.role')='user'` — the one SQL-side filter), so
 *   `promptCount`/title share the core classifier without reading
 *   assistant/tool bodies.
 * - **Transcript tier** (lazy): first `subscribe`/`readAll`/search
 *   registration for a session materializes its stream — the pure emission
 *   plan of `transcript.ts` walks the rows and emits
 *   `opencode.message`/`opencode.part`/`opencode.finish` stream lines plus
 *   `opencode.session`/`opencode.prune` sidecars. The scanner is REBUILT at
 *   this point (never let the catalog-fed one double count).
 *
 * Record vocabulary (docs/harness-formats.md → OpenCode → Wire vocabulary —
 * the ONLY thing parsers see): stream lines
 * are indexed 0-based per stream; `opencode.session` (session facts +
 * flattened `children`) and `opencode.prune` (a tool part's
 * `state.time.compacted` prune marker) ride `startLine: -1` and are
 * re-merged by time on replay.
 *
 * Change probe per tick: `PRAGMA data_version` first — unchanged means skip
 * every query (pending plan passes still run: the trailing-user patience
 * gate needs a tick, not a write). Then the two grouped touches + the
 * `session` rows: count regression → full rebuild (`file reset` +
 * `search.reset`), max advanced → `time_updated > last` rows into the plan.
 * Revert deletes rows, so a regression is the rebuild signal.
 *
 * Children: a `session` row with `parent_id` is a child stream of its ROOT
 * session at `opencode://sessions/<root>/<childId>` (orphan parents → the
 * row is its own root). `ref.agent` carries the row-derived facts; when the
 * parent's stream materializes, a `tool` part whose
 * `state.metadata.sessionId` names the child enriches the ref with
 * `toolUseId`/model/description via a `file` event.
 */

import { EventEmitter } from 'node:events'
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import {
  asString, isRecord, opencodeChildTitle,
  type AgentFileMeta, type HarnessKind, type SessionFileRef, type SessionLiveEvent,
} from '@harness-trajectory/core'
import { createMetaScanner } from '../meta.ts'
import type { SearchIndexer } from '../search/indexer.ts'
import {
  CHUNK_LINES, emitReplay, lineTimes, SessionBook, searchKeyOf, standaloneRef,
  type LineSource, type SessionSource, type ReplaySink, type SourceEntry, type SourceSession, type Subscriber,
} from '../source.ts'
import { OpencodeDb, type OpencodeSessionRow } from './db.ts'
import {
  emptyCursor, headerLine, openRowCount, parseMessageRow, parsePartRow, planLines, sessionLine,
  type ParsedMessage, type ParsedPart, type TranscriptCursor, type WireLine,
} from './transcript.ts'

const KIND: HarnessKind = 'opencode'
const POLL_INTERVAL_MS = 1_500

export interface OpencodeSourceOptions {
  /** Absolute path of `opencode.db`. */
  dbPath: string
  search?: SearchIndexer | undefined
  /** Disable polling and file watching (tests). */
  watch?: boolean | undefined
  now?: (() => number) | undefined
}

interface OpencodeEntry extends SourceEntry {
  /** First line index that still needs search indexing (`beginFile`'s answer). */
  searchFrom: number
  /** Session aged past the retention window: browsable, but never queued. */
  searchSkipped: boolean
}

/**
 * One session row's stream: the catalog facts every row gets, plus the
 * transcript-tier cursor/scanner once materialized. A descendant row's
 * entry lives under its root's `SourceSession.children`.
 */
interface StreamState {
  row: OpencodeSessionRow
  /** Root session id (topmost `parent_id` ancestor, or itself). */
  rootId: string
  entry: OpencodeEntry
  cursor: TranscriptCursor
  materialized: boolean
  needsRebuild: boolean
  /** `COUNT(*)`/`MAX(time_updated)` per table at the last consume. */
  messageCount: number
  partCount: number
  messageMax: number
  partMax: number
  /** Dedup key of the last emitted sidecar (root streams only). */
  sidecarKey: string | null
}

export class OpencodeSource extends EventEmitter implements SessionSource {
  private readonly dbPath: string
  /** Mutable: the Content search toggle attaches and detaches this at runtime. */
  private search: SearchIndexer | undefined
  private readonly watchEnabled: boolean
  private readonly now: () => number
  private readonly book = new SessionBook<OpencodeEntry>(() => this.now())
  /** session id → its stream; every row gets one (roots and descendants alike). */
  private readonly streams = new Map<string, StreamState>()
  private db: OpencodeDb | null = null
  /** `dev:ino` of the file the open handle was built from; kept across `stop()`. */
  private dbSig: string | null = null
  /** Last seen `PRAGMA data_version`; unchanged skips the tick's queries. */
  private dataVersion: number | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private readonly watchers: FSWatcher[] = []
  private readonly watchedPaths = new Set<string>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private openFailed = false
  private queryFailed = false
  /**
   * The open file is a replacement whose resync could not finish; states
   * still describe the OLD store — ticks retry before serving them.
   */
  private resyncPending = false

  constructor(options: OpencodeSourceOptions) {
    super()
    this.dbPath = options.dbPath
    this.search = options.search
    this.watchEnabled = options.watch !== false
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    this.stopped = false
    this.openFailed = false
    this.queryFailed = false
    if (this.db === null) this.openDb()
    await this.sweep()
    // Search injected at construction: backfill before start resolves —
    // SearchLifecycle's finishBackfill lands after every source's start.
    if (this.search !== undefined) await this.backfillSearch(this.streams.values())
    if (!this.watchEnabled) return
    if (this.poll === null) {
      this.poll = setInterval(() => {
        this.tick().catch((error: unknown) => { this.emit('error', error) })
      }, POLL_INTERVAL_MS)
      this.poll.unref()
    }
    this.attachWatcher()
  }

  // -- lifecycle (Devin's shape) ---------------------------------------------

  private fileSig(): string | null {
    try {
      const st = statSync(this.dbPath)
      return `${st.dev}:${st.ino}`
    } catch {
      return null
    }
  }

  /**
   * (Re)open the store read-only. A missing file degrades silently (the
   * poll retries); a file that exists but will not open reports once per
   * streak. A replacement is caught by `dbSig` and resyncs every state.
   */
  private openDb(): boolean {
    const sig = this.fileSig()
    if (sig === null) return false
    try {
      this.db = new OpencodeDb(this.dbPath)
      if (!this.db.hasSchema()) throw new Error('missing OpenCode tables')
    } catch (error) {
      this.db?.close()
      this.db = null
      if (!this.openFailed) {
        this.openFailed = true
        this.emit('error', new Error(`${this.dbPath}: not an OpenCode session store`, { cause: error }))
      }
      return false
    }
    this.openFailed = false
    const replaced = this.dbSig !== null && this.dbSig !== sig && this.streams.size > 0
    this.dbSig = sig
    this.dataVersion = null
    if (replaced) this.resyncPending = !this.resyncAll()
    return true
  }

  private attachWatcher(): void {
    for (const path of [this.dbPath, `${this.dbPath}-wal`]) {
      if (this.watchedPaths.has(path) || !existsSync(path)) continue
      try {
        this.watchers.push(watch(path, () => this.scheduleTick()))
        this.watchedPaths.add(path)
      } catch {
        // An unwatchable path only costs promptness — the interval still polls.
      }
    }
  }

  private clearWatchers(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers.length = 0
    this.watchedPaths.clear()
  }

  stop(): void {
    this.stopped = true
    if (this.poll !== null) {
      clearInterval(this.poll)
      this.poll = null
    }
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.clearWatchers()
    if (this.db !== null) {
      this.db.close()
      this.db = null
    }
  }

  // -- SessionSource surface ---------------------------------------------------

  livePaths(): string[] {
    return [...this.book.files.values()].flatMap(entry => (entry.searchSkipped ? [] : [entry.path]))
  }

  /**
   * Attach a search indexer mid-run, then backfill: streams the index does
   * not already cover materialize and queue as they emit (the lazy tier is
   * what keeps a re-attach off the hundreds of MB of bodies).
   */
  async enableSearch(search: SearchIndexer): Promise<void> {
    if (this.search !== undefined) return
    this.search = search
    await this.backfillSearch(this.streams.values())
  }

  /**
   * Index every indexable stream. An unmaterialized stream materializes
   * unless the index already covers it exactly (`coverage` — same row
   * count AND an mtime at least as new, so a second boot does not re-read
   * the store but a reverted or rewritten session is not mistaken for
   * covered); a materialized one queues its emitted backlog from
   * `searchFrom`. Yields between streams so a first-time backfill does
   * not freeze the server.
   */
  private async backfillSearch(streams: Iterable<StreamState>): Promise<void> {
    const search = this.search
    if (search === undefined) return
    for (const stream of streams) {
      // The toggle detached mid-pass (or a newer indexer replaced it):
      // queuing into the closed store would throw on every remaining stream.
      if (this.search !== search) return
      const entry = stream.entry
      entry.searchSkipped = !search.shouldIndex({ mtimeMs: entry.mtimeMs })
      if (entry.searchSkipped) continue
      try {
        if (stream.materialized) {
          this.indexBacklog(search, stream)
        } else {
          // Covered means exactly: same row count, an mtime at least as
          // new, AND a fully consumed stream (`indexedBytes` = rows the
          // emitted lines account for; an open tail at shutdown reads as
          // incomplete — materialize so its held rows can index). Anything
          // else materializes — a larger or older prior makes `beginFile`
          // reset and re-index from line 0 (the same append-shaped-rewrite
          // blind spot JSONL accepts).
          const prior = search.coverage(entry.path)
          const covered = prior !== undefined
            && prior.size === this.countOf(stream)
            && prior.mtimeMs >= entry.mtimeMs
            && prior.indexedBytes >= prior.size
          if (!covered) {
            this.materialize(stream)
            this.syncSidecar(this.streams.get(stream.rootId))
          }
        }
      } catch (error) {
        stream.needsRebuild = true
        this.emit('error', new Error(`opencode session ${stream.row.id} materialization failed`, { cause: error }))
      }
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
  }

  /**
   * Queue a materialized stream's emitted backlog under its pinned line
   * numbering — lines shipped before the indexer attached were never
   * queued, so the replay re-feeds them from `searchFrom`.
   */
  private indexBacklog(search: SearchIndexer, stream: StreamState): void {
    const entry = stream.entry
    entry.searchFrom = search.beginFile(
      searchKeyOf(entry), { size: this.countOf(stream), mtimeMs: entry.mtimeMs },
    )
    const replay = this.replayStream(stream)
    // The replay must re-derive the emitted stream exactly; a mismatch
    // leaves this stream to the next registration rather than indexing
    // lines under shifted numbers.
    if (replay.stream.length !== entry.lines) return
    for (let index = entry.searchFrom; index < replay.stream.length; index += 1) {
      const line = replay.stream[index]
      if (line !== undefined) search.queue(searchKeyOf(entry), index, line)
    }
    search.noteProgress(searchKeyOf(entry), {
      size: this.countOf(stream),
      mtimeMs: entry.mtimeMs,
      indexedBytes: this.countOf(stream) - openRowCount(stream.cursor),
      indexedLines: entry.lines,
    })
  }

  /** Detach the indexer (Content search toggled off). */
  disableSearch(): void {
    this.search = undefined
  }

  kinds(): readonly HarnessKind[] {
    return [KIND]
  }

  list() { return this.book.list() }
  get(kind: HarnessKind, id: string) { return kind === KIND ? this.book.get(kind, id) : undefined }
  hasChild(kind: HarnessKind, id: string, fileId: string) {
    return kind === KIND && this.book.hasChild(kind, id, fileId)
  }
  facts(kind: HarnessKind, id: string) {
    return kind === KIND ? this.book.facts(kind, id) : undefined
  }

  subscribe(kind: HarnessKind, id: string, subscriber: Subscriber) {
    // Materialize BEFORE registering: the SSE contract pairs subscribe with
    // a readAll replay, so the initial batch must NOT reach this subscriber
    // as live lines — it would ship the whole stream a second time after
    // the replay. Lines landed after registration flow normally.
    if (kind === KIND) this.materializeRoot(id)
    return this.book.subscribe(kind, id, subscriber)
  }

  /**
   * Replay one session: `file` events, then synthetic sources (the session
   * sidecar plus each stream's pinned prune sidecars), then the per-stream
   * lines merged by time. With `fileId` only that child stream replays,
   * served as `main`.
   */
  async readAll(
    kind: HarnessKind,
    id: string,
    emit: ReplaySink,
    fileId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return
    if (kind !== KIND) return
    this.materializeRoot(id)
    const session = this.book.sessions.get(`${KIND} ${id}`)
    const main = session?.main
    if (session === undefined || main === null || main === undefined) return
    let entries: OpencodeEntry[]
    let refOf: (entry: OpencodeEntry) => SessionFileRef = entry => entry.ref
    if (fileId === undefined) {
      entries = [main, ...session.children.values()]
    } else {
      const child = session.children.get(fileId)
      if (child === undefined) return
      entries = [child]
      refOf = entry => standaloneRef(entry.ref)
    }
    const sources: LineSource[] = []
    if (fileId === undefined) {
      const root = this.streams.get(id)
      const sidecar = root === undefined ? null : this.sidecarLine(root)
      if (sidecar !== null) {
        sources.push({ ref: main.ref, lines: [sidecar.line.line], times: [sidecar.line.time], synthetic: 1 })
      }
    }
    for (const entry of entries) {
      const stream = this.streamOfEntry(entry)
      if (stream === undefined) continue
      const replay = this.replayStream(stream)
      // Pinned prune sidecars ride their own stream's ref (a child's prunes
      // ship under the child, including standalone `?file=` replays).
      if (replay.sidecar.length > 0) {
        sources.push({
          ref: refOf(entry),
          lines: replay.sidecar.map(line => line.line),
          times: replay.sidecar.map(line => line.time),
          synthetic: replay.sidecar.length,
        })
      }
      sources.push({ ref: refOf(entry), lines: replay.stream, times: lineTimes(replay.stream) })
    }
    await emitReplay(
      entries.map(refOf), sources,
      { type: 'meta', summary: this.book.summarize(session), children: this.book.childSummaries(session) },
      emit, signal,
    )
  }

  /** One store poll (tests and manual refresh; the interval calls it too). */
  async refresh(): Promise<void> {
    await this.tick()
  }

  // -- catalog tier ------------------------------------------------------------

  private static sessionPath(id: string): string {
    return `opencode://sessions/${id}`
  }

  /**
   * Every descendant stream attaches to its ROOT session: the child entry's
   * path is `opencode://sessions/<root>/<childId>` and its ref carries the
   * row-derived agent facts (the spawn binding enriches them later).
   */
  private registerStream(
    row: OpencodeSessionRow,
    rootId: string,
    size?: number,
    counts?: { messages: number; parts: number; messageMax: number; partMax: number },
  ): StreamState {
    const existing = this.streams.get(row.id)
    if (existing !== undefined) return existing
    const session = this.book.sessionFor(KIND, rootId)
    const isMain = row.id === rootId
    const path = isMain ? OpencodeSource.sessionPath(row.id) : `${OpencodeSource.sessionPath(rootId)}/${row.id}`
    const ref: SessionFileRef = isMain
      ? { id: row.id, role: 'main', path }
      : {
        id: row.id, role: 'child', path, parentId: row.parent_id ?? rootId,
        agent: this.agentFacts(row),
      }
    const entry: OpencodeEntry = {
      kind: KIND,
      path,
      ref,
      sessionId: rootId,
      size: size ?? this.sizeOf(row.id),
      mtimeMs: row.time_updated,
      lines: 0,
      meta: null,
      searchFrom: 0,
      searchSkipped: this.search !== undefined && !this.search.shouldIndex({ mtimeMs: row.time_updated }),
    }
    if (isMain) session.main = entry
    else session.children.set(row.id, entry)
    this.book.files.set(path, entry)
    const stream: StreamState = {
      row,
      rootId,
      entry,
      cursor: emptyCursor(),
      materialized: false,
      needsRebuild: false,
      messageCount: counts?.messages ?? 0,
      partCount: counts?.parts ?? 0,
      messageMax: counts?.messageMax ?? 0,
      partMax: counts?.partMax ?? 0,
      sidecarKey: null,
    }
    this.streams.set(row.id, stream)
    this.rebuildCatalogScanner(stream)
    return stream
  }

  /** Row-derived agent facts for a child entry; spawn metadata enriches them later. */
  private agentFacts(row: OpencodeSessionRow): AgentFileMeta {
    const model = jsonRecord(row.model)
    const modelId = asString(model?.['id'])
    const description = opencodeChildTitle(row.title)
    return {
      agentId: row.id,
      ...(description === '' ? {} : { description }),
      ...(row.agent === null ? {} : { agentType: row.agent }),
      ...(modelId === undefined ? {} : { model: modelId }),
    }
  }

  /** The session row as a meta-scanner seed (model falls back to the first assistant's). */
  private seedOf(stream: StreamState): Record<string, unknown> {
    const row = stream.row
    const model = jsonRecord(row.model)
    return {
      title: row.title,
      cwd: row.directory,
      model: asString(model?.['id']) ?? this.db?.firstAssistantModel(row.id)?.modelID ?? null,
      createdAt: row.time_created,
      updatedAt: row.time_updated,
    }
  }

  private sizeOf(sessionId: string): number {
    if (this.db === null) return 0
    try {
      return this.db.sizeOf('message', sessionId) + this.db.sizeOf('part', sessionId)
    } catch {
      return 0
    }
  }

  /** `COUNT(message) + COUNT(part)` — the watermark `beginFile` compares against. */
  private countOf(stream: StreamState): number {
    return stream.messageCount + stream.partCount
  }

  /**
   * The catalog-tier scanner: a FRESH scanner seeded from the row and fed
   * only the session's user header lines (small — assistant/tool bodies
   * stay unread). Rebuilt on every catalog change so promptCount never
   * double counts.
   */
  private rebuildCatalogScanner(stream: StreamState): void {
    const db = this.db
    stream.entry.meta = createMetaScanner(KIND, this.seedOf(stream))
    if (db === null) return
    try {
      const parts = new Map<string, ParsedPart[]>()
      for (const row of db.userParts(stream.row.id)) {
        const part = parsePartRow(row)
        const list = parts.get(row.message_id)
        if (list === undefined) parts.set(row.message_id, [part])
        else list.push(part)
      }
      for (const row of db.userMessages(stream.row.id)) {
        stream.entry.meta?.push(
          headerLine(parseMessageRow(row), parts.get(row.id) ?? []).line,
        )
      }
    } catch {
      // A catalog-scanner failure degrades listing facts only; the tick retries.
    }
  }

  // -- transcript tier -----------------------------------------------------------

  /**
   * Materialize a stream's emitted prefix: run the live plan over all rows,
   * rebuild the scanner fresh (the catalog-fed one would double count), and
   * ship the batch. Rebuild on `full` (revert/replacement) also ships
   * `file reset` so subscribers refold.
   */
  private materialize(stream: StreamState, full = false): void {
    const db = this.db
    if (db === null) return
    if (stream.needsRebuild) full = true
    try {
      if (full) {
        stream.cursor = emptyCursor()
        stream.entry.lines = 0
        stream.entry.size = this.sizeOf(stream.row.id)
        stream.entry.searchFrom = 0
        if (stream.materialized) {
          this.search?.reset(stream.entry.path)
          this.book.emitTo(this.sessionOf(stream), { type: 'file', file: stream.entry.ref, reset: true })
        }
        stream.messageCount = 0
        stream.partCount = 0
        stream.messageMax = 0
        stream.partMax = 0
        stream.sidecarKey = null
      }
      // The scanner is rebuilt when the input tier changes (catalog → full
      // stream) and on a full rebuild — an incremental re-materialize must
      // keep the scanner that already counted the emitted prefix.
      if (full || !stream.materialized) {
        stream.entry.meta = createMetaScanner(KIND, this.seedOf(stream))
      }
      const messages = db.messages(stream.row.id).map(parseMessageRow)
      const parts = db.parts(stream.row.id).map(parsePartRow)
      stream.messageCount = messages.length
      stream.partCount = parts.length
      stream.messageMax = maxUpdated(messages)
      stream.partMax = maxUpdated(parts)
      // Anchor before the batch ships so appended lines queue at the index
      // `beginFile` returns (no-op while `enableSearch` materializes — it
      // anchors and replays itself afterwards).
      if (this.search !== undefined && !stream.entry.searchSkipped) {
        stream.entry.searchFrom = this.search.beginFile(
          searchKeyOf(stream.entry), { size: this.countOf(stream), mtimeMs: stream.entry.mtimeMs },
        )
      }
      const out = planLines({ messages, parts, cursor: stream.cursor, mode: { kind: 'live' } })
      this.ship(stream, out.lines)
      stream.materialized = true
      stream.needsRebuild = false
      this.noteSearchProgress(stream)
    } catch (error) {
      stream.needsRebuild = true
      throw error
    }
  }

  /** Materialize every stream under a session's root (first subscribe/readAll/search). */
  private materializeRoot(id: string): void {
    for (const stream of this.streams.values()) {
      if (stream.rootId !== id || stream.materialized) continue
      try {
        this.materialize(stream)
        this.syncSidecar(this.streams.get(stream.rootId))
      } catch (error) {
        this.emit('error', new Error(`opencode session ${stream.row.id} materialization failed`, { cause: error }))
      }
    }
  }

  /** The `SourceSession` a stream's entry is grouped under (its root's). */
  private sessionOf(stream: StreamState): SourceSession<OpencodeEntry> {
    return this.book.sessionFor(KIND, stream.rootId)
  }

  private streamOfEntry(entry: OpencodeEntry): StreamState | undefined {
    const session = this.book.sessions.get(`${KIND} ${entry.sessionId}`)
    if (session === undefined) return undefined
    if (session.main === entry) return this.streams.get(entry.sessionId)
    for (const [childId, child] of session.children) {
      if (child === entry) return this.streams.get(childId)
    }
    return undefined
  }

  /** Consume the plan's output: stream lines append, sidecars ship at `startLine: -1`. */
  private ship(stream: StreamState, lines: readonly WireLine[]): void {
    const streamLines: string[] = []
    for (const wire of lines) {
      if (wire.kind === 'sidecar') {
        // Prune lines and (on a keyed change) the session sidecar.
        this.book.emitTo(this.sessionOf(stream), {
          type: 'lines', file: stream.entry.ref, lines: [wire.line], startLine: -1,
        })
        continue
      }
      const index = stream.entry.lines
      stream.entry.lines += 1
      stream.entry.mtimeMs = Math.max(stream.entry.mtimeMs, wire.time)
      stream.entry.meta?.push(wire.line)
      if (
        this.search !== undefined && !stream.entry.searchSkipped && index >= stream.entry.searchFrom
      ) {
        this.search.queue(searchKeyOf(stream.entry), index, wire.line)
      }
      streamLines.push(wire.line)
      this.learnSpawn(stream, wire)
    }
    for (let offset = 0; offset < streamLines.length; offset += CHUNK_LINES) {
      this.book.emitTo(this.sessionOf(stream), {
        type: 'lines',
        file: stream.entry.ref,
        lines: streamLines.slice(offset, offset + CHUNK_LINES),
        startLine: stream.entry.lines - streamLines.length + offset,
      })
    }
    if (streamLines.length > 0 || lines.length > 0) this.noteSearchProgress(stream)
  }

  private noteSearchProgress(stream: StreamState): void {
    if (stream.entry.searchSkipped || this.search === undefined) return
    this.search.noteProgress(searchKeyOf(stream.entry), {
      size: this.countOf(stream),
      mtimeMs: stream.entry.mtimeMs,
      // Same shape JSONL uses: `size` is the total (rows), `indexedBytes`
      // the consumed prefix (rows the emitted lines account for). An open
      // tail at shutdown reads as incomplete to `coverage`.
      indexedBytes: this.countOf(stream) - openRowCount(stream.cursor),
      indexedLines: stream.entry.lines,
    })
  }

  /**
   * A settled `tool` part's `state.metadata.sessionId` binds a child
   * session: enrich that child entry's `agent` ref facts (the spawning
   * call's `toolUseId`, description, type, model) and re-ship the ref when
   * anything moved — the row-derived facts landed at catalog time.
   */
  private learnSpawn(stream: StreamState, wire: WireLine): void {
    if (!wire.line.includes('"sessionId"')) return
    let record: unknown
    try {
      record = JSON.parse(wire.line)
    } catch {
      return
    }
    if (!isRecord(record)) return
    const part = isRecord(record['part']) ? record['part'] : undefined
    if (part === undefined || asString(part['type']) !== 'tool') return
    const state = isRecord(part['state']) ? part['state'] : undefined
    const metadata = isRecord(state?.['metadata']) ? state['metadata'] : undefined
    const childId = asString(metadata?.['sessionId'])
    if (childId === undefined) return
    const session = this.book.sessions.get(`${KIND} ${stream.rootId}`)
    const entry = session?.children.get(childId)
    if (entry === undefined) return
    const input = isRecord(state?.['input']) ? state['input'] : undefined
    const model = isRecord(metadata?.['model']) ? metadata['model'] : undefined
    const callID = asString(part['callID'])
    const description = asString(state?.['title']) ?? asString(input?.['description'])
    const agentType = asString(input?.['subagent_type'])
    const modelId = asString(model?.['modelID'])
    const known = entry.ref.agent
    if (
      known !== undefined
      && (callID === undefined || known.toolUseId === callID)
      && (description === undefined || known.description === description)
      && (agentType === undefined || known.agentType === agentType)
      && (modelId === undefined || known.model === modelId)
    ) return
    const toolUseId = callID ?? known?.toolUseId
    const nextDescription = description ?? known?.description
    const nextType = agentType ?? known?.agentType
    const nextModel = modelId ?? known?.model
    entry.ref = {
      ...entry.ref,
      agent: {
        agentId: childId,
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(nextDescription === undefined ? {} : { description: nextDescription }),
        ...(nextType === undefined ? {} : { agentType: nextType }),
        ...(nextModel === undefined ? {} : { model: nextModel }),
      },
    }
    if (session !== undefined) this.book.emitTo(session, { type: 'file', file: entry.ref })
  }

  // -- synthetic records ---------------------------------------------------------

  /**
   * The `opencode.session` sidecar: row facts + every descendant flattened
   * under this root, dedup'd by content (`sidecarKey`) so it re-sends only
   * when a fact actually moved (a late title, a discovered child).
   */
  private sidecarLine(stream: StreamState): { line: WireLine; key: string } | null {
    const row = stream.row
    const session = this.book.sessions.get(`${KIND} ${stream.rootId}`)
    const children = [...(session?.children.values() ?? [])].map(entry => ({
      id: entry.ref.id,
      title: childTitle(this.streams.get(entry.ref.id)?.row),
      ...(this.streams.get(entry.ref.id)?.row.agent === null
        ? {}
        : { agent: this.streams.get(entry.ref.id)?.row.agent }),
      parentID: this.streams.get(entry.ref.id)?.row.parent_id ?? stream.rootId,
    }))
    const facts: Record<string, unknown> = {
      id: row.id,
      ...(row.parent_id === null ? {} : { parentID: row.parent_id }),
      slug: row.slug,
      directory: row.directory,
      title: row.title,
      version: row.version,
      ...(row.agent === null ? {} : { agent: row.agent }),
      ...(jsonRecord(row.model) === undefined ? {} : { model: jsonRecord(row.model) }),
      timeUpdated: row.time_updated,
      cost: row.cost,
      tokens: {
        input: row.tokens_input,
        output: row.tokens_output,
        reasoning: row.tokens_reasoning,
        cacheRead: row.tokens_cache_read,
        cacheWrite: row.tokens_cache_write,
      },
    }
    const key = JSON.stringify({ session: facts, children })
    return { line: sessionLine(facts, children, row.time_created), key }
  }

  /** Re-send the facts sidecar when its content moved; main streams only. */
  private syncSidecar(stream: StreamState | undefined): void {
    if (stream === undefined || stream.row.id !== stream.rootId) return
    const sidecar = this.sidecarLine(stream)
    if (sidecar === null || sidecar.key === stream.sidecarKey) return
    stream.sidecarKey = sidecar.key
    this.book.emitTo(this.sessionOf(stream), {
      type: 'lines', file: stream.entry.ref, lines: [sidecar.line.line], startLine: -1,
    })
    this.book.emitTo(this.sessionOf(stream), {
      type: 'meta',
      summary: this.book.summarize(this.sessionOf(stream)),
      children: this.book.childSummaries(this.sessionOf(stream)),
    })
  }

  /** Re-derive one stream's emitted lines pinned to its cursor (replay/readAll/search). */
  private replayStream(stream: StreamState): { stream: string[]; sidecar: WireLine[] } {
    const db = this.db
    if (db === null) return { stream: [], sidecar: [] }
    const messages = db.messages(stream.row.id).map(parseMessageRow)
    const parts = db.parts(stream.row.id).map(parsePartRow)
    const out = planLines({ messages, parts, cursor: stream.cursor, mode: { kind: 'replay', pinned: stream.cursor } })
    return {
      stream: out.lines.filter(line => line.kind === 'stream').map(line => line.line),
      sidecar: out.lines.filter(line => line.kind === 'sidecar'),
    }
  }

  // -- polling -----------------------------------------------------------------

  private scheduleTick(): void {
    if (this.pollTimer !== null) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      this.tick().catch((error: unknown) => { this.emit('error', error) })
    }, 120)
  }

  private async sweep(): Promise<void> {
    const db = this.db
    if (db === null) return
    const rows = this.sessionRows()
    if (rows === null) return
    const byId = new Map(rows.map(row => [row.id, row]))
    // Two grouped SUM(length(data)) queries for the whole store — the only
    // time blob sizes are read in bulk (per-session `sizeOf` covers a single
    // changed row later; never 2×N queries at startup).
    const messageSizes = db.sizes('message')
    const partSizes = db.sizes('part')
    // Grouped counts/maxes too: the lazy streams' watermarks start honest so
    // search coverage can compare without materializing and an unchanged
    // stream costs nothing on the first tick.
    const messageTouch = new Map(db.touches('message').map(touch => [touch.session_id, touch]))
    const partTouch = new Map(db.touches('part').map(touch => [touch.session_id, touch]))
    for (const row of rows) {
      try {
        const size = (messageSizes.get(row.id) ?? 0) + (partSizes.get(row.id) ?? 0)
        const msg = messageTouch.get(row.id)
        const prt = partTouch.get(row.id)
        this.registerStream(row, rootOf(row, byId), size, {
          messages: msg?.count ?? 0,
          parts: prt?.count ?? 0,
          messageMax: msg?.max_updated ?? 0,
          partMax: prt?.max_updated ?? 0,
        })
      } catch (error) {
        this.emit('error', new Error(`opencode session ${row.id} registration failed`, { cause: error }))
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    if (this.db === null) {
      if (!this.openDb()) return
      if (this.watchEnabled) this.attachWatcher()
      await this.sweep()
      for (const stream of this.streams.values()) this.emit('change', KIND, stream.rootId)
      return
    }
    const sig = this.fileSig()
    if (sig !== null && sig !== this.dbSig) {
      this.db.close()
      this.db = null
      this.clearWatchers()
      if (this.openDb()) {
        if (this.watchEnabled) this.attachWatcher()
        for (const stream of this.streams.values()) this.emit('change', KIND, stream.rootId)
      }
      return
    }
    if (this.resyncPending && !this.resyncAll()) return
    this.resyncPending = false
    if (this.watchEnabled) this.attachWatcher()
    const db = this.db
    // The WAL gate: an unchanged data version means no commit landed — skip
    // the grouped touches entirely. Pending plan passes still run below:
    // the trailing-user patience gate is measured in ticks, not writes.
    const version = db.dataVersion()
    const moved = this.dataVersion !== version
    this.dataVersion = version
    // Streams that already ran a plan pass during this tick's refresh: the
    // patience pass below must not count as their "next tick", or the
    // trailing-user gate would release in the same poll that armed it.
    const planned = new Set<StreamState>()
    if (moved) {
      const rows = this.sessionRows()
      if (rows === null) return
      const messageTouch = new Map(db.touches('message').map(touch => [touch.session_id, touch]))
      const partTouch = new Map(db.touches('part').map(touch => [touch.session_id, touch]))
      const byId = new Map(rows.map(row => [row.id, row]))
      const seen = new Set<string>()
      for (const row of rows) {
        seen.add(row.id)
        try {
          const stream = this.refreshStream(row, byId, messageTouch.get(row.id), partTouch.get(row.id))
          if (stream !== null) planned.add(stream)
        } catch (error) {
          const stream = this.streams.get(row.id)
          if (stream !== undefined) stream.needsRebuild = true
          this.emit('error', new Error(`opencode session ${row.id} refresh failed`, { cause: error }))
        }
      }
      for (const [id, stream] of [...this.streams]) {
        if (!seen.has(id)) this.drop(stream)
      }
    }
    // The patience pass: plan with no new rows so a trailing user message
    // (or a settling part) closes its wait. No SQL — pure cursor work.
    for (const stream of this.streams.values()) {
      if (planned.has(stream)) continue
      if (!stream.materialized || stream.cursor.pending.size === 0) continue
      const out = planLines({ messages: [], parts: [], cursor: stream.cursor, mode: { kind: 'live' } })
      if (out.lines.length > 0) {
        this.ship(stream, out.lines)
        this.emit('change', KIND, stream.rootId)
      }
    }
  }

  /**
   * One session row against the current store: register new rows, drop
   * missing ones, rebuild on count regression (revert), merge moved rows
   * into materialized streams, refresh catalog facts for the lazy tier.
   * Returns the stream when it ran a plan pass this tick (so the patience
   * pass can skip it), null otherwise.
   */
  private refreshStream(
    row: OpencodeSessionRow,
    byId: Map<string, OpencodeSessionRow>,
    messageTouch: { count: number; max_updated: number } | undefined,
    partTouch: { count: number; max_updated: number } | undefined,
  ): StreamState | null {
    const db = this.db
    if (db === null) return null
    const stream = this.streams.get(row.id)
    const rowMoved = stream === undefined || stream.row.time_updated !== row.time_updated
      || stream.row.title !== row.title
    if (stream === undefined) {
      const fresh = this.registerStream(row, rootOf(row, byId))
      this.book.emitTo(this.sessionOf(fresh), { type: 'file', file: fresh.entry.ref })
      // A stream appearing under an already-materialized root materializes
      // with it; so does one arriving while search is live and indexable
      // (materialize anchors `beginFile` and queues as it emits). Otherwise
      // it waits for the lazy tier like the rest.
      const rootLive = [...this.streams.values()].some(
        other => other.rootId === fresh.rootId && other !== fresh && other.materialized,
      )
      const indexable = this.search !== undefined
        && this.search.shouldIndex({ mtimeMs: fresh.entry.mtimeMs })
      if (rootLive || indexable) this.materialize(fresh)
      this.syncSidecar(this.streams.get(fresh.rootId))
      this.emit('change', KIND, fresh.rootId)
      return rootLive || indexable ? fresh : null
    }
    stream.row = row
    stream.entry.mtimeMs = Math.max(stream.entry.mtimeMs, row.time_updated)
    const msgCount = messageTouch?.count ?? 0
    const partCount = partTouch?.count ?? 0
    const msgMax = messageTouch?.max_updated ?? 0
    const partMax = partTouch?.max_updated ?? 0
    const regressed = stream.materialized
      && (msgCount < stream.messageCount || partCount < stream.partCount)
    if (regressed || stream.needsRebuild) {
      this.materialize(stream, true)
      this.emit('change', KIND, stream.rootId)
      return stream
    }
    const moved = msgMax > stream.messageMax || partMax > stream.partMax
    if (stream.materialized) {
      // An open tail re-queries on every moved tick: a second write in the
      // same millisecond can hide a terminal state behind the watermark
      // (the `>=` fetch re-reads those rows; re-planning is idempotent).
      // Closed streams keep the cheap strict gate.
      if (moved || stream.cursor.pending.size > 0) {
        const messages = db.messagesUpdatedAfter(row.id, stream.messageMax).map(parseMessageRow)
        const parts = db.partsUpdatedAfter(row.id, stream.partMax).map(parsePartRow)
        const out = planLines({ messages, parts, cursor: stream.cursor, mode: { kind: 'live' } })
        stream.messageCount = msgCount
        stream.partCount = partCount
        stream.messageMax = msgMax
        stream.partMax = partMax
        this.ship(stream, out.lines)
        if (out.lines.length > 0) this.emit('change', KIND, stream.rootId)
        return stream
      } else {
        stream.messageCount = msgCount
        stream.partCount = partCount
      }
    } else if (moved || rowMoved) {
      // A stream the index already covered stayed unmaterialized — but new
      // content behind it still needs indexing, so materialize on the
      // first touch: `beginFile` anchors at the prior `indexedLines`
      // watermark and `ship` queues only the lines from there (the emitted
      // prefix is deterministic for closed messages).
      if (this.search !== undefined && !stream.entry.searchSkipped
        && this.search.shouldIndex({ mtimeMs: stream.entry.mtimeMs })) {
        try {
          this.materialize(stream)
          this.syncSidecar(this.streams.get(stream.rootId))
        } catch (error) {
          this.emit('error', new Error(`opencode session ${stream.row.id} materialization failed`, { cause: error }))
        }
        this.emit('change', KIND, stream.rootId)
        return stream
      }
      // The lazy tier only re-derives catalog facts — a rebuilt scanner re-reads
      // the small user feed; bodies stay unread.
      stream.messageCount = msgCount
      stream.partCount = partCount
      stream.messageMax = msgMax
      stream.partMax = partMax
      stream.entry.size = this.sizeOf(row.id)
      this.rebuildCatalogScanner(stream)
      this.emit('change', KIND, stream.rootId)
    }
    if (rowMoved) {
      // Title/model land late: re-seed in place (a rebuilt scanner would
      // drop the promptCount the materialized stream accumulated) and
      // re-send the sidecar on a key change.
      const meta = stream.entry.meta?.state
      const seed = this.seedOf(stream)
      if (meta !== undefined) {
        const title = asString(seed['title'])?.trim()
        meta.aiTitle = title === undefined || title === '' ? null : title
        meta.cwd = asString(seed['cwd']) ?? null
        meta.model = asString(seed['model']) ?? null
      }
      this.syncSidecar(stream)
      this.emit('change', KIND, stream.rootId)
    }
    return null
  }

  /** Forget a session whose row vanished (delete/revert). */
  private drop(stream: StreamState): void {
    const session = this.sessionOf(stream)
    // A vanished root takes the whole session with it; a vanished child only
    // detaches its own entry.
    if (stream.row.id === stream.rootId) {
      const paths = this.book.dropSession(session)
      for (const path of paths) this.search?.forget(path)
      for (const [id, child] of [...this.streams]) {
        if (child.rootId === stream.rootId) this.streams.delete(id)
      }
      this.emit('change', KIND, stream.rootId)
    } else {
      session.children.delete(stream.row.id)
      this.book.files.delete(stream.entry.path)
      this.search?.forget(stream.entry.path)
      this.streams.delete(stream.row.id)
      this.emit('change', KIND, stream.rootId)
    }
  }

  /**
   * The store file was replaced: every cursor, counter and pending buffer
   * was built from the old store's rows — all void. Rebuild each stream in
   * place (`materialize(full)` ships `file reset`) and drop what the new
   * store lacks. Returns false when the new store will not query yet.
   */
  private resyncAll(): boolean {
    const db = this.db
    if (db === null) return false
    const rows = this.sessionRows()
    if (rows === null) return false
    const byId = new Map(rows.map(row => [row.id, row]))
    const messageSizes = db.sizes('message')
    const partSizes = db.sizes('part')
    const seen = new Set<string>()
    for (const row of rows) {
      seen.add(row.id)
      const stream = this.streams.get(row.id)
      try {
        if (stream === undefined) {
          const size = (messageSizes.get(row.id) ?? 0) + (partSizes.get(row.id) ?? 0)
          this.registerStream(row, rootOf(row, byId), size)
          this.emit('change', KIND, row.id)
          continue
        }
        stream.row = row
        this.materialize(stream, true)
        this.syncSidecar(stream)
      } catch (error) {
        if (stream !== undefined) stream.needsRebuild = true
        this.emit('error', new Error(`opencode session ${row.id} resync failed`, { cause: error }))
      }
    }
    for (const [id, stream] of [...this.streams]) {
      if (!seen.has(id)) this.drop(stream)
    }
    return true
  }

  /** `sessions()` with failure isolation: one error event per streak, empty tick. */
  private sessionRows(): OpencodeSessionRow[] | null {
    if (this.db === null) return null
    try {
      const rows = this.db.sessions()
      this.queryFailed = false
      return rows
    } catch (error) {
      if (!this.queryFailed) {
        this.queryFailed = true
        this.emit('error', new Error(`${this.dbPath}: session query failed`, { cause: error }))
      }
      return null
    }
  }
}

/** Highest `time_updated` among parsed rows (0 when empty). */
function maxUpdated(rows: readonly { row: { time_updated: number } }[]): number {
  let max = 0
  for (const { row } of rows) max = Math.max(max, row.time_updated)
  return max
}

/** Parse a JSON column; non-JSON degrades to undefined. */
function jsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A child row's display title (`title` is always set; the cleaned form may be empty). */
function childTitle(row: OpencodeSessionRow | undefined): string {
  return row?.title ?? ''
}

/**
 * The root of a session row: walk `parent_id` up through the current row
 * set; a cycle or a missing parent makes the row its own root (orphan
 * children are roots — docs/harness-formats.md → OpenCode).
 */
function rootOf(row: OpencodeSessionRow, byId: Map<string, OpencodeSessionRow>): string {
  let current = row
  const seen = new Set<string>([row.id])
  while (current.parent_id !== null) {
    const parent = byId.get(current.parent_id)
    if (parent === undefined || seen.has(parent.id)) return current.id
    seen.add(parent.id)
    current = parent
  }
  return current.id
}
