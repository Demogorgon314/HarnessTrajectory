/**
 * Session index: discovers transcript files under each harness root, keeps
 * listing metadata, watches for appends, and fans live lines out to subscribers.
 */

import { EventEmitter } from 'node:events'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  asNumber, isRecord, parseDshLine, parseJsonLine,
  type AgentFileMeta, type HarnessKind, type SessionDetail, type SessionFileRef,
  type SessionLiveEvent, type SessionSummary,
} from '@harness-trajectory/core'
import {
  agentMetaEqual, createMetaScanner, hydrateMeta, listingScannerFor, mergeChildAgent, META_SCANNER_VERSION,
  readHead, serializeMeta, type FileHead, type MetaScanner,
} from './meta.ts'
import type { ListingCache } from './listing-cache.ts'
import type { HarnessRoot } from './roots.ts'
import type { SearchIndexer } from './search/indexer.ts'
import {
  scopeToFile, searchKeyOf,
  SessionBook, sessionKey, standaloneRef, type ReplaySink, type SourceEntry, type SourceSession,
  type SessionSource, type Subscriber,
} from './source.ts'
import {
  isCompressedTranscript, plainTranscriptPath, readDecodedPrefix, readFirstLine, readLines,
  resolveTranscriptFile, streamLines, zstdSupported,
} from './tail.ts'
import {
  classifyCodexPath, CodexRollouts, codexFootprintMatches, parseCodexFootprint,
  serializeCodexFootprint, type CodexBase,
} from './codex-rollouts.ts'
import { mergeReplay, type StreamingLineSource } from './replay.ts'
import type { Classified } from './harness/classified.ts'
import { classifyClaudePath, claudeChildDir, readAgentMeta } from './harness/claude.ts'
import {
  buildGrokSidecar, classifyGrokPath, GrokBindings, grokChildDir, grokChildPaths,
  grokSummaryTitle, readGrokSidecar, readGrokSubagentMetas,
} from './harness/grok.ts'
import { classifyKimiPath, kimiChildDir, readKimiTitle } from './harness/kimi.ts'
import { classifyPiPath } from './harness/pi.ts'
import { classifyDshPath, DshGenerations, dshAttachmentPath, type DshLogFile } from './harness/dsh.ts'
import { readJsonRecord } from './harness/sidecar.ts'

/** Keep the owning header even though it precedes the child's activity boundary. */
function isOwnCodexRecord(entry: FileEntry, line: string): boolean {
  if (entry.historyStartOrdinal === undefined) return true
  const record = parseJsonLine(line)
  if (!isRecord(record)) return true
  if (record['type'] === 'session_meta') {
    const payload = record['payload']
    return isRecord(payload) && payload['id'] === entry.ref.id
  }
  const ordinal = asNumber(record['ordinal'])
  return ordinal === undefined || ordinal >= entry.historyStartOrdinal
}

// The shared source plumbing lives in `source.ts`; these re-exports keep the
// historical `index.ts` import surface (tests, app.ts) intact.
export {
  lineTime, lineTimes, mergeChronologically, scopeToFile, standaloneRef, summaryOrderKey,
  type LineChunk, type LineSource, type SessionSource, type Subscriber,
} from './source.ts'

const WATCH_DEBOUNCE_MS = 120
const POLL_INTERVAL_MS = 1_500
/** Files the startup sweep registers at once; the reads overlap, the parsing does not. */
const BACKFILL_CONCURRENCY = 8
/**
 * Bytes the first pass over a transcript reads at a time. The local corpus holds
 * rollouts of well over 100 MB and `readLines` allocates one buffer per call, so
 * the initial scan walks a large file in slices instead of materializing it whole.
 */
const INITIAL_CHUNK_BYTES = 8 * 1024 * 1024

/** Let the HTTP server run during the startup sweep (SQLite writes are sync). */
function yieldTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

interface FileEntry extends SourceEntry {
  kind: HarnessKind
  path: string
  ref: SessionFileRef
  /** Owning session id (`ref.id` for main files, the parent id for children). */
  sessionId: string
  /**
   * Size of the stream's own content in DECODED bytes (a plain file's size;
   * for a `.jsonl.zst` head the decompressed length). Excludes lineage bases.
   */
  size: number
  /** Physical size of the on-disk representation; the watch/listing change check. */
  physicalSize: number
  mtimeMs: number
  /** Byte offset up to which lines have been consumed (decoded for compressed heads). */
  offset: number
  rest: string
  /**
   * Non-blank lines consumed so far, which is also the 0-based index the next
   * one gets in the search index. Blank lines are dropped by `readLines`, so
   * this counts records, exactly like the replay a viewer receives.
   */
  lines: number
  /** First line index the search index still wants; everything below it is already stored. */
  searchFrom: number
  /** Too old for the retention window: browsable, but nothing is queued for the index. */
  searchSkipped: boolean
  meta: MetaScanner | null
  /** A consume is reading this file right now; a concurrent one folds into `consumePending`. */
  consuming: boolean
  /** The newest stat a skipped consume arrived with, drained by the lock holder. */
  consumePending: { size: number; mtimeMs: number } | undefined
  /** Grok only: mtime of the `summary.json` last read for this file. */
  summaryMtimeMs?: number
  /**
   * Grok only: the facts of the sidecar last sent to subscribers
   * (`grokSidecarKey`). `summary.json` is rewritten on essentially every
   * appended line — `num_messages`, `updated_at` and the trace cursor are
   * patched per write — so neither the mtime nor the rendered line is a usable
   * gate: only what the sidecar actually tells the fold is.
   */
  sidecarKey?: string
  /** Grok only: `summary.session_summary` as last read, so the title syncs only on a change. */
  summaryTitle?: string | null
  /**
   * Grok only: this file registered as a main session although it may be a
   * subagent child — its `summary.json` was unreadable, or it said "subagent"
   * and no parent binding existed yet. Re-probed until it settles.
   */
  grokUnresolved?: boolean

  // -- Codex lineage / compression ------------------------------------------
  /** Codex only: the rollout id from the filename (last UUID), which `history_base` references. */
  rolloutId?: string
  /** Codex only: `session_meta.id` — stable across revert; shared by several physical files. */
  threadId?: string
  /** Codex only: the root the file registered under (bases resolve across every codex root). */
  rootDir?: string
  /** Codex only: the head's own `session_meta.history_base`, kept for re-resolution. */
  historyBase?: FileHead['historyBase']
  /** Codex only: records below this stream ordinal are inherited parent history — never indexed. */
  historyStartOrdinal?: number
  /** Codex only: resolved lineage bases, oldest first. */
  bases?: CodexBase[] | undefined
  /** Codex only: rollout ids `resolveCodexBases` could not find on disk yet. */
  pendingBases?: Set<string> | undefined
  /** Codex only: a base registered after this head consumed — re-resolve and re-read. */
  basesStale?: boolean | undefined
  /** Codex only: decoded bytes/lines the resolved bases contributed. */
  baseBytes: number
  baseLines: number
  basesConsumed: boolean
  /** Codex only: `{resolved path, physical size, mtime}` per consumed base — the listing fingerprint. */
  baseFootprint?: { p: string; s: number; m: number }[] | undefined
  /** Codex only: the head's on-disk representation is `.jsonl.zst` (immutable). */
  compressed?: boolean | undefined
  /** Codex only: decoded length of a compressed head — its cursor's end. */
  decodedSize?: number
  /** Codex only: a superseded same-thread rollout — never listed as a session. */
  superseded?: boolean

  // -- Dsh generations --------------------------------------------------------
  /** Dsh only: a newer generation resolved, waiting for the consume lock to re-point this entry. */
  dshPending?: DshLogFile | undefined
  /**
   * Dsh only: the header line was not readable at registration (the first
   * frame was still torn), so `ref.parentId` is unproven — the first consumed
   * line settles it (`probeDshHeader`).
   */
  dshUnprobed?: boolean | undefined
}

type SessionRecord = SourceSession<FileEntry>

export interface SessionIndexOptions {
  roots: readonly HarnessRoot[]
  /** Disable filesystem watching and polling (tests). */
  watch?: boolean
  now?: () => number
  /**
   * Full-text index fed from the same byte stream the meta scanner reads.
   * Omitted (tests, or search left at its off-by-default) means nothing is indexed.
   */
  search?: SearchIndexer
  /**
   * Persisted consume cursors + listing metadata; a restart then re-reads
   * only transcripts that changed (listing-cache.ts). Omitted in tests.
   */
  listing?: ListingCache
  /** Files registered concurrently during the startup sweep; 1 for a strict order. */
  backfillConcurrency?: number
}

export type { Classified } from './harness/classified.ts'

