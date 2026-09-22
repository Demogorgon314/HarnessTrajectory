/**
 * Cursor Agent session source. Catalog tier walks
 * `~/.cursor/chats/<md5>/<agentId>/meta.json` and registers every directory
 * that has a conversation and a `store.db` — no SQLite in that pass. The
 * transcript tier opens the store on first subscribe, replay, or search
 * registration, decodes the protobuf root, and emits `cursor.session` plus
 * one `cursor.message` per field-1 blob id.
 *
 * A newer root that extends the emitted id list appends. Any other change
 * (shrink, rewrite, summary) emits `file reset` and rebuilds. A missing
 * chats directory, a corrupt meta row, or blobs that are not JSON degrade
 * to a catalog entry and never throw. Handles are read-only and LRU-capped:
 * one database per session must not stay open for the whole tree.
 */

import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import {
  asNumber, asString, isRecord, type HarnessKind, type CursorSessionFacts,
} from '@harness-trajectory/core'
import { createMetaScanner } from '../meta.ts'
import type { SearchIndexer } from '../search/indexer.ts'
import {
  emitReplay, searchKeyOf, SessionBook, type LineSource, type ReplaySink, type SessionSource,
  type SourceEntry, type SourceSession, type Subscriber,
} from '../source.ts'
import { decodeRoot, type CursorRoot } from './proto.ts'
import { CursorReaderPool, cursorPrefixVersion, type CursorPublishedRecord } from './reader.ts'
import { cursorSessionModel, messageLine, sessionLine } from './transcript.ts'

const KIND: HarnessKind = 'cursor'
const POLL_MS = 1_500
const FAIL_LIMIT = 3

interface CursorFile extends SourceEntry {
  searchSkipped: boolean
}

interface CatalogFacts {
  title?: string
  cwd?: string
  createdAt?: number
  updatedAt?: number
}

interface RootFacts {
  workspaceUri?: string
  repo?: string
  branch?: string
  client?: string
  usage?: CursorSessionFacts['usage']
}

interface CursorState {
  id: string
  dir: string
  storePath: string
  metaPath: string
  catalog: CatalogFacts
  rootFacts: RootFacts
  session: SourceSession<CursorFile>
  entry: CursorFile
  stamp: string
  dataVersion: number | null
  materialized: boolean
  rootId: string | null
  records: CursorPublishedRecord[]
  searchCursor: { indexer: SearchIndexer; nextLine: number } | undefined
  sidecar: string | null
  seenModel: string | undefined
  storeMeta: Record<string, unknown> | undefined
  incomplete: boolean
  failStreak: number
}

interface Hit {
  id: string
  dir: string
  storePath: string
  metaPath: string
  catalog: CatalogFacts
}

export interface CursorSourceOptions {
  chatsDir: string
  /** Disable polling and `fs.watch` (tests). */
  watch?: boolean
  now?: () => number
  search?: SearchIndexer
}

function fileStat(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const stat = statSync(path)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return undefined
  }
}

function readCatalog(metaPath: string): CatalogFacts | undefined {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as unknown
    if (!isRecord(parsed) || parsed['hasConversation'] !== true) return undefined
    const title = asString(parsed['title'])?.trim()
    const cwd = asString(parsed['cwd'])
    const createdAt = asNumber(parsed['createdAtMs'])
    const updatedAt = asNumber(parsed['updatedAtMs'])
    return {
      ...(title === undefined || title === '' ? {} : { title }),
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    }
  } catch {
    return undefined
  }
}

export class CursorSource extends EventEmitter implements SessionSource {
  private readonly chatsDir: string
  private readonly watchEnabled: boolean
  private readonly book: SessionBook<CursorFile>
  private readonly states = new Map<string, CursorState>()
  private readonly pool = new CursorReaderPool()
  private search: SearchIndexer | undefined
  private poll: ReturnType<typeof setInterval> | null = null
  private watcher: FSWatcher | null = null
  private stopped = false
  private scanning: Promise<void> | undefined
  private watchTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pendingPaths = new Set<string>()

  constructor(options: CursorSourceOptions) {
    super()
    this.chatsDir = options.chatsDir
    this.watchEnabled = options.watch !== false
    this.book = new SessionBook(options.now ?? Date.now)
    this.search = options.search
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.scan()
    if (!this.watchEnabled || this.stopped) return
    if (this.poll === null) {
      this.poll = setInterval(() => { void this.scan() }, POLL_MS)
      this.poll.unref()
    }
    this.attachWatch()
  }

