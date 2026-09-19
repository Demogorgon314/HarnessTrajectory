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
 * Four decisions keep the index small on a large corpus (measured on the
 * 2026-09 reference corpus: 829 transcripts, 755k documents, 629 MB of
 * extracted text — schema v4 takes 615 MB down to 417 MB and the backfill
 * from 90 s to 64 s):
 *
 * - **Duplicate text is stored and indexed once.** 45% of the documents on
 *   the reference corpus repeat another document byte-for-byte (tool-output
 *   boilerplate, repeated reminders, template prose). `texts` holds each
 *   unique text once — keyed by an 8-byte SHA-1 prefix, deflate-compressed —
 *   and `docs` is only the occurrence: (file, line, role, time) → text id.
 *   The FTS rowid is the *text* id, so the inverted index shrinks by the
 *   duplicate fraction too, which is also most of the backfill win: FTS
 *   inserts are ~70% of indexing time. Orphaned texts (their last occurrence
 *   deleted) are reclaimed by {@link SearchStore.gcTexts} on the purge paths,
 *   never inline, so a reset stays cheap.
 * - `detail=none`: the index stores only which texts contain each trigram,
 *   not where. Positions are what made the trigram index cost 2× the document
 *   text on disk; without them the inverted index shrinks by ~80%. The price
 *   is paid in `query.ts`: FTS5 refuses phrase queries, `snippet()` and
 *   `bm25` on such a table, so the read side slices the query into trigrams
 *   itself, ANDs them (a superset of the real matches), and then verifies
 *   the substring, ranks, and builds snippets in JavaScript.
 * - `content=''` (contentless): the FTS table holds no document text at all.
 *   Text lives once per unique text, deflate-compressed, in `texts.text` and
 *   is inflated only for the candidates a query actually reads.
 *   `contentless_delete=1` keeps plain `DELETE by rowid` working for
 *   {@link SearchStore.gcTexts}.
 * - `docs.file` is an integer FK into `files`: the path and session id are
 *   stored once per transcript instead of once per document. `query.ts`
 *   resolves them through {@link SearchStore.filesMap}, an in-memory snapshot,
 *   so candidate expansion never joins.
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateSync, inflateSync } from 'node:zlib'
import type { HarnessKind, SearchRole } from '@harness-trajectory/core'

/**
 * Bumped whenever the schema below — or the indexing policy that decides what
 * lands in it — changes; a mismatch drops and rebuilds. v7 combines Codex
 * logical-history indexing with deduplicated text and excludes tool outputs.
 */
