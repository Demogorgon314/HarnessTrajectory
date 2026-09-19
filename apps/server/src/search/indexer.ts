/**
 * Write side of the search index: a batching queue between `SessionIndex` and
 * SQLite.
 *
 * `SessionIndex.consume` hands every JSONL line it reads to {@link
 * SearchIndexer.queue} as it already has it in memory — the index never opens a
 * transcript of its own, so a 147 MB rollout is still read exactly once, in the
 * same byte-range chunks. Extraction runs inline (it is a JSON parse the
 * process would do anyway) but writing does not: documents pile up in a batch
 * that is committed in one transaction, either 250 ms after the last line or as
 * soon as it grows past a few thousand documents, so appends never wait for a
 * disk write.
 *
 * Restart behaviour: {@link SearchIndexer.beginFile} is asked about a file
 * before its bytes are replayed and answers with the first line index that
 * still needs indexing. The meta scanner keeps re-reading from byte 0 (its
 * state lives only in memory), but already-indexed lines are not re-extracted
 * and not re-inserted.
 */

import { SETTINGS_DEFAULTS, type HarnessKind, type SearchIndexing } from '@harness-trajectory/core'
import { extractSearchDocs, type SearchDocDraft } from './extract.ts'
import type { SearchDoc, SearchFileKey, SearchStore } from './store.ts'

const FLUSH_DELAY_MS = 250
const MAX_BATCH_DOCS = 8_000
const DAY_MS = 86_400_000

/** Progress of one file, written with the documents it produced. */
interface FileProgress {
  size: number
  mtimeMs: number
  indexedBytes: number
  indexedLines: number
}

interface PendingDoc extends SearchDoc {
  path: string
}

export interface SearchIndexerOptions {
  store: SearchStore
  /** Debounce before a batch is committed. */
  flushDelayMs?: number
  /** Commit immediately once the batch holds this many documents. */
  maxBatchDocs?: number
  /** Retention window in days; older transcripts stay out of the index. 0 = all. */
  maxAgeDays?: number
  /** Clock for the retention cutoff; injectable for tests. */
  now?: () => number
  /** Extractor override, for tests that count calls. */
  extract?: (kind: HarnessKind, line: string) => readonly SearchDocDraft[]
}

export class SearchIndexer {
  private readonly store: SearchStore
  private readonly flushDelayMs: number
  private readonly maxBatchDocs: number
  private readonly extract: (kind: HarnessKind, line: string) => readonly SearchDocDraft[]
  private readonly now: () => number
  private maxAgeDays: number
  private readonly batch: PendingDoc[] = []
  /** Latest known identity per path; a rebind updates it before the flush uses it. */
  private readonly keys = new Map<string, SearchFileKey>()
  private readonly progress = new Map<string, FileProgress>()
  /** Files whose existing documents must be dropped before this batch lands. */
  private readonly resets = new Set<string>()
  /** Files to remove ENTIRELY — documents and the `files` watermark row. */
  private readonly drops = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private backfilling = true
  private backfillDone = 0
  private backfillTotal = 0

  constructor(options: SearchIndexerOptions) {
    this.store = options.store
    this.flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS
    this.maxBatchDocs = options.maxBatchDocs ?? MAX_BATCH_DOCS
    this.maxAgeDays = options.maxAgeDays ?? SETTINGS_DEFAULTS.searchMaxAgeDays
    this.now = options.now ?? Date.now
    this.extract = options.extract ?? extractSearchDocs
  }

  /**
   * Whether a transcript belongs in the index under the current retention
   * window. The decision is made once per registration; a file that grows new
   * lines afterwards keeps it until the next start reconsiders the file under
   * its then-current mtime.
   */
  shouldIndex(file: { mtimeMs: number }): boolean {
    if (this.maxAgeDays === 0) return true
    return file.mtimeMs >= this.now() - this.maxAgeDays * DAY_MS
  }

  /**
   * Change the retention window and purge what now falls outside it.
   * Narrowing applies immediately; widening only affects files registered
   * from now on — everything already indexed stays, and skipped files
   * re-enter on the next start's sweep. Returns the files dropped.
   */
  applyMaxAgeDays(days: number): number {
    this.maxAgeDays = days
    if (days === 0) return 0
    const stale = this.store.pathsOlderThan(this.now() - days * DAY_MS)
    if (stale.length === 0) return 0
    try {
      this.store.transaction(() => {
        for (const path of stale) this.store.deleteFile(path)
      })
      // Reclaim the texts those files were the last reference of, then hand
      // the freed pages back to the OS so narrowing the window shows on disk.
      this.store.gcTexts()
    } catch {
      // A locked database keeps the stale rows; the next startup tries again.
      return 0
    }
    this.store.compact()
    return stale.length
  }

