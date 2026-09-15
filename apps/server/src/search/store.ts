/**
 * SQLite storage for full-text session search.
 *
 * One file under the cache directory (never inside a harness root). Node's
 * built-in `node:sqlite` is the only engine — no native dependency — and the
 * text index is an FTS5 table with the **trigram** tokenizer, which is what
 * makes substring search over code, paths and command lines work at all: the
 * default `unicode61` tokenizer would only match whole words, so `packages/co`
 * or `--project serv` would find nothing. Trigram is case-insensitive for ASCII
 * by default (`case_sensitive 0`) and cannot match fewer than three characters.
 *
 * The table is created with `detail=none`: the index stores only which
 * documents contain each trigram, not where. Positions are what made the
 * trigram index cost 2× the document text on disk (60% of a 5.6 GB database);
 * without them the inverted index shrinks by ~80%. The price is paid in
 * `query.ts`: FTS5 refuses phrase queries, `snippet()` and `bm25` on such a
 * table, so the read side slices the query into trigrams itself, ANDs them
 * (a superset of the real matches), and then verifies the substring, ranks,
 * and builds snippets against the stored text in JavaScript.
 *
 * `docs_fts` is a plain (not external-content or contentless) FTS5 table, so
 * the document text itself stays available for that verification; `docs`
 * beside it holds the addressing columns and shares its rowid.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HarnessKind, SearchRole } from '@harness-trajectory/core'

/** Bumped whenever the schema below changes; a mismatch drops and rebuilds. */
export const SEARCH_SCHEMA_VERSION = 2

/** Identity of one indexed transcript, as the SSE route addresses it. */
export interface SearchFileKey {
  path: string
  kind: HarnessKind
  /** Main session id: the parent's id for a child transcript. */
  sessionId: string
  /** `?file=` id of this transcript; equals `sessionId` for a main file. */
  fileId: string
}

/** What the index already knows about a file on disk. */
export interface SearchFileState extends SearchFileKey {
  size: number
  mtimeMs: number
  indexedBytes: number
  indexedLines: number
}

/** One indexable record extracted from a JSONL line. */
export interface SearchDoc {
  /** 0-based line index of the record within its file. */
  line: number
  role: SearchRole
  text: string
  timeMs?: number
}

export interface SearchStoreOptions {
  /** Absolute path, or `':memory:'` for tests and for a disabled on-disk index. */
  path: string
}

const SCHEMA = `
create table files (
  path          text primary key,
  kind          text not null,
  session_id    text not null,
  file_id       text not null,
  size          integer not null,
  mtime_ms      real not null,
  indexed_bytes integer not null,
  indexed_lines integer not null
);
create table docs (
  id         integer primary key,
  path       text not null,
  line       integer not null,
  role       text not null,
  time_ms    integer,
  kind       text not null,
  session_id text not null,
  file_id    text not null
);
create index docs_by_path on docs(path);
create index docs_by_session on docs(kind, session_id);
create virtual table docs_fts using fts5(text, tokenize="trigram", detail=none);
`

function asInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export class SearchStore {
  readonly db: DatabaseSync

  constructor(options: SearchStoreOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
    this.db = new DatabaseSync(options.path)
    this.db.exec('pragma journal_mode = wal')
    this.db.exec('pragma synchronous = normal')
    this.ensureSchema()
  }

  /**
   * Create the schema, dropping whatever an older build left behind. The index
   * is a cache: rebuilding it costs one backfill, so there are no migrations.
   */
  private ensureSchema(): void {
    const row = this.db.prepare('pragma user_version').get()
    const version = asInt(row?.['user_version'], 0)
    if (version === SEARCH_SCHEMA_VERSION) {
      // A half-created database (an interrupted first run) still needs the tables.
      const table = this.db.prepare(
        `select name from sqlite_master where type in ('table','view') and name = 'docs_fts'`,
      ).get()
      if (table !== undefined) return
    }
    this.db.exec(`
      drop table if exists docs_fts;
      drop table if exists docs;
      drop table if exists files;
    `)
    this.db.exec(SCHEMA)
    this.db.exec(`pragma user_version = ${SEARCH_SCHEMA_VERSION}`)
  }

  /**
   * Fold the write-ahead log back into the database file. The backfill commits
   * tens of megabytes in a few hundred transactions, which grows the `-wal`
   * sidecar well past the automatic checkpoint threshold; this keeps the cache
   * directory at the size the database actually needs.
   */
  checkpoint(): void {
    try {
      this.db.exec('pragma wal_checkpoint(truncate)')
    } catch {
      // A concurrent reader blocks the truncate; the next one succeeds.
    }
  }

  close(): void {
    this.checkpoint()
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }

  /** Run `body` in one transaction, rolling back when it throws. */
  transaction<T>(body: () => T): T {
    this.db.exec('begin')
    try {
      const result = body()
      this.db.exec('commit')
      return result
    } catch (error) {
      try {
        this.db.exec('rollback')
      } catch {
        // The transaction was already gone.
      }
      throw error
    }
  }

  fileState(path: string): SearchFileState | undefined {
    const row = this.db.prepare('select * from files where path = ?').get(path)
    if (row === undefined) return undefined
    return {
      path,
      kind: asText(row['kind']) as HarnessKind,
      sessionId: asText(row['session_id']),
      fileId: asText(row['file_id']),
      size: asInt(row['size']),
      mtimeMs: asInt(row['mtime_ms']),
      indexedBytes: asInt(row['indexed_bytes']),
      indexedLines: asInt(row['indexed_lines']),
    }
  }

  /** Every path the index has a `files` row for, for the startup sweep. */
  paths(): string[] {
    return this.db.prepare('select path from files').all().map(row => asText(row['path']))
  }

  setFileState(key: SearchFileKey, progress: {
    size: number
    mtimeMs: number
    indexedBytes: number
    indexedLines: number
  }): void {
    this.db.prepare(`
      insert into files (path, kind, session_id, file_id, size, mtime_ms, indexed_bytes, indexed_lines)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(path) do update set
        kind = excluded.kind,
        session_id = excluded.session_id,
        file_id = excluded.file_id,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_bytes = excluded.indexed_bytes,
        indexed_lines = excluded.indexed_lines
    `).run(
      key.path, key.kind, key.sessionId, key.fileId,
      progress.size, progress.mtimeMs, progress.indexedBytes, progress.indexedLines,
    )
  }

  /** Append documents for one file. Call inside {@link transaction}. */
  insertDocs(key: SearchFileKey, docs: readonly SearchDoc[]): void {
    if (docs.length === 0) return
    const doc = this.db.prepare(
      'insert into docs (path, line, role, time_ms, kind, session_id, file_id) values (?, ?, ?, ?, ?, ?, ?)',
    )
    const text = this.db.prepare('insert into docs_fts (rowid, text) values (?, ?)')
    for (const entry of docs) {
      const { lastInsertRowid } = doc.run(
        key.path, entry.line, entry.role, entry.timeMs ?? null,
        key.kind, key.sessionId, key.fileId,
      )
      text.run(lastInsertRowid, entry.text)
    }
  }

  /** Drop every document of a file, keeping its `files` row. */
  clearDocs(path: string): void {
    this.db.prepare('delete from docs_fts where rowid in (select id from docs where path = ?)').run(path)
    this.db.prepare('delete from docs where path = ?').run(path)
  }

  /** Forget a file entirely: it disappeared from disk. */
  deleteFile(path: string): void {
    this.clearDocs(path)
    this.db.prepare('delete from files where path = ?').run(path)
  }

  /**
   * Re-home a file whose owning session was only learned after its lines were
   * indexed (a subagent transcript that registered before its parent claimed it).
   */
  rebind(path: string, sessionId: string, fileId: string): void {
    this.db.prepare('update files set session_id = ?, file_id = ? where path = ?').run(sessionId, fileId, path)
    this.db.prepare('update docs set session_id = ?, file_id = ? where path = ?').run(sessionId, fileId, path)
  }

  docCount(): number {
    return asInt(this.db.prepare('select count(*) as n from docs').get()?.['n'])
  }

  fileCount(): number {
    return asInt(this.db.prepare('select count(*) as n from files').get()?.['n'])
  }
}
