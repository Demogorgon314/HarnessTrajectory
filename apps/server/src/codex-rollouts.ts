/**
 * Codex rollout bookkeeping for `SessionIndex`: canonical filename parsing,
 * the plain/`.jsonl.zst` representation index, `history_base` lineage
 * resolution, and same-thread supersession.
 *
 * Ported semantics (codex-rs):
 * - `rollout/src/rollout_file_name.rs`: `rollout-<ts>-<threadId>[_<rolloutId>]`;
 *   the LAST filename UUID is the rollout id — the value `history_base`
 *   references — and a single-UUID file has that id as both ids.
 * - `rollout/src/compression.rs`: a `.jsonl.zst` twin is the same rollout in a
 *   compressed, immutable representation; the plain file wins when both exist.
 * - `thread-store/src/local/rollout_lineage.rs`: `history_base.thread_id` is
 *   (despite the name) the BASE file's rollout id; `end_byte_offset` is a
 *   decoded-byte cut into that file; `end_ordinal_exclusive` caps its records.
 * - `thread-store/src/local/archive_thread.rs` + `rollout/src/list.rs`: bases
 *   can live under any codex root, including `archived_sessions`.
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isRecord, asArray, asNumber, asString } from '@harness-trajectory/core'
import { readHead, type FileHead } from './meta.ts'
import {
  plainTranscriptPath, readFirstLine, resolveTranscriptFile, zstdSupported,
} from './tail.ts'

const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F-]{36})(?:_([0-9a-fA-F-]{36}))?$/

/**
 * Parse a rollout filename (any representation suffix already stripped):
 * `threadUuid` is the first UUID — the THREAD the file belongs to — and
 * `rolloutId` the last, the file's own identity. A name without both UUIDs is
 * not a rollout file at all.
 */
export function codexIdsFromName(name: string): { threadUuid?: string; rolloutId?: string } {
  const match = ROLLOUT_NAME.exec(name)
  if (match === null) return {}
  const threadUuid = match[1]!.toLowerCase()
  return { threadUuid, rolloutId: (match[2] ?? match[1]!).toLowerCase() }
}

/** One slice of another rollout that a head inherits: the decoded prefix below its cut. */
export interface CodexBase {
  /** The base FILE's rollout id — what `history_base.thread_id` names. */
  rolloutId: string
  /** Canonical `.jsonl` path; the representation is resolved at read time. */
  path: string
  endOrdinalExclusive: number | null
  endByteOffset: number | null
}

/**
 * The lineage bookkeeping a registered Codex file carries. `SessionIndex`'s
 * `FileEntry` satisfies this structurally; the registry never touches
 * session/summary state — arbitration returns verdicts the caller applies.
 */
export interface CodexFile {
  readonly path: string
  readonly rolloutId?: string | undefined
  readonly threadId?: string | undefined
  readonly historyBase?: FileHead['historyBase']
  bases?: CodexBase[] | undefined
  pendingBases?: Set<string> | undefined
  basesStale?: boolean | undefined
  readonly mtimeMs: number
}

/** A registering rollout's fate among the same-thread files seen so far. */
export interface CodexArbitration<E extends CodexFile> {
  /** The newcomer was superseded by an existing head — never list it. */
  superseded: boolean
  /** Registered entries the newcomer replaces (its ancestors or older heads). */
  demote: E[]
}

export class CodexRollouts<E extends CodexFile> {
  /**
   * @param rootDirs every codex root — lineage bases resolve across all of
   *   them (a head under `sessions/` can build on an `archived_sessions/` file).
   */
  constructor(private readonly rootDirs: () => readonly string[]) {}

  /** rollout id → canonical `.jsonl` spelling of its on-disk path. */
  private readonly rolloutPaths = new Map<string, string>()
  /** rollout id → the registered entry. */
  private readonly byRollout = new Map<string, E>()
  /** Canonical paths a same-thread head replaced — on disk but never listed. */
  private readonly superseded = new Set<string>()
  /** Missing rollout id → heads waiting for it as a lineage base. */
  private readonly waiting = new Map<string, Set<E>>()
  /** The filename index below is complete once every codex root was swept. */
  private rootsIndexed = false

  // -- filename index ------------------------------------------------------

  /** Record a swept/registered file's canonical path under its rollout id. */
  notePath(rolloutId: string, path: string): void {
    this.rolloutPaths.set(rolloutId, plainTranscriptPath(path))
  }

  /** The canonical path a rollout id maps to, when indexed. */
  rolloutPath(rolloutId: string): string | undefined {
    return this.rolloutPaths.get(rolloutId)
  }

  // -- registry ------------------------------------------------------------

  entry(rolloutId: string): E | undefined {
    return this.byRollout.get(rolloutId)
  }

