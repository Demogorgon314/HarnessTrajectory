/**
 * Session index: discovers transcript files under each harness root, keeps
 * listing metadata, watches for appends, and fans live lines out to subscribers.
 */

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  asArray, asString, isRecord, GROK_SIDECAR_METHOD,
  type AgentFileMeta, type HarnessKind, type SessionChildSummary, type SessionDetail, type SessionFileRef,
  type SessionLiveEvent, type SessionSummary,
} from '@harness-trajectory/core'
import { createMetaScanner, readHead, type MetaScanner } from './meta.ts'
import type { HarnessRoot } from './roots.ts'
import type { SearchIndexer } from './search/indexer.ts'
import type { SearchFileKey } from './search/store.ts'
import { readFirstLine, readLines } from './tail.ts'

const LIVE_WINDOW_MS = 2 * 60_000
const WATCH_DEBOUNCE_MS = 120
const POLL_INTERVAL_MS = 1_500
const CHUNK_LINES = 400
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

interface FileEntry {
  kind: HarnessKind
  path: string
  ref: SessionFileRef
  /** Owning session id (`ref.id` for main files, the parent id for children). */
  sessionId: string
  size: number
  mtimeMs: number
  /** Byte offset up to which lines have been consumed. */
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
}

interface SessionRecord {
  kind: HarnessKind
  id: string
  main: FileEntry | null
  children: Map<string, FileEntry>
}

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
  /** Files registered concurrently during the startup sweep; 1 for a strict order. */
  backfillConcurrency?: number
}

type Subscriber = (event: SessionLiveEvent) => void

function sessionKey(kind: HarnessKind, id: string): string {
  return `${kind} ${id}`
}

/** Identify the transcript role of a file from its path; `null` when it is not a transcript. */
export function classifyPath(
  kind: HarnessKind,
  root: string,
  path: string,
): { id: string; role: 'main' | 'child'; parentId?: string } | null {
  if (!path.endsWith('.jsonl')) return null
  const rel = relative(root, path)
  if (rel.startsWith('..')) return null
  const name = basename(path, '.jsonl')
  const parts = rel.split(sep)
  if (kind === 'claude') {
    // <slug>/<uuid>.jsonl, <slug>/agent-<id>.jsonl, <slug>/<uuid>/subagents/agent-<id>.jsonl
    if (parts.length === 2) {
      return name.startsWith('agent-') ? { id: name, role: 'child' } : { id: name, role: 'main' }
    }
    const owner = parts[1]
    if (parts.length === 4 && parts[2] === 'subagents' && owner !== undefined) {
      return { id: `${owner}/${name}`, role: 'child', parentId: owner }
    }
    if (parts.length === 3 && owner !== undefined && name.startsWith('agent-')) {
      return { id: `${owner}/${name}`, role: 'child', parentId: owner }
    }
    return null
  }
  if (kind === 'codex') {
    // YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl; identity comes from session_meta.
    if (!name.startsWith('rollout-')) return null
    const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name)
    return { id: match?.[1] ?? name, role: 'main' }
  }
  if (kind === 'kimi') {
    // <workspace>/session_<id>/agents/<agentId>/wire.jsonl — identity is entirely path-derived.
    if (parts.length !== 5 || parts[2] !== 'agents' || name !== 'wire') return null
    const sessionId = parts[1]
    const agentId = parts[3]
    if (sessionId === undefined || sessionId === '' || agentId === undefined || agentId === '') return null
    return agentId === 'main'
      ? { id: sessionId, role: 'main' }
      : { id: agentId, role: 'child', parentId: sessionId }
  }
  if (kind === 'grok') {
    // <encoded-cwd>/<session-id>/updates.jsonl is the only transcript grok
    // writes (GROK-FORMAT §A.2, §C.0): `chat_history.jsonl` is a derived cache,
    // `events.jsonl` is telemetry, `rewind_points.jsonl` a side store, and the
    // cwd-level `prompt_history.jsonl` sits one level up. Session id is the
    // directory name (a UUIDv7); the role is provisional, because a child
    // session is a top-level directory too and only `summary.json` tells them
    // apart (GROK-FORMAT §D.2, §D.5 — see `SessionIndex.register`).
    if (parts.length !== 3 || name !== 'updates') return null
    const sessionId = parts[1]
    if (sessionId === undefined || sessionId === '') return null
    return { id: sessionId, role: 'main' }
  }
  return null
}