/** Identify the transcript role of a file from its path; `null` when it is not a transcript. */
export function classifyPath(
  kind: HarnessKind,
  root: string,
  path: string,
): Classified | null {
  const codex = kind === 'codex'
  const dsh = kind === 'dsh'
  const transcript = path.endsWith('.jsonl')
    || (codex && path.endsWith('.jsonl.zst'))
    || (dsh && path.endsWith('.jsonl.zstd'))
  if (!transcript) return null
  const rel = relative(root, path)
  if (rel.startsWith('..')) return null
  const parts = rel.split(sep)
  switch (kind) {
    case 'claude':
      return classifyClaudePath(parts, basename(path, '.jsonl'))
    case 'codex': {
      let stem = basename(path)
      if (stem.endsWith('.zst')) stem = stem.slice(0, -'.zst'.length)
      return classifyCodexPath(stem.endsWith('.jsonl') ? stem.slice(0, -'.jsonl'.length) : stem)
    }
    case 'kimi':
      return classifyKimiPath(parts, basename(path, '.jsonl'))
    case 'grok':
      return classifyGrokPath(parts, basename(path, '.jsonl'))
    case 'pi':
      return classifyPiPath(parts, basename(path, '.jsonl'))
    case 'dsh':
      return classifyDshPath(parts, basename(path))
    default:
      return null
  }
}

export class SessionIndex extends EventEmitter implements SessionSource {
  private readonly roots: readonly HarnessRoot[]
  /** Sessions/files/subscriber bookkeeping, shared with the non-file sources. */
  private readonly book = new SessionBook<FileEntry>(() => this.now())
  /**
   * Grok child → parent bindings read from `<parent>/subagents/<childId>/meta.json`.
   * A grok child is a top-level session directory that names no parent of its
   * own, so this map is the only way a child registered before (or far away
   * from) its parent finds it (GROK-FORMAT §D.2, §D.3). The mechanics live in
   * `harness/grok.ts`.
   */
  private readonly grok = new GrokBindings()

  // -- Codex rollout lineage -------------------------------------------------
  /**
   * Codex filename/registry/lineage bookkeeping — rollout ids, representation
   * dedup, `history_base` resolution, same-thread supersession. The mechanics
   * live in `codex-rollouts.ts`; this index only applies its verdicts to the
   * shared `SessionBook`.
   */
  private readonly codex = new CodexRollouts<FileEntry>(() =>
    this.roots.filter(root => root.kind === 'codex').map(root => root.dir))
  /**
   * Session keys whose live head was demoted by a revert and whose
   * replacement has not registered yet — the new head's `file` event must
   * carry `reset` because the demote already cleared the session's pointer.
   */
  private readonly codexResets = new Set<string>()
  /**
   * Dsh session directory → its registered entry, so a walk/watch path that
   * names a non-current generation resolves onto the same file and a newly
   * published generation migrates the entry instead of double-registering.
   * Generations are immutable once published — a successor's appearance is
   * the only reason the resolved path ever changes.
   */
  private readonly dsh = new DshGenerations<FileEntry>()
  private readonly watchers: FSWatcher[] = []
  private readonly pending = new Map<string, NodeJS.Timeout>()
  private poll: NodeJS.Timeout | null = null
  private readonly watchEnabled: boolean
  private readonly backfillConcurrency: number
  private readonly now: () => number
  /** Mutable: the Content search toggle attaches and detaches this at runtime. */
  private search: SearchIndexer | undefined
  private readonly listing: ListingCache | undefined
  /** Startup-sweep counters for the launch log. */
  private sweepRead = 0
  private sweepCached = 0
  private stopped = false

  constructor(options: SessionIndexOptions) {
    super()
    this.roots = options.roots
    this.watchEnabled = options.watch ?? true
    this.backfillConcurrency = Math.max(1, options.backfillConcurrency ?? BACKFILL_CONCURRENCY)
    this.now = options.now ?? Date.now
    this.search = options.search
    this.listing = options.listing
  }

  /** The transcript paths this source feeds to the search index. */
  livePaths(): string[] {
    return [...this.book.files.values()].flatMap(entry => (entry.searchSkipped ? [] : [entry.path]))
  }

  kinds(): readonly HarnessKind[] {
    return [...new Set(this.roots.map(root => root.kind))]
  }

  async start(): Promise<void> {
    this.stopped = false
    this.sweepRead = 0
    this.sweepCached = 0
    // Walk every root first so the search UI can show N/M from the first file,
    // instead of a total that jumps each time a harness directory is entered.
    const planned: { root: HarnessRoot; path: string; mtimeMs: number }[] = []
    for (const root of this.roots) {
      if (this.stopped) return
      let paths = (await walk(root.dir)).filter(path => classifyPath(root.kind, root.dir, path) !== null)
      if (root.kind === 'codex') {
        // One rollout can sit on disk twice mid-transition; Codex itself
        // resolves the plain file first, so the `.zst` twin is never a
        // second session (rollout/src/compression.rs).
        const seen = new Set(paths)
        paths = paths.filter(path => !isCompressedTranscript(path) || !seen.has(plainTranscriptPath(path)))
        // Seed the rollout-id → path index; `history_base` resolution looks
        // bases up here before they are registered (or listed at all).
        for (const path of paths) {
          const rolloutId = classifyPath(root.kind, root.dir, path)?.rolloutId
          if (rolloutId !== undefined) this.codex.notePath(rolloutId, path)
        }
      }
      // Watch before the sweep, not after it: a transcript created while the
      // pool below is still reading older files is announced by the watcher
      // instead of waiting for the next start. The consume lock keeps a watch
      // event from double-reading a file the pool is still registering.
      if (this.watchEnabled) this.watchRoot(root)
      for (const path of paths) {
        // The order needs the mtimes anyway; `register` stats again, but a
        // stat is cheap next to the read that follows it.
        const info = await stat(path).catch(() => null)
        if (info !== null && info.isFile()) planned.push({ root, path, mtimeMs: info.mtimeMs })
      }
    }
    // Newest first: the sessions a user is most likely to open become visible
    // and searchable within seconds, not only after the whole sweep has
    // chewed through months of old transcripts.
    planned.sort((left, right) => right.mtimeMs - left.mtimeMs)
    this.search?.setBackfillPlan(planned.length)
    // A few files in flight: parsing stays on this one thread, but the reads
    // overlap and one multi-hundred-megabyte rollout no longer stalls every
    // file queued behind it.
    let cursor = 0
    const workers = Array.from({ length: Math.min(this.backfillConcurrency, planned.length) }, async () => {
      while (!this.stopped) {
        const item = planned[cursor]
        cursor += 1
        if (item === undefined) return
        try {
          await this.register(item.root, item.path, true)
        } catch {
          // One unreadable transcript must not take the sweep down with it.
        } finally {
          this.search?.noteBackfillFile()
        }
      }
    })
    await Promise.all(workers)
    if (this.stopped) return
    // Rows for transcripts that disappeared between runs are dropped here;
    // unlike the search index the listing cache also covers retention-skipped
    // files, so its live set is every registered path.
    this.listing?.prune(new Set(this.book.files.keys()))
    if (this.watchEnabled) {
      this.poll = setInterval(() => { void this.pollSubscribed() }, POLL_INTERVAL_MS)
      this.poll.unref()
    }
  }

  stop(): void {
    this.stopped = true
    for (const watcher of this.watchers) watcher.close()
    this.watchers.length = 0
    if (this.poll !== null) clearInterval(this.poll)
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  /** Re-stat one path (tests and manual refresh). */
  async refreshPath(path: string): Promise<void> {
    const root = this.rootFor(path)
    if (root !== undefined) await this.refresh(root, path)
  }

  /** Files the last startup sweep re-read vs served whole from the listing cache. */
  sweepStats(): { read: number; cached: number } {
    return { read: this.sweepRead, cached: this.sweepCached }
  }

  /**
   * Attach a search indexer mid-run and index everything already registered,
   * in the background. Historical lines are re-read from disk — the consume
   * path only ever forwards appends — through the same per-file watermarks
   * the startup sweep uses, so re-enabling after a disable resumes instead
   * of starting over. The caller owns `finishBackfill` (SearchLifecycle closes
   * it once every source has been enabled).
   */
  async enableSearch(search: SearchIndexer): Promise<void> {
    if (this.search !== undefined) return
    // Anchor every registered file synchronously, before the indexer goes
    // live on the consume path: `beginFile` fixes each resume watermark and
    // the plan freezes which lines (`from..upto`, within `bytes` on disk)
    // this pass reads itself. Appends from here on get line indexes past
    // `upto` and reach the indexer through the consume path only — an
    // append that landed mid-pass would otherwise be queued twice.
    const plan = new Map<FileEntry, { from: number; upto: number; bytes: number }>()
    for (const entry of this.book.files.values()) {
      entry.searchSkipped = !search.shouldIndex({ mtimeMs: entry.mtimeMs })
      entry.searchFrom = entry.searchSkipped
        ? 0
        : search.beginFile(searchKeyOf(entry), { size: entry.size, mtimeMs: entry.mtimeMs })
      if (!entry.searchSkipped && entry.searchFrom < entry.lines) {
        plan.set(entry, { from: entry.searchFrom, upto: entry.lines, bytes: entry.offset })
      }
    }
    this.search = search
    const entries = [...this.book.files.values()]
    search.setBackfillPlan(entries.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(this.backfillConcurrency, entries.length) }, async () => {
      for (;;) {
        // Toggled off mid-pass: the indexer is being closed; stop touching it.
        if (this.stopped || this.search !== search) return
        const entry = entries[cursor]
        cursor += 1
        if (entry === undefined) return
        try {
          await this.backfillSearchEntry(search, entry, plan.get(entry))
        } catch {
          // One unreadable transcript must not take the pass down with it.
        } finally {
          search.noteBackfillFile()
        }
      }
    })
    await Promise.all(workers)
  }

