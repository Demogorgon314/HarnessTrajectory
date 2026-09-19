/**
 * Devin session source: reads `sessions.db` (SQLite, WAL, written live) and
 * serves each session's logical transcript as virtual line streams — no
 * materialized JSONL anywhere.
 *
 * Record vocabulary emitted to subscribers/replay (parsed by the devin
 * adapter, the context synthesizer, the meta scanner and the search
 * extractor):
 *
 * - `{t:'devin.session', …}` — session facts sidecar: title/cwd/model/agent
 *   mode/created time from the `sessions` row plus the discovered subagent
 *   list. Synthetic (`startLine: -1`), re-sent when facts change.
 * - `{t:'devin.msg', node, parent, time, kept?, msg}` — one message node. `msg`
 *   is the raw `chat_message` JSON; `time` is epoch ms (`metadata.created_at`,
 *   else `created_at` seconds). `kept:1` marks a summary's ancestor flush —
 *   the incoming render's declared-kept prefix/context — so the synthesizer
 *   exempts exactly those seqs from the summary's claim (later kept copies
 *   that arrive as descendants carry no tag and are claimed normally). These
 *   are the only indexed lines: the 0-based line number is the emission index
 *   within its stream.
 * - `{t:'devin.tool', id, time, call?, update?}` — one `tool_call_state` row:
 *   serialized ACP `ToolCall`/`ToolCallUpdate`. Synthetic; re-sent when the
 *   row changes (the update column lands late).
 *
 * Stream layout: `devin://sessions/<id>` is the main stream; a disjoint chain
 * becomes the child stream `devin://sessions/<id>/agent-<agentId>` once
 * claimed — by a `subagent_heads` row or a `subagent/agent_id` +
 * `chain_node_id` pair (a spawn result's extensions for a synchronous run,
 * the `<subagent_completion_notification>` system node on the main chain for
 * a background one), or a unique exact match between a spawn's task and a
 * chain's opening human message, joined to the launch receipt's agent id.
 * Unclaimed chains (context renders, compactor/summarizer
 * passes) buffer as `pending` and never appear: a claim drains the backlog in
 * order, a merge into the main chain drains it there.
 *
 * Chain membership (see db.ts header): a union-find over `parent_node_id`,
 * `compact/prior_node_ids` and shared `message_id`s groups render trees into
 * logical chains. The edges are NOT equally trustworthy: parent/prior links
 * are conversation lineage — a re-render points at the nodes it replaces —
 * while `message_id` is OBJECT identity, and the CLI inserts the same message
 * object into many conversations (every subagent's context opens with one
 * shared system-prompt object, one mid across every agent chain). So a mid
 * edge glues components only when NEITHER side carries prior structure —
 * prior-free fragments of older stores where mid is the only render link.
 * A logical chain only ever grows — a render's links land in
 * one transaction — but if a union ever merges two groups that both already
 * emitted lines, the earlier attribution was wrong, so the session is
 * re-materialized with `file reset` (deterministic rebuild, cheap at this
 * size). The same rebuild covers the converse: a prior edge landing inside a
 * mid-glued component proves the mid merge was a shared object, and the full
 * pass re-derives the grouping with every prior known up front.
 *
 * Compaction epochs: a `system` node carrying `extensions['devin-rs/summary']`
 * closes one render and opens the next ON ITS OWN STREAM — each owner entry
 * keeps an epoch counter (`epochs`), so a subagent chain's compaction works
 * the same way as the main chain's. Dedup is per `(message_id, stream,
 * epoch)` — a mid emitted before the latest summary re-emits once afterward,
 * because a render copy of a shadowed message is kept context, not a dup.
 * Only the FIRST sighting of a summary mid opens an epoch: a later render's
 * kept copy of that summary is content, not a new boundary. Copies that are
 * ancestors of the summary node itself (the render's prefix and kept
 * injections) emit with it via `emitRenderAncestors`, tagged `kept` on the
 * wire; same-epoch copies of still-live messages stay deduped, and
 * re-emissions skip search indexing so the index never double-counts.
 *
 * Store rewrites: the CLI periodically rewrites a session's whole forest in
 * one commit — same node_ids re-inserted in node order under fresh row_ids,
 * so the row watermark ADVANCES (never a `dropped` regression) and the batch
 * looks like a giant append. Content is keyed by node_id — verified
 * byte-identical across generations — so pass 2 skips any node_id already
 * materialized; without that guard every rewrite appends a whole extra copy
 * of the transcript. `state.nodes` keeps the FIRST parse of a node so
 * ancestor re-emissions stay byte-stable.
 */

import { EventEmitter } from 'node:events'
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import {
  asArray, asString, isRecord, parseJsonLine,
  type AgentFileMeta, type HarnessKind, type SessionFileRef, type SessionLiveEvent,
} from '@harness-trajectory/core'
import { createMetaScanner } from '../meta.ts'
import type { ListingCache } from '../listing-cache.ts'
import type { SearchIndexer } from '../search/indexer.ts'
import {
  CHUNK_LINES, emitReplay, lineTimes, SessionBook, searchKeyOf, standaloneRef,
  type LineSource, type SessionSource, type ReplaySink, type SourceEntry, type SourceSession, type Subscriber,
} from '../source.ts'
import { DevinDb, type DevinNodeRow, type DevinSessionRow } from './db.ts'
import { catalogFingerprint, parseCatalog, serializeCatalog } from './catalog.ts'

const KIND: HarnessKind = 'devin'
const POLL_INTERVAL_MS = 1_500

export interface DevinSourceOptions {
  /** Absolute path of `sessions.db`. */
  dbPath: string
  search?: SearchIndexer | undefined
  listing?: ListingCache | undefined
  /** Disable polling and file watching (tests). */
  watch?: boolean | undefined
  now?: (() => number) | undefined
}

interface DevinEntry extends SourceEntry {
  /** First line index that still needs search indexing (`beginFile`'s answer). */
  searchFrom: number
  /** Session aged past the retention window: browsable, but never queued. */
  searchSkipped: boolean
}

/**
 * Union-find over message nodes. Roots carry the entry already emitting the
 * group, so an emitted-lines merge is detectable. Two flag sets ride the
 * roots: `prior` marks components containing a `compact/prior_node_ids` edge
 * (reliable lineage — shared objects must not glue them), `mid` marks
 * components a `message_id` edge glued (a later prior edge into one voids the
 * merge). (The child file id comes from the claiming agent id, not the group
 * — see `childEntry`.)
 */
class ChainGroups {
  private readonly parent = new Map<number, number>()
  private readonly emitted = new Map<number, DevinEntry>()
  private readonly prior = new Set<number>()
  private readonly mid = new Set<number>()

  find(node: number): number {
    // An unknown node is its own group until `add`/`union` place it.
    if (!this.parent.has(node)) return node
    let root = node
    while (this.parent.get(root) !== root) root = this.parent.get(root) ?? root
    // Path halving.
    let cursor = node
    while (this.parent.get(cursor) !== cursor) {
      const next = this.parent.get(cursor) ?? cursor
      this.parent.set(cursor, root)
      cursor = next
    }
    return root
  }

  add(node: number): void {
    if (this.parent.has(node)) return
    this.parent.set(node, node)
  }

  /** Entry (if any) already emitting for the node's group. */
  entryOf(node: number): DevinEntry | undefined {
    return this.emitted.get(this.find(node))
  }

  /** Claim `entry` as the emitter of the node's group. */
  claim(node: number, entry: DevinEntry): void {
    this.emitted.set(this.find(node), entry)
  }

  /** The node's component contains a `compact/prior_node_ids` edge. */
  hasPrior(node: number): boolean {
    return this.prior.has(this.find(node))
  }

  /** The node's component was glued together by a `message_id` edge. */
  hasMid(node: number): boolean {
    return this.mid.has(this.find(node))
  }

  /** Mark the node's component as containing a prior edge. */
  markPrior(node: number): void {
    this.prior.add(this.find(node))
  }

  /** Mark the node's component as containing a mid merge. */
  markMid(node: number): void {
    this.mid.add(this.find(node))
  }