export const SEARCH_SCHEMA_VERSION = 8

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
  /** `files` rowid; the `docs.file` foreign key. */
  id: number
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
  id            integer primary key,
  path          text not null unique,
  kind          text not null,
  session_id    text not null,
  file_id       text not null,
  size          integer not null,
  mtime_ms      real not null,
  indexed_bytes integer not null,
  indexed_lines integer not null
);
create table texts (
  id   integer primary key,
  hash integer not null unique,
  text blob not null
);
create table docs (
  id      integer primary key,
  file    integer not null references files(id),
  line    integer not null,
  role    text not null,
  time_ms integer,
  text    integer not null references texts(id)
);
create index docs_by_file on docs(file);
create index docs_by_text on docs(text);
create virtual table docs_fts using fts5(text, tokenize="trigram", detail=none, content='', contentless_delete=1);
`

function asInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Document text at rest: one deflate stream per unique text (~70% smaller). */
export function packText(text: string): Buffer {
  return deflateSync(Buffer.from(text, 'utf8'))
}

/** The inverse of {@link packText}; throws on a corrupt blob — callers skip that row. */
export function unpackText(blob: Uint8Array): string {
  return inflateSync(blob).toString('utf8')
}

/**
 * Dedup key of one document text: the first 8 bytes of its SHA-1, as a signed
 * int64 SQLite can index natively. Collision odds at corpus scale (~10⁶ texts)
 * are ~10⁻⁸; a collision would merge two documents' text, so this trades an
 * astronomically unlikely wrong snippet for a compact integer unique index.
 */
export function hashText(text: string): bigint {
  return createHash('sha1').update(text, 'utf8').digest().readBigInt64BE(0)
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
      drop table if exists texts;
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

  /**
   * Return freed pages to the OS. Deletes (the retention purge, a vanished
   * file) leave them inside the database file, so without this the file never
   * shrinks. Runs outside any transaction; on a multi-GB database it takes a
   * few seconds, which is why it is called only after a real purge.
   */
  compact(): void {
    try {
      this.db.exec('vacuum')
    } catch {
      // A concurrent reader blocks it; the freed pages get reused either way.
    }
  }

  /** Avoid rewriting the entire startup cache for a handful of reclaimed pages. */
  compactIfWasteful(): void {
    const free = asInt(this.db.prepare('pragma freelist_count').get()?.['freelist_count'])
    const pages = asInt(this.db.prepare('pragma page_count').get()?.['page_count'])
    const pageSize = asInt(this.db.prepare('pragma page_size').get()?.['page_size'])
    // Smaller holes are reused by subsequent indexing. Both limits matter:
    // a large database should not be rewritten for a tiny fraction of its size.
    if (free * pageSize >= 16 * 1024 * 1024 && free >= pages * 0.1) this.compact()
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
      id: asInt(row['id']),
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

  /** Files whose recorded modification time is older than the cutoff. */
  pathsOlderThan(cutoffMs: number): string[] {
    return this.db.prepare('select path from files where mtime_ms < ?').all(cutoffMs)
      .map(row => asText(row['path']))
  }

  /**
   * The `files` rowid for `key`, creating a stub row when this is the file's
   * first document. The stub's zeroed progress is filled in by the
   * {@link setFileState} upsert landing in the same transaction.
   */
  private fileRef(key: SearchFileKey): number {
    this.db.prepare(`
      insert into files (path, kind, session_id, file_id, size, mtime_ms, indexed_bytes, indexed_lines)
      values (?, ?, ?, ?, 0, 0, 0, 0)
      on conflict(path) do nothing
    `).run(key.path, key.kind, key.sessionId, key.fileId)
    const row = this.db.prepare('select id from files where path = ?').get(key.path)
    this.filesVersion += 1
    return asInt(row?.['id'])
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
    this.filesVersion += 1
  }

  /**
   * `files` as an in-memory lookup by rowid, for `query.ts` candidate
   * expansion: a text carries no session identity, so every occurrence join
   * resolves through this map instead of a SQL join. Rebuilt lazily whenever
   * a mutation bumped {@link filesVersion}; reloading is a sub-millisecond
   * scan of one small table even on a large corpus.
   */
  filesMap(): Map<number, SearchFileKey> {
    if (this.filesCache?.version !== this.filesVersion) {
      const map = new Map<number, SearchFileKey>()
      for (const row of this.db.prepare('select id, path, kind, session_id, file_id from files').all()) {
        map.set(asInt(row['id']), {
          path: asText(row['path']),
          kind: asText(row['kind']) as HarnessKind,
          sessionId: asText(row['session_id']),
          fileId: asText(row['file_id']),
        })
      }
      this.filesCache = { version: this.filesVersion, map }
    }
    return this.filesCache.map
  }

  private filesVersion = 0
  private filesCache: { version: number; map: Map<number, SearchFileKey> } | null = null

  /** Append documents for one file. Call inside {@link transaction}. */
  insertDocs(key: SearchFileKey, docs: readonly SearchDoc[]): void {
    if (docs.length === 0) return
    const file = this.fileRef(key)
    const doc = this.db.prepare(
      'insert into docs (file, line, role, time_ms, text) values (?, ?, ?, ?, ?)',
    )
    const findText = this.db.prepare('select id from texts where hash = ?')
    const insertText = this.db.prepare('insert into texts (hash, text) values (?, ?)')
    // The FTS table is contentless: the text is tokenized, then discarded.
    const fts = this.db.prepare('insert into docs_fts (rowid, text) values (?, ?)')
    for (const entry of docs) {
      const textId = this.textRef(entry.text, findText, insertText, fts)
      doc.run(file, entry.line, entry.role, entry.timeMs ?? null, textId)
    }
  }

  /**
   * The `texts` rowid for one document text, inserting and indexing it on its
   * first occurrence. Duplicate documents — 45% of the reference corpus — cost
   * one hash lookup and share the stored blob and the FTS entry.
   */
  private textRef(
    text: string,
    findText: { get(hash: bigint): Record<string, unknown> | undefined },
    insertText: { run(hash: bigint, blob: Buffer): { lastInsertRowid: number | bigint } },
    fts: { run(rowid: number | bigint, text: string): unknown },
  ): number {
    const hash = hashText(text)
    const found = findText.get(hash)
    if (found !== undefined) return asInt(found['id'])
    const { lastInsertRowid } = insertText.run(hash, packText(text))
    fts.run(lastInsertRowid, text)
    return asInt(lastInsertRowid)
  }

  /**
   * Drop every document of a file, keeping its `files` row. Texts and FTS
   * rows are deliberately left behind: another file may reference the same
   * text, and finding out is a full-corpus anti-join that has no place in an
   * append-time flush. Orphans match a query but expand to zero hits until
   * the next {@link gcTexts} (startup sweep or retention purge) reclaims them.
   */
  clearDocs(path: string): void {
    this.db.prepare('delete from docs where file in (select id from files where path = ?)').run(path)
  }

  /** Forget a file entirely: it disappeared from disk or fell out of the retention window. */
  deleteFile(path: string): void {
    this.clearDocs(path)
    this.db.prepare('delete from files where path = ?').run(path)
    this.filesVersion += 1
  }

  /**
   * Reclaim texts whose last occurrence was deleted, along with their FTS
   * rows. An anti-join over the whole corpus (~0.5 s per 400k texts on the
   * reference corpus), so it runs only where a purge already accepts a
   * multi-second cost: the startup sweep and retention changes, right before
   * {@link compact} hands the freed pages back to the OS. Returns the number
   * of texts reclaimed so callers can compact even without deleting files.
   */
  gcTexts(): number {
    // Keep both indexes consistent if cleanup fails between the two deletes.
    return this.transaction(() => {
      this.db.prepare(`
        delete from docs_fts where rowid in (
          select id from texts where not exists (select 1 from docs where docs.text = texts.id)
        )
      `).run()
      const result = this.db.prepare(`
        delete from texts where not exists (select 1 from docs where docs.text = texts.id)
      `).run()
      return Number(result.changes)
    })
  }

  /**
   * Re-home a file whose owning session was only learned after its lines were
   * indexed (a subagent transcript that registered before its parent claimed
   * it). One row now: the documents follow their foreign key.
   */
  rebind(path: string, sessionId: string, fileId: string): void {
    this.db.prepare('update files set session_id = ?, file_id = ? where path = ?').run(sessionId, fileId, path)
    this.filesVersion += 1
  }

  docCount(): number {
    return asInt(this.db.prepare('select count(*) as n from docs').get()?.['n'])
  }

  /** Unique texts currently stored; occurrences are {@link docCount}. */
  textCount(): number {
    return asInt(this.db.prepare('select count(*) as n from texts').get()?.['n'])
  }

  fileCount(): number {
    return asInt(this.db.prepare('select count(*) as n from files').get()?.['n'])
  }
}
