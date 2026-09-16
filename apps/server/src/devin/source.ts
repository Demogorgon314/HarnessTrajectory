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
 * claimed — by a `subagent_heads` row or a spawn result's `subagent/*`
 * extensions. Unclaimed chains (context renders, compactor/summarizer passes)
 * buffer as `pending` and never appear: a claim drains the backlog in order,
 * a merge into the main chain drains it there.
 *
 * Chain membership (see db.ts header): a union-find over `parent_node_id`,
 * `compact/prior_node_ids` and shared `message_id`s groups render trees into
 * logical chains. A logical chain only ever grows — a render's links land in
 * one transaction — but if a union ever merges two groups that both already
 * emitted lines, the earlier attribution was wrong, so the session is
 * re-materialized with `file reset` (deterministic rebuild, cheap at this
 * size).
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
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { asString, isRecord, type HarnessKind, type SessionFileRef, type SessionLiveEvent } from '@harness-trajectory/core'
import { createMetaScanner } from '../meta.ts'
import type { SearchIndexer } from '../search/indexer.ts'
import {
  CHUNK_LINES, lineTimes, mergeChronologically, SessionBook, searchKeyOf, standaloneRef,
  type LineSource, type SessionSource, type SourceEntry, type SourceSession, type Subscriber,
} from '../source.ts'
import { DevinDb, type DevinNodeRow, type DevinSessionRow } from './db.ts'

const KIND: HarnessKind = 'devin'
const POLL_INTERVAL_MS = 1_500

export interface DevinSourceOptions {
  /** Absolute path of `sessions.db`. */
  dbPath: string
  search?: SearchIndexer | undefined
  /** Disable polling and file watching (tests). */
  watch?: boolean | undefined
  now?: (() => number) | undefined
}

interface DevinEntry extends SourceEntry {
  /** Lines emitted so far — replay reads them back. */
  buffered: string[]
  /** First line index that still needs search indexing (`beginFile`'s answer). */
  searchFrom: number
  /** Session aged past the retention window: browsable, but never queued. */
  searchSkipped: boolean
}

/**
 * Union-find over message nodes. Roots carry the entry already emitting the
 * group, so an emitted-lines merge is detectable. (The child file id comes
 * from the claiming agent id, not the group — see `childEntry`.)
 */
class ChainGroups {
  private readonly parent = new Map<number, number>()
  private readonly emitted = new Map<number, DevinEntry>()

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
  line: string
}

interface DevinSessionState {
  session: SourceSession<DevinEntry>
  row: DevinSessionRow
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
  /** node_id of the session's first row — the main-chain fallback root. */
  earliestNode: number
  /** node_id → parsed row, for walking a render chain's ancestry. */
  nodes: Map<number, ParsedNode>
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
  chainAgent: Map<number, { agentId: string; profile: string | null }>
  /**
   * Nodes of chain groups nothing has claimed yet (group root → rows, in row
   * order). Devin renders extra context chains — compactor and summarizer
   * passes — in the same forest, and only a spawn result's `subagent/*`
   * extensions (or a `subagent_heads` row) prove a group is a real agent
   * transcript. Unclaimed groups buffer here instead of becoming child files;
   * a group that merges into the main chain drains to the main stream, and a
   * never-claimed one stays invisible.
   */
  pending: Map<number, ParsedNode[]>
  /** Dedup keys of the nodes in `pending` (same vocabulary as `emitted`). */
  pendingKeys: Set<string>
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
  private readonly search: SearchIndexer | undefined
  private readonly watchEnabled: boolean
  private readonly now: () => number
  private readonly book = new SessionBook<DevinEntry>(() => this.now())
  private readonly states = new Map<string, DevinSessionState>()
  private db: DevinDb | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private watcher: FSWatcher | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** The last open attempt failed and was already reported — suppress repeats. */
  private openFailed = false

  constructor(options: DevinSourceOptions) {
    super()
    this.dbPath = options.dbPath
    this.search = options.search
    this.watchEnabled = options.watch !== false
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    this.openDb()
    await this.sweep()
    if (!this.watchEnabled) return
    this.poll = setInterval(() => {
      this.tick().catch((error: unknown) => { this.emit('error', error) })
    }, POLL_INTERVAL_MS)
    this.poll.unref()
    this.attachWatcher()
  }

