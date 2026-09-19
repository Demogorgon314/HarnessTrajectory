/**
 * DeepSeek Harness's filesystem layout:
 * `$DSH_HOME/sessions/<--encoded-cwd-->/<session-id>/session[.vN].jsonl[.zstd]`
 * (`~/.dsh` when unset). Each format generation is an immutable file of its
 * own — `session.jsonl` is v0, `session.vN` is version N — and a migrated
 * session keeps every committed generation on disk
 * (session-persistence-jsonl/src/format.ts, generation.ts). The CURRENT
 * generation is the numerically highest one; a seeded successor already
 * carries its inherited prefix (events up to `session/end-seed`), so only the
 * current file is ever read — replaying a predecessor too would fold the same
 * history twice.
 *
 * Beside the logs sits `session.lock` (the session lease, never a transcript)
 * and `$DSH_HOME/attachments/v1/objects/<2-hex>/<sha256>`, the global
 * content-addressed blob store `blobref:` image URLs resolve against.
 */

import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseDshLine } from '@harness-trajectory/core'
import type { Classified } from './classified.ts'
import { readFirstLine, zstdSupported } from '../tail.ts'

/** One generation file: `session.jsonl[.zstd]` is v0, `session.vN.jsonl[.zstd]` is version N. */
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/**
 * `<encoded-cwd>/<session-id>/<generation file>` — the session id is the
 * directory name (the same `session-<uuid>` the header's `id` records).
 */
export function classifyDshPath(parts: string[], name: string): Classified | null {
  if (parts.length !== 3 || !LOG_NAME.test(name)) return null
  const id = parts[1]
  if (id === undefined || id === '') return null
  return { id, role: 'main' }
}

/** The on-disk artifact `resolveDshLog` picked as the current generation. */
export interface DshLogFile {
  path: string
  version: number
  compressed: boolean
  size: number
  mtimeMs: number
}

/**
 * The current generation of the session living in `dir`: the highest version
 * present, preferring the `.zstd` spelling when both encodings of one version
 * exist (a deployment writes exactly one — the tie-break only orders a
 * hand-mixed directory). Returns null when no readable generation exists.
 */
export async function resolveDshLog(dir: string): Promise<DshLogFile | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  let best: { name: string; version: number; compressed: boolean } | undefined
  for (const name of names) {
    const match = LOG_NAME.exec(name)
    if (match === null) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    const compressed = match[2] === '.zstd'
    if (compressed && !zstdSupported()) continue
    if (best === undefined || version > best.version || (version === best.version && compressed)) {
      best = { name, version, compressed }
    }
  }
  if (best === undefined) return null
  const path = join(dir, best.name)
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return { path, version: best.version, compressed: best.compressed, size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Owns directory identity, pending generation changes and header confirmation.
 * SessionIndex applies transitions under its consume lock and owns the shared
 * cursors, session membership, search rebinding and subscriber events.
 * This state is ephemeral: restart resolves the current path and probes its
 * header before restoring that path's listing cursor.
 */
export class DshGenerations<E extends object> {
  /** Session directory → the entry currently reading it. */
  private readonly byDir = new Map<string, E>()
  private readonly states = new WeakMap<E, DshSessionState>()

  /** The current (highest-version) generation of `path`'s session directory. */
  resolve(path: string): Promise<DshLogFile | null> {
    return resolveDshLog(dirname(path))
  }

  /** The entry already reading `path`'s session directory, if any. */
  entry(path: string): E | undefined {
    return this.byDir.get(dirname(path))
  }

  /** Register once, after probing the current file and before consuming it. */
  register(path: string, entry: E, identity: DshIdentity): void {
    this.byDir.set(dirname(path), entry)
    this.states.set(entry, { path, awaitingHeader: !identity.confirmed, pending: undefined })
  }

  /** Stage a path change without moving the active reader's cursor. */
  stage(entry: E, generation: DshLogFile): void {
    const state = this.states.get(entry)
    if (state !== undefined && state.path !== generation.path) state.pending = generation
  }

  /** Commit a staged change only under the caller's consume lock. */
  takePending(entry: E): DshLogFile | undefined {
    const state = this.states.get(entry)
    const pending = state?.pending
    if (state === undefined || pending === undefined) return undefined
    state.pending = undefined
    state.path = pending.path
    return pending
  }

  /** A torn first frame settles identity on its first complete non-blank record. */
  parentFromLines(entry: E, startLine: number, lines: readonly string[]): string | undefined {
    const state = this.states.get(entry)
    const first = lines[0]
    if (state === undefined || !state.awaitingHeader || first === undefined) return undefined
    // A restored cursor may already be past an invalid/missing header. Later
    // records cannot establish identity on behalf of that first record.
    if (startLine !== 0) return undefined
    state.awaitingHeader = false
    return dshIdentity(first).parentId
  }
}

interface DshSessionState {
  path: string
  awaitingHeader: boolean
  pending: DshLogFile | undefined
}

export interface DshIdentity {
  confirmed: boolean
  parentId?: string
}

function dshIdentity(line: string): DshIdentity {
  const record = parseDshLine(line)
  if (record?.tag !== 'header') return { confirmed: false }
  const parentId = record.header.origin === 'subagent' ? record.header.parentSession : undefined
  return { confirmed: true, ...(parentId === undefined ? {} : { parentId }) }
}

/** Missing or incomplete headers keep path-derived identity until consumption. */
export async function readDshIdentity(path: string): Promise<DshIdentity> {
  try {
    return dshIdentity(await readFirstLine(path))
  } catch {
    return { confirmed: false }
  }
}

/**
 * One object of the global attachment store: `$DSH_HOME/attachments/v1/
 * objects/<first 2 hex>/<full sha256>`. `dshHome` is the parent of the
 * sessions root (attachments is its sibling, not inside it).
 */
export function dshAttachmentPath(dshHome: string, hash: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null
  return join(dshHome, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash)
}
