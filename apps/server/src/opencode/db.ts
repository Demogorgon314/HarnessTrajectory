/**
 * OpenCode session store (`$XDG_DATA_HOME/opencode/opencode.db`, else
 * `~/.local/share/opencode/opencode.db`, WAL mode, written live by running
 * `opencode` processes). `HARNESS_TRAJECTORY_OPENCODE_DB` overrides the path.
 *
 * Tables (schema verified against opencode 1.18.31,
 * `packages/core/src/session/sql.ts`, and a 1.18.x local store):
 *
 * - `session` — one row per session: `id`, `parent_id` (the spawning session
 *   for subagents), `slug`, `directory`, `title` (always set — generated
 *   later, or `New session - <iso>`), `version`, `agent`, `model` (JSON
 *   `{id, providerID, variant?}`, NULL on ~3/4 of rows), `cost`,
 *   `tokens_*`, `revert`, `time_created`/`time_updated`. All times epoch
 *   MILLISECONDS.
 * - `message` — `(id 'msg_…', session_id, time_created, time_updated, data)`;
 *   `data` is the V1 `Message` JSON minus `id`/`sessionID` (`role: 'user'`
 *   or `'assistant'`). Order = `time_created, id`.
 * - `part` — `(id 'prt_…', message_id, session_id, time_created,
 *   time_updated, data)`; `data` is the V1 `Part` JSON minus
 *   `id`/`messageID`/`sessionID`. Order within a message = `id` (ascending
 *   ULID-like). Tool parts mutate `pending→running→completed|error`;
 *   `SessionCompaction.prune` sets `state.time.compacted` on old completed
 *   ones. Revert deletes rows — a count regression means rebuild.
 * - `session_message`/`session_v2`/`session_input` are the newer V2
 *   projection and are ignored: V1 `message`+`part` is what the CLI/TUI/SDK
 *   read and what old stores have.
 *
 * Scale traps (1.4 GB store, 381 sessions): `PRAGMA data_version` gates a
 * tick; `SUM(length(data))` reads every blob (~2 s cold) so it runs once at
 * startup grouped per session and per changed session afterwards — never
 * per tick for all sessions; message/part BODIES are fetched lazily per
 * session (the transcript tier), never all at startup.
 *
 * `json_extract` is used only for role row-selection — `userMessages`/
 * `userParts` (`role: 'user'`, the catalog scanner feed) and
 * `firstAssistantModel` (`role: 'assistant'`, the model fallback). Every
 * classification decision beyond picking the rows stays in TypeScript.
 * `userMessages` also projects `data` through `json_remove($.summary.diffs)`
 * — again a row projection, not a classification: the ~500 KB diff blobs
 * are stripped at wire time anyway, so they never leave SQLite here.
 */

import { DatabaseSync } from 'node:sqlite'

export interface OpencodeSessionRow {
  id: string
  parent_id: string | null
  slug: string
  directory: string
  title: string
  version: string
  agent: string | null
  /** JSON `{id, providerID, variant?}` or null. */
  model: string | null
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  /** Epoch ms. */
  time_created: number
  /** Epoch ms. */
  time_updated: number
}

export interface OpencodeMessageRow {
  id: string
  session_id: string
  /** Epoch ms. */
  time_created: number
  /** Epoch ms. */
  time_updated: number
  /** V1 `Message` JSON minus `id`/`sessionID`. */
  data: string
}

export interface OpencodePartRow {
  id: string
  message_id: string
  session_id: string
  /** Epoch ms. */
  time_created: number
  /** Epoch ms. */
  time_updated: number
  /** V1 `Part` JSON minus `id`/`messageID`/`sessionID`. */
  data: string
}

/** `COUNT(*)`/`MAX(time_updated)` of one session's rows in one table. */
export interface OpencodeTouch {
  session_id: string
  count: number
  max_updated: number
}

const TABLES = [
  `CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    parent_id TEXT,
    slug TEXT NOT NULL DEFAULT '',
    directory TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    agent TEXT,
    model TEXT,
    cost REAL NOT NULL DEFAULT 0,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    workspace_id TEXT,
    path TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER
  )`,
  `CREATE INDEX session_parent_idx ON session (parent_id)`,
  `CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id)`,
  `CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX part_message_id_id_idx ON part (message_id, id)`,
  // The real store has it; the `>=` per-session tick queries rely on it.
  `CREATE INDEX part_session_idx ON part (session_id)`,
]

const SESSION_COLUMNS = `id, parent_id, slug, directory, title, version, agent, model,
  cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
  time_created, time_updated`
const MESSAGE_COLUMNS = `id, session_id, time_created, time_updated, data`
const PART_COLUMNS = `id, message_id, session_id, time_created, time_updated, data`

/**
 * Open the store read-only (WAL allows concurrent readers while `opencode`
 * writes). `create` exists so tests can build a fixture with the same class.
 */
export class OpencodeDb {
  readonly db: DatabaseSync