  /**
   * What the index already holds for a path — the `size`/`mtimeMs`
   * watermarks a source registered with, the consumed-prefix `indexedBytes`,
   * and the highest indexed line. Lets a lazy source ask whether the store
   * already covers a transcript without materializing it.
   */
  coverage(path: string): { size: number; mtimeMs: number; indexedBytes: number; indexedLines: number } | undefined {
    const state = this.store.fileState(path)
    if (state === undefined) return undefined
    return {
      size: state.size,
      mtimeMs: state.mtimeMs,
      indexedBytes: state.indexedBytes,
      indexedLines: state.indexedLines,
    }
  }

  /**
   * Register a file about to be replayed and report the first line index that
   * still needs indexing.
   *
   * A file is treated as having grown by appending — the only thing any of the
   * four harnesses does to a live transcript — when it is at least as large and
   * at least as new as when it was last indexed. Anything else (a shrunken
   * file, a copy restored from an older backup) drops the file's documents and
   * re-indexes from line 0. A rewrite that lands on exactly the same size and a
   * newer mtime is indistinguishable from an append and is not detected here;
   * `SessionIndex` catches the common case, where the offset runs past the end.
   */
  beginFile(key: SearchFileKey, file: { size: number; mtimeMs: number }): number {
    this.keys.set(key.path, key)
    // A queued reset/forget still has the old `files` row — the delete only
    // lands at flush. Resuming from its watermark would leave the prefix
    // unindexed once the pending delete and the new docs commit together.
    if (this.resets.has(key.path) || this.drops.has(key.path)) return 0
    const state = this.store.fileState(key.path)
    if (state === undefined) return 0
    if (state.sessionId !== key.sessionId || state.fileId !== key.fileId) {
      // Learned only now which session owns this transcript (a subagent that
      // registered before its parent claimed it).
      this.store.rebind(key.path, key.sessionId, key.fileId)
    }
    if (file.size < state.size || file.mtimeMs < state.mtimeMs) {
      this.reset(key.path)
      return 0
    }
    this.progress.set(key.path, {
      size: file.size,
      mtimeMs: Math.max(file.mtimeMs, state.mtimeMs),
      indexedBytes: state.indexedBytes,
      indexedLines: state.indexedLines,
    })
    return state.indexedLines
  }

  /** Drop everything the index holds for a file; it was truncated or rewritten. */
  reset(path: string): void {
    this.resets.add(path)
    // Documents already queued for this file belong to the old content too.
    for (let index = this.batch.length - 1; index >= 0; index -= 1) {
      if (this.batch[index]?.path === path) this.batch.splice(index, 1)
    }
    this.progress.delete(path)
    this.schedule()
  }

  /**
   * Remove a file from the index completely — documents AND the `files`
   * watermark row. `reset` alone would leave `indexed_lines` behind, so a
   * source stream that drops and later re-registers (a Devin session
   * un-hiding) would never re-index the lines before the watermark.
   */
  forget(path: string): void {
    this.drops.add(path)
    this.resets.delete(path)
    for (let index = this.batch.length - 1; index >= 0; index -= 1) {
      if (this.batch[index]?.path === path) this.batch.splice(index, 1)
    }
    this.progress.delete(path)
    this.keys.delete(path)
    this.schedule()
  }

  /** Index one JSONL record. `lineIndex` is 0-based within the file. */
  queue(key: SearchFileKey, lineIndex: number, line: string): void {
    this.keys.set(key.path, key)
    let drafts: readonly SearchDocDraft[]
    try {
      drafts = this.extract(key.kind, line)
    } catch {
      // The extractor is written not to throw; a future record shape must not
      // take the whole index down either.
      return
    }
    for (const draft of drafts) {
      this.batch.push({
        path: key.path,
        line: lineIndex,
        role: draft.role,
        text: draft.text,
        ...(draft.timeMs === undefined ? {} : { timeMs: draft.timeMs }),
      })
    }
    if (this.batch.length >= this.maxBatchDocs) this.flush()
    else this.schedule()
  }