export class SessionIndex extends EventEmitter {
  private readonly roots: readonly HarnessRoot[]
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly files = new Map<string, FileEntry>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  /**
   * Grok child → parent bindings read from `<parent>/subagents/<childId>/meta.json`.
   * A grok child is a top-level session directory that names no parent of its
   * own, so this map is the only way a child registered before (or far away
   * from) its parent finds it (GROK-FORMAT §D.2, §D.3).
   */
  private readonly grokChildren = new Map<string, GrokChildBinding>()
  /** Bumped whenever a new grok binding is learned; see `grokParentOf`. */
  private grokGeneration = 0
  /** Grok root → the generation its whole-root sweep ran at (negative cache). */
  private readonly grokSwept = new Map<string, number>()
  private readonly watchers: FSWatcher[] = []
  private readonly pending = new Map<string, NodeJS.Timeout>()
  private poll: NodeJS.Timeout | null = null
  private readonly watchEnabled: boolean
  private readonly backfillConcurrency: number
  private readonly now: () => number
  private readonly search: SearchIndexer | undefined
  private stopped = false

  constructor(options: SessionIndexOptions) {
    super()
    this.roots = options.roots
    this.watchEnabled = options.watch ?? true
    this.backfillConcurrency = Math.max(1, options.backfillConcurrency ?? BACKFILL_CONCURRENCY)
    this.now = options.now ?? Date.now
    this.search = options.search
  }

