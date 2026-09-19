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
import type { Classified } from './classified.ts'
import { zstdSupported } from '../tail.ts'

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
 * Generation lifecycle bookkeeping for `SessionIndex`, the dsh counterpart of
 * `CodexRollouts`: session-directory → live-entry registry plus current-
 * generation resolution. Every entry point (startup sweep, watcher, poll)
 * must resolve the session directory and dedupe against the same entry, so
 * both concerns live here. The consume lock, stream reset, search rebinding,
 * and subscriber events stay in `SessionIndex`.
 */
export class DshGenerations<E> {
  /** Session directory → the entry currently reading it. */
  private readonly byDir = new Map<string, E>()

  /** The current (highest-version) generation of `path`'s session directory. */
  resolve(path: string): Promise<DshLogFile | null> {
    return resolveDshLog(dirname(path))
  }

  /** The entry already reading `path`'s session directory, if any. */
  entry(path: string): E | undefined {
    return this.byDir.get(dirname(path))
  }

  /** Record `entry` as the live reader of `path`'s session directory. */
  note(path: string, entry: E): void {
    this.byDir.set(dirname(path), entry)
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