  /**
   * (Re)open the store. A missing file is normal — Devin CLI may simply not
   * be installed yet — so it degrades silently and the poll retries; a file
   * that exists but will not open reports once per failure streak instead of
   * crashing the composite.
   */
  private openDb(): boolean {
    if (!existsSync(this.dbPath)) return false
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
    return true
  }

  /**
   * The WAL file's mtime moves on every commit; watch it for promptness and
   * let the debounced poll do the real work (WAL may not exist yet — retry
   * each tick is overkill, just watch the db file itself too).
   */
  private attachWatcher(): void {
    if (this.watcher !== null) return
    try {
      this.watcher = watch(this.dbPath, () => this.scheduleTick())
    } catch {
      this.watcher = null
    }
  }

  stop(): void {
    this.stopped = true
    if (this.poll !== null) clearInterval(this.poll)
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.watcher?.close()
    this.db?.close()
  }

  /** Streams this source feeds to the search index (its half of `finishBackfill`). */
  livePaths(): string[] {
    return [...this.book.files.values()].flatMap(entry => (entry.searchSkipped ? [] : [entry.path]))
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
    emit: (event: SessionLiveEvent) => void,
    fileId?: string,
  ): Promise<void> {
    if (kind !== KIND) return
    const state = this.states.get(id)
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
    for (const entry of entries) emit({ type: 'file', file: refOf(entry) })
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
    for (const entry of entries) {
      sources.push({ ref: refOf(entry), lines: entry.buffered, times: lineTimes(entry.buffered) })
    }
    for (const chunk of mergeChronologically(sources)) {
      emit({ type: 'lines', file: chunk.ref, lines: chunk.lines, startLine: chunk.startLine })
    }
    emit({ type: 'meta', summary: this.book.summarize(session), children: this.book.childSummaries(session) })
  }

  // -- discovery -----------------------------------------------------------

  private static sessionPath(id: string): string {
    return `devin://sessions/${id}`
  }