  stop(): void {
    this.stopped = true
    if (this.poll !== null) {
      clearInterval(this.poll)
      this.poll = null
    }
    this.watcher?.close()
    this.watcher = null
    clearTimeout(this.watchTimer)
    this.watchTimer = undefined
    this.pendingPaths.clear()
    this.pool.close()
  }

  /** One catalog/transcript pass. Tests call this instead of waiting for the poll. */
  refresh(): Promise<void> {
    return this.scan()
  }

  livePaths(): string[] {
    return [...this.book.files.values()].flatMap(entry => (entry.searchSkipped ? [] : [entry.path]))
  }

  /**
   * Verify the persisted content prefix before resuming search. Yield between
   * sessions so disabling search can detach an in-flight backfill promptly.
   */
  async enableSearch(search: SearchIndexer): Promise<void> {
    if (this.search !== undefined) return
    this.search = search
    for (const state of this.states.values()) {
      if (this.stopped || this.search !== search) return
      state.entry.searchSkipped = !search.shouldIndex({ mtimeMs: state.entry.mtimeMs })
      if (state.entry.searchSkipped) continue
      this.sync(state, true)
      this.indexMaterialized(state, search)
      await yieldToLoop()
    }
  }

  disableSearch(): void {
    this.search = undefined
    for (const state of this.states.values()) state.searchCursor = undefined
  }

  kinds(): readonly HarnessKind[] {
    return [KIND]
  }

  list() { return this.book.list() }

  get(kind: HarnessKind, id: string) {
    return kind === KIND ? this.book.get(kind, id) : undefined
  }

  hasChild(kind: HarnessKind, id: string, fileId: string) {
    return kind === KIND && this.book.hasChild(kind, id, fileId)
  }

  subscribe(kind: HarnessKind, id: string, subscriber: Subscriber) {
    // Materialize before the subscriber is registered so this viewer receives
    // the stream once, through `readAll`, not also as a live echo.
    if (kind === KIND) {
      const state = this.states.get(id)
      if (state !== undefined) this.sync(state, true)
    }
    return this.book.subscribe(kind, id, subscriber)
  }

  facts(kind: HarnessKind, id: string) {
    return kind === KIND ? this.book.facts(kind, id) : undefined
  }