  /** Detach the indexer (Content search toggled off): appends stop indexing. */
  disableSearch(): void {
    this.search = undefined
  }

  /**
   * Feed a registered file's historical lines to a freshly attached indexer.
   * Only the plan's `[from, upto)` lines are queued: older ones are already
   * in the index, newer ones arrived (or arrive) through the consume path.
   */
  private async backfillSearchEntry(
    search: SearchIndexer,
    entry: FileEntry,
    plan: { from: number; upto: number; bytes: number } | undefined,
  ): Promise<void> {
    if (plan === undefined) return
    const { from, upto, bytes: sizeLimit } = plan
    const key = searchKeyOf(entry)
    let offset = 0
    let rest = ''
    let lineIndex = 0
    let end = Math.min(INITIAL_CHUNK_BYTES, sizeLimit)
    while (offset < sizeLimit) {
      if (this.stopped || this.search !== search) return
      // A truncation/rewrite mid-pass resets the entry and re-queues every
      // line through the consume path; continuing here would double them.
      if (entry.searchFrom !== from || entry.lines < upto) return
      const result = await readLines(entry.path, offset, rest, end)
      for (const line of result.lines) {
        if (lineIndex >= from) search.queue(key, lineIndex, line)
        lineIndex += 1
      }
      if (result.offset === offset) {
        // A `.zstd` window ending mid-frame yields no progress: grow it while
        // real bytes remain ahead — the same expansion consumeInitial uses.
        // Only a still-torn tail at the plan's actual boundary is terminal.
        if (end >= sizeLimit) return
        end = Math.min(end + INITIAL_CHUNK_BYTES, sizeLimit)
        await yieldTurn()
        continue
      }
      offset = result.offset
      rest = result.rest
      end = Math.min(offset + INITIAL_CHUNK_BYTES, sizeLimit)
      await yieldTurn()
    }
    // The consume path owns the watermark from the first appended line on; a
    // file that changed mid-pass must not have its progress rolled back here.
    if (entry.searchFrom !== from || entry.lines !== upto) return
    search.noteProgress(key, {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      indexedBytes: offset,
      indexedLines: lineIndex,
    })
  }

  /** Sessions with a main transcript, newest activity first. */
  list(): SessionSummary[] {
    return this.book.list()
  }

  get(kind: HarnessKind, id: string): SessionDetail | undefined {
    return this.book.get(kind, id)
  }

  /** Whether a session has a child transcript with this id. */
  hasChild(kind: HarnessKind, id: string, fileId: string): boolean {
    return this.book.hasChild(kind, id, fileId)
  }

  /**
   * Absolute path of one offloaded attachment blob.
   *
   * Kimi offloads media above ~4 KB into a per-agent store
   * (`agents/<agentId>/blobs/<hash>`) beside the transcript. Dsh's store is
   * global instead: `$DSH_HOME/attachments/v1/objects/<2-hex>/<sha256>`,
   * derived from the dsh root's parent (the sessions dir and `attachments/`
   * are siblings). Both stores are content-addressed, so the response is
   * immutable.
   */
  blobPath(kind: HarnessKind, id: string, fileId: string, hash: string): string | null {
    if (!/^[0-9a-f]{16,64}$/.test(hash)) return null
    const session = this.book.sessions.get(sessionKey(kind, id))
    if (session === undefined) return null
    const entry = fileId === id ? session.main : (session.children.get(fileId) ?? null)
    if (entry === null || entry === undefined) return null
    if (kind === 'dsh') {
      const root = this.roots.find(candidate => candidate.kind === 'dsh')
      if (root === undefined) return null
      return dshAttachmentPath(dirname(root.dir), hash)
    }
    return join(dirname(entry.path), 'blobs', hash)
  }

  /**
   * Stream the existing content of every file of a session, chunked. Lines
   * from the main transcript and child (subagent) transcripts are merged in
   * timestamp order so adapters see children where they actually happened.
   *
   * With `fileId`, only that child transcript is replayed, served as the main
   * file of its own view (see `scopeToFile`).
   */
  async readAll(
    kind: HarnessKind,
    id: string,
    emit: ReplaySink,
    fileId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return
    const session = this.book.sessions.get(sessionKey(kind, id))
    if (session === undefined || session.main === null) return
    let entries: FileEntry[]
    let refOf: (entry: FileEntry) => SessionFileRef = entry => entry.ref
    if (fileId === undefined) {
      entries = [session.main, ...session.children.values()]
    } else {
      const child = session.children.get(fileId)
      if (child === undefined) return
      entries = [child]
      refOf = entry => standaloneRef(entry.ref)
    }
    // Capture every stream's boundary before the first await. In particular,
    // a slow client must not replay records also arriving through live events.
    const captured = entries.map(entry => ({
      entry, ref: refOf(entry), path: entry.path, end: entry.offset,
      bases: (entry.bases ?? []).map(base => ({ ...base })),
    }))
    const sources: StreamingLineSource[] = []
    for (const capturedFile of captured) {
      if (signal?.aborted) return
      const { entry, ref, path, end, bases } = capturedFile
      const parts: { path: string; end?: number }[] = []
      for (const base of bases) {
        const resolved = await resolveTranscriptFile(base.path)
        if (resolved !== null) parts.push({
          path: resolved.path,
          ...(base.endByteOffset !== null ? { end: base.endByteOffset }
            : resolved.compressed ? {} : { end: resolved.size }),
        })
      }
      parts.push({ path, end })
      const sidecar = entry.kind === 'grok' ? await readGrokSidecar(path, ref.id) : undefined
      if (sidecar !== undefined) entry.sidecarKey = sidecar.key
      sources.push({
        ref,
        ...(sidecar === undefined ? {} : { synthetic: 1 }),
        async *open() {
          if (sidecar !== undefined) yield sidecar.line
          // Each lineage prefix discards its own incomplete final record,
          // exactly as consume does; partial lines cannot cross files.
          for (const part of parts) yield* streamLines(part.path, part.end, signal)
        },
      })
    }
    const meta = { type: 'meta' as const, summary: this.book.summarize(session), children: this.book.childSummaries(session) }
    for (const { ref } of captured) {
      if (signal?.aborted) return
      await emit({ type: 'file', file: ref })
    }
    for await (const chunk of mergeReplay(sources, signal)) {
      if (signal?.aborted) return
      await emit({ type: 'lines', file: chunk.ref, lines: chunk.lines, startLine: chunk.startLine })
    }
    if (!signal?.aborted) await emit(meta)
  }

  subscribe(kind: HarnessKind, id: string, subscriber: Subscriber): () => void {
    return this.book.subscribe(kind, id, subscriber)
  }

  // -- discovery -----------------------------------------------------------