  private register(row: DevinSessionRow): DevinSessionState {
    const existing = this.states.get(row.id)
    if (existing !== undefined) return existing
    const session = this.book.sessionFor(KIND, row.id)
    const entry: DevinEntry = {
      kind: KIND,
      path: DevinSource.sessionPath(row.id),
      ref: { id: row.id, role: 'main', path: DevinSource.sessionPath(row.id) },
      sessionId: row.id,
      size: 0,
      mtimeMs: row.last_activity_at * 1000,
      lines: 0,
      meta: createMetaScanner(KIND, sessionSeed(row)),
      buffered: [],
      searchFrom: 0,
      searchSkipped: this.search !== undefined
        && !this.search.shouldIndex({ mtimeMs: row.last_activity_at * 1000 }),
    }
    session.main = entry
    this.book.files.set(entry.path, entry)
    const state: DevinSessionState = {
      session,
      row,
      groups: new ChainGroups(),
      midAnchor: new Map(),
      emitted: new Map(),
      epochs: new Map(),
      maxRowId: 0,
      earliestNode: 0,
      nodes: new Map(),
      toolFingerprints: new Map(),
      sidecarKey: null,
      heads: new Map(),
      chainAgent: new Map(),
      pending: new Map(),
      pendingKeys: new Set(),
    }
    this.states.set(row.id, state)
    if (this.search !== undefined && !entry.searchSkipped) {
      // The row watermark stands in for file size: monotonic while the store
      // appends, lower after a rebuild — exactly what `beginFile` checks.
      const maxRow = this.db?.maxRowId(row.id) ?? 0
      entry.searchFrom = this.search.beginFile(
        searchKeyOf(entry), { size: maxRow, mtimeMs: entry.mtimeMs },
      )
    }
    return state
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
    const priors: number[] = []
    for (const bag of [ext['compact/prior_node_ids'], msgExt]) {
      const list = isRecord(bag) ? bag['compact/prior_node_ids'] : undefined
      if (Array.isArray(list)) {
        for (const value of list) if (typeof value === 'number') priors.push(value)
      }
    }
    const compaction = msgExt['devin-rs/summary'] !== undefined || ext['devin-rs/summary'] !== undefined
    const metaCreated = Date.parse(asString(meta['created_at']) ?? '')
    const time = Number.isNaN(metaCreated) ? row.created_at * 1000 : metaCreated
    const messageId = asString(record['message_id']) ?? null
    // The raw chat_message JSON rides the line verbatim — the adapter and the
    // extractors parse it once, client side.
    const line = `{"t":"devin.msg","node":${row.node_id},`
      + `"parent":${row.parent_node_id === null ? 'null' : row.parent_node_id},`
      + `"time":${time},"msg":${row.chat_message}}`
    return { row, record, messageId, priors, compaction, time, line }
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
    const profile = asString(ext?.['subagent/profile_name']) ?? null
    if (!state.chainAgent.has(chainNode)) state.chainAgent.set(chainNode, { agentId, profile })
    const entry = state.groups.entryOf(chainNode)
    if (entry === undefined || entry === state.session.main || entry.ref.agent?.agentId === agentId) return
    entry.ref = {
      ...entry.ref,
      agent: { ...entry.ref.agent, agentId, ...(profile === null ? {} : { agentType: profile }) },
    }
    this.book.emitTo(state.session, { type: 'file', file: entry.ref })
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

  private childEntry(state: DevinSessionState, node: ParsedNode): DevinEntry | null {
    const session = state.session
    // A subagent chain is named by `subagent_heads` when populated, else by the
    // `subagent/*` extensions on the result of the call that spawned it.
    const named = [...state.heads.entries()].find(([chainNode]) =>
      state.groups.find(chainNode) === state.groups.find(node.row.node_id))
    const learned = [...state.chainAgent.entries()].find(([chainNode]) =>
      state.groups.find(chainNode) === state.groups.find(node.row.node_id))
    const agentId = named?.[1] ?? learned?.[1].agentId
    if (agentId === undefined) return null
    // The file is named by the claimed agent id, not a row-derived group key:
    // the key depends on WHICH members were visible at claim time (a pending
    // chain drains under whatever group existed then), while the agent id is
    // identical for a fresh scan, a live poll, and a restart.
    const fileId = `agent-${agentId}`
    const existing = session.children.get(fileId)
    if (existing !== undefined) return existing
    const path = `${DevinSource.sessionPath(session.id)}/${fileId}`
    const profile = learned?.[1].profile
    const entry: DevinEntry = {
      kind: KIND,
      path,
      ref: {
        id: fileId, role: 'child', path, parentId: session.id,
        agent: {
          agentId,
          ...(profile === null || profile === undefined ? {} : { agentType: profile }),
        },
      },
      sessionId: session.id,
      size: 0,
      mtimeMs: node.time,
      lines: 0,
      meta: createMetaScanner(KIND),
      buffered: [],
      searchFrom: 0,
      searchSkipped: this.search !== undefined
        && !this.search.shouldIndex({ mtimeMs: state.row.last_activity_at * 1000 }),
    }
    session.children.set(fileId, entry)
    this.book.files.set(path, entry)
    if (this.search !== undefined && !entry.searchSkipped) {
      entry.searchFrom = this.search.beginFile(
        searchKeyOf(entry), { size: state.maxRowId, mtimeMs: entry.mtimeMs },
      )
    }
    this.book.emitTo(session, { type: 'file', file: entry.ref })
    return entry
  }

  /**
   * Append `line` (the node's wire form, or a tagged variant such as the
   * ancestor flush's `kept` line) to `entry`'s stream: buffer for replay,
   * feed the meta scanner, and queue it for search when fresh.
   */
  private emitLine(
    state: DevinSessionState,
    entry: DevinEntry,
    node: ParsedNode,
    indexable = true,
    line = node.line,
  ): void {
    entry.buffered.push(line)
    entry.lines = entry.buffered.length
    entry.size += line.length + 1
    entry.mtimeMs = Math.max(entry.mtimeMs, node.time)
    entry.meta?.push(line)
    if (
      indexable && !entry.searchSkipped && this.search !== undefined
      && entry.buffered.length - 1 >= entry.searchFrom
    ) {
      this.search.queue(searchKeyOf(entry), entry.buffered.length - 1, line)
    }
  }

  /**
   * Fan a materialization batch out to subscribers as chunked `lines` events
   * (one event per contiguous run per stream) and record search progress.
   */
  private flushBatch(state: DevinSessionState, emitted: Map<DevinEntry, string[]>): void {
    for (const [entry, lines] of emitted) {
      const startLine = entry.buffered.length - lines.length
      for (let offset = 0; offset < lines.length; offset += CHUNK_LINES) {
        this.book.emitTo(state.session, {
          type: 'lines',
          file: entry.ref,
          lines: lines.slice(offset, offset + CHUNK_LINES),
          startLine: startLine + offset,
        })
      }
      if (!entry.searchSkipped) {
        this.search?.noteProgress(searchKeyOf(entry), {
          size: state.maxRowId,
          mtimeMs: entry.mtimeMs,
          indexedBytes: entry.size,
          indexedLines: entry.lines,
        })
      }
    }
  }

  /**
   * Consume the rows appended since `state.maxRowId`. `full` rebuilds from
   * scratch after a structural merge voided emitted attributions.
   */
  private materialize(state: DevinSessionState, full = false): void {
    if (this.db === null) return
    if (full) {
      state.groups = new ChainGroups()
      state.midAnchor.clear()
      state.emitted.clear()
      state.epochs.clear()
      state.nodes.clear()
      state.pending.clear()
      state.pendingKeys.clear()
      state.maxRowId = 0
      for (const entry of [state.session.main, ...state.session.children.values()]) {
        if (entry === null) continue
        entry.buffered = []
        entry.lines = 0
        entry.size = 0
        entry.searchFrom = 0
        this.search?.reset(entry.path)
        this.book.emitTo(state.session, { type: 'file', file: entry.ref, reset: true })
      }
      state.session.children.clear()
      for (const [path, entry] of this.book.files) {
        if (entry.sessionId === state.session.id && entry !== state.session.main) this.book.files.delete(path)
      }
    }
    const rows = full ? this.db.nodes(state.row.id) : this.db.nodesAfter(state.row.id, state.maxRowId)
    if (rows.length === 0) return
    if (state.maxRowId === 0) state.earliestNode = rows[0]?.node_id ?? 0
    state.maxRowId = Math.max(state.maxRowId, rows[rows.length - 1]?.row_id ?? 0)
    const parsed = rows.map(row => this.parseNode(row))
    // Pass 1 — structure: parent + prior + identity edges before any line is
    // attributed, so a render committed in this batch is already merged.
    const fresh = new Set<number>()
    for (const node of parsed) {
      const { node_id, parent_node_id } = node.row
      // The CLI periodically rewrites a session's whole forest in one commit
      // (fresh row_ids, in node order — not an append). Content is keyed by
      // node_id: a row whose node_id already materialized is a rewrite copy —
      // its edges are idempotent and its line must not re-emit, or every
      // rewrite would append a whole extra generation to the stream.
      if (!state.nodes.has(node_id)) {
        fresh.add(node_id)
        state.nodes.set(node_id, node)
      }
      state.groups.add(node_id)
      if (!state.groups.union(node_id, parent_node_id)) return this.materialize(state, true)
      for (const prior of node.priors) {
        state.groups.add(prior)
        if (!state.groups.union(node_id, prior)) return this.materialize(state, true)
      }
      if (node.messageId !== null) {
        const anchor = state.midAnchor.get(node.messageId)
        if (anchor !== undefined && !state.groups.union(node_id, anchor)) {
          return this.materialize(state, true)
        }
        state.midAnchor.set(node.messageId, node_id)
      }
      // A spawn result names its chain: `subagent/chain_node_id` points at the
      // child tree's head. Learn it here so `childEntry` can name the file's
      // agent even when the chain's lines preceded the result.
      this.learnChainAgent(state, node)
    }
    // Pass 2 — emit first occurrences in insertion order. Chains nothing has
    // claimed yet (context renders, compactor passes) buffer until a claim or
    // a merge into the main chain resolves them.
    this.drainPending(state)
    const emitted = new Map<DevinEntry, string[]>()
    for (const node of parsed) {
      // Store-rewrite copies never re-emit; the kept-copy re-emission past a
      // compaction boundary belongs to render nodes — always NEW node_ids.
      if (!fresh.has(node.row.node_id)) continue
      const owner = this.isMainGroup(state, node.row.node_id)
        ? state.session.main
        : this.childEntry(state, node)
      if (owner === null) {
        const key = node.messageId ?? `node:${node.row.node_id}`
        if (state.pendingKeys.has(key)) continue
        state.pendingKeys.add(key)
        const root = state.groups.find(node.row.node_id)
        const list = state.pending.get(root)
        if (list === undefined) state.pending.set(root, [node])
        else list.push(node)
        continue
      }
      if (!this.tryEmitNode(state, owner, node, emitted)) continue
    }
    if (emitted.size > 0) {
      this.flushBatch(state, emitted)
      this.emit('change', KIND, state.row.id)
    }
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
        const key = node.messageId ?? `node:${node.row.node_id}`
        state.pendingKeys.delete(key)
        if (!this.tryEmitNode(state, owner, node, emitted)) continue
      }
    }
    if (emitted.size > 0) {
      this.flushBatch(state, emitted)
      this.emit('change', KIND, state.row.id)
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
    node: ParsedNode,
    emitted: Map<DevinEntry, string[]>,
  ): boolean {
    const key = node.messageId ?? `node:${node.row.node_id}`
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
    state.groups.claim(node.row.node_id, owner)
    this.emitLine(state, owner, node, indexable)
    const list = emitted.get(owner)
    if (list === undefined) emitted.set(owner, [node.line])
    else list.push(node.line)
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
    summary: ParsedNode,
    emitted: Map<DevinEntry, string[]>,
  ): void {
    const epoch = state.epochs.get(owner) ?? 0
    const ancestors: ParsedNode[] = []
    const guard = new Set<number>([summary.row.node_id])
    let cur = summary.row.parent_node_id
    while (cur !== null && !guard.has(cur)) {
      guard.add(cur)
      const anc = state.nodes.get(cur)
      if (anc === undefined) break
      ancestors.push(anc)
      cur = anc.row.parent_node_id
    }
    for (const anc of ancestors.reverse()) {
      const key = anc.messageId ?? `node:${anc.row.node_id}`
      const owners = state.emitted.get(key)
      if (owners?.get(owner) === epoch) continue
      const indexable = owners === undefined || owners.get(owner) === undefined
      if (owners === undefined) state.emitted.set(key, new Map([[owner, epoch]]))
      else owners.set(owner, epoch)
      state.groups.claim(anc.row.node_id, owner)
      const line = `{"t":"devin.msg","node":${anc.row.node_id},`
        + `"parent":${anc.row.parent_node_id === null ? 'null' : anc.row.parent_node_id},`
        + `"time":${anc.time},"kept":1,"msg":${anc.row.chat_message}}`
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
    if (this.db === null) return
    for (const row of this.db.sessions()) {
      if (row.hidden !== 0) continue
      const state = this.register(row)
      state.row = row
      state.heads = new Map(this.db.subagentHeads(row.id).map(head => [head.chain_node_id, head.agent_id]))
      this.materialize(state)
      // History tools arrive in replay; only track their fingerprints live.
      for (const tool of this.db.toolStates(row.id)) {
        state.toolFingerprints.set(
          tool.tool_call_id,
          `${tool.tool_call_json?.length ?? -1}:${tool.tool_call_update_json ?? ''}`,
        )
      }
      this.syncSidecar(state)
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    // The store can appear after start (Devin CLI installed, or its first
    // session created while the viewer is already up): a tick retries the
    // open, then sweeps once and announces the sessions it found.
    if (this.db === null) {
      if (!this.openDb()) return
      this.attachWatcher()
      await this.sweep()
      for (const state of this.states.values()) this.emit('change', KIND, state.row.id)
      return
    }
    let rows: DevinSessionRow[]
    try {
      rows = this.db.sessions()
    } catch (error) {
      this.emit('error', error)
      return
    }
    const seen = new Set<string>()
    for (const row of rows) {
      if (row.hidden !== 0) continue
      seen.add(row.id)
      // A session appearing between polls (created live, or un-hidden after a
      // drop) registers with `state.row` already equal to `row`, so `moved`
      // alone would never materialize it — it would list but stay empty.
      const fresh = !this.states.has(row.id)
      const state = this.register(row)
      const moved = row.last_activity_at !== state.row.last_activity_at
        || row.main_chain_id !== state.row.main_chain_id
        || row.title !== state.row.title
      const dropped = this.db.maxRowId(row.id) < state.maxRowId
      state.row = row
      if (state.session.main !== null) state.session.main.mtimeMs = row.last_activity_at * 1000
      state.heads = new Map(this.db.subagentHeads(row.id).map(head => [head.chain_node_id, head.agent_id]))
      if (dropped) {
        this.materialize(state, true)
      } else if (fresh || moved || this.book.hasSubscribers(KIND, row.id)) {
        this.materialize(state)
        this.syncToolState(state)
      }
      // A `subagent_heads` claim can land without new message rows.
      this.drainPending(state)
      this.syncSidecar(state)
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
