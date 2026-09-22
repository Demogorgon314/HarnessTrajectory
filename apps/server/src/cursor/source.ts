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
import {
  asNumber, asString, cursorModelOf, isRecord, type HarnessKind,
} from '@harness-trajectory/core'
import { createMetaScanner } from '../meta.ts'
import type { SearchIndexer } from '../search/indexer.ts'
import {
  emitReplay, searchKeyOf, SessionBook, type LineSource, type ReplaySink, type SessionSource,
  type SourceEntry, type SourceSession, type Subscriber,
} from '../source.ts'
import { CursorDb } from './db.ts'
import { decodeItem, decodeRoot, decodeTurn, decodeUserPrompt, type CursorRoot, type CursorTurnItem } from './proto.ts'
import {
  assignCursorTimes, assignTimes, clockMessageOf, cursorSessionModel, messageLine, planTranscript, sessionLine,
  type CursorClockTurn, type CursorLineClock, type CursorSessionFacts, type CursorStepSpan,
} from './transcript.ts'

const KIND: HarnessKind = 'cursor'
const POLL_MS = 1_500
const POOL_LIMIT = 16
const FAIL_LIMIT = 3

interface CursorFile extends SourceEntry {
  searchFrom: number
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
  emittedIds: string[]
  times: number[]
  spans: (CursorStepSpan | undefined)[]
  lastTime: number | null
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

interface OpenStore {
  db: CursorDb
  fresh: boolean
}

class StorePool {
  private readonly open = new Map<string, CursorDb>()

  acquire(path: string): OpenStore | undefined {
    const existing = this.open.get(path)
    if (existing !== undefined) {
      this.open.delete(path)
      this.open.set(path, existing)
      return { db: existing, fresh: false }
    }
    try {
      const db = new CursorDb(path)
      this.open.set(path, db)
      while (this.open.size > POOL_LIMIT) {
        const oldest = this.open.keys().next().value
        if (oldest === undefined) break
        this.open.get(oldest)?.close()
        this.open.delete(oldest)
      }
      return { db, fresh: true }
    } catch {
      return undefined
    }
  }

  drop(path: string): void {
    const db = this.open.get(path)
    if (db === undefined) return
    db.close()
    this.open.delete(path)
  }

