/**
 * Session index: discovers transcript files under each harness root, keeps
 * listing metadata, watches for appends, and fans live lines out to subscribers.
 */

import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  asString, isRecord,
  type AgentFileMeta, type HarnessKind, type SessionChildSummary, type SessionDetail, type SessionFileRef,
  type SessionLiveEvent, type SessionSummary,
} from '@harness-trajectory/core'
import { createMetaScanner, readHead, type MetaScanner } from './meta.ts'
import type { HarnessRoot } from './roots.ts'
import { readFirstLine, readLines } from './tail.ts'

const LIVE_WINDOW_MS = 2 * 60_000
const WATCH_DEBOUNCE_MS = 120
const POLL_INTERVAL_MS = 1_500
const CHUNK_LINES = 400

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
  meta: MetaScanner | null
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
  return null
}

export class SessionIndex extends EventEmitter {
  private readonly roots: readonly HarnessRoot[]
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly files = new Map<string, FileEntry>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  private readonly watchers: FSWatcher[] = []
  private readonly pending = new Map<string, NodeJS.Timeout>()
  private poll: NodeJS.Timeout | null = null
  private readonly watchEnabled: boolean
  private readonly now: () => number

  constructor(options: SessionIndexOptions) {
    super()
    this.roots = options.roots
    this.watchEnabled = options.watch ?? true
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    for (const root of this.roots) {
      await this.scanRoot(root)
      if (this.watchEnabled) this.watchRoot(root)
    }
    if (this.watchEnabled) {
      this.poll = setInterval(() => { void this.pollSubscribed() }, POLL_INTERVAL_MS)
      this.poll.unref()
    }
  }

  stop(): void {
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
      return { ref: refOf(entry), lines, times: lineTimes(lines) }
    }))
    for (const chunk of mergeChronologically(sources)) {
      emit({ type: 'lines', file: chunk.ref, lines: chunk.lines })
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
      if (set.size === 0) this.subscribers.delete(key)
    }
  }

  // -- discovery -----------------------------------------------------------

  private async scanRoot(root: HarnessRoot): Promise<void> {
    const paths = await walk(root.dir)
    for (const path of paths) {
      await this.register(root, path, true)
    }
  }

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
    const role: 'main' | 'child' = parentId !== undefined ? 'child' : classified.role
    const sessionId = parentId ?? id
    const agent = role === 'child' && root.kind === 'claude' ? await readAgentMeta(path) : undefined
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
      meta: role === 'main' ? createMetaScanner(root.kind) : null,
    }
    if (this.files.has(path)) return this.files.get(path)
    this.files.set(path, entry)
    const session = this.sessionFor(root.kind, sessionId)
    if (role === 'main') session.main = entry
    else session.children.set(id, entry)
    if (role === 'child' && !initial) this.emitTo(session, { type: 'file', file: ref })
    await this.consume(entry, info.size, info.mtimeMs, initial)
    await this.syncKimiTitle(entry)
    return entry
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

  private sessionFor(kind: HarnessKind, id: string): SessionRecord {
    const key = sessionKey(kind, id)
    let session = this.sessions.get(key)
    if (session === undefined) {
      session = { kind, id, main: null, children: new Map() }
      this.sessions.set(key, session)
    }
    return session
  }

  /** Consume appended bytes: update metadata and forward new lines to subscribers. */
  private async consume(entry: FileEntry, size: number, mtimeMs: number, initial = false): Promise<void> {
    const session = this.sessions.get(sessionKey(entry.kind, entry.sessionId))
    if (size < entry.offset) {
      // Truncated or rewritten: start over and tell subscribers to reset the file.
      entry.offset = 0
      entry.rest = ''
      entry.meta = entry.ref.role === 'main' ? createMetaScanner(entry.kind) : null
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
    if (result.lines.length === 0 || session === undefined) return
    if (!initial) {
      this.emitTo(session, { type: 'lines', file: entry.ref, lines: result.lines })
      this.emitTo(session, { type: 'meta', summary: this.summarize(session), children: this.childSummaries(session) })
    }
    this.emit('change', entry.kind, entry.sessionId)
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
        } catch {
          // Ignore transient errors.
        }
      }
      // Newly created child transcripts inside a session directory (subagents).
      const main = session.main
      const childDir = main === null ? undefined : liveChildDir(session.kind, session.id, main.path)
      const root = main === null ? undefined : this.rootFor(main.path)
      if (childDir !== undefined && root !== undefined) {
        for (const path of await walk(childDir)) {
          if (!this.files.has(path)) await this.register(root, path)
        }
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

/** Epoch milliseconds of a raw JSONL line's `timestamp` (or Kimi's `time`), or `null`. */
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
}

/**
 * Stable k-way merge of per-file line sequences by time; earlier sources win
 * ties, so the main transcript precedes children at equal timestamps. Emits
 * runs of consecutive lines from one file, capped at `CHUNK_LINES`.
 */
export function* mergeChronologically(
  sources: readonly LineSource[],
): Generator<{ ref: SessionFileRef; lines: string[] }> {
  const cursors = sources.map(() => 0)
  let current: { ref: SessionFileRef; lines: string[]; source: number } | null = null
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
    if (current === null || current.source !== best || current.lines.length >= CHUNK_LINES) {
      if (current !== null) yield { ref: current.ref, lines: current.lines }
      current = { ref: source.ref, lines: [], source: best }
    }
    current.lines.push(line)
  }
  if (current !== null && current.lines.length > 0) yield { ref: current.ref, lines: current.lines }
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