  /**
   * Union two nodes. Returns `false` when the merge joined two groups that
   * each already emitted lines — the earlier attribution is void, caller must
   * re-materialize the session.
   */
  union(a: number | null, b: number | null): boolean {
    if (a === null || b === null) return true
    this.add(a)
    this.add(b)
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return true
    const ea = this.emitted.get(ra)
    const eb = this.emitted.get(rb)
    if (ea !== undefined && eb !== undefined && ea !== eb) return false
    this.parent.set(ra, rb)
    if (this.prior.delete(ra)) this.prior.add(rb)
    if (this.mid.delete(ra)) this.mid.add(rb)
    const entry = ea ?? eb
    if (entry !== undefined) this.emitted.set(rb, entry)
    return true
  }
}

interface ParsedNode {
  row: DevinNodeRow
  /** Parsed `chat_message` (kept for the `subagent/*` extensions). */
  record: Record<string, unknown>
  messageId: string | null
  priors: number[]
  /** Carries `extensions['devin-rs/summary']` — emitting one to main ends an epoch. */
  compaction: boolean
  time: number
}

/**
 * What a consumed node costs to keep: the fields a render-ancestor walk and
 * a delayed (pending) emit need — NOT the parsed message graph or a second
 * copy of the wire line. The wire form is re-synthesized on demand
 * (`wireLine`); a transcript's memory footprint stays near one copy of
 * `chat_message` instead of four or five.
 */
interface StoredNode {
  nodeId: number
  parentId: number | null
  messageId: string | null
  compaction: boolean
  time: number
  chatMessage: string
}

interface DevinSessionState {
  /** Validated listing-only restart snapshot; no chain state has been built yet. */
  catalogFingerprint: string | null
  session: SourceSession<DevinEntry>
  row: DevinSessionRow
  /**
   * A live state emits events, feeds meta/search, and is the one `states`
   * holds. A replay state (`live: false`) is a throwaway rebuild of the same
   * rows used by `readAll`: it collects lines instead of buffering them and
   * touches nothing shared — its `book` is private so `emitTo` reaches no
   * real subscriber.
   */
  live: boolean
  book: SessionBook<DevinEntry>
  /** Replay mode only: emitted lines per entry, read back by `readAll`. */
  replay?: Map<DevinEntry, string[]>
  /** Replay mode only: the pinned row set (live's consumed frontier), so a union-conflict rebuild replays the same rows. */
  replayRows?: DevinNodeRow[]
  groups: ChainGroups
  /** message_id → a node already carrying it (identity edges). */
  midAnchor: Map<string, number>
  /**
   * Dedup key (message_id, else `node:<id>`) → owner entry → compaction epoch
   * at emit time. A key may emit to an owner AGAIN once a summary node has
   * landed there: everything emitted before a compaction leaves the rendered
   * context, so a later render carrying the same message_id is a kept copy —
   * real context the fold must re-count. Same-epoch duplicates dedupe flat.
   */
  emitted: Map<string, Map<DevinEntry, number>>
  /** Summary nodes emitted per owner entry — each stream's render boundary. */
  epochs: Map<DevinEntry, number>
  /** Highest row_id consumed; a regression means the store was rebuilt. */
  maxRowId: number
  /**
   * A materialization batch aborted midway: `nodes`/structure maps hold rows
   * that never emitted, so an incremental retry would skip them (`fresh`
   * comes up empty). The next materialize for this session must rebuild.
   */
  needsRebuild: boolean
  /** node_id of the session's first row — the main-chain fallback root. */
  earliestNode: number
  /** node_id → retained row facts, for walking a render chain's ancestry. */
  nodes: Map<number, StoredNode>
  /** tool_call_id → fingerprint of the last emitted `tool_call_state` row. */
  toolFingerprints: Map<string, string>
  /** Dedup key of the last emitted sidecar line. */
  sidecarKey: string | null
  /** chain_node_id → agent_id from `subagent_heads`, when populated. */
  heads: Map<number, string>
  /**
   * chain_node_id → run facts learned from the spawning tool result's
   * `subagent/*` metadata extensions — the reliable binding (`subagent_heads`
   * is empty in observed stores).
   */
  chainAgent: Map<number, { agentId: string; profile: string | null; model: string | null }>
  /** `run_subagent` call id → its `title`/`task`/`profile` arguments. */
  spawnArgs: Map<string, { title: string | null; task: string | null; profile: string | null }>
  /** agent_id → the `run_subagent` call that spawned it (result's tool_call_id). */
  agentCall: Map<string, string>
  /** Human task nodes; exact task matching is only a fallback to explicit claims. */
  taskNodes: Map<number, string>
  inferredAgents: Map<number, string>
  /**
   * Nodes of chain groups nothing has claimed yet (group root → rows, in row
   * order). Devin renders extra context chains — compactor and summarizer
   * passes — in the same forest. Explicit claims or a unique spawn/task match
   * identify agent transcripts. Unclaimed groups buffer here instead of becoming child files;
   * a group that merges into the main chain drains to the main stream, and a
   * never-claimed one stays invisible.
   */
  pending: Map<number, StoredNode[]>
}