  async start(): Promise<void> {
    this.stopped = false
    // Walk every root first so the search UI can show N/M from the first file,
    // instead of a total that jumps each time a harness directory is entered.
    const planned: { root: HarnessRoot; path: string; mtimeMs: number }[] = []
    for (const root of this.roots) {
      if (this.stopped) return
      const paths = (await walk(root.dir)).filter(path => classifyPath(root.kind, root.dir, path) !== null)
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
    // Everything on disk has been seen: commit the backfill and forget the
    // files that are gone. Files the retention window skips are not live for
    // the index either, so rows an earlier run stored for them are dropped
    // here. Only now does search report itself as ready.
    this.search?.finishBackfill(
      [...this.files.values()].flatMap(entry => (entry.searchSkipped ? [] : [entry.path])),
    )
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
    this.search?.stop()
  }

  /** Re-stat one path (tests and manual refresh). */
  async refreshPath(path: string): Promise<void> {
    const root = this.rootFor(path)
    if (root !== undefined) await this.refresh(root, path)
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

  /** Whether a session has a child transcript with this id. */
  hasChild(kind: HarnessKind, id: string, fileId: string): boolean {
    return this.sessions.get(sessionKey(kind, id))?.children.has(fileId) === true
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
    emit: (event: SessionLiveEvent) => void,
    fileId?: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionKey(kind, id))
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
    for (const entry of entries) emit({ type: 'file', file: refOf(entry) })
    const sources = await Promise.all(entries.map(async (entry) => {
      // Read up to the index's consumed offset; live events cover the rest.
      const lines = await readWholeFile(entry.path, entry.offset)
      // Grok's session facts, system prompt and tool schemas live beside the
      // transcript, so one synthetic line carries them into the fold
      // (GROK-DESIGN §3). Its `timestamp` is the session's creation instant, so
      // the chronological merge keeps it first.
      const sidecar = entry.kind === 'grok' ? await readGrokSidecar(entry.path, entry.ref.id) : undefined
      // The replay carries these facts, so a live tick only re-sends them when
      // they actually differ from what this view already folded.
      if (sidecar !== undefined) entry.sidecarKey = sidecar.key
      const all = sidecar === undefined ? lines : [sidecar.line, ...lines]
      // The sidecar is in no file, so it takes no line index: the merge keeps it
      // in its own chunk and the first real line of the file is still line 0.
      return {
        ref: refOf(entry),
        lines: all,
        times: lineTimes(all),
        ...(sidecar === undefined ? {} : { synthetic: 1 }),
      }
    }))
    for (const chunk of mergeChronologically(sources)) {
      emit({ type: 'lines', file: chunk.ref, lines: chunk.lines, startLine: chunk.startLine })
    }
    emit({ type: 'meta', summary: this.summarize(session), children: this.childSummaries(session) })
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

  // -- discovery -----------------------------------------------------------

  /**
   * Add a transcript to the index. During the initial scan its content only
   * feeds the metadata; a file that appears later (a subagent transcript of a
   * session someone is watching) is announced and its lines are forwarded.
   */
  private async register(root: HarnessRoot, path: string, initial = false): Promise<FileEntry | undefined> {
    const classified = classifyPath(root.kind, root.dir, path)
    if (classified === null) return undefined
    let info
    try {
      info = await stat(path)
    } catch {
      return undefined
    }
    if (!info.isFile()) return undefined
    let id = classified.id
    let parentId = classified.parentId
    // Codex identity lives in `session_meta`; a Claude child names its parent in its first record.
    // Kimi needs no probe: `classifyPath` already derived both ids from the path.
    if (root.kind === 'codex' || (root.kind === 'claude' && classified.role === 'child')) {
      try {
        const head = readHead(root.kind, await readFirstLine(path))
        if (root.kind === 'codex') {
          id = head.id ?? id
          parentId = head.parentId ?? undefined
        } else if (parentId === undefined) {
          parentId = head.id ?? undefined
        }
      } catch {
        // Unreadable head: keep the path-derived identity.
      }
    }
    // Grok's role is not path-derived: a child session is a top-level directory
    // like any other and only `summary.json` says otherwise (GROK-DESIGN §2).
    let agent: AgentFileMeta | undefined
    let grokSummary: Record<string, unknown> | null = null
    let grokUnresolved = false
    if (root.kind === 'grok') {
      const probe = await this.probeGrokFile(root, path, id)
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
    }
    const entry: FileEntry = {
      kind: root.kind,
      path,
      ref,
      sessionId,
      size: 0,
      mtimeMs: info.mtimeMs,
      offset: 0,
      rest: '',
      lines: 0,
      consuming: false,
      consumePending: undefined,
      searchFrom: 0,
      searchSkipped: false,
      meta: role === 'main' ? createMetaScanner(root.kind, grokSummary) : null,
      ...(root.kind === 'grok' ? { summaryTitle: grokSummaryTitle(grokSummary) } : {}),
      ...(grokUnresolved && role === 'main' ? { grokUnresolved: true } : {}),
    }
    if (this.files.has(path)) return this.files.get(path)
    this.files.set(path, entry)
    const session = this.sessionFor(root.kind, sessionId)
    if (role === 'main') session.main = entry
    else session.children.set(id, entry)
    if (role === 'child' && !initial) this.emitTo(session, { type: 'file', file: ref })
    // The meta scanner always replays from byte 0 (its state is in memory only);
    // the search index answers with the first line it has not stored yet.
    // A transcript untouched for longer than the retention window stays
    // browsable but out of the index; the next start reconsiders it under its
    // then-current mtime and settings.
    entry.searchSkipped = this.search !== undefined && !this.search.shouldIndex({ mtimeMs: info.mtimeMs })
    entry.searchFrom = entry.searchSkipped
      ? 0
      : this.search?.beginFile(searchKeyOf(entry), { size: info.size, mtimeMs: info.mtimeMs }) ?? 0
    await this.consumeInitial(entry, info.size, info.mtimeMs, initial)
    await this.syncKimiTitle(entry)
    await this.syncGrokSummary(entry, true)
    return entry
  }

  /**
   * Decide whether a grok session directory is a subagent child and bind it to
   * its parent (GROK-DESIGN §2).
   *
   * The marker is `summary.json`: `hidden === true`, else a `session_kind`
   * starting with `subagent` — a prefix match, since the flavors are
   * `subagent`, `subagent_fork` and `subagent_resume` (GROK-FORMAT §D.5).
   * The parent is named by `<parentDir>/subagents/<childId>/meta.json`, which
   * carries the run's facts too; `summary.parent_session_id` is a fallback only
   * for a `subagent_fork`, because on a `subagent_resume` it points at the
   * previous CHILD rather than at the real parent. A child that binds to
   * neither registers as a main session — an orphan is better than an
   * invisible one.
   *
   * The parsed `summary.json` comes back with the verdict: it is also the
   * listing metadata (`createMetaScanner`), so the file is read exactly once
   * per registration.
   */
  private async probeGrokFile(root: HarnessRoot, path: string, id: string): Promise<GrokProbe> {
    const sessionDir = dirname(path)
    const summary = await readJsonRecord(join(sessionDir, 'summary.json'))
    if (summary === null || !isGrokChildSummary(summary)) {
      // A main session (or one whose summary is not written yet): publish its
      // bindings so its children resolve from the cache however far away (and
      // however much later) they are registered.
      await this.cacheGrokBindings(sessionDir)
      return { summary, child: false }
    }
    const binding = await this.grokParentOf(root.dir, sessionDir, id)
    if (binding !== undefined) {
      return { summary, child: true, parentId: binding.parentId, agent: binding.agent }
    }
    if (asString(summary['session_kind']) === 'subagent_fork') {
      const parentId = asString(summary['parent_session_id'])
      if (parentId !== undefined && parentId !== '' && parentId !== id) {
        return { summary, child: true, parentId, agent: { agentId: id } }
      }
    }
    return { summary, child: true }
  }

  /**
   * Cached binding for a grok child, widening the search until one is found.
   *
   * The sibling group (the same encoded cwd) is always re-read: it is one
   * `readdir` per session directory there and it is where a child normally
   * lands. The whole-root fallback — for a child that got its own worktree cwd
   * (GROK-FORMAT §D.2) — is swept at most once per generation, so a child that
   * binds to nothing does not walk every session directory on every
   * registration. Learning any new binding starts a new generation, and a new
   * session directory can only contribute bindings through
   * `cacheGrokBindings`, which is exactly what bumps it.
   */
  private async grokParentOf(rootDir: string, sessionDir: string, childId: string): Promise<GrokChildBinding | undefined> {
    const cached = this.grokChildren.get(childId)
    if (cached !== undefined) return cached
    // Siblings under the same encoded cwd first: the common case.
    await this.cacheGrokGroup(dirname(sessionDir))
    const sibling = this.grokChildren.get(childId)
    if (sibling !== undefined) return sibling
    if (this.grokSwept.get(rootDir) === this.grokGeneration) return undefined
    // A worktree or explicit cwd puts the child under a different group
    // entirely (GROK-FORMAT §D.2), so fall back to the whole root.
    for (const group of await subdirectories(rootDir)) await this.cacheGrokGroup(group)
    this.grokSwept.set(rootDir, this.grokGeneration)
    return this.grokChildren.get(childId)
  }

  private async cacheGrokGroup(groupDir: string): Promise<void> {
    for (const sessionDir of await subdirectories(groupDir)) await this.cacheGrokBindings(sessionDir)
  }

  private async cacheGrokBindings(sessionDir: string): Promise<void> {
    for (const binding of await readGrokSubagentMetas(join(sessionDir, 'subagents'))) {
      this.noteGrokBinding(binding)
    }
  }

  /** Remember one child → parent binding; a new one invalidates the swept generation. */
  private noteGrokBinding(binding: GrokChildBinding): void {
    if (this.grokChildren.has(binding.childId)) return
    this.grokChildren.set(binding.childId, binding)
    this.grokGeneration += 1
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
    const probe = await this.probeGrokFile(root, entry.path, entry.ref.id)
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
    const previous = this.sessions.get(previousKey)
    if (previous !== undefined) {
      if (previous.main === entry) previous.main = null
      if (previous.main === null && previous.children.size === 0) this.sessions.delete(previousKey)
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
    const parent = this.sessionFor(entry.kind, parentId)
    parent.children.set(entry.ref.id, entry)
    this.emitTo(parent, { type: 'file', file: entry.ref })
    this.emitTo(parent, { type: 'meta', summary: this.summarize(parent), children: this.childSummaries(parent) })
    this.emit('change', entry.kind, parentId)
  }

  /** Re-read a child's sidecar facts when they were missing at registration (written a moment later). */
  private async refreshAgentMeta(session: SessionRecord, entry: FileEntry): Promise<void> {
    if (entry.kind !== 'claude' || entry.ref.role !== 'child' || entry.ref.agent?.toolUseId !== undefined) return
    const agent = await readAgentMeta(entry.path)
    if (agent?.toolUseId === undefined) return
    entry.ref = { ...entry.ref, agent }
    this.emitTo(session, { type: 'file', file: entry.ref })
  }

  /**
   * Kimi keeps the session's own (generated or user-set) title in `state.json`
   * beside `agents/`, rewritten as the session runs — re-read it on every
   * refresh and surface it the way Claude's `ai-title` record is surfaced.
   */
  private async syncKimiTitle(entry: FileEntry): Promise<void> {
    if (entry.kind !== 'kimi' || entry.ref.role !== 'main' || entry.meta === null) return
    const title = await readKimiTitle(entry.path)
    if (title !== undefined) entry.meta.state.aiTitle = title
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
    const session = this.sessions.get(key)
    if (session === undefined) return
    const summary = await readJsonRecord(join(dir, 'summary.json'))
    const title = grokSummaryTitle(summary)
    const titleChanged = title !== entry.summaryTitle
    entry.summaryTitle = title
    if (titleChanged && title !== null && entry.meta !== null) entry.meta.state.aiTitle = title
    if (this.subscribers.get(key) === undefined) return
    const sidecar = await buildGrokSidecar(dir, entry.ref.id, summary)
    if (sidecar !== undefined && sidecar.key !== entry.sidecarKey) {
      entry.sidecarKey = sidecar.key
      // Synthetic: it belongs to no line of `updates.jsonl` (see `startLine`).
      this.emitTo(session, { type: 'lines', file: entry.ref, lines: [sidecar.line], startLine: -1 })
    } else if (!titleChanged) {
      return
    }
    this.emitTo(session, { type: 'meta', summary: this.summarize(session), children: this.childSummaries(session) })
  }

  private sessionFor(kind: HarnessKind, id: string): SessionRecord {
    const key = sessionKey(kind, id)
    let session = this.sessions.get(key)
    if (session === undefined) {
      session = { kind, id, main: null, children: new Map() }
      this.sessions.set(key, session)
    }
    return session
  }

  /**
   * First pass over a file, in bounded slices. `consume` allocates one buffer
   * per call, so a multi-hundred-megabyte rollout is walked rather than loaded.
   */
  private async consumeInitial(entry: FileEntry, size: number, mtimeMs: number, initial: boolean): Promise<void> {
    let end = Math.min(INITIAL_CHUNK_BYTES, size)
    for (;;) {
      if (this.stopped) return
      await this.consume(entry, end, mtimeMs, initial)
      // `offset` can land past `end` when a folded-in watch event was drained
      // with the file's real size; never let `end` fall behind it, or the
      // next slice would look like a truncation.
      if (entry.offset >= size) return
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

  /** Consume appended bytes: update metadata and forward new lines to subscribers. */
  private async consumeInner(entry: FileEntry, size: number, mtimeMs: number, initial = false): Promise<void> {
    const session = this.sessions.get(sessionKey(entry.kind, entry.sessionId))
    if (size < entry.offset) {
      // Truncated or rewritten: start over and tell subscribers to reset the file.
      entry.offset = 0
      entry.rest = ''
      entry.lines = 0
      entry.searchFrom = 0
      this.search?.reset(entry.path)
      entry.meta = entry.ref.role === 'main'
        // Grok's listing facts come from `summary.json`, not from the lines.
        ? createMetaScanner(entry.kind, entry.kind === 'grok'
          ? await readJsonRecord(join(dirname(entry.path), 'summary.json'))
          : null)
        : null
      if (session !== undefined) this.emitTo(session, { type: 'file', file: entry.ref, reset: true })
    }
    entry.size = size
    entry.mtimeMs = Math.max(entry.mtimeMs, mtimeMs)
    if (size === entry.offset) return
    const result = await readLines(entry.path, entry.offset, entry.rest, size)
    entry.offset = result.offset
    entry.rest = result.rest
    if (entry.meta !== null) {
      for (const line of result.lines) entry.meta.push(line)
    }
    // `index` advances `entry.lines`, so the first appended line's index is the
    // count as it stands here — the same one the search index gives the record.
    const startLine = entry.lines
    this.index(entry, result.lines)
    if (result.lines.length === 0 || session === undefined) return
    if (!initial) {
      this.emitTo(session, { type: 'lines', file: entry.ref, lines: result.lines, startLine })
      this.emitTo(session, { type: 'meta', summary: this.summarize(session), children: this.childSummaries(session) })
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
      if (entry.lines >= entry.searchFrom) search.queue(key, entry.lines, line)
      entry.lines += 1
    }
    search.noteProgress(key, {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      indexedBytes: entry.offset,
      indexedLines: entry.lines,
    })
  }

  /** Listing facts for one session, for search result grouping. */
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

  private emitTo(session: SessionRecord, event: SessionLiveEvent): void {
    const set = this.subscribers.get(sessionKey(session.kind, session.id))
    if (set === undefined) return
    for (const subscriber of set) subscriber(event)
  }

  private childSummaries(session: SessionRecord): SessionChildSummary[] {
    return [...session.children.values()].map(entry => ({
      file: entry.ref,
      updatedAt: entry.mtimeMs,
      bytes: entry.size,
    }))
  }

  private summarize(session: SessionRecord): SessionSummary {
    const main = session.main
    const meta = main?.meta?.state
    const entries = [main, ...session.children.values()]
      .filter((entry): entry is FileEntry => entry !== null)
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

  // -- watching ------------------------------------------------------------

  private watchRoot(root: HarnessRoot): void {
    try {
      const watcher = watch(root.dir, { recursive: true, persistent: true }, (_event, filename) => {
        if (filename === null || filename === undefined) return
        const name = filename.toString()
        if (!name.endsWith('.jsonl')) return
        this.schedule(root, join(root.dir, name))
      })
      watcher.on('error', (error) => { this.emit('error', error) })
      watcher.unref()
      this.watchers.push(watcher)
    } catch (error) {
      this.emit('error', error)
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
    const entry = this.files.get(path)
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
    } catch {
      // Deleted or momentarily unreadable; keep the last known state.
    }
  }

  /** Fallback for watchers that miss events: poll files of sessions someone is viewing. */
  private async pollSubscribed(): Promise<void> {
    for (const key of this.subscribers.keys()) {
      const session = this.sessions.get(key)
      if (session === undefined) continue
      for (const entry of [session.main, ...session.children.values()]) {
        if (entry === null) continue
        try {
          const info = await stat(entry.path)
          if (info.size !== entry.size) await this.consume(entry, info.size, info.mtimeMs)
          await this.refreshAgentMeta(session, entry)
          await this.syncKimiTitle(entry)
          await this.syncGrokSummary(entry)
          const entryRoot = entry.grokUnresolved === true ? this.rootFor(entry.path) : undefined
          if (entryRoot !== undefined) await this.refreshGrokBinding(entryRoot, entry)
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
          if (!this.files.has(path)) await this.register(root, path)
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
      this.noteGrokBinding(binding)
      for (const candidate of grokChildPaths(root.dir, main.path, binding)) {
        const existing = this.files.get(candidate)
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
 * How the search index addresses one transcript: the session a hit opens and
 * the `?file=` id that selects this file inside it. For a main file both are the
 * session id; for a child, `fileId` is the child's own ref id.
 */
function searchKeyOf(entry: FileEntry): SearchFileKey {
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

/** Claude Code writes `agent-<id>.meta.json` beside each subagent transcript. */
export async function readAgentMeta(transcriptPath: string): Promise<AgentFileMeta | undefined> {
  const name = basename(transcriptPath, '.jsonl')
  const agentId = name.startsWith('agent-') ? name.slice('agent-'.length) : name
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(`${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`, 'utf8'))
  } catch {
    return { agentId }
  }
  if (!isRecord(parsed)) return { agentId }
  const toolUseId = asString(parsed['toolUseId'])
  const description = asString(parsed['description'])
  const agentType = asString(parsed['agentType'])
  const model = asString(parsed['model'])
  return {
    agentId,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(description === undefined ? {} : { description }),
    ...(agentType === undefined ? {} : { agentType }),
    ...(model === undefined ? {} : { model }),
    ...(parsed['isFork'] === true ? { isFork: true } : {}),
  }
}

/**
 * Directory a live session's subagent transcripts appear in, so they can be
 * picked up while someone is watching. Codex writes children as top-level
 * rollouts, which the root walk already covers.
 */
export function liveChildDir(kind: HarnessKind, sessionId: string, mainPath: string): string | undefined {
  // claude: <slug>/<sessionId>/subagents/agent-<id>.jsonl
  if (kind === 'claude') return join(dirname(mainPath), sessionId, 'subagents')
  // kimi: the main file is <session>/agents/main/wire.jsonl, siblings are <session>/agents/<agentId>/wire.jsonl
  if (kind === 'kimi') return dirname(dirname(mainPath))
  // grok: only the child's METADATA nests under the parent, as
  // <session>/subagents/<childId>/meta.json; the transcript itself is a
  // top-level session directory, possibly under another encoded cwd
  // (GROK-FORMAT §D.2, §D.3). `pollGrokChildren` resolves each meta to it.
  if (kind === 'grok') return join(dirname(mainPath), 'subagents')
  return undefined
}

/**
 * Kimi's session title sidecar: `<session>/state.json`, two levels above the
 * `agents/main/wire.jsonl` transcript. Best effort — unreadable means no title.
 */
export async function readKimiTitle(transcriptPath: string): Promise<string | undefined> {
  const sessionDir = dirname(dirname(dirname(transcriptPath)))
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const title = asString(parsed['title'])
  return title === undefined || title.trim() === '' ? undefined : title
}

/** Parse a small JSON sidecar file; unreadable or non-object means no facts. */
async function readJsonRecord(file: string): Promise<Record<string, unknown> | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

/** Immediate subdirectories of a directory; a missing directory has none. */
async function subdirectories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => join(dir, entry.name))
  } catch {
    return []
  }
}

/**
 * Whether a grok `summary.json` describes a subagent child rather than a
 * session of its own (GROK-FORMAT §D.5): `hidden` is the explicit override and
 * wins when present, else a `session_kind` **starting with** `subagent`
 * (`subagent`, `subagent_fork`, `subagent_resume`).
 */
function isGrokChildSummary(summary: Record<string, unknown>): boolean {
  const hidden = summary['hidden']
  if (typeof hidden === 'boolean') return hidden
  return asString(summary['session_kind'])?.startsWith('subagent') === true
}

/** What `summary.json` (plus the binding search) says about one grok session directory. */
interface GrokProbe {
  /** The parsed `summary.json`, or `null` when grok has not written it yet. */
  summary: Record<string, unknown> | null
  /** Whether the summary marks this session as a subagent run (GROK-FORMAT §D.5). */
  child: boolean
  /** The parent it was bound to; unset for a main session and for an unbindable child. */
  parentId?: string
  agent?: AgentFileMeta
}

/** A parent's durable record of one subagent run (GROK-FORMAT §D.3). */
export interface GrokChildBinding {
  /** Child session id: the name of the top-level directory its transcript lives in. */
  childId: string
  parentId: string
  agent: AgentFileMeta
  /** The child's own working directory, when the meta recorded one. */
  childCwd: string | null
}

/**
 * Read `<session>/subagents/<childId>/meta.json` for every subagent a grok
 * session spawned. This is the binding authority: a child transcript is a
 * top-level session directory that names no parent of its own, and
 * `summary.parent_session_id` is unreliable (GROK-FORMAT §D.3, §D.5).
 */
export async function readGrokSubagentMetas(subagentsDir: string): Promise<GrokChildBinding[]> {
  const bindings: GrokChildBinding[] = []
  for (const dir of await subdirectories(subagentsDir)) {
    const meta = await readJsonRecord(join(dir, 'meta.json'))
    if (meta === null) continue
    const childId = asString(meta['child_session_id']) ?? asString(meta['subagent_id']) ?? basename(dir)
    const parentId = asString(meta['parent_session_id'])
    if (childId === '' || parentId === undefined || parentId === '') continue
    const description = asString(meta['description'])
    const agentType = asString(meta['subagent_type'])
    const model = asString(meta['effective_model_id'])
    bindings.push({
      childId,
      parentId,
      // grok records no spawning tool-call id anywhere (GROK-FORMAT §D.4), so
      // `toolUseId` stays unset and the adapter binds by prompt id and order.
      agent: {
        agentId: childId,
        ...(description === undefined ? {} : { description }),
        ...(agentType === undefined ? {} : { agentType }),
        ...(model === undefined ? {} : { model }),
      },
      childCwd: asString(meta['child_cwd']) ?? null,
    })
  }
  return bindings
}

/** Bytes that pass through grok's cwd encoding unescaped: the RFC 3986 unreserved set. */
const GROK_UNRESERVED = /[A-Za-z0-9\-_.~]/

/**
 * Grok's encoded-cwd directory name (GROK-FORMAT §A.3): RFC 3986
 * unreserved-set percent-encoding with **upper-case** hex — not
 * `encodeURIComponent`, which leaves `!'()*` alone. A cwd whose encoding would
 * exceed 255 bytes is stored under an irreversible `{slug}-{blake3}` name
 * instead, which cannot be recomputed here; `undefined` says so.
 */
export function encodeGrokCwd(cwd: string): string | undefined {
  let encoded = ''
  for (const byte of Buffer.from(cwd, 'utf8')) {
    const char = String.fromCharCode(byte)
    encoded += GROK_UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return encoded.length > 255 ? undefined : encoded
}

/**
 * Where a grok child's `updates.jsonl` can be: under its own cwd's group when
 * the meta recorded one, else beside the parent (GROK-FORMAT §D.2, mirroring
 * grok's own `ReplayPathHint`).
 */
export function grokChildPaths(rootDir: string, parentPath: string, binding: GrokChildBinding): string[] {
  const paths: string[] = []
  const encoded = binding.childCwd === null ? undefined : encodeGrokCwd(binding.childCwd)
  if (encoded !== undefined) paths.push(join(rootDir, encoded, binding.childId, 'updates.jsonl'))
  const sibling = join(dirname(dirname(parentPath)), binding.childId, 'updates.jsonl')
  if (!paths.includes(sibling)) paths.push(sibling)
  return paths
}

/**
 * Grok's own generated session title: `summary.json`'s `session_summary`
 * (GROK-FORMAT §B.1), verbatim like Kimi's `state.json` title — the meta
 * scanner reads the same field the same way.
 */
export function grokSummaryTitle(summary: Record<string, unknown> | null): string | null {
  const title = summary === null ? undefined : asString(summary['session_summary'])?.trim()
  return title === undefined || title === '' ? null : title
}

/**
 * The synthetic first line of a grok replay (GROK-DESIGN §3): the session facts
 * (`summary.json`), the verbatim system prompt (`system_prompt.txt`, written
 * for every session) and the tool schemas (`tool_definitions.json`, newest
 * builds only) that grok keeps outside `updates.jsonl` (GROK-FORMAT §E.1,
 * §E.3). `undefined` when the directory holds none of them — a transcript folds
 * without a sidecar, it just has no system prompt and no schemas.
 */
export async function readGrokSidecar(transcriptPath: string, sessionId: string): Promise<GrokSidecarLine | undefined> {
  const dir = dirname(transcriptPath)
  return buildGrokSidecar(dir, sessionId, await readJsonRecord(join(dir, 'summary.json')))
}

/** A rendered sidecar line and the facts it carries, so an unchanged one is not re-sent. */
export interface GrokSidecarLine {
  line: string
  key: string
}

/**
 * `summary.json` fields grok patches on every appended line: write bookkeeping,
 * not session facts (GROK-FORMAT §B.1). They ride along in the sidecar, so they
 * are excluded from the key that decides whether a sidecar is news.
 */
const GROK_VOLATILE_SUMMARY_KEYS: ReadonlySet<string> = new Set([
  'updated_at', 'num_messages', 'num_chat_messages', 'next_trace_turn',
])

/** The sidecar line for a session directory whose `summary.json` the caller already read. */
async function buildGrokSidecar(
  dir: string,
  sessionId: string,
  summary: Record<string, unknown> | null,
): Promise<GrokSidecarLine | undefined> {
  let systemPrompt: string | null
  try {
    systemPrompt = await readFile(join(dir, 'system_prompt.txt'), 'utf8')
  } catch {
    systemPrompt = null
  }
  let definitions: unknown
  try {
    definitions = JSON.parse(await readFile(join(dir, 'tool_definitions.json'), 'utf8'))
  } catch {
    definitions = undefined
  }
  const toolDefinitions = asArray(definitions) ?? null
  if (summary === null && systemPrompt === null && toolDefinitions === null) return undefined
  // `created_at` is RFC 3339; the envelope carries epoch SECONDS (GROK-FORMAT §C.1).
  const created = Date.parse(asString(summary?.['created_at']) ?? '')
  const stable = summary === null
    ? null
    : Object.fromEntries(Object.entries(summary).filter(([key]) => !GROK_VOLATILE_SUMMARY_KEYS.has(key)))
  return {
    line: JSON.stringify({
      timestamp: Number.isNaN(created) ? 0 : Math.floor(created / 1000),
      method: GROK_SIDECAR_METHOD,
      params: { sessionId, summary, systemPrompt, toolDefinitions },
    }),
    key: JSON.stringify({ sessionId, stable, systemPrompt, toolDefinitions }),
  }
}

async function readWholeFile(path: string, end: number): Promise<string[]> {
  const lines: string[] = []
  let from = 0
  let rest = ''
  while (from < end) {
    const result = await readLines(path, from, rest, end)
    if (result.offset === from && result.lines.length === 0) break
    from = result.offset
    rest = result.rest
    lines.push(...result.lines)
  }
  return lines
}

const TIMESTAMP_PATTERN = /"timestamp"\s*:\s*(?:"([^"]+)"|(\d+(?:\.\d+)?))/
/** Kimi records carry `"time":<epoch ms>` and no `timestamp`. */
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
 * pattern (GROK-FORMAT §C.1).
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
   * sidecar). They are in no file, so they take no line index and the entry
   * after them is line 0.
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

/** Recursively list `.jsonl` files under a directory; missing directories yield nothing. */
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
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      paths.push(path)
    }
  }
  return paths
}