  close(): void {
    for (const db of this.open.values()) db.close()
    this.open.clear()
  }
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

/** Model messages are JSON objects. Anything else (protobuf, ciphertext) is not a line. */
function parseMessage(data: Uint8Array): Record<string, unknown> | undefined {
  if (data.length === 0 || data[0] !== 0x7b) return undefined
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export class CursorSource extends EventEmitter implements SessionSource {
  private readonly chatsDir: string
  private readonly watchEnabled: boolean
  private readonly book: SessionBook<CursorFile>
  private readonly states = new Map<string, CursorState>()
  private readonly pool = new StorePool()
  private search: SearchIndexer | undefined
  private poll: ReturnType<typeof setInterval> | null = null
  private watcher: FSWatcher | null = null
  private stopped = false
  private scanning = false

  constructor(options: CursorSourceOptions) {
    super()
    this.chatsDir = options.chatsDir
    this.watchEnabled = options.watch !== false
    this.book = new SessionBook(options.now ?? Date.now)
    this.search = options.search
  }

  async start(): Promise<void> {
    this.stopped = false
    this.scan()
    if (!this.watchEnabled) return
    if (this.poll === null) {
      this.poll = setInterval(() => { this.scan() }, POLL_MS)
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
    this.pool.close()
  }

  /** One catalog/transcript pass. Tests call this instead of waiting for the poll. */
  refresh(): void {
    this.scan()
  }

  livePaths(): string[] {
    return [...this.book.files.values()].flatMap(entry => (entry.searchSkipped ? [] : [entry.path]))
  }

  /**
   * Attach search and backfill. Already-materialized streams re-derive lines
   * from the store and queue from `beginFile`'s watermark. The rest materialize
   * now. Called before `start` on a cold boot (the catalog is still empty)
   * and again, after `disableSearch`, once sessions exist.
   */
  async enableSearch(search: SearchIndexer): Promise<void> {
    if (this.search !== undefined) return
    this.search = search
    for (const state of this.states.values()) {
      state.entry.searchSkipped = !search.shouldIndex({ mtimeMs: state.entry.mtimeMs })
      if (state.entry.searchSkipped) continue
      if (state.materialized) this.indexMaterialized(state, search)
      else this.load(state)
    }
  }

  disableSearch(): void {
    this.search = undefined
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
    const times = state.times.slice(0, lines.length)
    sources.push({ ref: state.entry.ref, lines, times })
    await emitReplay(
      [state.entry.ref],
      sources,
      { type: 'meta', summary: this.book.summarize(state.session), children: [] },
      emit,
      signal,
    )
  }

  private scan(): void {
    if (this.stopped || this.scanning) return
    this.scanning = true
    try {
      const hits = this.listHits()
      const seen = new Set<string>()
      for (const hit of hits) {
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
      }
      for (const state of [...this.states.values()]) {
        if (!seen.has(state.id)) this.drop(state)
      }
      if (this.watchEnabled) this.attachWatch()
    } catch (error) {
      this.emit('error', error)
    } finally {
      this.scanning = false
    }
  }

  private listHits(): Hit[] {
    let parents: string[]
    try {
      parents = readdirSync(this.chatsDir)
    } catch {
      return []
    }
    const hits: Hit[] = []
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
        hits.push({ id, dir, storePath, metaPath, catalog })
      }
    }
    return hits
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
      searchFrom: 0,
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
      emittedIds: [],
      times: [],
      spans: [],
      lastTime: null,
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
    const { db, fresh } = opened
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
    if (root.messageIds.length === 0) {
      // Ciphertext, a truncated root, or a session whose field 1 is empty.
      // Catalog facts still publish; a later root id retries.
      state.materialized = true
      state.incomplete = false
      state.failStreak = 0
      state.rootId = rootId
      this.rememberRoot(state, root)
      this.noteSidecar(state, this.factsFrom(state))
      return
    }
    const plan = planTranscript(root.messageIds, state.emittedIds)
    const rebuilding = plan.action === 'rebuild' && state.emittedIds.length > 0
    if (rebuilding) this.resetStream(state)
    if (this.search !== undefined && !state.entry.searchSkipped) {
      state.entry.searchFrom = this.search.beginFile(searchKeyOf(state.entry), {
        size: root.messageIds.length,
        mtimeMs: state.entry.mtimeMs,
      })
    }
    const start = state.emittedIds.length
    const created = state.catalog.createdAt ?? asNumber(meta?.['createdAt']) ?? root.createdAt ?? 0
    const updated = state.catalog.updatedAt ?? created
    const clocks = this.clocksFor(db, root, created, updated)
    const times: CursorLineClock[] = clocks === undefined
      ? assignTimes(start, plan.ids.length, created, updated, state.lastTime).map(time => ({ time }))
      : clocks.slice(start)
    const accepted: string[] = []
    const acceptedTimes: number[] = []
    const acceptedSpans: (CursorStepSpan | undefined)[] = []
    const lines: string[] = []
    let blocked = false
    for (let index = 0; index < plan.ids.length; index += 1) {
      const id = plan.ids[index]
      if (id === undefined) {
        blocked = true
        break
      }
      const data = db.readBlob(id)
      const message = data === undefined ? undefined : parseMessage(data)
      if (message === undefined) {
        blocked = true
        break
      }
      const model = cursorModelOf(message)
      if (model !== undefined) state.seenModel = model
      const clock = times[index]
      const raw = clock?.time ?? updated
      const time = state.lastTime !== null && raw < state.lastTime ? state.lastTime : raw
      const span = clock?.span
      const lineIndex = start + accepted.length
      accepted.push(id)
      acceptedTimes.push(time)
      acceptedSpans.push(span)
      lines.push(messageLine(lineIndex, id, time, message, span))
    }
    state.materialized = true
    this.rememberRoot(state, root)
    this.noteSidecar(state, this.factsFrom(state))
    if (lines.length > 0) this.emitLines(state, lines)
    state.emittedIds.push(...accepted)
    state.times.push(...acceptedTimes)
    state.spans.push(...acceptedSpans)
    const last = acceptedTimes[acceptedTimes.length - 1]
    if (last !== undefined) state.lastTime = last
    if (blocked) this.noteFailure(state)
    else {
      state.failStreak = 0
      state.incomplete = false
      state.rootId = rootId
    }
    if (!blocked || state.failStreak >= FAIL_LIMIT) {
      if (blocked) state.rootId = rootId
    }
    this.noteSearch(state)
  }

  /**
   * Full-list clocks from the turn chain. `undefined` when the root has no
   * field-8 refs; a chain with no timestamps falls through inside
   * `assignCursorTimes` to the phase-1 stamps.
   */
  private clocksFor(
    db: CursorDb,
    root: CursorRoot,
    createdAt: number,
    updatedAt: number,
  ): CursorLineClock[] | undefined {
    if (root.turnIds.length === 0) return undefined
    const turns: CursorClockTurn[] = []
    for (const id of root.turnIds) {
      const blob = db.readBlob(id)
      if (blob === undefined) continue
      const skeleton = decodeTurn(blob)
      if (skeleton === undefined) continue
      const promptBlob = skeleton.promptId === undefined ? undefined : db.readBlob(skeleton.promptId)
      const prompt = promptBlob === undefined ? undefined : decodeUserPrompt(promptBlob)
      const items: CursorTurnItem[] = []
      for (const itemId of skeleton.itemIds) {
        const data = db.readBlob(itemId)
        if (data === undefined) continue
        const item = decodeItem(data)
        if (item !== undefined) items.push(item)
      }
      turns.push({
        items,
        ...(skeleton.requestId === undefined ? {} : { requestId: skeleton.requestId }),
        ...(prompt?.time === undefined ? {} : { promptTime: prompt.time }),
      })
    }
    const messages: ReturnType<typeof clockMessageOf>[] = []
    for (const id of root.messageIds) {
      const data = db.readBlob(id)
      const message = data === undefined ? undefined : parseMessage(data)
      if (message === undefined) break
      messages.push(clockMessageOf(message))
    }
    return assignCursorTimes(messages, turns, createdAt, updatedAt, null)
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
    entry.searchFrom = 0
    state.emittedIds = []
    state.times = []
    state.spans = []
    state.lastTime = null
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
    const search = this.search
    if (search === undefined || entry.searchSkipped) return
    for (let index = 0; index < lines.length; index += 1) {
      const lineIndex = startLine + index
      if (lineIndex < entry.searchFrom) continue
      const line = lines[index]
      if (line !== undefined) search.queue(searchKeyOf(entry), lineIndex, line)
    }
  }

  private noteSearch(state: CursorState): void {
    const search = this.search
    if (search === undefined || state.entry.searchSkipped) return
    search.noteProgress(searchKeyOf(state.entry), {
      size: state.emittedIds.length,
      mtimeMs: state.entry.mtimeMs,
      indexedBytes: state.entry.lines,
      indexedLines: state.entry.lines,
    })
  }

  private indexMaterialized(state: CursorState, search: SearchIndexer): void {
    const lines = this.reread(state)
    state.entry.searchFrom = search.beginFile(searchKeyOf(state.entry), {
      size: state.emittedIds.length,
      mtimeMs: state.entry.mtimeMs,
    })
    for (let index = state.entry.searchFrom; index < lines.length; index += 1) {
      const line = lines[index]
      if (line !== undefined) search.queue(searchKeyOf(state.entry), index, line)
    }
    this.noteSearch(state)
  }

  private reread(state: CursorState): string[] {
    const opened = this.pool.acquire(state.storePath)
    if (opened === undefined) return []
    const lines: string[] = []
    for (let index = 0; index < state.emittedIds.length; index += 1) {
      const id = state.emittedIds[index]
      const time = state.times[index]
      if (id === undefined || time === undefined) continue
      const data = opened.db.readBlob(id)
      const message = data === undefined ? undefined : parseMessage(data)
      if (message === undefined) continue
      lines.push(messageLine(index, id, time, message, state.spans[index]))
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

  private attachWatch(): void {
    if (this.watcher !== null || this.stopped) return
    try {
      this.watcher = watch(this.chatsDir, { recursive: true, persistent: true }, () => { this.scan() })
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
