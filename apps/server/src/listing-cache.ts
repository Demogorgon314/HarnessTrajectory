/**
 * Listing cache: the per-file consume cursor and listing metadata, persisted
 * so a restart does not re-read transcripts that did not change.
 *
 * `SessionIndex` keeps the session listing in memory only, so every process
 * start used to replay every transcript from byte 0 — tens of gigabytes of
 * JSONL on a large corpus — even though the search index already resumes
 * per line. This cache stores, per transcript, how far it was consumed
 * (`consumed_bytes`, `rest`, `lines`) plus the meta scanner's serialized
 * state. A file whose `(size, mtime)` still matches is not read at all; one
 * that only grew resumes from the persisted cursor, exactly like the live
 * tail does. Anything else — a shrink, an older mtime, a scanner-logic
 * version bump, a changed sidecar fingerprint — falls back to a full scan.
 *
 * Grok's `summary.json` is a scanner input that lives outside the transcript,
 * so its mtime is part of the fingerprint (`sidecar_mtime_ms`); other
 * sidecars are re-read at registration regardless and need none.
 *
 * The index is a cache, same policy as the search store: bump
 * {@link LISTING_CACHE_VERSION} on a format change instead of migrating, and
 * `META_SCANNER_VERSION` (meta.ts) on a scanner-logic change — stale rows then
 * simply miss and the files are re-read. One SQLite file under the cache
 * directory, never inside a harness root.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Filesystem cursor schema; source catalogs version their own payload fingerprints. */
export const LISTING_CACHE_VERSION = 2

/** What the index persists for one consumed transcript. */
export interface ListingRow {
  size: number
  mtimeMs: number
  /** Byte offset up to which lines were consumed (same as `FileEntry.offset`). */
  consumedBytes: number
  /** Unterminated trailing text carried between reads. */
  rest: string
  /** Non-blank records consumed; also the next record's search line index. */
  lines: number
  /** `META_SCANNER_VERSION` the serialized state was written under. */
  scannerVersion: number
  /** Grok: `summary.json`'s mtime, a scanner input outside the transcript. */
  sidecarMtimeMs: number | null
  /** `serializeMeta()` output; null when the file carried no scanner. */
  state: string | null
  /**
   * JSON fingerprint of the parts of the entry's stream that are not the
   * head file itself: the head's physical (on-disk) size plus each Codex
   * lineage base's resolved path/size/mtime. `null` for single-file streams.
   */
  footprint: string | null
}

const SCHEMA = `
create table files (
  path            text primary key,
  size            integer not null,
  mtime_ms        real not null,
  consumed_bytes  integer not null,
  rest            text not null,
  lines           integer not null,
  scanner_version integer not null,
  sidecar_mtime   real,
  state           text,
  footprint       text
);
`

const CATALOG_SCHEMA = `
create table if not exists catalogs (
  source text not null,
  session text not null,
  fingerprint text not null,
  state text not null,
  primary key (source, session)
);
`

function asInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

export class ListingCache {
  readonly db: DatabaseSync

  constructor(options: { path: string }) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
    this.db = new DatabaseSync(options.path)
    this.db.exec('pragma journal_mode = wal')
    this.db.exec('pragma synchronous = normal')
    this.ensureSchema()
    // Adding an independent catalog must not invalidate every JSONL cursor.
    this.db.exec(CATALOG_SCHEMA)
  }

  private ensureSchema(): void {
    const row = this.db.prepare('pragma user_version').get()
    const version = asInt(row?.['user_version'], 0)
    if (version === LISTING_CACHE_VERSION) {
      const table = this.db.prepare(
        `select name from sqlite_master where type = 'table' and name = 'files'`,
      ).get()
      if (table !== undefined) return
    }
    this.db.exec('drop table if exists files')
    this.db.exec(SCHEMA)
    this.db.exec(`pragma user_version = ${LISTING_CACHE_VERSION}`)
  }

  load(path: string): ListingRow | undefined {
    const row = this.db.prepare('select * from files where path = ?').get(path)
    if (row === undefined) return undefined
    const sidecar = row['sidecar_mtime']
    const state = row['state']
    const footprint = row['footprint']
    return {
      size: asInt(row['size']),
      mtimeMs: asInt(row['mtime_ms']),
      consumedBytes: asInt(row['consumed_bytes']),
      rest: typeof row['rest'] === 'string' ? row['rest'] : '',
      lines: asInt(row['lines']),
      scannerVersion: asInt(row['scanner_version'], -1),
      sidecarMtimeMs: typeof sidecar === 'number' || typeof sidecar === 'bigint' ? Number(sidecar) : null,
      state: typeof state === 'string' ? state : null,
      footprint: typeof footprint === 'string' ? footprint : null,
    }
  }

  /** SQLite source snapshots are separate from filesystem consume cursors. */
  loadCatalog(source: string, session: string, fingerprint: string): string | undefined {
    try {
      const row = this.db.prepare('select state from catalogs where source = ? and session = ? and fingerprint = ?')
        .get(source, session, fingerprint)
      return typeof row?.['state'] === 'string' ? row['state'] : undefined
    } catch {
      return undefined
    }
  }

  saveCatalog(source: string, session: string, fingerprint: string, state: string): void {
    try {
      this.db.prepare(`insert into catalogs values (?, ?, ?, ?)
        on conflict(source, session) do update set fingerprint = excluded.fingerprint, state = excluded.state`)
        .run(source, session, fingerprint, state)
    } catch {
      // A failed cache write only costs reconstruction on the next start.
    }
  }

  pruneCatalog(source: string, live: ReadonlySet<string>): void {
    try {
      const rows = this.db.prepare('select session from catalogs where source = ?').all(source)
      const drop = this.db.prepare('delete from catalogs where source = ? and session = ?')
      for (const row of rows) {
        const id = String(row['session'])
        if (!live.has(id)) drop.run(source, id)
      }
    } catch {
      // Stale snapshots still need a matching fingerprint to be reused.
    }
  }

  /** Upsert one file's snapshot; a cache that cannot write must not stop the server. */
  save(path: string, row: ListingRow): void {
    try {
      this.db.prepare(`
        insert into files (path, size, mtime_ms, consumed_bytes, rest, lines, scanner_version, sidecar_mtime, state, footprint)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(path) do update set
          size = excluded.size,
          mtime_ms = excluded.mtime_ms,
          consumed_bytes = excluded.consumed_bytes,
          rest = excluded.rest,
          lines = excluded.lines,
          scanner_version = excluded.scanner_version,
          sidecar_mtime = excluded.sidecar_mtime,
          state = excluded.state,
          footprint = excluded.footprint
      `).run(
        path, row.size, row.mtimeMs, row.consumedBytes, row.rest, row.lines,
        row.scannerVersion, row.sidecarMtimeMs, row.state, row.footprint,
      )
    } catch {
      // A locked or full database only costs the next start a re-read.
    }
  }

  /** Forget files that no longer exist, run once at the end of the startup sweep. */
  prune(live: ReadonlySet<string>): void {
    const gone = this.db.prepare('select path from files').all()
      .map(row => String(row['path']))
      .filter(path => !live.has(path))
    if (gone.length === 0) return
    try {
      this.db.exec('begin')
      const drop = this.db.prepare('delete from files where path = ?')
      for (const path of gone) drop.run(path)
      this.db.exec('commit')
    } catch {
      try {
        this.db.exec('rollback')
      } catch {
        // Already rolled back.
      }
    }
  }

  close(): void {
    try {
      this.db.exec('pragma wal_checkpoint(truncate)')
    } catch {
      // A concurrent reader blocks the truncate; the next one succeeds.
    }
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}