  /** Record how far a file has been consumed; written with its documents. */
  noteProgress(key: SearchFileKey, progress: FileProgress): void {
    this.keys.set(key.path, key)
    this.progress.set(key.path, progress)
    this.schedule()
  }

  /** Move a file's already-indexed documents to another session. */
  rebind(key: SearchFileKey): void {
    this.keys.set(key.path, key)
    this.store.rebind(key.path, key.sessionId, key.fileId)
  }

  /** Commit the pending batch. Safe to call at any time; cheap when idle. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.batch.length === 0 && this.progress.size === 0 && this.resets.size === 0 && this.drops.size === 0) return
    const resets = [...this.resets]
    const drops = [...this.drops]
    const docs = this.batch.splice(0)
    const progress = [...this.progress]
    this.resets.clear()
    this.drops.clear()
    this.progress.clear()
    const grouped = new Map<string, PendingDoc[]>()
    for (const doc of docs) {
      const list = grouped.get(doc.path)
      if (list === undefined) grouped.set(doc.path, [doc])
      else list.push(doc)
    }
    try {
      this.store.transaction(() => {
        for (const path of drops) this.store.deleteFile(path)
        for (const path of resets) this.store.clearDocs(path)
        const progressMap = new Map(progress)
        // A size-triggered flush can land documents before `noteProgress` runs.
        // The `files` row must go in the same transaction: without it, the next
        // start sees no bookkeeping, re-extracts from line 0, and duplicates.
        for (const [path, list] of grouped) {
          const key = this.keys.get(path)
          if (key === undefined) continue
          this.store.insertDocs(key, list)
          if (progressMap.has(path)) continue
          const prev = this.store.fileState(path)
          let maxLine = -1
          for (const doc of list) if (doc.line > maxLine) maxLine = doc.line
          progressMap.set(path, {
            size: prev?.size ?? 0,
            mtimeMs: prev?.mtimeMs ?? 0,
            indexedBytes: prev?.indexedBytes ?? 0,
            indexedLines: Math.max(prev?.indexedLines ?? 0, maxLine + 1),
          })
        }
        for (const [path, state] of progressMap) {
          const key = this.keys.get(path)
          if (key !== undefined) this.store.setFileState(key, state)
        }
      })
    } catch {
      // A locked or corrupt database must not stop the server from serving
      // transcripts; the batch is dropped and the next append re-queues.
    }
  }

  /**
   * End of the startup sweep: commit what is pending, forget files that are no
   * longer on disk, and report the index as ready.
   */
  finishBackfill(livePaths: Iterable<string>): void {
    this.flush()
    const live = new Set(livePaths)
    const gone = this.store.paths().filter(path => !live.has(path))
    try {
      if (gone.length > 0) {
        this.store.transaction(() => {
          for (const path of gone) this.store.deleteFile(path)
        })
      }
      // Runtime resets and forgets orphan texts without a file ever vanishing,
      // so this runs whether or not the sweep deleted anything: the startup
      // sweep is the one guaranteed chance to reclaim what piled up.
      this.store.gcTexts()
      // Check existing holes too: a previous vacuum may have been blocked.
      this.store.compactIfWasteful()
    } catch {
      // Stale rows are harmless; the next startup tries again.
    }
    // The backfill is the one burst of heavy writing; fold its WAL back in now
    // so the cache directory settles at the database's real size.
    this.store.checkpoint()
    this.backfilling = false
  }

  /** How many transcript files the startup sweep will visit. */
  setBackfillPlan(total: number): void {
    this.backfillTotal = total
    this.backfillDone = 0
  }

  /** One file from the plan has been consumed (indexed or skipped). */
  noteBackfillFile(): void {
    this.backfillDone += 1
  }

  stats(): SearchIndexing {
    const pending = new Set<string>([...this.resets, ...this.drops])
    for (const doc of this.batch) pending.add(doc.path)
    for (const path of this.progress.keys()) pending.add(path)
    return {
      pendingFiles: pending.size,
      ready: !this.backfilling,
      filesDone: this.backfillDone,
      filesTotal: this.backfillTotal,
    }
  }

  /** Flush and release the timer; the store is closed by its owner. */
  stop(): void {
    this.flush()
  }

  private schedule(): void {
    if (this.timer !== null) return
    const timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.flushDelayMs)
    timer.unref()
    this.timer = timer
  }
}