  /**
   * Add a transcript to the index. During the initial scan its content only
   * feeds the metadata; a file that appears later (a subagent transcript of a
   * session someone is watching) is announced and its lines are forwarded.
   */
  private async register(root: HarnessRoot, path: string, initial = false): Promise<FileEntry | undefined> {
    const classified = classifyPath(root.kind, root.dir, path)
    if (classified === null) return undefined
    let info: { size: number; mtimeMs: number }
    let compressed = false
    if (root.kind === 'codex') {
      // Codex resolves the plain `.jsonl` before its `.jsonl.zst` twin
      // (rollout/src/compression.rs), and a watch event can name either
      // spelling — resolve before touching rollout-level dedup.
      const file = await resolveTranscriptFile(path)
      if (file === null || (file.compressed && !zstdSupported())) return undefined
      path = file.path
      compressed = file.compressed
      info = file
    } else if (root.kind === 'dsh') {
      // One session directory publishes several immutable generations; only
      // the current (highest-version) log is a transcript of the session.
      const resolved = await this.dsh.resolve(path)
      if (resolved === null) return undefined
      const prior = this.dsh.entry(path)
      if (prior !== undefined) {
        return prior.path === resolved.path
          ? prior
          : await this.migrateDshGeneration(prior, resolved, initial)
      }
      path = resolved.path
      info = resolved
    } else {
      try {
        const found = await stat(path)
        if (!found.isFile()) return undefined
        info = found
      } catch {
        return undefined
      }
    }
    let id = classified.id
    let parentId = classified.parentId
    // Codex's session id is `session_meta.id` (the THREAD id, stable across
    // revert); `classified.id` is the rollout id (the file's own identity).
    let rolloutId: string | undefined
    let threadId: string | undefined
    let historyBase: FileHead['historyBase']
    let historyStartOrdinal: number | undefined
    if (root.kind === 'codex') {
      rolloutId = classified.rolloutId ?? classified.id
      const canonical = plainTranscriptPath(path)
      this.codex.notePath(rolloutId, canonical)
      if (this.codex.isSuperseded(canonical)) {
        await this.noteCodexBaseAvailable(rolloutId)
        return undefined
      }
      const existing = this.codex.entry(rolloutId)
      if (existing !== undefined) {
        await this.noteCodexBaseAvailable(rolloutId)
        if (existing.path === path) return existing
        return this.migrateCodexRepresentation(existing, path, info, compressed, initial)
      }
    }
    // Codex identity lives in `session_meta`; a Claude child names its parent in its first record.
    // Kimi needs no probe: `classifyPath` already derived both ids from the path.
    // A dsh child's header names its parent (`origin:"subagent"` + `parentSession`).
    let dshUnprobed = false
    if (root.kind === 'codex' || root.kind === 'dsh' || (root.kind === 'claude' && classified.role === 'child')) {
      try {
        const firstLine = await readFirstLine(path)
        const head = readHead(root.kind, firstLine)
        if (root.kind === 'codex') {
          threadId = head.id ?? classified.threadUuid ?? rolloutId
          id = threadId ?? id
          parentId = head.parentId ?? undefined
          historyBase = head.historyBase ?? undefined
          historyStartOrdinal = head.historyStartOrdinal ?? undefined
        } else if (root.kind === 'dsh') {
          parentId = head.parentId ?? undefined
          // A session file exists before its first frame completes, so a watch
          // event can register it while the header is still unreadable. The
          // first consumed line then settles the role (`probeDshHeader`).
          dshUnprobed = parentId === undefined && parseDshLine(firstLine)?.tag !== 'header'
        } else if (parentId === undefined) {
          parentId = head.id ?? undefined
        }
      } catch {
        // Unreadable head: keep the path-derived identity.
        if (root.kind === 'codex') threadId = classified.threadUuid ?? rolloutId
        else if (root.kind === 'dsh') dshUnprobed = true
      }
    }
    // Codex lineage: `history_base` names the older rollout this file's
    // history starts from, and a reverted thread leaves several physical
    // files sharing one thread id — only the head of the chain is a session.
    let bases: CodexBase[] = []
    let pendingBases: Set<string> | undefined
    if (root.kind === 'codex') {
      const lineage = await this.codex.resolveBases(historyBase)
      bases = lineage.bases
      if (lineage.missing.length > 0) pendingBases = new Set(lineage.missing)
      const outcome = this.codex.arbitrate({
        rolloutId: rolloutId ?? '',
        threadId,
        bases,
        pendingBases,
        mtimeMs: info.mtimeMs,
      })
      if (outcome.superseded) {
        this.codex.markSuperseded(plainTranscriptPath(path))
        await this.noteCodexBaseAvailable(rolloutId ?? '')
        return undefined
      }
      for (const other of outcome.demote) this.demoteCodexFile(other, !initial)
    }
    // Grok's role is not path-derived: a child session is a top-level directory
    // like any other and only `summary.json` says otherwise (GROK-DESIGN §2).
    let agent: AgentFileMeta | undefined
    let grokSummary: Record<string, unknown> | null = null
    let grokUnresolved = false
    if (root.kind === 'grok') {
      const probe = await this.grok.probe(root.dir, path, id)
      grokSummary = probe.summary
      if (probe.parentId !== undefined) {
        parentId = probe.parentId
        agent = probe.agent
      }
      // Grok writes the child's directory and `updates.jsonl` before its
      // `summary.json` and before the parent's `subagents/<id>/meta.json`, so
      // an early probe has to be repeatable (see `refreshGrokBinding`).
      grokUnresolved = probe.summary === null || (probe.child && probe.parentId === undefined)
    }
    const role: 'main' | 'child' = parentId !== undefined ? 'child' : classified.role
    const sessionId = parentId ?? id
    if (agent === undefined && role === 'child' && root.kind === 'claude') agent = await readAgentMeta(path)
    const ref: SessionFileRef = {
      id,
      role,
      path,
      ...(parentId === undefined ? {} : { parentId }),
      ...(agent === undefined ? {} : { agent }),
      ...(historyStartOrdinal === undefined ? {} : { historyStartOrdinal }),
    }
    const entry: FileEntry = {
      kind: root.kind,
      path,
      ref,
      sessionId,
      size: 0,
      physicalSize: info.size,
      mtimeMs: info.mtimeMs,
      offset: 0,
      rest: '',
      lines: 0,
      consuming: false,
      consumePending: undefined,
      searchFrom: 0,
      searchSkipped: false,
      meta: listingScannerFor(root.kind, role, agent, grokSummary),
      baseBytes: 0,
      baseLines: 0,
      basesConsumed: false,
      ...(root.kind === 'grok' ? { summaryTitle: grokSummaryTitle(grokSummary) } : {}),
      ...(grokUnresolved && role === 'main' ? { grokUnresolved: true } : {}),
      ...(dshUnprobed ? { dshUnprobed: true } : {}),
      ...(root.kind === 'codex' ? {
        rootDir: root.dir,
        ...(rolloutId === undefined ? {} : { rolloutId }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(historyStartOrdinal === undefined ? {} : { historyStartOrdinal }),
        ...(historyBase === undefined || historyBase === null ? {} : { historyBase }),
        ...(bases.length === 0 ? {} : { bases }),
        ...(pendingBases === undefined ? {} : { pendingBases }),
        ...(compressed ? { compressed: true } : {}),
      } : {}),
    }
    if (this.book.files.has(path)) return this.book.files.get(path)
    this.book.files.set(path, entry)
    if (root.kind === 'dsh') this.dsh.note(path, entry)
    if (root.kind === 'codex') {
      this.codex.registered(entry)
      // Heads still waiting for this file as a lineage base re-resolve through it.
      await this.noteCodexBaseAvailable(rolloutId ?? '')
      if (pendingBases !== undefined) this.codex.setWaiting(entry, [...pendingBases])
    }
    const session = this.book.sessionFor(root.kind, sessionId)
    // A live revert demotes the old head above, which already clears
    // `session.main`/`children` — `session.main !== null` can therefore never
    // observe the replacement. The demote records the fact instead, and the
    // new head's `file` event carries `reset` so an open view refolds.
    const demoted = this.codexResets.delete(sessionKey(root.kind, sessionId))
    const replaced = demoted
      || (role === 'main' && session.main !== null && session.main !== entry)
      || (role === 'child' && session.children.get(id) !== undefined && session.children.get(id) !== entry)
    if (role === 'main') session.main = entry
    else session.children.set(id, entry)
    if (!initial && (role === 'child' || replaced)) {
      this.book.emitTo(session, { type: 'file', file: ref, ...(replaced ? { reset: true } : {}) })
    }
    // The meta scanner replays from byte 0 unless the listing cache restores
    // it; the search index answers with the first line it has not stored yet.
    // A transcript untouched for longer than the retention window stays
    // browsable but out of the index; the next start reconsiders it under its
    // then-current mtime and settings.
    entry.searchSkipped = this.search !== undefined && !this.search.shouldIndex({ mtimeMs: info.mtimeMs })
    entry.searchFrom = entry.searchSkipped
      ? 0
      : this.search?.beginFile(searchKeyOf(entry), { size: info.size, mtimeMs: info.mtimeMs }) ?? 0
    // The listing cache only serves the startup sweep: a file registered live
    // (a subagent transcript that just appeared) is always read, since its
    // lines are forwarded to whoever is watching.
    const restored = initial
      ? await this.restoreListing(entry, info, await this.sidecarMtime(entry))
      : 'none'
    if (restored === 'none') {
      if (initial) this.sweepRead += 1
      await this.consumeInitial(entry, info.size, info.mtimeMs, initial)
    } else {
      if (restored === 'tail') {
        // Only the appended bytes are read, through the restored scanner.
        if (initial) this.sweepRead += 1
        await this.consume(entry, info.size, info.mtimeMs, initial)
      } else {
        if (initial) this.sweepCached += 1
      }
      // consumeInner's stamping never ran, so stamp children explicitly.
      this.applyChildListing(session)
    }
    await this.syncKimiTitle(entry)
    await this.syncGrokSummary(entry, true)
    this.saveListing(entry)
    // Membership and listing facts moved even when no lines were consumed at
    // all (a cache-restored file, an empty transcript, a child attaching):
    // `feedLines` only emits when it saw lines, so the listing revision would
    // otherwise never learn the session exists.
    this.emit('change', entry.kind, entry.sessionId)
    return entry
  }

  /**
   * Remove a superseded same-thread rollout from the listing: it stays on
   * disk as a lineage base (or dead branch) but is no longer a session of its
   * own. Its indexed rows are dropped — the surviving head re-indexes the
   * shared prefix under its own key.
   */
  private demoteCodexFile(entry: FileEntry, live: boolean): void {
    entry.superseded = true
    this.book.files.delete(entry.path)
    this.codex.forget(entry)
    const key = sessionKey(entry.kind, entry.sessionId)
    // The replacement registers moments later; by then the session no longer
    // points at this entry, so the reset must be remembered here.
    if (live) this.codexResets.add(key)
    const session = this.book.sessions.get(key)
    if (session !== undefined) {
      if (session.main === entry) session.main = null
      for (const [childId, child] of session.children) {
        if (child === entry) session.children.delete(childId)
      }
      if (session.main === null && session.children.size === 0) {
        this.book.sessions.delete(key)
      } else {
        this.book.emitTo(session, {
          type: 'meta',
          summary: this.book.summarize(session),
          children: this.book.childSummaries(session),
        })
      }
    }
    this.search?.reset(entry.path)
    this.emit('change', entry.kind, entry.sessionId)
  }

  /**
   * Re-point an entry at the other representation of its rollout — Codex
   * materializes a `.jsonl.zst` back to `.jsonl` before appending
   * (rollout/src/compression.rs). Decoded offsets carry over unchanged, but
   * the stream is re-read so search/meta stay consistent under the new path
   * key and any appended bytes are picked up.
   */
  private async migrateCodexRepresentation(
    entry: FileEntry,
    path: string,
    info: { size: number; mtimeMs: number },
    compressed: boolean,
    initial: boolean,
  ): Promise<FileEntry> {
    this.book.files.delete(entry.path)
    this.search?.reset(entry.path)
    entry.path = path
    entry.ref = { ...entry.ref, path }
    entry.compressed = compressed ? true : undefined
    entry.physicalSize = info.size
    this.book.files.set(path, entry)
    this.resetCodexStream(entry)
    const session = this.book.sessions.get(sessionKey(entry.kind, entry.sessionId))
    if (session !== undefined) this.book.emitTo(session, { type: 'file', file: entry.ref, reset: true })
    await this.consume(entry, info.size, info.mtimeMs, initial)
    this.saveListing(entry)
    return entry
  }

  /**
   * Re-point an entry at a newer dsh generation (a resumed session migrated
   * its log to `session.vN.jsonl[.zstd]`). Unlike a Codex representation swap
   * the successor is NOT the same byte stream — it opens with a transformed
   * inherited prefix — so the whole stream is reset and re-read, and the old
   * generation's search rows are dropped. The swap itself is deferred to the
   * consume lock (`dshPending`) so an in-flight read never sees the path move
   * under its cursor.
   */
  private async migrateDshGeneration(
    entry: FileEntry,
    resolved: DshLogFile,
    initial: boolean,
  ): Promise<FileEntry> {
    entry.dshPending = resolved
    await this.consume(entry, resolved.size, resolved.mtimeMs, initial)
    this.saveListing(entry)
    return entry
  }

  /**
   * A rollout a head was waiting for is now on disk: re-resolve its base
   * chain and re-read the stream so the new slices land ahead of the head's
   * own records.
   */
  private async noteCodexBaseAvailable(rolloutId: string): Promise<void> {
    for (const entry of this.codex.baseAvailable(rolloutId)) {
      // Serialized by the consume lock: a waiter mid-consume folds this into
      // `consumePending` and re-resolves when the in-flight read drains.
      await this.consume(entry, entry.physicalSize, entry.mtimeMs)
      this.saveListing(entry)
    }
  }

  /** Rewind a Codex entry's stream state so `consume` replays it with its current bases. */
  private resetCodexStream(entry: FileEntry): void {
    entry.offset = 0
    entry.rest = ''
    entry.lines = 0
    entry.baseBytes = 0
    entry.baseLines = 0
    entry.baseFootprint = undefined
    entry.basesConsumed = false
    entry.searchFrom = 0
    this.search?.reset(entry.path)
    if (entry.meta !== null) entry.meta = createMetaScanner(entry.kind, null)
    const session = this.book.sessions.get(sessionKey(entry.kind, entry.sessionId))
    if (session !== undefined) this.book.emitTo(session, { type: 'file', file: entry.ref, reset: true })
  }

  /**
   * Re-probe a grok file that registered as a main session although it may be a
   * child: grok creates the child's directory and starts appending to its
   * `updates.jsonl` before it writes the child's `summary.json` and the
   * parent's `subagents/<id>/meta.json`, so the probe in `register` can run too
   * early and would otherwise leave the run as a top-level session forever.
   * The grok counterpart of Claude's `refreshAgentMeta`: a no-op once the file
   * has settled, either as a genuine main or under its parent.
   */
  private async refreshGrokBinding(root: HarnessRoot, entry: FileEntry): Promise<void> {
    if (entry.kind !== 'grok' || entry.grokUnresolved !== true || entry.ref.role !== 'main') return
    const probe = await this.grok.probe(root.dir, entry.path, entry.ref.id)
    if (probe.parentId !== undefined && probe.agent !== undefined) {
      this.rehomeGrokChild(entry, probe.parentId, probe.agent)
      return
    }
    // A readable summary that claims no subagent kind settles the question.
    if (probe.summary !== null && !probe.child) entry.grokUnresolved = false
  }

  /**
   * Move a grok file that was listed as its own session under the parent that
   * has now claimed it: the session record, the file's ref and its membership
   * all move together, and the parent's subscribers learn about the new child
   * the same way they would about one that appeared while they watched.
   */
  private rehomeGrokChild(entry: FileEntry, parentId: string, agent: AgentFileMeta): void {
    if (entry.ref.role !== 'main' || entry.sessionId === parentId) return
    const previousKey = sessionKey(entry.kind, entry.sessionId)
    const previous = this.book.sessions.get(previousKey)
    if (previous !== undefined) {
      if (previous.main === entry) previous.main = null
      if (previous.main === null && previous.children.size === 0) this.book.sessions.delete(previousKey)
    }
    entry.ref = { ...entry.ref, role: 'child', parentId, agent }
    entry.sessionId = parentId
    // Listing metadata belongs to main files only; the child is served through
    // its parent (and standalone from its lines) from here on.
    entry.meta = null
    entry.grokUnresolved = false
    // Its lines were indexed under its own id; move them to the parent so a hit
    // opens the parent session with this transcript selected.
    this.search?.rebind(searchKeyOf(entry))
    const parent = this.book.sessionFor(entry.kind, parentId)
    parent.children.set(entry.ref.id, entry)
    this.book.emitTo(parent, { type: 'file', file: entry.ref })
    this.book.emitTo(parent, { type: 'meta', summary: this.book.summarize(parent), children: this.book.childSummaries(parent) })
    this.emit('change', entry.kind, parentId)
  }

  /**
   * Move a dsh file that registered as a main session under the parent its
   * header now names: registration probed the first line before the writer's
   * first frame completed, so `origin:"subagent"` was unreadable. Mirror of
   * `rehomeGrokChild` except the child keeps its scanner — a JSONL-only
   * child's own title/model still flow through `mergeChildAgent`.
   */
  private rehomeDshChild(entry: FileEntry, parentId: string): void {
    if (entry.ref.role !== 'main' || entry.sessionId === parentId) return
    const previousKey = sessionKey(entry.kind, entry.sessionId)
    const previous = this.book.sessions.get(previousKey)
    if (previous !== undefined) {
      if (previous.main === entry) previous.main = null
      if (previous.main === null && previous.children.size === 0) this.book.sessions.delete(previousKey)
    }
    entry.ref = { ...entry.ref, role: 'child', parentId }
    entry.sessionId = parentId
    this.search?.rebind(searchKeyOf(entry))
    const parent = this.book.sessionFor(entry.kind, parentId)
    parent.children.set(entry.ref.id, entry)
    this.book.emitTo(parent, { type: 'file', file: entry.ref })
    this.book.emitTo(parent, { type: 'meta', summary: this.book.summarize(parent), children: this.book.childSummaries(parent) })
    this.emit('change', entry.kind, parentId)
  }

  /** Re-read a child's sidecar facts when they were missing at registration (written a moment later). */
  private async refreshAgentMeta(session: SessionRecord, entry: FileEntry): Promise<void> {
    if (entry.kind !== 'claude' || entry.ref.role !== 'child' || entry.ref.agent?.toolUseId !== undefined) return
    const agent = await readAgentMeta(entry.path)
    if (agent?.toolUseId === undefined) return
    entry.ref = { ...entry.ref, agent }
    this.book.emitTo(session, { type: 'file', file: entry.ref })
  }

  /**
   * Kimi keeps the session's own (generated or user-set) title in `state.json`
   * beside `agents/`, rewritten as the session runs — re-read it on every
   * refresh and surface it the way Claude's `ai-title` record is surfaced.
   */
  private async syncKimiTitle(entry: FileEntry): Promise<void> {
    if (entry.kind !== 'kimi' || entry.ref.role !== 'main' || entry.meta === null) return
    const title = await readKimiTitle(entry.path)
    if (title === undefined || title === entry.meta.state.aiTitle) return
    entry.meta.state.aiTitle = title
    this.emit('change', entry.kind, entry.sessionId)
  }

  /**
   * Grok keeps the session's title, cwd, model, system prompt and tool schemas
   * beside `updates.jsonl` and rewrites `summary.json` as the session runs
   * (GROK-FORMAT §B.1). Re-read the title the way Claude's `ai-title` record is
   * surfaced, and — whenever the facts actually changed — re-send the sidecar
   * line (GROK-DESIGN §3) as a one-line append, so an open view refolds them
   * without a reconnect. The initial pass only records the baseline: the replay
   * in `readAll` already carries a sidecar of its own.
   *
   * Three gates, cheapest first, because grok patches `num_messages` and
   * `updated_at` into `summary.json` on essentially every appended line, so
   * "changed" is the steady state of a live session:
   *   1. the mtime, which costs one `stat`;
   *   2. `session_summary`, which gates the title sync;
   *   3. the facts the sidecar carries (`grokSidecarKey`), which gate the
   *      ~60 KB line — and which are only assembled at all when somebody is
   *      subscribed to the session.
   */
  private async syncGrokSummary(entry: FileEntry, initial = false): Promise<void> {
    if (entry.kind !== 'grok') return
    const dir = dirname(entry.path)
    let mtimeMs: number
    try {
      mtimeMs = (await stat(join(dir, 'summary.json'))).mtimeMs
    } catch {
      // Written last (GROK-DESIGN §1): a session without it yet keeps its facts null.
      return
    }
    if (entry.summaryMtimeMs === mtimeMs) return
    entry.summaryMtimeMs = mtimeMs
    // `register` already fed this very object to the meta scanner.
    if (initial) return
    const key = sessionKey(entry.kind, entry.sessionId)
    const session = this.book.sessions.get(key)
    if (session === undefined) return
    const summary = await readJsonRecord(join(dir, 'summary.json'))
    const title = grokSummaryTitle(summary)
    const titleChanged = title !== entry.summaryTitle
    entry.summaryTitle = title
    if (titleChanged && title !== null && entry.meta !== null) entry.meta.state.aiTitle = title
    if (titleChanged) this.emit('change', entry.kind, entry.sessionId)
    if (!this.book.hasSubscribers(entry.kind, entry.sessionId)) return
    const sidecar = await buildGrokSidecar(dir, entry.ref.id, summary)
    if (sidecar !== undefined && sidecar.key !== entry.sidecarKey) {
      entry.sidecarKey = sidecar.key
      // Synthetic: it belongs to no line of `updates.jsonl` (see `startLine`).
      this.book.emitTo(session, { type: 'lines', file: entry.ref, lines: [sidecar.line], startLine: -1 })
    } else if (!titleChanged) {
      return
    }
    this.book.emitTo(session, { type: 'meta', summary: this.book.summarize(session), children: this.book.childSummaries(session) })
  }

  /**
   * Resume a startup-sweep file from the listing cache. `full`: the transcript
   * is byte-identical to the snapshot — not read at all. `tail`: it only grew —
   * the appended bytes are read through the restored scanner, exactly like the
   * live tail. `none`: anything else, and the file is scanned from byte 0.
   */
  private async restoreListing(
    entry: FileEntry,
    info: { size: number; mtimeMs: number },
    sidecarMtimeMs: number | null,
  ): Promise<'none' | 'full' | 'tail'> {
    const cache = this.listing
    if (cache === undefined) return 'none'
    const row = cache.load(entry.path)
    if (row === undefined || row.scannerVersion !== META_SCANNER_VERSION) return 'none'
    if (row.sidecarMtimeMs !== sidecarMtimeMs) return 'none'
    // Codex rows carry a footprint: the head's physical size plus each lineage
    // base's resolved stat. Any change to a base — or a base resolved now that
    // was missing at save time — invalidates the snapshot.
    if (entry.kind === 'codex' && !(await codexFootprintMatches(entry, row.footprint))) {
      // The LOGICAL stream changed although the head's own stat did not:
      // `beginFile` already answered from the head's size/mtime, so the stored
      // rows are indexed under the old base-less line numbering. Drop them and
      // re-queue every replayed line.
      this.search?.reset(entry.path)
      entry.searchFrom = 0
      return 'none'
    }
    // `unchanged` also requires the snapshot to have been fully consumed: a row
    // that stopped mid-file must not skip the bytes past `consumedBytes`. For
    // a compressed head `consumedBytes` is a decoded offset, so the comparison
    // target is the saved decoded length, not the physical size.
    const decodedSize = entry.compressed === true ? parseCodexFootprint(row.footprint)?.d ?? row.size : row.size
    const unchanged =
      row.consumedBytes === decodedSize && info.size === row.size && info.mtimeMs === row.mtimeMs
    // `appended` covers both a grown transcript and a partially consumed one:
    // resuming at `consumedBytes` reads the remainder through `rest`. A
    // compressed head never appends — a different physical size is a rewrite.
    const appended =
      entry.compressed !== true &&
      info.size >= row.size && info.size > row.consumedBytes && info.mtimeMs >= row.mtimeMs
    if (!unchanged && !appended) return 'none'
    // A scanner exists now but none ran back then: it cannot own state for
    // bytes it was never fed. The inverse is fine — a file that gained a
    // sidecar since simply drops the serialized state.
    if (row.state === null && entry.meta !== null) return 'none'
    // The search index must already cover the persisted lines, or the gap
    // below `searchFrom` would never reach it again.
    if (!entry.searchSkipped && this.search !== undefined && entry.searchFrom < row.lines) return 'none'
    if (row.state !== null && entry.meta !== null && !hydrateMeta(entry.meta, row.state)) return 'none'
    entry.offset = row.consumedBytes
    entry.rest = row.rest
    entry.lines = row.lines
    entry.size = decodedSize
    if (entry.compressed === true) entry.decodedSize = decodedSize
    if (entry.bases !== undefined && entry.bases.length > 0) {
      entry.basesConsumed = true
      const saved = parseCodexFootprint(row.footprint)
      entry.baseBytes = saved?.bb ?? 0
      entry.baseLines = saved?.bl ?? 0
      entry.baseFootprint = saved?.b
    }
    return unchanged ? 'full' : 'tail'
  }

  /** Grok: `summary.json`'s mtime — the one scanner input outside the transcript. */
  private async sidecarMtime(entry: FileEntry): Promise<number | null> {
    if (entry.kind !== 'grok') return null
    try {
      return (await stat(join(dirname(entry.path), 'summary.json'))).mtimeMs
    } catch {
      return null
    }
  }

  /** Persist the consume cursor and scanner state at a settle point. */
  private saveListing(entry: FileEntry): void {
    // `size`/`mtimeMs` are the head representation's physical stat — for a
    // `.zst` head the decoded cursor lives in `consumedBytes`/`footprint.d`.
    const footprint = entry.kind === 'codex' ? serializeCodexFootprint(entry) : null
    this.listing?.save(entry.path, {
      size: entry.physicalSize,
      mtimeMs: entry.mtimeMs,
      consumedBytes: entry.offset,
      rest: entry.rest,
      lines: entry.lines,
      scannerVersion: META_SCANNER_VERSION,
      sidecarMtimeMs: entry.kind === 'grok' ? entry.summaryMtimeMs ?? null : null,
      state: serializeMeta(entry.meta),
      footprint,
    })
  }

  /**
   * First pass over a file, in bounded slices. `consume` allocates one buffer
   * per call, so a multi-hundred-megabyte rollout is walked rather than loaded.
   */
  private async consumeInitial(entry: FileEntry, size: number, mtimeMs: number, initial: boolean): Promise<void> {
    // A compressed head is decompressed whole in one pass; `size` is its
    // physical (compressed) size and says nothing about the decoded stream.
    if (entry.compressed === true) {
      await this.consume(entry, size, mtimeMs, initial)
      return
    }
    let end = Math.min(INITIAL_CHUNK_BYTES, size)
    for (;;) {
      if (this.stopped) return
      const before = entry.offset
      await this.consume(entry, end, mtimeMs, initial)
      // `offset` can land past `end` when a folded-in watch event was drained
      // with the file's real size; never let `end` fall behind it, or the
      // next slice would look like a truncation.
      if (entry.offset >= size) return
      // A dsh `.zstd` cursor only advances to complete frame boundaries: a
      // torn tail (a flush in flight or a crash) consumes nothing, and no
      // larger window changes that — the next append is what completes it.
      if (end >= size && entry.offset === before) return
      end = Math.min(Math.max(end, entry.offset) + INITIAL_CHUNK_BYTES, size)
      await yieldTurn()
    }
  }

  /**
   * Serialize the consumes of one file. A watch event (or the poll) that
   * lands while an earlier consume is still reading would re-read the same
   * bytes and feed the lines to the meta scanner and the search index twice;
   * instead it folds its stat into `consumePending` and the lock holder
   * drains it before releasing.
   */
  private async consume(entry: FileEntry, size: number, mtimeMs: number, initial = false): Promise<void> {
    if (entry.consuming) {
      const pending = entry.consumePending
      entry.consumePending = {
        size: Math.max(size, pending?.size ?? 0),
        mtimeMs: Math.max(mtimeMs, pending?.mtimeMs ?? 0),
      }
      return
    }
    entry.consuming = true
    try {
      let current = { size, mtimeMs }
      for (;;) {
        entry.consumePending = undefined
        await this.consumeInner(entry, current.size, current.mtimeMs, initial)
        const pending = entry.consumePending
        if (pending === undefined || this.stopped) return
        current = pending
      }
    } finally {
      entry.consuming = false
    }
  }

  /**
   * Consume appended bytes: update metadata and forward new lines to
   * subscribers. `size` is the PHYSICAL size of the head's on-disk
   * representation; a compressed head's cursor and `entry.size` live in
   * decoded bytes instead.
   */
  private async consumeInner(entry: FileEntry, size: number, mtimeMs: number, initial = false): Promise<void> {
    const session = this.book.sessions.get(sessionKey(entry.kind, entry.sessionId))
    // A newer dsh generation resolved while a consume may have been in flight:
    // re-point the entry inside the lock, before the size/offset comparisons
    // below would read the new file's stat against the old stream's cursor.
    const pendingGeneration = entry.dshPending
    if (pendingGeneration !== undefined) {
      entry.dshPending = undefined
      this.book.files.delete(entry.path)
      this.search?.reset(entry.path)
      entry.path = pendingGeneration.path
      entry.ref = { ...entry.ref, path: pendingGeneration.path }
      entry.offset = 0
      entry.rest = ''
      entry.lines = 0
      entry.searchFrom = 0
      if (entry.meta !== null) entry.meta = createMetaScanner('dsh', null)
      this.book.files.set(pendingGeneration.path, entry)
      this.dsh.note(pendingGeneration.path, entry)
      if (session !== undefined) this.book.emitTo(session, { type: 'file', file: entry.ref, reset: true })
    }
    // A lineage base registered after this head consumed: re-resolve the chain
    // under the consume lock and replay the whole stream.
    if (entry.basesStale === true) {
      entry.basesStale = false
      this.resetCodexStream(entry)
      const lineage = await this.codex.resolveBases(entry.historyBase)
      entry.bases = lineage.bases
      this.codex.setWaiting(entry, lineage.missing)
    }
    if (entry.compressed !== true && size < entry.offset) {
      // Truncated or rewritten: start over and tell subscribers to reset the file.
      entry.offset = 0
      entry.rest = ''
      entry.lines = 0
      entry.searchFrom = 0
      this.search?.reset(entry.path)
      // Recreate the listing scanner only if this file already had one. A
      // sidecar-less child is later stamped onto `ref.agent`; consulting that
      // after the first consume would skip the rescan.
      const hadListing = entry.meta !== null
      entry.meta = hadListing
        // Grok's listing facts come from `summary.json`, not from the lines.
        ? createMetaScanner(entry.kind, entry.kind === 'grok'
          ? await readJsonRecord(join(dirname(entry.path), 'summary.json'))
          : null)
        : null
      if (session !== undefined) this.book.emitTo(session, { type: 'file', file: entry.ref, reset: true })
    }
    // A compressed rollout is immutable in practice: any stat change means the
    // archive was rewritten, so the decoded stream is re-read whole.
    if (
      entry.compressed === true && entry.decodedSize !== undefined
      && (size !== entry.physicalSize || mtimeMs !== entry.mtimeMs)
    ) {
      this.resetCodexStream(entry)
    }
    entry.physicalSize = size
    entry.mtimeMs = Math.max(entry.mtimeMs, mtimeMs)

    // Codex lineage: the head's effective stream is its resolved bases'
    // decoded prefixes (immutable, read once) followed by its own records.
    if (entry.basesConsumed !== true && entry.bases !== undefined && entry.bases.length > 0) {
      entry.basesConsumed = true
      entry.baseFootprint = []
      for (const base of entry.bases) {
        const file = await resolveTranscriptFile(base.path)
        entry.baseFootprint.push({ p: file?.path ?? base.path, s: file?.size ?? -1, m: file?.mtimeMs ?? -1 })
        const slice = await readDecodedPrefix(base.path, base.endByteOffset ?? undefined)
        entry.baseBytes += slice.offset
        entry.baseLines += slice.lines.length
        await this.feedLines(entry, session, slice.lines, initial)
      }
    }

    if (entry.compressed === true) {
      // Immutable: decoded size is learned on the first read; afterwards only
      // a physical change (a rewritten archive) matters — the watcher's stat
      // comparison gates that before we get here.
      if (entry.offset === entry.decodedSize && entry.decodedSize !== undefined) return
      const result = await readLines(entry.path, entry.offset, entry.rest)
      entry.offset = result.offset
      entry.rest = result.rest
      entry.decodedSize = result.offset
      entry.size = result.offset
      await this.feedLines(entry, session, result.lines, initial)
      return
    }

    entry.size = size
    if (size === entry.offset) return
    const result = await readLines(entry.path, entry.offset, entry.rest, size)
    entry.offset = result.offset
    entry.rest = result.rest
    await this.feedLines(entry, session, result.lines, initial)
  }

  /**
   * Feed one batch of freshly consumed lines to the meta scanner, the search
   * index and the session's subscribers. `startLine` counts across the whole
   * logical stream — lineage bases first — so a search hit's `line` matches
   * the index `readAll` replays.
   */
  private async feedLines(
    entry: FileEntry,
    session: SessionRecord | undefined,
    lines: readonly string[],
    initial: boolean,
  ): Promise<void> {
    // `index` advances `entry.lines`, so the first appended line's index is the
    // count as it stands here — the same one the search index gives the record.
    const startLine = entry.lines
    // A dsh file registered while its first frame was still torn settles its
    // role on the first consumed line: `origin:"subagent"` re-homes it under
    // `parentSession`, anything else confirms it as a main file.
    let target = session
    if (entry.dshUnprobed === true && entry.lines === 0 && lines.length > 0) {
      entry.dshUnprobed = undefined
      const record = parseDshLine(lines[0] ?? '')
      if (record?.tag === 'header' && record.header.origin === 'subagent'
        && record.header.parentSession !== undefined) {
        this.rehomeDshChild(entry, record.header.parentSession)
        target = this.book.sessions.get(sessionKey(entry.kind, entry.sessionId))
      }
    }
    if (entry.meta !== null) {
      for (const line of lines) {
        // A child's inherited records (below `historyStartOrdinal`, possibly
        // replayed from lineage bases before the head's own `session_meta`
        // arrives) are the parent's history — they must not steer the child's
        // title or prompt tally. The scanner re-learns the boundary in-band
        // for files registered without a head probe.
        if (isOwnCodexRecord(entry, line)) {
          entry.meta.push(line)
        }
      }
    }
    this.index(entry, lines)
    if (lines.length === 0 || target === undefined) return
    this.applyChildListing(target)
    if (!initial) {
      this.book.emitTo(target, { type: 'lines', file: entry.ref, lines: [...lines], startLine })
      this.book.emitTo(target, { type: 'meta', summary: this.book.summarize(target), children: this.book.childSummaries(target) })
    }
    this.emit('change', entry.kind, entry.sessionId)
  }

  /**
   * Hand freshly consumed lines to the search index. Lines below `searchFrom`
   * were stored by an earlier run of the server and are only replayed here for
   * the meta scanner's benefit.
   */
  private index(entry: FileEntry, lines: readonly string[]): void {
    const search = this.search
    if (search === undefined || entry.searchSkipped) {
      entry.lines += lines.length
      return
    }
    const key = searchKeyOf(entry)
    for (const line of lines) {
      // Stream line numbers address search hits; durable ordinals determine
      // ownership even when a base is missing or ordinal ranges have gaps.
      const own = isOwnCodexRecord(entry, line)
      if (own && entry.lines >= entry.searchFrom) search.queue(key, entry.lines, line)
      entry.lines += 1
    }
    // `size` is what `beginFile` compares against the next start's stat: the
    // physical representation's size, not a compressed head's decoded length.
    search.noteProgress(key, {
      size: entry.physicalSize,
      mtimeMs: entry.mtimeMs,
      indexedBytes: entry.offset,
      indexedLines: entry.lines,
    })
  }

  /** Listing facts for one session, for search result grouping. */
  facts(kind: HarnessKind, id: string): { title: string; cwd?: string; updatedAt?: number } | undefined {
    return this.book.facts(kind, id)
  }

  /**
   * Stamp each child `ref.agent` from listing facts: the parent scanner's
   * spawn map, else the child's own title/type/model, else an existing sidecar.
   * Sidecar harnesses no-op (parent map empty, child unscanned, sidecar already
   * on the ref). A harness that only names children in JSONL fills the gaps.
   * Only the main wire's spawn map is consulted: a nested spawn's facts sit in
   * the intermediate child's own map, so a grandchild falls back to its own
   * transcript title.
   */
  private applyChildListing(session: SessionRecord): void {
    if (session.children.size === 0) return
    const fromParent = session.main?.meta?.state.agents
    for (const [id, child] of session.children) {
      const next = mergeChildAgent(id, fromParent?.get(id), child.meta?.state, child.ref.agent)
      if (next === undefined || agentMetaEqual(child.ref.agent, next)) continue
      child.ref = { ...child.ref, agent: next }
      this.book.emitTo(session, { type: 'file', file: child.ref })
    }
  }

  // -- watching ------------------------------------------------------------

  private watchRoot(root: HarnessRoot): void {
    // A harness that never ran has no session root: nothing to scan, nothing
    // to watch, and nothing to report (same contract as `walk`).
    if (!existsSync(root.dir)) return
    try {
      const watcher = watch(root.dir, { recursive: true, persistent: true }, (_event, filename) => {
        if (filename === null || filename === undefined) return
        const name = filename.toString()
        if (!name.endsWith('.jsonl')
          && !(root.kind === 'codex' && name.endsWith('.jsonl.zst'))
          && !(root.kind === 'dsh' && name.endsWith('.jsonl.zstd'))) return
        this.schedule(root, join(root.dir, name))
      })
      watcher.on('error', (error) => {
        // The root can still vanish between the check and the watch.
        if (!isEnoent(error)) this.emit('error', error)
      })
      watcher.unref()
      this.watchers.push(watcher)
    } catch (error) {
      if (!isEnoent(error)) this.emit('error', error)
    }
  }

  private schedule(root: HarnessRoot, path: string): void {
    const existing = this.pending.get(path)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.pending.delete(path)
      void this.refresh(root, path)
    }, WATCH_DEBOUNCE_MS)
    timer.unref()
    this.pending.set(path, timer)
  }

  private async refresh(root: HarnessRoot, path: string): Promise<void> {
    // A watch event can name either representation; the entry lives under the
    // resolved one (the plain `.jsonl` while it exists).
    if (root.kind === 'codex') {
      const file = await resolveTranscriptFile(path)
      if (file === null) return
      const entry = this.book.files.get(file.path)
      if (entry === undefined) {
        await this.register(root, path)
        return
      }
      try {
        await this.consume(entry, file.size, file.mtimeMs)
        this.saveListing(entry)
      } catch {
        // Deleted or momentarily unreadable; keep the last known state.
      }
      return
    }
    // A watch event can name ANY generation file of the session directory;
    // the entry lives under — and reads — only the current (highest) one.
    if (root.kind === 'dsh') {
      const resolved = await this.dsh.resolve(path)
      if (resolved === null) return
      const entry = this.dsh.entry(path)
      if (entry === undefined) {
        await this.register(root, path)
        return
      }
      try {
        if (entry.path !== resolved.path) {
          await this.migrateDshGeneration(entry, resolved, false)
        } else {
          await this.consume(entry, resolved.size, resolved.mtimeMs)
        }
        this.saveListing(entry)
      } catch {
        // Deleted or momentarily unreadable; keep the last known state.
      }
      return
    }
    const entry = this.book.files.get(path)
    if (entry === undefined) {
      await this.register(root, path)
      return
    }
    try {
      const info = await stat(path)
      await this.consume(entry, info.size, info.mtimeMs)
      await this.syncKimiTitle(entry)
      await this.syncGrokSummary(entry)
      await this.refreshGrokBinding(root, entry)
      this.saveListing(entry)
    } catch {
      // Deleted or momentarily unreadable; keep the last known state.
    }
  }

  /** Fallback for watchers that miss events: poll files of sessions someone is viewing. */
  private async pollSubscribed(): Promise<void> {
    for (const key of this.book.subscribedKeys()) {
      const session = this.book.sessions.get(key)
      if (session === undefined) continue
      for (const entry of [session.main, ...session.children.values()]) {
        if (entry === null) continue
        try {
          // Dsh resolves the current generation: a resumed session's
          // `session.vN` publish re-points the entry when the watcher missed it.
          if (entry.kind === 'dsh') {
            const resolved = await this.dsh.resolve(entry.path)
            if (resolved !== null && resolved.path !== entry.path) {
              await this.migrateDshGeneration(entry, resolved, false)
            } else if (resolved !== null && resolved.size !== entry.physicalSize) {
              await this.consume(entry, resolved.size, resolved.mtimeMs)
            }
          } else {
            // Codex: the poll sees the physical representation's size; the entry
            // may point at a `.zst` whose decoded size is tracked separately, or
            // a materialized `.jsonl` the watcher has not delivered yet.
            const file = entry.kind === 'codex'
              ? await resolveTranscriptFile(entry.path)
              : await stat(entry.path).then(info => info.isFile()
                ? { path: entry.path, compressed: false, size: info.size, mtimeMs: info.mtimeMs }
                : null)
            if (file === null) continue
            if (file.path !== entry.path && entry.kind === 'codex') {
              await this.migrateCodexRepresentation(entry, file.path, file, file.compressed, false)
            } else if (file.size !== entry.physicalSize || (entry.compressed === true && file.mtimeMs !== entry.mtimeMs)) {
              await this.consume(entry, file.size, file.mtimeMs)
            }
          }
          await this.refreshAgentMeta(session, entry)
          await this.syncKimiTitle(entry)
          await this.syncGrokSummary(entry)
          const entryRoot = entry.grokUnresolved === true ? this.rootFor(entry.path) : undefined
          if (entryRoot !== undefined) await this.refreshGrokBinding(entryRoot, entry)
          this.saveListing(entry)
        } catch {
          // Ignore transient errors.
        }
      }
      // Newly created child transcripts inside a session directory (subagents).
      const main = session.main
      const root = main === null ? undefined : this.rootFor(main.path)
      if (main === null || root === undefined) continue
      if (session.kind === 'grok') {
        await this.pollGrokChildren(root, main)
        continue
      }
      const childDir = liveChildDir(session.kind, session.id, main.path)
      if (childDir !== undefined) {
        for (const path of await walk(childDir)) {
          if (!this.book.files.has(path)) await this.register(root, path)
        }
      }
    }
  }

  /**
   * Pick up subagent transcripts of a live grok session. `liveChildDir` names
   * the only place a child is announced — `<session>/subagents/<childId>/`,
   * which holds `meta.json`, not a transcript (GROK-FORMAT §D.3). Each meta
   * names the child's own cwd, which resolves to a **top-level**
   * `<encoded-cwd>/<childId>/updates.jsonl`; when it is absent (or the cwd is
   * long enough that grok hashed the directory name), the parent's own group
   * is the fallback (GROK-FORMAT §D.2, §A.3).
   */
  private async pollGrokChildren(root: HarnessRoot, main: FileEntry): Promise<void> {
    const metaDir = liveChildDir('grok', main.ref.id, main.path)
    if (metaDir === undefined) return
    for (const binding of await readGrokSubagentMetas(metaDir)) {
      this.grok.note(binding)
      for (const candidate of grokChildPaths(root.dir, main.path, binding)) {
        const existing = this.book.files.get(candidate)
        if (existing !== undefined) {
          // Registered before this meta.json existed, so it landed as a session
          // of its own: the parent has claimed it now.
          if (existing.grokUnresolved === true) this.rehomeGrokChild(existing, binding.parentId, binding.agent)
          break
        }
        if (await this.register(root, candidate) !== undefined) break
      }
    }
  }

  private rootFor(path: string): HarnessRoot | undefined {
    for (const root of this.roots) {
      if (path.startsWith(root.dir + sep)) return root
    }
    return undefined
  }
}