  /**
   * Record a registered entry and register it as a waiter for the bases it
   * still lacks. Returns the heads its appearance unblocked — the caller
   * marks them stale and re-reads them.
   */
  registered(entry: E): void {
    if (entry.rolloutId !== undefined) this.byRollout.set(entry.rolloutId, entry)
  }

  /** Forget a demoted entry: it stays a path on disk but is no longer listed. */
  forget(entry: E): void {
    if (entry.rolloutId !== undefined) this.byRollout.delete(entry.rolloutId)
    this.superseded.add(plainTranscriptPath(entry.path))
    this.clearWaiting(entry)
  }

  isSuperseded(canonicalPath: string): boolean {
    return this.superseded.has(canonicalPath)
  }

  markSuperseded(canonicalPath: string): void {
    this.superseded.add(canonicalPath)
  }

  // -- arbitration ----------------------------------------------------------

  /**
   * Decide a registering rollout's place among the same-thread entries. A
   * thread keeps one live head: the new file demotes its ancestors and older
   * same-thread entries, but is itself superseded when a registered head was
   * built on top of it or is simply newer.
   */
  arbitrate(candidate: {
    rolloutId: string
    threadId: string | undefined
    bases: readonly CodexBase[]
    pendingBases: ReadonlySet<string> | undefined
    mtimeMs: number
  }): CodexArbitration<E> {
    const demote: E[] = []
    const baseIds = new Set(candidate.bases.map(base => base.rolloutId))
    for (const other of this.byRollout.values()) {
      if (other.threadId !== candidate.threadId) continue
      if (baseIds.has(other.rolloutId ?? '')) {
        demote.push(other)
        continue
      }
      // `other` is a head built on top of the newcomer — the newcomer is its
      // superseded prefix and must not list as a session.
      const builtOnCandidate = other.bases?.some(base => base.rolloutId === candidate.rolloutId) === true
        || other.pendingBases?.has(candidate.rolloutId) === true
      if (builtOnCandidate || other.mtimeMs >= candidate.mtimeMs) {
        return { superseded: true, demote: [] }
      }
      demote.push(other)
    }
    return { superseded: false, demote }
  }

  // -- lineage --------------------------------------------------------------

  /**
   * Resolve a head's `history_base` chain to the base slices it inherits,
   * oldest first. A missing rollout truncates the chain there; the head gets
   * the links found so far and waits for the rest via `setWaiting`.
   */
  async resolveBases(
    base: FileHead['historyBase'],
  ): Promise<{ bases: CodexBase[]; missing: string[] }> {
    const bases: CodexBase[] = []
    const missing: string[] = []
    const seen = new Set<string>()
    let cursor = base ?? null
    while (cursor !== null && cursor !== undefined && cursor.rolloutId !== '') {
      if (!seen.has(cursor.rolloutId)) seen.add(cursor.rolloutId)
      else break // a hand-edited file can name itself — stop instead of looping
      const path = await this.findRollout(cursor.rolloutId)
      if (path === undefined) {
        missing.push(cursor.rolloutId)
        break
      }
      bases.unshift({
        rolloutId: cursor.rolloutId,
        path,
        endOrdinalExclusive: cursor.endOrdinalExclusive,
        endByteOffset: cursor.endByteOffset,
      })
      // The base's own session_meta may chain further back (a revert of a
      // revert): follow its history_base too.
      let next: FileHead['historyBase'] = null
      const file = await resolveTranscriptFile(path)
      if (file !== null && (!file.compressed || zstdSupported())) {
        try {
          next = readHead('codex', await readFirstLine(file.path)).historyBase ?? null
        } catch {
          next = null
        }
      }
      cursor = next ?? null
    }
    return { bases, missing }
  }

  /**
   * Locate a rollout file by its rollout id: the swept filename index first,
   * then a one-time re-index of every codex root (a base can live in a root
   * the head is not under, e.g. `archived_sessions`). `undefined` when it is
   * not on disk yet.
   */
  private async findRollout(rolloutId: string): Promise<string | undefined> {
    const known = this.rolloutPaths.get(rolloutId)
    if (known !== undefined) return known
    if (this.rootsIndexed) return undefined
    this.rootsIndexed = true
    for (const dir of this.rootDirs()) {
      for (const path of await listRolloutFiles(dir)) {
        const ids = codexIdsFromName(basename(path).replace(/\.jsonl(\.zst)?$/, ''))
        if (ids.rolloutId !== undefined) this.notePath(ids.rolloutId, path)
      }
    }
    return this.rolloutPaths.get(rolloutId)
  }

  // -- waiting bases ----------------------------------------------------------