  constructor(readonly path: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, options.readOnly === false ? {} : { readOnly: true })
  }

  /** Create the schema in a fresh (test) database. */
  createSchema(): void {
    for (const sql of TABLES) this.db.exec(sql)
  }

  /** Whether the store has the V1 tables this source reads. */
  hasSchema(): boolean {
    const names = new Set(
      (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
        .map(row => row.name),
    )
    return ['session', 'message', 'part'].every(name => names.has(name))
  }

  /**
   * WAL data version — the cheap "did anything move" tick gate: unchanged
   * means skip the grouped touch queries entirely.
   */
  dataVersion(): number {
    const row = this.db.prepare(`PRAGMA data_version`).get() as { data_version: number }
    return row.data_version
  }

  sessions(): OpencodeSessionRow[] {
    return this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM session ORDER BY time_created, id`)
      .all() as unknown as OpencodeSessionRow[]
  }

  /** `COUNT(*)`/`MAX(time_updated)` per session for `message` or `part` — the tick's change probe. */
  touches(table: 'message' | 'part'): OpencodeTouch[] {
    return this.db.prepare(
      `SELECT session_id, COUNT(*) AS count, MAX(time_updated) AS max_updated
       FROM ${table} GROUP BY session_id`,
    ).all() as unknown as OpencodeTouch[]
  }

  /** `SUM(length(data))` per session for `message` or `part` — expensive; startup + per-session refresh only. */
  sizes(table: 'message' | 'part'): Map<string, number> {
    const rows = this.db.prepare(
      `SELECT session_id, SUM(length(data)) AS bytes FROM ${table} GROUP BY session_id`,
    ).all() as unknown as Array<{ session_id: string; bytes: number | null }>
    const map = new Map<string, number>()
    for (const row of rows) map.set(row.session_id, row.bytes ?? 0)
    return map
  }

  /** Byte size of one session's rows in one table (the per-refresh variant of `sizes`). */
  sizeOf(table: 'message' | 'part', sessionId: string): number {
    const row = this.db.prepare(
      `SELECT SUM(length(data)) AS bytes FROM ${table} WHERE session_id = ?`,
    ).get(sessionId) as { bytes: number | null }
    return row.bytes ?? 0
  }

  /** All messages of a session in transcript order (materialization/replay). */
  messages(sessionId: string): OpencodeMessageRow[] {
    return this.db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM message WHERE session_id = ? ORDER BY time_created, id`,
    ).all(sessionId) as unknown as OpencodeMessageRow[]
  }

  /** All parts of a session grouped by message, ordered `(message_id, id)`. */
  parts(sessionId: string): OpencodePartRow[] {
    return this.db.prepare(
      `SELECT ${PART_COLUMNS} FROM part WHERE session_id = ? ORDER BY message_id, id`,
    ).all(sessionId) as unknown as OpencodePartRow[]
  }

  /**
   * Messages whose row moved since `since` (incremental tick fetch). The
   * comparison is `>=` on purpose: two writes in the same millisecond with
   * a poll between them would lose the second under strict `>`. Rows at
   * the watermark are re-read — `noteRows` upserts and skips known ids, so
   * a re-read is idempotent.
   */
  messagesUpdatedAfter(sessionId: string, since: number): OpencodeMessageRow[] {
    return this.db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM message WHERE session_id = ? AND time_updated >= ? ORDER BY time_created, id`,
    ).all(sessionId, since) as unknown as OpencodeMessageRow[]
  }

  /** Parts whose row moved since `since` — `>=`, same watermark reason as `messagesUpdatedAfter`. */
  partsUpdatedAfter(sessionId: string, since: number): OpencodePartRow[] {
    return this.db.prepare(
      `SELECT ${PART_COLUMNS} FROM part WHERE session_id = ? AND time_updated >= ? ORDER BY message_id, id`,
    ).all(sessionId, since) as unknown as OpencodePartRow[]
  }

  /**
   * `role: 'user'` message rows of a session — the catalog scanner's feed.
   * The ONLY `json_extract` in the layer: the filter is row selection, not
   * classification (that stays in `opencodeUserClass`). The data column is
   * projected with `json_remove(data, '$.summary.diffs')` — user rows carry
   * ~500 KB diff blobs the wire strips anyway; projecting in SQL keeps them
   * out of the startup feed. `stripSummaryDiffs` in transcript.ts remains
   * the wire-time guarantee.
   */
  userMessages(sessionId: string): OpencodeMessageRow[] {
    return this.db.prepare(
      `SELECT id, session_id, time_created, time_updated,
              json_remove(data, '$.summary.diffs') AS data
       FROM message
       WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
       ORDER BY time_created, id`,
    ).all(sessionId) as unknown as OpencodeMessageRow[]
  }

  /** Parts of a session's `role: 'user'` messages (the catalog scanner's feed). */
  userParts(sessionId: string): OpencodePartRow[] {
    return this.db.prepare(
      `SELECT p.id, p.message_id, p.session_id, p.time_created, p.time_updated, p.data
       FROM part p
       JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? AND json_extract(m.data, '$.role') = 'user'
       ORDER BY p.message_id, p.id`,
    ).all(sessionId) as unknown as OpencodePartRow[]
  }

  /** `modelID`/`providerID` of the session's first assistant message (the `session.model` fallback). */
  firstAssistantModel(sessionId: string): { modelID: string; providerID: string } | null {
    const row = this.db.prepare(
      `SELECT json_extract(data, '$.modelID') AS model, json_extract(data, '$.providerID') AS provider
       FROM message
       WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
       ORDER BY time_created, id LIMIT 1`,
    ).get(sessionId) as { model: string | null; provider: string | null } | undefined
    if (row === undefined || row.model === null) return null
    return { modelID: row.model, providerID: row.provider ?? '' }
  }

  close(): void {
    this.db.close()
  }
}