/**
 * Directory a live session's subagent transcripts appear in, so they can be
 * picked up while someone is watching. Codex writes children as top-level
 * rollouts, which the root walk already covers.
 */
export function liveChildDir(kind: HarnessKind, sessionId: string, mainPath: string): string | undefined {
  switch (kind) {
    case 'claude':
      return claudeChildDir(sessionId, mainPath)
    case 'kimi':
      return kimiChildDir(mainPath)
    case 'grok':
      return grokChildDir(mainPath)
    default:
      return undefined
  }
}

// Per-harness filesystem knowledge lives in `harness/`; these re-exports keep
// the historical `index.ts` import surface intact.
export { readAgentMeta } from './harness/claude.ts'
export { readKimiTitle } from './harness/kimi.ts'
export {
  encodeGrokCwd, grokChildPaths, grokSummaryTitle, readGrokSidecar, readGrokSubagentMetas,
  type GrokChildBinding, type GrokSidecarLine,
} from './harness/grok.ts'

/** Missing-path fs errors: the harness simply has no root on this machine. */
function isEnoent(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT'
}

/** Recursively list transcript files under a directory; missing directories yield nothing. */
export async function walk(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const paths: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'memory' || entry.name.startsWith('.')) continue
      paths.push(...await walk(path))
    } else if (entry.isFile() && (entry.name.endsWith('.jsonl')
      || entry.name.endsWith('.jsonl.zst') || entry.name.endsWith('.jsonl.zstd'))) {
      paths.push(path)
    }
  }
  return paths
}