function jsonString(value: string | null): unknown {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export class DevinSource extends EventEmitter implements SessionSource {
  private readonly dbPath: string
  private readonly listing: ListingCache | undefined
  /** Mutable: the Content search toggle attaches and detaches this at runtime. */
  private search: SearchIndexer | undefined
  private readonly watchEnabled: boolean
  private readonly now: () => number
  private readonly book = new SessionBook<DevinEntry>(() => this.now())
  private readonly states = new Map<string, DevinSessionState>()
  private db: DevinDb | null = null
  /**
   * Identity (`dev:ino`) of the file the open handle and every derived state
   * were built from. Kept across `stop()` so a file swapped while stopped is
   * still caught at the next `start()`.
   */
  private dbSig: string | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private readonly watchers: FSWatcher[] = []
  private readonly watchedPaths = new Set<string>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** The last open attempt failed and was already reported — suppress repeats. */
  private openFailed = false
  /** The last sessions() query failed and was already reported — suppress repeats. */
  private queryFailed = false
  /**
   * The open file is a replacement whose resync could not finish (the new
   * store opened but its `sessions()` query failed). States still describe
   * the OLD store — ticks retry the resync before serving them.
   */
  private resyncPending = false

  constructor(options: DevinSourceOptions) {
    super()
    this.dbPath = options.dbPath
    this.listing = options.listing
    this.search = options.search
    this.watchEnabled = options.watch !== false
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    this.stopped = false
    // A restart re-reports failures: the streak flags belong to the run, not
    // the instance.
    this.openFailed = false
    this.queryFailed = false
    if (this.db === null) this.openDb()
    await this.sweep()
    if (!this.watchEnabled) return
    if (this.poll === null) {
      this.poll = setInterval(() => {
        this.tick().catch((error: unknown) => { this.emit('error', error) })
      }, POLL_INTERVAL_MS)
      this.poll.unref()
    }
    this.attachWatcher()
  }

  /** `dev:ino` of the file at `dbPath`; null when it does not exist. */
  private fileSig(): string | null {
    try {
      const st = statSync(this.dbPath)
      return `${st.dev}:${st.ino}`
    } catch {
      return null
    }
  }

  /**
   * (Re)open the store. A missing file is normal — Devin CLI may simply not
   * be installed yet — so it degrades silently and the poll retries; a file
   * that exists but will not open reports once per failure streak instead of
   * crashing the composite. When the opened file is not the one the states
   * were built from (replaced while stopped, or reopened after a delete), the
   * whole derived view is rebuilt against it.
   */
  private openDb(): boolean {
    const sig = this.fileSig()
    if (sig === null) return false
    try {
      this.db = new DevinDb(this.dbPath)
      if (!this.db.hasSchema()) throw new Error('missing Devin tables')
    } catch (error) {
      this.db?.close()
      this.db = null
      if (!this.openFailed) {
        this.openFailed = true
        this.emit('error', new Error(`${this.dbPath}: not a Devin session store`, { cause: error }))
      }
      return false
    }
    this.openFailed = false
    const replaced = this.dbSig !== null && this.dbSig !== sig && this.states.size > 0
    this.dbSig = sig
    if (replaced) this.resyncPending = !this.resyncAll()
    return true
  }

  /**
   * The store file was replaced (atomic rename, delete+recreate): every
   * derived map, cursor, fingerprint and pending buffer was built from the
   * old store's rows — all void, even for session ids the new file reuses.
   * Rebuild each known session in place (`materialize(full)` ships `file
   * reset` so subscribers refold) and drop the ones the new store lacks.
   * Returns false when the new store will not query yet — the caller keeps
   * `resyncPending` set so the next tick retries instead of serving the
   * old store's state.
   */
  private resyncAll(): boolean {
    const db = this.db
    if (db === null) return false
    const rows = this.sessionRows()
    if (rows === null) return false
    const seen = new Set<string>()
    for (const row of rows) {
      if (row.hidden !== 0) continue
      seen.add(row.id)
      const state = this.states.get(row.id)
      try {
        if (state === undefined) {
          this.freshSession(db, row)
          this.emit('change', KIND, row.id)
          continue
        }
        state.row = row
        if (state.session.main !== null) {
          state.session.main.mtimeMs = row.last_activity_at * 1000
        }
        // `materialize(full)` resets the lineage/dedup/counter/scanner state
        // and ships `file reset`; the claim maps it does not own still hold
        // old-store node ids — void them first.
        state.heads = new Map(db.subagentHeads(row.id).map(head => [head.chain_node_id, head.agent_id]))
        state.chainAgent.clear()
        state.spawnArgs.clear()
        state.agentCall.clear()
        this.materialize(state, true)
        // The reset wiped the fingerprints: re-emit the store's current tool
        // rows so subscribers that just refolded get their tool state back.
        this.syncToolState(state)
        this.syncSeedFacts(state)
        this.syncSidecar(state)
      } catch (error) {
        this.markBroken(row.id)
        this.emit('error', new Error(`devin session ${row.id} resync failed`, { cause: error }))
        continue
      }
      this.emit('change', KIND, row.id)
    }
    for (const state of [...this.states.values()]) {
      if (!seen.has(state.row.id)) this.drop(state)
    }
    return true
  }

  /**
   * Register and materialize one session row (initial sweep and resync share
   * it). The caller's loop decides whether a failure here is fatal — it is
   * not: callers catch per session.
   */
  private freshSession(db: DevinDb, row: DevinSessionRow): void {
    const fresh = !this.states.has(row.id)
    const fingerprint = this.listing === undefined ? undefined : catalogFingerprint(db, this.dbSig, row)
    const state = this.register(row)
    state.row = row
    state.heads = new Map(db.subagentHeads(row.id).map(head => [head.chain_node_id, head.agent_id]))
    if (fresh && fingerprint !== undefined && this.restoreCatalog(state, fingerprint)) return
    this.materialize(state)
    // History tools arrive in replay; only track their fingerprints live.
    for (const tool of db.toolStates(row.id)) {
      state.toolFingerprints.set(
        tool.tool_call_id,
        `${tool.tool_call_json?.length ?? -1}:${tool.tool_call_update_json ?? ''}`,
      )
    }
    this.syncSeedFacts(state)
    this.syncSidecar(state)
    if (fingerprint !== undefined && fingerprint === catalogFingerprint(db, this.dbSig, row)) {
      const entries = [state.session.main, ...state.session.children.values()].filter(entry => entry !== null)
      this.listing?.saveCatalog(this.dbPath, row.id, fingerprint, serializeCatalog(entries, state.maxRowId))
    }
  }

  private restoreCatalog(state: DevinSessionState, fingerprint: string): boolean {
    const saved = this.listing?.loadCatalog(this.dbPath, state.row.id, fingerprint)
    if (saved === undefined) return false
    const catalog = parseCatalog(saved, state.row.id)
    if (catalog === undefined) return false
    const search = this.search
    const skipped = search !== undefined && !search.shouldIndex({ mtimeMs: state.row.last_activity_at * 1000 })
    if (search !== undefined && !skipped) {
      for (const entry of catalog.entries) {
        const prior = search.coverage(entry.path)
        if (prior === undefined || prior.size !== catalog.maxRowId || prior.indexedLines !== entry.lines
          || prior.indexedBytes !== entry.size || prior.mtimeMs !== state.row.last_activity_at * 1000) return false
      }
    }
    for (const entry of catalog.entries) {
      const restored: DevinEntry = { ...entry, searchFrom: entry.lines, searchSkipped: skipped }
      if (entry.ref.role === 'main') state.session.main = restored
      else state.session.children.set(entry.ref.id, restored)
      this.book.files.set(entry.path, restored)
    }
    state.maxRowId = catalog.maxRowId
    state.catalogFingerprint = fingerprint
    return true
  }

  /**
   * The `sessions` row feeds the meta scanner's seed at registration; a title
   * that lands late (or is rewritten) updates the seeded fields in place —
   * re-creating the scanner would drop promptCount and its mid dedup set.
   */
  private syncSeedFacts(state: DevinSessionState): void {
    const meta = state.session.main?.meta?.state
    if (meta === undefined || meta === null) return
    const title = state.row.title?.trim()
    meta.aiTitle = title === undefined || title === '' ? null : title
    meta.cwd = state.row.working_directory
    meta.model = state.row.model
  }

  /**
   * `sessions()` with failure isolation: a whole-store query failure degrades
   * this source to empty for the tick instead of rejecting the sweep (which
   * would take the composite — and every other harness — down with it). One
   * error event per failure streak.
   */
  private sessionRows(): DevinSessionRow[] | null {
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

  /**
   * The store file's WAL moves on every commit while the main file only moves
   * at checkpoint — watch both for promptness and let the debounced poll do
   * the real work. The WAL may not exist yet; ticks retry the attach.
   */
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

  /** Streams this source feeds to the search index (its half of `finishBackfill`). */
  livePaths(): string[] {
    return [...this.book.files.values()].flatMap(entry => (entry.searchSkipped ? [] : [entry.path]))
  }

  /**
   * Attach a search indexer mid-run: every live session is re-anchored with
   * `beginFile` and its emitted lines are re-derived from the store and fed
   * to the index (replays produce no side effects, which is exactly what
   * makes them safe to re-read for search). Appends index from here on.
   * Synchronous on purpose: no poll tick can interleave. The caller owns
   * `finishBackfill`.
   */
  enableSearch(search: SearchIndexer): void {
    if (this.search !== undefined) return
    // The backlog pass below is the sole producer for this toggle. Restore
    // deferred chains before attaching, otherwise materialization queues the
    // same lines that the following replay is about to enqueue.
    for (const state of this.states.values()) {
      if (state.catalogFingerprint !== null) this.materialize(state)
    }
    this.search = search
    for (const state of this.states.values()) {
      if (!state.live) continue
      const entries = [...state.book.files.values()].filter(entry => entry.sessionId === state.row.id)
      for (const entry of entries) {
        entry.searchSkipped = !search.shouldIndex({ mtimeMs: state.row.last_activity_at * 1000 })
        entry.searchFrom = entry.searchSkipped
          ? 0
          : search.beginFile(searchKeyOf(entry), { size: state.maxRowId, mtimeMs: state.row.last_activity_at * 1000 })
      }
      const replay = this.replaySession(state)
      for (const [path, lines] of replay) {
        const entry = state.book.files.get(path)
        if (entry === undefined || entry.searchSkipped) continue
        // The replay must re-derive the emitted stream exactly; a mismatch
        // leaves this stream to the next startup's registration path rather
        // than indexing lines under shifted numbers.
        if (lines.length !== entry.lines) continue
        for (let index = entry.searchFrom; index < lines.length; index += 1) {
          const line = lines[index]
          if (line !== undefined) search.queue(searchKeyOf(entry), index, line)
        }
        search.noteProgress(searchKeyOf(entry), {
          size: state.maxRowId,
          mtimeMs: state.row.last_activity_at * 1000,
          indexedBytes: entry.size,
          indexedLines: entry.lines,
        })
      }
    }
  }

  /** Detach the indexer (Content search toggled off): new rows stop indexing. */
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
  subscribe(kind: HarnessKind, id: string, subscriber: Subscriber) {
    const state = kind === KIND ? this.states.get(id) : undefined
    if (state !== undefined && state.catalogFingerprint !== null) this.materialize(state)
    return this.book.subscribe(kind, id, subscriber)
  }
  facts(kind: HarnessKind, id: string) {
    return kind === KIND ? this.book.facts(kind, id) : undefined
  }

  /**
   * Replay one session: `file` events, then the session sidecar and the known
   * tool state (both synthetic), then the per-stream lines merged by time.
   * With `fileId` only that child stream replays, served as `main`.
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
    const state = this.states.get(id)
    if (state !== undefined && state.catalogFingerprint !== null) this.materialize(state)
    const main = state?.session.main
    if (state === undefined || main === null || main === undefined) return
    const session = state.session
    let entries: DevinEntry[]
    let refOf: (entry: DevinEntry) => SessionFileRef = entry => entry.ref
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
      // Facts + tool state are synthetic: they belong to no line of the stream,
      // so they ride `startLine: -1` chunks and take no index.
      const sidecar = this.sidecarLine(state)
      if (sidecar !== null) {
        sources.push({ ref: main.ref, lines: [sidecar.line], times: [state.row.created_at * 1000], synthetic: 1 })
      }
      const toolLines = this.toolLines(state)
      if (toolLines.length > 0) {
        const time = state.row.last_activity_at * 1000
        sources.push({ ref: main.ref, lines: toolLines, times: toolLines.map(() => time), synthetic: toolLines.length })
      }
    }
    const replayed = this.replaySession(state)
    for (const entry of entries) {
      const lines = replayed.get(entry.path) ?? []
      sources.push({ ref: refOf(entry), lines, times: lineTimes(lines) })
    }
    await emitReplay(
      entries.map(refOf), sources,
      { type: 'meta', summary: this.book.summarize(session), children: this.book.childSummaries(session) },
      emit, signal,
    )
  }

  // -- discovery -----------------------------------------------------------

  private static sessionPath(id: string): string {
    return `devin://sessions/${id}`
  }

  /**
   * Build the materialization state for `row` on `book`. Live states
   * (`live: true`) emit events and feed meta/search; replay states collect
   * lines instead — same materialization path, no observable side effects.
   */
  private buildState(row: DevinSessionRow, book: SessionBook<DevinEntry>, live: boolean): DevinSessionState {
    const session = book.sessionFor(KIND, row.id)
    const entry: DevinEntry = {
      kind: KIND,
      path: DevinSource.sessionPath(row.id),
      ref: { id: row.id, role: 'main', path: DevinSource.sessionPath(row.id) },
      sessionId: row.id,
      size: 0,
      mtimeMs: row.last_activity_at * 1000,
      lines: 0,
      meta: live ? createMetaScanner(KIND, sessionSeed(row)) : null,
      searchFrom: 0,
      searchSkipped: !live || (this.search !== undefined
        && !this.search.shouldIndex({ mtimeMs: row.last_activity_at * 1000 })),
    }
    session.main = entry
    book.files.set(entry.path, entry)
    return {
      catalogFingerprint: null,
      session,
      row,
      live,
      book,
      ...(live ? {} : { replay: new Map(), replayRows: [] }),
      groups: new ChainGroups(),
      midAnchor: new Map(),
      emitted: new Map(),
      epochs: new Map(),
      maxRowId: 0,
      earliestNode: 0,
      needsRebuild: false,
      nodes: new Map(),
      toolFingerprints: new Map(),
      sidecarKey: null,
      heads: new Map(),
      chainAgent: new Map(),
      spawnArgs: new Map(),
      agentCall: new Map(),
      taskNodes: new Map(),
      inferredAgents: new Map(),
      pending: new Map(),
    }
  }

  private register(row: DevinSessionRow): DevinSessionState {
    const existing = this.states.get(row.id)
    if (existing !== undefined) return existing
    const state = this.buildState(row, this.book, true)
    this.states.set(row.id, state)
    const entry = state.session.main
    if (entry !== null && this.search !== undefined && !entry.searchSkipped) {
      // The row watermark stands in for file size: monotonic while the store
      // appends, lower after a rebuild — exactly what `beginFile` checks.
      const maxRow = this.db?.maxRowId(row.id) ?? 0
      entry.searchFrom = this.search.beginFile(
        searchKeyOf(entry), { size: maxRow, mtimeMs: state.row.last_activity_at * 1000 },
      )
    }
    return state
  }

  /**
   * Rebuild a session's emitted lines from the store for a replay, in a
   * scratch state that runs the same materialization path but touches nothing
   * shared: its book has no subscribers, search/meta stay off, and the
   * collected lines come back by stream path. The row set is pinned to the
   * rows live has consumed — rows it has not (appended since the last tick)
   * must not replay, or the next live emit sends them a second time and the
   * client's incremental fold doubles them. In the common case that set is
   * the indexed prefix `row_id <= maxRowId`; a whole-forest rewrite between
   * live's last consume and now makes every current row_id sit above the
   * stale watermark, so that case falls back to matching the consumed
   * node_ids (rewrite copies keep theirs — the consumed set re-derives
   * exactly what live shows even mid-rewrite).
   */
  private replaySession(state: DevinSessionState): Map<string, string[]> {
    const byPath = new Map<string, string[]>()
    if (this.db === null) return byPath
    const scratch = this.buildState(state.row, new SessionBook<DevinEntry>(() => this.now()), false)
    scratch.heads = new Map(
      this.db.subagentHeads(state.row.id).map(head => [head.chain_node_id, head.agent_id]),
    )
    let rows = this.db.nodesBefore(state.row.id, state.maxRowId)
    if (rows.length === 0 && state.nodes.size > 0) {
      rows = this.db.nodes(state.row.id).filter(row => state.nodes.has(row.node_id))
    }
    scratch.replayRows = rows
    this.materialize(scratch)
    for (const [entry, lines] of scratch.replay ?? []) byPath.set(entry.path, lines)
    return byPath
  }

  /** Forget a session (hidden or deleted from the store). */
  private drop(state: DevinSessionState): void {
    const paths = this.book.dropSession(state.session)
    // `forget` (not `reset`): the watermark row must go too, or a session that
    // reappears keeps `indexed_lines` and its earlier lines never re-index.
    for (const path of paths) this.search?.forget(path)
    this.states.delete(state.row.id)
    this.emit('change', KIND, state.row.id)
  }

  // -- materialization -----------------------------------------------------

  private parseNode(row: DevinNodeRow): ParsedNode {
    const message = jsonString(row.chat_message)
    const record = isRecord(message) ? message : {}
    const meta = isRecord(record['metadata']) ? record['metadata'] : {}
    const ext = isRecord(record['extensions']) ? record['extensions'] : {}
    const msgExt = isRecord(meta['extensions']) ? meta['extensions'] : {}
    // The render's replace links live in the row's own `metadata` column
    // (`extensions."compact/prior_node_ids"`); the chat_message locations are
    // kept for older stores that wrote them inside the message.
    const rowMeta = jsonString(row.metadata)
    const rowExtRaw = isRecord(rowMeta) ? rowMeta['extensions'] : undefined
    const rowExt = isRecord(rowExtRaw) ? rowExtRaw : {}
    const priors: number[] = []
    for (const bag of [rowExt, ext, msgExt]) {
      const list = bag['compact/prior_node_ids']
      if (!Array.isArray(list)) continue
      for (const value of list) if (typeof value === 'number') priors.push(value)
    }
    const compaction = msgExt['devin-rs/summary'] !== undefined || ext['devin-rs/summary'] !== undefined
    const metaCreated = Date.parse(asString(meta['created_at']) ?? '')
    const time = Number.isNaN(metaCreated) ? row.created_at * 1000 : metaCreated
    const messageId = asString(record['message_id']) ?? null
    return { row, record, messageId, priors, compaction, time }
  }

  /** Slim a parsed row down to what stays in memory once its batch is done. */
  private static storedOf(node: ParsedNode): StoredNode {
    const { row } = node
    return {
      nodeId: row.node_id,
      parentId: row.parent_node_id,
      messageId: node.messageId,
      compaction: node.compaction,
      time: node.time,
      chatMessage: row.chat_message,
    }
  }

  /**
   * A node's wire line — the raw `chat_message` JSON rides verbatim so the
   * adapter and the extractors parse it once, client side. `kept` tags the
   * render-ancestor flush (the synthesizer's claim-exemption marker).
   */
  private static wireLine(node: StoredNode, kept = false): string {
    return `{"t":"devin.msg","node":${node.nodeId},`
      + `"parent":${node.parentId === null ? 'null' : node.parentId},`
      + `"time":${node.time},${kept ? '"kept":1,' : ''}"msg":${node.chatMessage}}`
  }

  /**
   * Facts about a claimed agent the child file's `agent` meta advertises: the
   * resolved agent id, the `run_subagent` call that spawned it (`toolUseId`),
   * its human title (`description` = the call's `title`, else `task`), and the
   * profile from `subagent/profile_name` (else the call's `profile` arg).
   */
  private agentFacts(
    state: DevinSessionState,
    agentId: string,
    learned: { profile: string | null; model: string | null } | undefined,
  ): AgentFileMeta {
    const callId = state.agentCall.get(agentId)
    const spawn = callId === undefined ? undefined : state.spawnArgs.get(callId)
    const description = spawn?.title ?? spawn?.task ?? null
    const agentType = learned?.profile ?? spawn?.profile ?? null
    return {
      agentId,
      ...(callId === undefined ? {} : { toolUseId: callId }),
      ...(description === null ? {} : { description }),
      ...(agentType === null ? {} : { agentType }),
      ...(learned?.model == null ? {} : { model: learned.model }),
    }
  }

  /**
   * A spawn result's `subagent/*` extensions name the chain it produced. When
   * the chain's child file already exists, its agent facts update in place and
   * a `file` event re-ships the ref.
   */
  private learnChainAgent(state: DevinSessionState, node: ParsedNode): void {
    const meta = isRecord(node.record['metadata']) ? node.record['metadata'] : undefined
    const ext = isRecord(meta?.['extensions']) ? meta['extensions'] : undefined
    const chainNode = ext?.['subagent/chain_node_id']
    const agentId = ext?.['subagent/agent_id']
    if (typeof chainNode !== 'number' || typeof agentId !== 'string') return
    const learned = {
      profile: asString(ext?.['subagent/profile_name']) ?? null,
      model: asString(ext?.['subagent/model']) ?? null,
    }
    if (!state.chainAgent.has(chainNode)) state.chainAgent.set(chainNode, { agentId, ...learned })
    const entry = state.groups.entryOf(chainNode)
    if (entry === undefined || entry === state.session.main) return
    this.refreshAgentFacts(state, entry, agentId, learned)
  }

  /**
   * Re-resolve a claimed child's `agent` meta against the spawn facts learned
   * so far and re-ship the ref when they changed — a completion's claim, a
   * late `tool_call_id` join, or a `subagent_heads` row can each arrive after
   * the file already exists.
   */
  private refreshAgentFacts(
    state: DevinSessionState,
    entry: DevinEntry,
    agentId: string,
    learned: { profile: string | null; model: string | null } | undefined,
  ): void {
    const facts = this.agentFacts(state, agentId, learned)
    const known = entry.ref.agent
    if (known?.agentId === agentId
      && known.toolUseId === facts.toolUseId
      && known.description === facts.description
      && known.agentType === facts.agentType
      && known.model === facts.model) return
    entry.ref = { ...entry.ref, agent: { ...entry.ref.agent, ...facts } }
    state.book.emitTo(state.session, { type: 'file', file: entry.ref })
  }

  /**
   * The `title`/`task`/`profile` arguments a `run_subagent` call carried, and
   * the result node's `tool_call_id` → `subagent/agent_id` join — together
   * they attach the human title to a claimed chain's file (the catalog row's
   * fallback title when no run bound it).
   */
  private learnSpawnFacts(state: DevinSessionState, node: ParsedNode): void {
    for (const call of asArray(node.record['tool_calls']) ?? []) {
      if (!isRecord(call) || asString(call['name']) !== 'run_subagent') continue
      const callId = asString(call['id'])
      if (callId === undefined) continue
      const parsed: unknown = typeof call['arguments'] === 'string' ? parseJsonLine(call['arguments']) : call['arguments']
      const args = isRecord(parsed) ? parsed : {}
      state.spawnArgs.set(callId, {
        title: asString(args['title']) ?? null,
        task: asString(args['task']) ?? null,
        profile: asString(args['profile']) ?? null,
      })
    }
    const meta = isRecord(node.record['metadata']) ? node.record['metadata'] : undefined
    const ext = isRecord(meta?.['extensions']) ? meta['extensions'] : undefined
    const agentId = asString(ext?.['subagent/agent_id'])
    const callId = asString(node.record['tool_call_id'])
    if (agentId === undefined || callId === undefined || state.agentCall.has(agentId)) return
    state.agentCall.set(agentId, callId)
    // The join may land after the child file exists — re-resolve its facts,
    // keeping the profile/model the claim already learned.
    const learned = [...state.chainAgent.values()].find(facts => facts.agentId === agentId)
    for (const child of state.session.children.values()) {
      if (child.ref.agent?.agentId === agentId) this.refreshAgentFacts(state, child, agentId, learned)
    }
  }

  /**
   * The group a node belongs to counts as main when it contains the committed
   * main chain head; before `main_chain_id` lands, the session's oldest node
   * stands in — a session's first context node is always on its main chain.
   */
  private isMainGroup(state: DevinSessionState, node: number): boolean {
    const root = state.row.main_chain_id ?? state.earliestNode
    return state.groups.find(root) === state.groups.find(node)
  }

  private childEntry(state: DevinSessionState, node: StoredNode): DevinEntry | null {
    const session = state.session
    // A subagent chain is named by `subagent_heads` when populated, else by the
    // `subagent/*` extensions on the result of the call that spawned it.
    const named = [...state.heads.entries()].find(([chainNode]) =>
      state.groups.find(chainNode) === state.groups.find(node.nodeId))
    const learned = [...state.chainAgent.entries()].find(([chainNode]) =>
      state.groups.find(chainNode) === state.groups.find(node.nodeId))
    const agentId = named?.[1] ?? learned?.[1].agentId
      ?? state.inferredAgents.get(state.groups.find(node.nodeId))
    if (agentId === undefined) return null
    const learnedFacts = learned?.[1]
    // The file is named by the claimed agent id, not a row-derived group key:
    // the key depends on WHICH members were visible at claim time (a pending
    // chain drains under whatever group existed then), while the agent id is
    // identical for a fresh scan, a live poll, and a restart.
    const fileId = `agent-${agentId}`
    const existing = session.children.get(fileId)
    if (existing !== undefined) return existing
    const path = `${DevinSource.sessionPath(session.id)}/${fileId}`
    const entry: DevinEntry = {
      kind: KIND,
      path,
      ref: {
        id: fileId, role: 'child', path, parentId: session.id,
        agent: this.agentFacts(state, agentId, learnedFacts),
      },
      sessionId: session.id,
      size: 0,
      mtimeMs: node.time,
      lines: 0,
      meta: state.live ? createMetaScanner(KIND) : null,
      searchFrom: 0,
      searchSkipped: !state.live || (this.search !== undefined
        && !this.search.shouldIndex({ mtimeMs: state.row.last_activity_at * 1000 })),
    }
    session.children.set(fileId, entry)
    state.book.files.set(path, entry)
    if (state.live && this.search !== undefined && !entry.searchSkipped) {
      entry.searchFrom = this.search.beginFile(
        searchKeyOf(entry), {
          size: this.db?.maxRowId(state.row.id) ?? state.maxRowId,
          mtimeMs: state.row.last_activity_at * 1000,
        },
      )
    }
    state.book.emitTo(session, { type: 'file', file: entry.ref })
    return entry
  }

  /**
   * Append `line` (the node's wire form, or a tagged variant such as the
   * ancestor flush's `kept` line) to `entry`'s stream: advance counters,
   * feed the meta scanner, and queue it for search when fresh.
   */
  private emitLine(
    state: DevinSessionState,
    entry: DevinEntry,
    node: StoredNode,
    indexable: boolean,
    line: string,
  ): void {
    // Lines are not retained: counters track the stream's position and a
    // replay re-derives content from the store on demand.
    entry.lines += 1
    entry.size += line.length + 1
    entry.mtimeMs = Math.max(entry.mtimeMs, node.time)
    entry.meta?.push(line)
    if (
      state.live && indexable && !entry.searchSkipped && this.search !== undefined
      && entry.lines - 1 >= entry.searchFrom
    ) {
      this.search.queue(searchKeyOf(entry), entry.lines - 1, line)
    }
  }

  /**
   * Fan a materialization batch out to subscribers as chunked `lines` events
   * (one event per contiguous run per stream). A
   * replay state just collects them for `readAll` instead.
   */
  private flushBatch(state: DevinSessionState, emitted: Map<DevinEntry, string[]>): void {
    for (const [entry, lines] of emitted) {
      const startLine = entry.lines - lines.length
      if (state.replay !== undefined) {
        const list = state.replay.get(entry)
        if (list === undefined) state.replay.set(entry, [...lines])
        else list.push(...lines)
        continue
      }
      for (let offset = 0; offset < lines.length; offset += CHUNK_LINES) {
        state.book.emitTo(state.session, {
          type: 'lines',
          file: entry.ref,
          lines: lines.slice(offset, offset + CHUNK_LINES),
          startLine: startLine + offset,
        })
      }
    }
  }

  private noteSearchProgress(state: DevinSessionState): void {
    if (!state.live || this.search === undefined) return
    const entries = [state.session.main, ...state.session.children.values()]
    for (const entry of entries) {
      if (entry === null || entry.searchSkipped) continue
      this.search.noteProgress(searchKeyOf(entry), {
        size: state.maxRowId,
        // Listing activity includes message timestamps; restart validation
        // must use the same source timestamp before and after reconstruction.
        mtimeMs: state.row.last_activity_at * 1000,
        indexedBytes: entry.size,
        indexedLines: entry.lines,
      })
    }
  }

  /**
   * Consume the rows appended since `state.maxRowId`. `full` rebuilds from
   * scratch after a structural merge voided emitted attributions.
   */
  private materialize(state: DevinSessionState, full = false): void {
    if (this.db === null) return
    // A flagged state's derived maps are unreliable — force the rebuild no
    // matter which caller asked. Any throw below left partial batch state
    // (`state.nodes` already holds rows that never emitted — an incremental
    // retry would see `fresh` empty and skip them forever), so flag it and
    // let the next materialize rebuild rather than resume.
    if (state.needsRebuild) full = true
    const fromCatalog = state.catalogFingerprint !== null
    if (fromCatalog) {
      // Access may beat the next poll. Validate again before trusting the
      // cached line numbers, and pick up claims that landed in the meantime.
      state.row = this.db.sessions().find(row => row.id === state.row.id) ?? state.row
      full ||= catalogFingerprint(this.db, this.dbSig, state.row) !== state.catalogFingerprint
      state.heads = new Map(this.db.subagentHeads(state.row.id).map(head => [head.chain_node_id, head.agent_id]))
    }
    state.catalogFingerprint = null
    try {
      this.materializeRows(state, full || fromCatalog, fromCatalog && !full)
      this.noteSearchProgress(state)
      state.needsRebuild = false
    } catch (error) {
      state.needsRebuild = true
      throw error
    }
  }

  private materializeRows(state: DevinSessionState, full: boolean, preserveSearch = false): void {
    const db = this.db
    if (db === null) return
    if (full) {
      state.groups = new ChainGroups()
      state.midAnchor.clear()
      state.emitted.clear()
      state.epochs.clear()
      state.nodes.clear()
      state.pending.clear()
      state.taskNodes.clear()
      state.inferredAgents.clear()
      state.maxRowId = 0
      // `file reset` makes subscribers refold from empty, so every fact
      // folded from the old rows must re-derive: rebuild each meta scanner
      // (promptCount, mid-dedup, prompt title) and drop the tool/sidecar
      // dedup state so those lines re-emit.
      state.toolFingerprints.clear()
      state.sidecarKey = null
      for (const entry of [state.session.main, ...state.session.children.values()]) {
        if (entry === null) continue
        entry.lines = 0
        entry.size = 0
        entry.searchFrom = 0
        if (state.live) {
          if (preserveSearch) {
            entry.searchFrom = this.search?.beginFile(searchKeyOf(entry), {
              size: db.maxRowId(state.row.id), mtimeMs: state.row.last_activity_at * 1000,
            }) ?? 0
          } else {
            this.search?.reset(entry.path)
          }
          entry.meta = createMetaScanner(
            KIND, entry === state.session.main ? sessionSeed(state.row) : null,
          )
          state.book.emitTo(state.session, { type: 'file', file: entry.ref, reset: true })
        }
      }
      // Lines collected so far are re-derived with the rest of the batch —
      // counters restarted, so keeping them would ship them twice. Today the
      // map is provably empty here (the union conflicts that trigger `full`
      // surface in pass 1, before any flush); keep the invariant structural.
      state.replay?.clear()
      state.session.children.clear()
      for (const [path, entry] of state.book.files) {
        if (entry.sessionId === state.session.id && entry !== state.session.main) state.book.files.delete(path)
      }
    }
    const rows = state.replayRows ?? (full
      ? db.nodes(state.row.id)
      : db.nodesAfter(state.row.id, state.maxRowId))
    if (rows.length === 0) {
      // Heads can change without any new messages, including overriding an
      // inferred owner. Apply the same attribution check as a message batch.
      if (!this.inferTaskAgents(state)) this.materialize(state, true)
      return
    }
    if (state.maxRowId === 0) state.earliestNode = rows[0]?.node_id ?? 0
    const parsed = rows.map(row => this.parseNode(row))
    // Pass 1 — structure: parent + prior + identity edges before any line is
    // attributed, so a render committed in this batch is already merged.
    const fresh = new Set<number>()
    // message_id edges collected while scanning; applied only after every
    // structural edge of the batch landed, so each is judged on the batch's
    // complete prior structure.
    const midEdges: [number, number][] = []
    for (const node of parsed) {
      const { node_id, parent_node_id } = node.row
      // The CLI periodically rewrites a session's whole forest in one commit
      // (fresh row_ids, in node order — not an append). Content is keyed by
      // node_id: a row whose node_id already materialized is a rewrite copy —
      // its edges are idempotent and its line must not re-emit, or every
      // rewrite would append a whole extra generation to the stream.
      if (!state.nodes.has(node_id)) {
        fresh.add(node_id)
        state.nodes.set(node_id, DevinSource.storedOf(node))
      }
      state.groups.add(node_id)
      if (!state.groups.union(node_id, parent_node_id)) return this.materialize(state, true)
      for (const prior of node.priors) {
        state.groups.add(prior)
        // A prior edge joining two components is reliable lineage. When one
        // side was glued by an earlier message_id edge, the glue may have been
        // a shared object (another conversation's copy): the merge is
        // unsafe — re-materialize so the full pass judges it with all priors.
        if (
          state.groups.find(node_id) !== state.groups.find(prior)
          && (state.groups.hasMid(node_id) || state.groups.hasMid(prior))
        ) {
          return this.materialize(state, true)
        }
        if (!state.groups.union(node_id, prior)) return this.materialize(state, true)
        state.groups.markPrior(node_id)
      }
      // Identity edges come only from conversation messages. `system`-role
      // records are context objects — render prefixes, injected blocks, the
      // boilerplate prompt opening every subagent context — shared across
      // conversations by design, so one must never glue two lineages.
      if (node.messageId !== null && asString(node.record['role']) !== 'system') {
        const anchor = state.midAnchor.get(node.messageId)
        if (anchor !== undefined) midEdges.push([node_id, anchor])
        state.midAnchor.set(node.messageId, node_id)
      }
      // A spawn result names its chain: `subagent/chain_node_id` points at the
      // child tree's head. Learn it here so `childEntry` can name the file's
      // agent even when the chain's lines preceded the result. Spawn facts go
      // first so a node carrying all three extensions resolves in one pass.
      this.learnSpawnFacts(state, node)
      this.learnChainAgent(state, node)
      const meta = isRecord(node.record['metadata']) ? node.record['metadata'] : undefined
      if (node.record['role'] === 'user' && meta?.['is_user_input'] === true) {
        const content = node.record['content']
        const text = typeof content === 'string' ? content : (asArray(content) ?? [])
          .flatMap(part => isRecord(part) && part['type'] === 'text' ? [asString(part['text']) ?? ''] : [])
          .join('\n')
        if (text.trim() !== '') state.taskNodes.set(node_id, text)
      }
    }
    // Shared message_id is object identity, not conversation membership — the
    // same boilerplate object (the subagent system prompt is one mid) opens
    // every agent's context. Glue two components on a mid edge only when
    // neither has prior structure of its own: prior-equipped lineages decide
    // by their edges, and a mid reaching between them is a shared object.
    for (const [nodeId, anchor] of midEdges) {
      if (state.groups.find(nodeId) === state.groups.find(anchor)) continue
      if (state.groups.hasPrior(nodeId) || state.groups.hasPrior(anchor)) continue
      if (!state.groups.union(nodeId, anchor)) return this.materialize(state, true)
      state.groups.markMid(nodeId)
    }
    if (!this.inferTaskAgents(state)) return this.materialize(state, true)
    // Pass 2 — emit first occurrences in insertion order. Chains nothing has
    // claimed yet (context renders, compactor passes) buffer until a claim or
    // a merge into the main chain resolves them.
    this.drainPending(state)
    const emitted = new Map<DevinEntry, string[]>()
    for (const node of parsed) {
      // Store-rewrite copies never re-emit; the kept-copy re-emission past a
      // compaction boundary belongs to render nodes — always NEW node_ids.
      if (!fresh.has(node.row.node_id)) continue
      const stored = DevinSource.storedOf(node)
      const owner = this.isMainGroup(state, node.row.node_id)
        ? state.session.main
        : this.childEntry(state, stored)
      if (owner === null) {
        // Buffer per chain, never dedup here: two unclaimed lineages may
        // legitimately carry the same shared object (the boilerplate opener)
        // and each needs its own copy when its claim lands. Dedup runs at
        // emit time, where the owner is known (`tryEmitNode`).
        const root = state.groups.find(node.row.node_id)
        const list = state.pending.get(root)
        if (list === undefined) state.pending.set(root, [stored])
        else list.push(stored)
        continue
      }
      if (!this.tryEmitNode(state, owner, stored, emitted)) continue
    }
    if (emitted.size > 0) {
      this.flushBatch(state, emitted)
      if (state.live) this.emit('change', KIND, state.row.id)
    }
    // The watermark marks rows CONSUMED — it advances only after the whole
    // batch landed. A mid-batch throw must leave it behind so the next tick
    // refetches and retries these rows instead of skipping them.
    state.maxRowId = Math.max(state.maxRowId, rows[rows.length - 1]?.row_id ?? 0)
  }

  /**
   * Background receipts omit the chain id, but the delegated task is already
   * persisted as the child's first user message. Infer only a one-to-one exact
   * match across both spawns and independent chains. Render copies collapse by
   * lineage first; shared prompts and arbitrary later user text prove nothing.
   */
  private inferTaskAgents(state: DevinSessionState): boolean {
    const callsByTask = new Map<string, string[]>()
    for (const [callId, spawn] of state.spawnArgs) {
      if (spawn.task === null || spawn.task.trim() === '') continue
      const calls = callsByTask.get(spawn.task) ?? []
      calls.push(callId)
      callsByTask.set(spawn.task, calls)
    }
    const groupsByTask = new Map<string, Set<number>>()
    for (const [nodeId, task] of state.taskNodes) {
      if (!callsByTask.has(task) || this.isMainGroup(state, nodeId)) continue
      let parent = state.nodes.get(nodeId)?.parentId ?? null
      const seen = new Set<number>([nodeId])
      let opener = true
      while (parent !== null) {
        const ancestor = state.nodes.get(parent)
        const message = ancestor === undefined ? undefined : jsonString(ancestor.chatMessage)
        if (seen.has(parent) || !isRecord(message) || message['role'] !== 'system') {
          opener = false
          break
        }
        seen.add(parent)
        parent = ancestor?.parentId ?? null
      }
      if (!opener) continue
      const groups = groupsByTask.get(task) ?? new Set<number>()
      groups.add(state.groups.find(nodeId))
      groupsByTask.set(task, groups)
    }
    const explicit = new Map<number, string>()
    for (const [nodeId, facts] of state.chainAgent) explicit.set(state.groups.find(nodeId), facts.agentId)
    for (const [nodeId, agentId] of state.heads) explicit.set(state.groups.find(nodeId), agentId)
    const claimedAgents = new Set(explicit.values())
    const inferred = new Map<number, string>()
    for (const [task, calls] of callsByTask) {
      const callId = calls[0]
      const groups = groupsByTask.get(task)
      if (calls.length !== 1 || callId === undefined || groups?.size !== 1) continue
      const root = groups.values().next().value
      const agents = [...state.agentCall].filter(([, spawnId]) => spawnId === callId)
      const agentId = agents.length === 1 ? agents[0]?.[0] : undefined
      if (root === undefined || agentId === undefined || explicit.has(root) || claimedAgents.has(agentId)) continue
      inferred.set(root, agentId)
    }
    // A later conflicting claim or duplicate task can invalidate a fallback.
    // Rebuild before emitting more so live attribution agrees with fresh replay.
    for (const [nodeId, agentId] of state.inferredAgents) {
      const root = state.groups.find(nodeId)
      if ((explicit.get(root) ?? inferred.get(root)) !== agentId) return false
    }
    state.inferredAgents = inferred
    return true
  }

  /**
   * Flush buffered chain groups whose ownership resolved since they were
   * buffered: a `subagent/*` result or a `subagent_heads` row turns the group
   * into a child file that receives its backlog in order; a group that merged
   * into the main chain emits to the main stream (identity-deduplicated, like
   * every line there).
   */
  private drainPending(state: DevinSessionState): void {
    if (state.pending.size === 0) return
    const emitted = new Map<DevinEntry, string[]>()
    for (const [root, nodes] of [...state.pending]) {
      const first = nodes[0]
      if (first === undefined) {
        state.pending.delete(root)
        continue
      }
      const owner = this.isMainGroup(state, root)
        ? state.session.main
        : this.childEntry(state, first)
      if (owner === null) continue
      state.pending.delete(root)
      for (const node of nodes) {
        if (!this.tryEmitNode(state, owner, node, emitted)) continue
      }
    }
    if (emitted.size > 0) {
      this.flushBatch(state, emitted)
      this.noteSearchProgress(state)
      if (state.live) this.emit('change', KIND, state.row.id)
    }
  }

  /**
   * Emit `node`'s line to `owner` unless its dedup key already produced a line
   * for that stream in the stream's current compaction epoch. A key emitted
   * before the owner's latest summary re-emits once a summary has landed:
   * everything before a compaction leaves the rendered context, so a later
   * copy is a kept/rendered message the fold must re-count. Same-epoch
   * duplicates dedupe flat. Returns whether a line went out.
   */
  private tryEmitNode(
    state: DevinSessionState,
    owner: DevinEntry,
    node: StoredNode,
    emitted: Map<DevinEntry, string[]>,
  ): boolean {
    const key = node.messageId ?? `node:${node.nodeId}`
    const epoch = state.epochs.get(owner) ?? 0
    const owners = state.emitted.get(key)
    const prevEpoch = owners?.get(owner)
    if (prevEpoch === epoch) return false
    // A re-emission is a render's kept copy: real context for the fold, but
    // already indexed — queueing it again would double its search hits.
    const indexable = prevEpoch === undefined
    if (owners === undefined) state.emitted.set(key, new Map([[owner, epoch]]))
    else owners.set(owner, epoch)
    if (node.compaction && prevEpoch === undefined) {
      // Only the FIRST sighting of a summary mid on this stream opens an
      // epoch and flushes its ancestors; a later render's kept copy of that
      // same summary is content, not another boundary.
      state.epochs.set(owner, epoch + 1)
      this.emitRenderAncestors(state, owner, node, emitted)
    }
    state.groups.claim(node.nodeId, owner)
    const line = DevinSource.wireLine(node)
    this.emitLine(state, owner, node, indexable, line)
    const list = emitted.get(owner)
    if (list === undefined) emitted.set(owner, [line])
    else list.push(line)
    return true
  }

  /**
   * The render a summary closes out re-copied its kept context onto the
   * summary's own chain — its ancestors are those copies. They precede the
   * summary in row order, so same-epoch ones were skipped as duplicates and
   * older ones may already sit in `pending`: flush any not yet emitted at the
   * new epoch, oldest first, so the fold sees the render's full prefix and
   * kept injections. Every flushed line carries `"kept":1` — the wire marker
   * the synthesizer uses to exempt exactly this run from the summary's claim
   * (kept copies arriving as post-summary descendants are NOT tagged: the
   * next render's copies replace them, so they stay claimable).
   */
  private emitRenderAncestors(
    state: DevinSessionState,
    owner: DevinEntry,
    summary: StoredNode,
    emitted: Map<DevinEntry, string[]>,
  ): void {
    const epoch = state.epochs.get(owner) ?? 0
    const ancestors: StoredNode[] = []
    const guard = new Set<number>([summary.nodeId])
    let cur = summary.parentId
    while (cur !== null && !guard.has(cur)) {
      guard.add(cur)
      const anc = state.nodes.get(cur)
      if (anc === undefined) break
      ancestors.push(anc)
      cur = anc.parentId
    }
    for (const anc of ancestors.reverse()) {
      const key = anc.messageId ?? `node:${anc.nodeId}`
      const owners = state.emitted.get(key)
      if (owners?.get(owner) === epoch) continue
      const indexable = owners === undefined || owners.get(owner) === undefined
      if (owners === undefined) state.emitted.set(key, new Map([[owner, epoch]]))
      else owners.set(owner, epoch)
      state.groups.claim(anc.nodeId, owner)
      const line = DevinSource.wireLine(anc, true)
      this.emitLine(state, owner, anc, indexable, line)
      const list = emitted.get(owner)
      if (list === undefined) emitted.set(owner, [line])
      else list.push(line)
    }
  }

  // -- synthetic records ----------------------------------------------------

  private sidecarLine(state: DevinSessionState): { line: string; key: string } | null {
    const agents = [...state.session.children.values()].map(entry => ({
      id: entry.ref.agent?.agentId ?? entry.ref.id,
      fileId: entry.ref.id,
    }))
    const payload: Record<string, unknown> = {
      t: 'devin.session',
      sessionId: state.row.id,
      title: state.row.title,
      cwd: state.row.working_directory,
      model: state.row.model,
      agentMode: state.row.agent_mode,
      backend: state.row.backend_type,
      createdAt: state.row.created_at * 1000,
      agents,
    }
    const line = JSON.stringify(payload)
    const key = line
    return { line, key }
  }

  private toolLines(state: DevinSessionState): string[] {
    if (this.db === null) return []
    const lines: string[] = []
    for (const row of this.db.toolStates(state.row.id)) {
      const call = row.tool_call_json
      const update = row.tool_call_update_json
      lines.push(
        `{"t":"devin.tool","id":${JSON.stringify(row.tool_call_id)},`
        + `"time":${state.row.last_activity_at * 1000},`
        + `"call":${call ?? 'null'},"update":${update ?? 'null'}}`,
      )
    }
    return lines
  }

  /** Poll one session's tool-call table; changed rows emit a synthetic line. */
  private syncToolState(state: DevinSessionState): void {
    if (this.db === null || state.session.main === null) return
    let changed = false
    for (const row of this.db.toolStates(state.row.id)) {
      const fingerprint = `${row.tool_call_json?.length ?? -1}:${row.tool_call_update_json ?? ''}`
      if (state.toolFingerprints.get(row.tool_call_id) === fingerprint) continue
      state.toolFingerprints.set(row.tool_call_id, fingerprint)
      const line = `{"t":"devin.tool","id":${JSON.stringify(row.tool_call_id)},`
        + `"time":${state.row.last_activity_at * 1000},`
        + `"call":${row.tool_call_json ?? 'null'},"update":${row.tool_call_update_json ?? 'null'}}`
      this.book.emitTo(state.session, {
        type: 'lines', file: state.session.main.ref, lines: [line], startLine: -1,
      })
      changed = true
    }
    if (changed) this.emit('change', KIND, state.row.id)
  }

  /** Emit the facts sidecar when title/agents/etc. moved. */
  private syncSidecar(state: DevinSessionState): void {
    const sidecar = this.sidecarLine(state)
    if (sidecar === null || sidecar.key === state.sidecarKey) return
    state.sidecarKey = sidecar.key
    if (state.session.main !== null) {
      this.book.emitTo(state.session, {
        type: 'lines', file: state.session.main.ref, lines: [sidecar.line], startLine: -1,
      })
      this.book.emitTo(state.session, {
        type: 'meta',
        summary: this.book.summarize(state.session),
        children: this.book.childSummaries(state.session),
      })
    }
  }

  // -- polling ---------------------------------------------------------------

  private scheduleTick(): void {
    if (this.pollTimer !== null) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      this.tick().catch((error: unknown) => { this.emit('error', error) })
    }, 120)
  }

  /** One store poll (tests and manual refresh; the interval calls it too). */
  async refresh(): Promise<void> {
    await this.tick()
  }

  private async sweep(): Promise<void> {
    const db = this.db
    if (db === null) return
    const rows = this.sessionRows()
    if (rows === null) return
    for (const row of rows) {
      if (row.hidden !== 0) continue
      // A session that fails to materialize must not take the sweep down —
      // the rest still register, and the next tick retries this one (its
      // watermark never advanced).
      try {
        this.freshSession(db, row)
      } catch (error) {
        this.markBroken(row.id)
        this.emit('error', new Error(`devin session ${row.id} materialization failed`, { cause: error }))
      }
    }
    this.listing?.pruneCatalog(this.dbPath, new Set(rows.filter(row => row.hidden === 0).map(row => row.id)))
  }

  /** Flag the session for a full rebuild on its next materialize. */
  private markBroken(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (state !== undefined) state.needsRebuild = true
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    // The store can appear after start (Devin CLI installed, or its first
    // session created while the viewer is already up): a tick retries the
    // open, then sweeps once and announces the sessions it found.
    if (this.db === null) {
      if (!this.openDb()) return
      if (this.watchEnabled) this.attachWatcher()
      await this.sweep()
      for (const state of this.states.values()) this.emit('change', KIND, state.row.id)
      return
    }
    // A replace (atomic rename over the path, delete+recreate) changes the
    // file's identity — the open handle keeps serving the OLD file. Plain
    // mtime movement does not count: every commit touches it.
    const sig = this.fileSig()
    if (sig !== null && sig !== this.dbSig) {
      this.db.close()
      this.db = null
      // fs watchers track the inode, not the path — they are stale now.
      this.clearWatchers()
      // Keep `dbSig` as the baseline: `openDb` compares and resyncs all
      // derived state when the opened file is a different one.
      if (this.openDb()) {
        if (this.watchEnabled) this.attachWatcher()
        for (const state of this.states.values()) this.emit('change', KIND, state.row.id)
      }
      return
    }
    if (this.resyncPending && !this.resyncAll()) return
    this.resyncPending = false
    if (this.watchEnabled) this.attachWatcher()
    const db = this.db
    const rows = this.sessionRows()
    if (rows === null) return
    const seen = new Set<string>()
    for (const row of rows) {
      if (row.hidden !== 0) continue
      seen.add(row.id)
      try {
        // A session appearing between polls (created live, or un-hidden after a
        // drop) registers with `state.row` already equal to `row`, so `moved`
        // alone would never materialize it — it would list but stay empty.
        const fresh = !this.states.has(row.id)
        const state = this.register(row)
        if (state.catalogFingerprint !== null) {
          if (!state.needsRebuild && state.catalogFingerprint === catalogFingerprint(db, this.dbSig, row)) continue
          state.row = row
          state.heads = new Map(db.subagentHeads(row.id).map(head => [head.chain_node_id, head.agent_id]))
          this.materialize(state, true)
          this.syncToolState(state)
          this.syncSeedFacts(state)
          this.syncSidecar(state)
          this.emit('change', KIND, row.id)
          continue
        }
        const metaMoved = row.title !== state.row.title
          || row.main_chain_id !== state.row.main_chain_id
        const moved = metaMoved || row.last_activity_at !== state.row.last_activity_at
        const maxRow = db.maxRowId(row.id)
        const dropped = maxRow < state.maxRowId
        const grew = maxRow > state.maxRowId
        state.row = row
        if (state.session.main !== null) state.session.main.mtimeMs = row.last_activity_at * 1000
        this.syncSeedFacts(state)
        state.heads = new Map(db.subagentHeads(row.id).map(head => [head.chain_node_id, head.agent_id]))
        if (dropped || state.needsRebuild) {
          this.materialize(state, true)
          // The reset made subscribers refold; tool lines re-emit now that
          // their fingerprints were cleared with the rest of the batch state.
          this.syncToolState(state)
        } else if (fresh || moved || grew || this.book.hasSubscribers(KIND, row.id)) {
          this.materialize(state)
          this.syncToolState(state)
        }
        // A `subagent_heads` claim can land without new message rows.
        this.drainPending(state)
        this.syncSidecar(state)
        // A just-registered session with no rows yet emits nothing from
        // `materialize` — announce it so live list views pick it up.
        if (fresh || metaMoved) this.emit('change', KIND, row.id)
      } catch (error) {
        this.markBroken(row.id)
        this.emit('error', new Error(`devin session ${row.id} refresh failed`, { cause: error }))
      }
    }
    for (const state of [...this.states.values()]) {
      if (!seen.has(state.row.id)) this.drop(state)
    }
  }
}

/** The `sessions` row as meta-scanner seed: `devinMeta` reads facts off it. */
function sessionSeed(row: DevinSessionRow): Record<string, unknown> {
  return {
    title: row.title,
    cwd: row.working_directory,
    model: row.model,
    agentMode: row.agent_mode,
    backend: row.backend_type,
    createdAt: row.created_at * 1000,
  }
}