  async readAll(
    kind: HarnessKind,
    id: string,
    emit: ReplaySink,
    _fileId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted || kind !== KIND) return
    const state = this.states.get(id)
    if (state === undefined) return
    this.sync(state, true)
    if (signal?.aborted) return
    const lines = this.reread(state)
    const sources: LineSource[] = []
    if (state.sidecar !== null) {
      sources.push({
        ref: state.entry.ref,
        lines: [state.sidecar],
        times: [state.catalog.createdAt ?? state.catalog.updatedAt ?? 0],
        synthetic: 1,
      })
    }
    const times = state.records.slice(0, lines.length).map(record => record.time)
    sources.push({ ref: state.entry.ref, lines, times })
    await emitReplay(
      [state.entry.ref],
      sources,
      { type: 'meta', summary: this.book.summarize(state.session), children: [] },
      emit,
      signal,
    )
  }

  private scan(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.scanning !== undefined) return this.scanning
    const pass = this.scanCatalog().finally(() => { this.scanning = undefined })
    this.scanning = pass
    return pass
  }

  private async scanCatalog(): Promise<void> {
    try {
      const hits = this.listHits()
      const seen = new Set<string>()
      for (const hit of hits) {
        if (this.stopped) return
        seen.add(hit.id)
        let state = this.states.get(hit.id)
        if (state === undefined) {
          state = this.create(hit)
          this.states.set(hit.id, state)
        } else {
          state.dir = hit.dir
          state.storePath = hit.storePath
          state.metaPath = hit.metaPath
          state.catalog = hit.catalog
        }
        this.sync(state, false)
        await yieldToLoop()
      }
      if (this.stopped) return
      for (const state of [...this.states.values()]) {
        if (!seen.has(state.id)) this.drop(state)
      }
      if (this.watchEnabled) this.attachWatch()
    } catch (error) {
      this.emit('error', error)
    }
  }

  private *listHits(): Generator<Hit> {
    let parents: string[]
    try {
      parents = readdirSync(this.chatsDir)
    } catch {
      return
    }
    for (const parent of parents) {
      const parentDir = join(this.chatsDir, parent)
      let agents: string[]
      try {
        if (statSync(parentDir).isDirectory() !== true) continue
        agents = readdirSync(parentDir)
      } catch {
        continue
      }
      for (const id of agents) {
        if (id === '' || id.startsWith('.')) continue
        const dir = join(parentDir, id)
        const metaPath = join(dir, 'meta.json')
        const storePath = join(dir, 'store.db')
        let directory = false
        try {
          directory = statSync(dir).isDirectory()
        } catch {
          continue
        }
        if (!directory) continue
        const catalog = readCatalog(metaPath)
        if (catalog === undefined || fileStat(storePath) === undefined) continue
        yield { id, dir, storePath, metaPath, catalog }
      }
    }
  }

  private create(hit: Hit): CursorState {
    const session = this.book.sessionFor(KIND, hit.id)
    const path = CursorSource.sessionPath(hit.id)
    const entry: CursorFile = {
      kind: KIND,
      path,
      ref: { id: hit.id, role: 'main', path },
      sessionId: hit.id,
      size: 0,
      mtimeMs: 0,
      lines: 0,
      meta: createMetaScanner(KIND, seedOf(hit.catalog)),
      searchSkipped: false,
    }
    session.main = entry
    this.book.files.set(path, entry)
    const state: CursorState = {
      id: hit.id,
      dir: hit.dir,
      storePath: hit.storePath,
      metaPath: hit.metaPath,
      catalog: hit.catalog,
      rootFacts: {},
      session,
      entry,
      stamp: '',
      dataVersion: null,
      materialized: false,
      rootId: null,
      records: [],
      searchCursor: undefined,
      sidecar: null,
      seenModel: undefined,
      storeMeta: undefined,
      incomplete: false,
      failStreak: 0,
    }
    this.applySize(state)
    if (this.search !== undefined) {
      entry.searchSkipped = !this.search.shouldIndex({ mtimeMs: entry.mtimeMs })
    }
    this.noteSidecar(state, this.factsFrom(state))
    return state
  }

  /**
   * `open` forces the transcript tier (subscribe / readAll). Otherwise a
   * session stays catalog-only until search wants it or it is already live.
   */
  private sync(state: CursorState, open: boolean): void {
    const stamp = this.stampOf(state)
    if (stamp === null) {
      this.drop(state)
      return
    }
    const first = state.stamp === ''
    const stampChanged = stamp !== state.stamp
    state.stamp = stamp
    this.applySize(state)
    const want = open || state.materialized || state.incomplete
      || (this.search !== undefined && !state.entry.searchSkipped)
    const needLoad = want && (!state.materialized || stampChanged || state.incomplete)
    if (!state.materialized && stampChanged) this.noteSidecar(state, this.factsFrom(state))
    if (needLoad) this.load(state)
    if (first || stampChanged || needLoad) this.emit('change', KIND, state.id)
  }

  private load(state: CursorState): void {
    const opened = this.pool.acquire(state.storePath)
    if (opened === undefined) {
      this.noteFailure(state)
      this.noteSidecar(state, this.factsFrom(state))
      return
    }
    const { reader, fresh } = opened
    const { db } = reader
    const version = db.dataVersion()
    if (!fresh && version !== undefined && version === state.dataVersion && state.materialized && !state.incomplete) {
      state.storeMeta = db.readMeta() ?? state.storeMeta
      this.noteSidecar(state, this.factsFrom(state))
      return
    }
    if (version !== undefined) state.dataVersion = version
    const meta = db.readMeta()
    state.storeMeta = meta
    const rootId = meta === undefined ? undefined : asString(meta['latestRootBlobId'])
    if (rootId === undefined || rootId === '') {
      this.noteFailure(state)
      this.noteSidecar(state, this.factsFrom(state))
      return
    }
    if (rootId === state.rootId && state.materialized && !state.incomplete) {
      this.noteSidecar(state, this.factsFrom(state))
      return
    }
    const blob = db.readBlob(rootId)
    if (blob === undefined) {
      this.noteFailure(state)
      this.noteSidecar(state, this.factsFrom(state))
      return
    }
    const root = decodeRoot(blob)
    if (root === undefined) {
      // A malformed root is not evidence that the conversation was cleared.
      this.noteFailure(state)
      this.noteSidecar(state, this.factsFrom(state))
      return
    }
    const created = state.catalog.createdAt ?? asNumber(meta?.['createdAt']) ?? root.createdAt ?? 0
    const updated = state.catalog.updatedAt ?? created
    const change = reader.prepare(root, state.records, created, updated)
    if (change.reset) this.resetStream(state)
    const startLine = state.records.length
    state.records.push(...change.records)
    if (change.model !== undefined) state.seenModel = change.model
    state.materialized = true
    this.rememberRoot(state, root)
    this.noteSidecar(state, this.factsFrom(state))
    if (change.lines.length > 0) this.emitLines(state, change.lines)
    if (change.blocked) this.noteFailure(state)
    else {
      state.failStreak = 0
      state.incomplete = false
      state.rootId = rootId
    }
    if (change.blocked && state.failStreak >= FAIL_LIMIT) state.rootId = rootId
    if (this.search !== undefined) this.indexMaterialized(state, this.search, startLine, change.lines)
  }

  private rememberRoot(state: CursorState, root: CursorRoot): void {
    state.rootFacts = {
      ...(root.workspaceUri === undefined ? {} : { workspaceUri: root.workspaceUri }),
      ...(root.repo === undefined ? {} : { repo: root.repo }),
      ...(root.branch === undefined ? {} : { branch: root.branch }),
      ...(root.client === undefined ? {} : { client: root.client }),
      ...(root.usage === undefined ? {} : { usage: root.usage }),
    }
  }

  private noteFailure(state: CursorState): void {
    state.failStreak += 1
    state.incomplete = state.failStreak < FAIL_LIMIT
    if (!state.incomplete) state.materialized = true
  }

  private resetStream(state: CursorState): void {
    const entry = state.entry
    entry.lines = 0
    state.records = []
    state.searchCursor = undefined
    state.sidecar = null
    state.seenModel = undefined
    entry.meta = createMetaScanner(KIND, seedOf(state.catalog))
    if (this.search !== undefined && !entry.searchSkipped) this.search.reset(entry.path)
    this.book.emitTo(state.session, { type: 'file', file: entry.ref, reset: true })
  }

  private emitLines(state: CursorState, lines: readonly string[]): void {
    const entry = state.entry
    const startLine = entry.lines
    for (const line of lines) entry.meta?.push(line)
    entry.lines += lines.length
    this.book.emitTo(state.session, { type: 'lines', file: entry.ref, lines, startLine })
  }

  private indexMaterialized(
    state: CursorState,
    search: SearchIndexer,
    preparedStart = 0,
    preparedLines: readonly string[] = [],
  ): void {
    if (!state.materialized || state.entry.searchSkipped) return
    const key = searchKeyOf(state.entry)
    const ids = state.records.map(record => record.blobId)
    let cursor = state.searchCursor
    if (cursor?.indexer !== search) {
      cursor = {
        indexer: search,
        nextLine: search.beginFile(key, {
          size: ids.length,
          mtimeMs: state.entry.mtimeMs,
          versionAt: length => cursorPrefixVersion(ids, length),
        }),
      }
      state.searchCursor = cursor
    }
    const opened = cursor.nextLine < preparedStart || preparedLines.length === 0
      ? this.pool.acquire(state.storePath) : undefined
    while (cursor.nextLine < state.records.length) {
      const index = cursor.nextLine
      const record = state.records[index]
      if (record === undefined) break
      let line = preparedLines[index - preparedStart]
      if (line === undefined) {
        const message = opened?.reader.readMessage(record.blobId)
        if (message === undefined) break
        line = messageLine(index, record.blobId, record.time, message, record.span)
      }
      search.queue(key, index, line)
      cursor.nextLine += 1
    }
    const contentVersion = cursorPrefixVersion(ids, cursor.nextLine)
    search.noteProgress(key, {
      size: ids.length,
      mtimeMs: state.entry.mtimeMs,
      indexedBytes: cursor.nextLine,
      indexedLines: cursor.nextLine,
      ...(contentVersion === undefined ? {} : { contentVersion }),
    })
  }

  private reread(state: CursorState): string[] {
    const opened = this.pool.acquire(state.storePath)
    if (opened === undefined) return []
    const lines: string[] = []
    for (const [index, record] of state.records.entries()) {
      const message = opened.reader.readMessage(record.blobId)
      // Never shift later records into a missing record's search/SSE line number.
      if (message === undefined) break
      lines.push(messageLine(index, record.blobId, record.time, message, record.span))
    }
    return lines
  }

  private factsFrom(state: CursorState): CursorSessionFacts {
    const meta = state.storeMeta
    const name = asString(meta?.['name'])?.trim()
    const title = state.catalog.title ?? (name === undefined || name === '' ? undefined : name)
    const model = cursorSessionModel(state.seenModel, asString(meta?.['lastUsedModel']))
    const createdAt = state.catalog.createdAt ?? asNumber(meta?.['createdAt'])
    const updatedAt = state.catalog.updatedAt ?? createdAt
    const mode = asString(meta?.['mode'])
    const approvalMode = asString(meta?.['approvalMode'])
    const root = state.rootFacts
    return {
      agentId: state.id,
      ...(title === undefined ? {} : { title }),
      ...(state.catalog.cwd === undefined ? {} : { cwd: state.catalog.cwd }),
      ...(root.workspaceUri === undefined ? {} : { workspaceUri: root.workspaceUri }),
      ...(root.repo === undefined ? {} : { repoPath: root.repo }),
      ...(root.branch === undefined ? {} : { branch: root.branch }),
      ...(root.client === undefined ? {} : { client: root.client }),
      ...(mode === undefined || mode === '' ? {} : { mode }),
      ...(approvalMode === undefined || approvalMode === '' ? {} : { approvalMode }),
      ...(model === undefined ? {} : { model }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(root.usage === undefined ? {} : { usage: root.usage }),
    }
  }

  private noteSidecar(state: CursorState, facts: CursorSessionFacts): void {
    const time = facts.updatedAt ?? facts.createdAt ?? 0
    const line = sessionLine(facts, time)
    if (line === state.sidecar) return
    state.sidecar = line
    state.entry.meta?.push(line)
    this.book.emitTo(state.session, {
      type: 'lines', file: state.entry.ref, lines: [line], startLine: -1,
    })
  }

  private applySize(state: CursorState): void {
    const db = fileStat(state.storePath)
    const wal = fileStat(`${state.storePath}-wal`)
    const meta = fileStat(state.metaPath)
    state.entry.size = (db?.size ?? 0) + (wal?.size ?? 0)
    state.entry.mtimeMs = Math.max(db?.mtimeMs ?? 0, wal?.mtimeMs ?? 0, meta?.mtimeMs ?? 0)
  }

  private stampOf(state: CursorState): string | null {
    const meta = fileStat(state.metaPath)
    const db = fileStat(state.storePath)
    if (meta === undefined || db === undefined) return null
    const wal = fileStat(`${state.storePath}-wal`)
    return `${meta.mtimeMs}:${db.mtimeMs}:${db.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`
  }

  private drop(state: CursorState): void {
    if (!this.states.has(state.id)) return
    const paths = this.book.dropSession(state.session)
    for (const path of paths) this.search?.forget(path)
    this.pool.drop(state.storePath)
    this.states.delete(state.id)
    this.emit('change', KIND, state.id)
  }

  /** A burst of WAL events for an existing session needs only that session. */
  private async refreshPaths(paths: readonly string[]): Promise<void> {
    await this.scanning
    if (this.stopped) return
    const sessions = new Set<CursorState>()
    for (const path of paths) {
      const parts = path.split(/[\\/]/)
      const id = parts[1]
      const state = id === undefined ? undefined : this.states.get(id)
      if (state === undefined || parts.length < 3 || join(this.chatsDir, parts[0] ?? '', id ?? '') !== state.dir) {
        await this.scan()
        return
      }
      sessions.add(state)
    }
    for (const state of sessions) {
      if (this.stopped) return
      const catalog = readCatalog(state.metaPath)
      if (catalog === undefined) this.drop(state)
      else {
        state.catalog = catalog
        this.sync(state, false)
      }
      await yieldToLoop()
    }
  }

  private attachWatch(): void {
    if (this.watcher !== null || this.stopped) return
    try {
      this.watcher = watch(this.chatsDir, { recursive: true, persistent: true }, (_event, filename) => {
        this.pendingPaths.add(filename ?? '')
        if (this.watchTimer !== undefined) return
        this.watchTimer = setTimeout(() => {
          this.watchTimer = undefined
          const paths = [...this.pendingPaths]
          this.pendingPaths.clear()
          void this.refreshPaths(paths).catch(error => { this.emit('error', error) })
        }, 50)
        this.watchTimer.unref()
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      // An unwatchable or missing directory only costs promptness; the poll retries.
    }
  }

  private static sessionPath(id: string): string {
    return `cursor://sessions/${id}`
  }
}

function seedOf(catalog: CatalogFacts): Record<string, unknown> {
  return {
    ...(catalog.title === undefined ? {} : { title: catalog.title }),
    ...(catalog.cwd === undefined ? {} : { cwd: catalog.cwd }),
    ...(catalog.createdAt === undefined ? {} : { createdAt: catalog.createdAt }),
    ...(catalog.updatedAt === undefined ? {} : { updatedAt: catalog.updatedAt }),
  }
}