  /** Re-register which missing rollout ids a head is waiting on. */
  setWaiting(entry: E, missing: readonly string[]): void {
    this.clearWaiting(entry)
    entry.pendingBases = missing.length === 0 ? undefined : new Set(missing)
    for (const rolloutId of missing) {
      let waiters = this.waiting.get(rolloutId)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiting.set(rolloutId, waiters)
      }
      waiters.add(entry)
    }
  }

  /** Drop a head from every waiting set (it demoted or re-resolved). */
  private clearWaiting(entry: E): void {
    for (const rolloutId of entry.pendingBases ?? []) {
      const waiters = this.waiting.get(rolloutId)
      if (waiters !== undefined && waiters.delete(entry) && waiters.size === 0) {
        this.waiting.delete(rolloutId)
      }
    }
  }

  /**
   * A rollout a head was waiting for is now on disk: return the unblocked
   * heads with `basesStale` set — the caller re-reads them under its consume
   * lock so the new slices land ahead of the head's own records.
   */
  baseAvailable(rolloutId: string): E[] {
    const waiters = this.waiting.get(rolloutId)
    if (waiters === undefined) return []
    this.waiting.delete(rolloutId)
    const unblocked: E[] = []
    for (const entry of waiters) {
      entry.pendingBases?.delete(rolloutId)
      entry.basesStale = true
      unblocked.push(entry)
    }
    return unblocked
  }
}

/** Codex rollout files under one root, both representations, recursively. */
async function listRolloutFiles(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await listRolloutFiles(path))
    else if (entry.isFile() && /\.jsonl(\.zst)?$/.test(entry.name)) found.push(path)
  }
  return found
}

// -- listing-cache footprint ------------------------------------------------

/** Decoded `{b, bb, bl, w, d}` of a row's persisted `footprint` JSON. */
export interface CodexFootprint {
  /** `{resolved path, physical size, mtime}` per consumed base, in order. */
  b: { p: string; s: number; m: number }[]
  /** Decoded bytes/lines the bases contributed. */
  bb: number
  bl: number
  /** Rollout ids still pending at save time — the snapshot is incomplete. */
  w: string[]
  /** Decoded stream length of a compressed head. */
  d: number | undefined
}

export function parseCodexFootprint(json: string | null): CodexFootprint | null {
  if (json === null) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (!isRecord(parsed)) return null
    return {
      b: (asArray(parsed['b']) ?? [])
        .filter(isRecord)
        .map(item => ({ p: asString(item['p']) ?? '', s: Number(item['s']), m: Number(item['m']) })),
      bb: Number(parsed['bb'] ?? 0),
      bl: Number(parsed['bl'] ?? 0),
      w: (asArray(parsed['w']) ?? []).filter((x): x is string => typeof x === 'string'),
      d: typeof parsed['d'] === 'number' ? parsed['d'] : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Whether a saved footprint still describes the entry's stream: same resolved
 * bases (by resolved path + stat) and no base pending at save time. The head's
 * own physical size/mtime compare happens in the caller's row check.
 */
export async function codexFootprintMatches<E extends CodexFile>(
  entry: E,
  footprint: string | null,
): Promise<boolean> {
  const saved = parseCodexFootprint(footprint)
  if (saved === null) return false
  if (saved.w.length > 0 || (entry.pendingBases?.size ?? 0) > 0) return false
  const bases = entry.bases ?? []
  if (saved.b.length !== bases.length) return false
  for (let i = 0; i < bases.length; i += 1) {
    const file = await resolveTranscriptFile(bases[i]!.path)
    const current = { p: file?.path ?? bases[i]!.path, s: file?.size ?? -1, m: file?.mtimeMs ?? -1 }
    const wanted = saved.b[i]!
    if (current.p !== wanted.p || current.s !== wanted.s || current.m !== wanted.m) return false
  }
  return true
}

export interface CodexFootprintFile extends CodexFile {
  compressed?: boolean | undefined
  decodedSize?: number | undefined
  size: number
  baseFootprint?: { p: string; s: number; m: number }[] | undefined
  baseBytes: number
  baseLines: number
}

/**
 * The persisted footprint JSON for a Codex entry: the head's physical size is
 * the row's `size`; `d` carries a `.zst` head's decoded cursor end, `b`/`bb`/`bl`
 * the consumed bases, `w` the pending rollout ids.
 */
export function serializeCodexFootprint(entry: CodexFootprintFile): string {
  return JSON.stringify({
    d: entry.compressed === true ? entry.decodedSize ?? 0 : entry.size,
    ...(entry.baseFootprint === undefined || entry.baseFootprint.length === 0
      ? {}
      : { b: entry.baseFootprint, bb: entry.baseBytes, bl: entry.baseLines }),
    ...(entry.pendingBases === undefined || entry.pendingBases.size === 0
      ? {}
      : { w: [...entry.pendingBases] }),
  })
}
