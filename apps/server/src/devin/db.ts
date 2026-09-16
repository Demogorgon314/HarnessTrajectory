/**
 * Devin CLI session store (`~/.local/share/devin/cli/sessions.db`, WAL mode,
 * written live by running `devin` processes).
 *
 * Tables (schema verified against devin 1.x stores; `refinery_schema_history`
 * records the migrations):
 *
 * - `sessions` — one row per session: id, title (generated, lands late),
 *   `working_directory`, model, agent_mode, `created_at`/`last_activity_at`
 *   (epoch SECONDS), `main_chain_id`, `hidden`, `metadata` (cost rollup).
 * - `message_nodes` — a persistent forest. Each row is one chat message node:
 *   `node_id`/`parent_node_id` form trees, and every context render copies the
 *   surviving chain into a NEW tree — the copies carry the same `message_id`
 *   and the ROW's `metadata.extensions."compact/prior_node_ids"` points at the
 *   nodes it replaces (older stores carried the same links inside
 *   `chat_message.metadata.extensions`). So the logical transcript is the
 *   first-occurrence node of each `message_id`; chain membership is decided by
 *   a union-find over parent + prior edges, with shared message ids gluing
 *   only prior-free components — `message_id` is object identity, and the
 *   subagent boilerplate (one shared system-prompt object) carries a single
 *   mid across every agent chain (`subagent_heads` exists but is empty in
 *   practice). A background `run_subagent` binds its chain late: the spawn
 *   result carries `subagent/agent_id` only, and a
 *   `<subagent_completion_notification>` system node on the main chain later
 *   adds `subagent/chain_node_id`. Before then, the source can infer ownership
 *   from a unique exact match between the spawn task and a chain's opener.
 * - `tool_call_state` — `(session_id, tool_call_id)` → serialized ACP
 *   `ToolCall` + `ToolCallUpdate` (status/title/kind/locations), update column
 *   filled when the call settles.
 *
 * All timestamps here are epoch seconds unless noted; `chat_message.metadata`
 * carries ISO/ms stamps (`created_at`, `started_generation_at`) that refine
 * them.
 */

import { DatabaseSync } from 'node:sqlite'

export interface DevinSessionRow {
  id: string
  working_directory: string
  backend_type: string
  model: string
  agent_mode: string
  /** Epoch seconds. */
  created_at: number
  /** Epoch seconds. */
  last_activity_at: number
  title: string | null
  main_chain_id: number | null
  hidden: number
  metadata: string | null
}

export interface DevinNodeRow {
  row_id: number
  node_id: number
  parent_node_id: number | null
  chat_message: string
  /** Epoch seconds. */
  created_at: number
  metadata: string | null
}

export interface DevinToolRow {
  tool_call_id: string
  tool_call_json: string | null
  tool_call_update_json: string | null
}

export interface DevinHeadRow {
  agent_id: string
  chain_node_id: number
  updated_at: number
}

const TABLES = [
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    working_directory TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_mode TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    title TEXT,
    main_chain_id INTEGER,
    hidden INTEGER NOT NULL DEFAULT 0,
    metadata TEXT
  )`,
  `CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL,
    parent_node_id INTEGER,
    chat_message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    metadata TEXT,
    UNIQUE(session_id, node_id)
  )`,
  `CREATE TABLE tool_call_state (
    session_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_call_json TEXT,
    tool_call_update_json TEXT,
    PRIMARY KEY (session_id, tool_call_id)
  )`,
  `CREATE TABLE subagent_heads (
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    chain_node_id INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, agent_id)
  )`,
]

/**
 * Open the store read-only (WAL allows concurrent readers while `devin`
 * writes). `create` exists so tests can build a fixture with the same class.
 */
export class DevinDb {
  readonly db: DatabaseSync

  constructor(readonly path: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, options.readOnly === false ? {} : { readOnly: true })
  }

  /** Create the schema in a fresh (test) database. */
  createSchema(): void {
    for (const sql of TABLES) this.db.exec(sql)
  }

  /** Whether the store has the tables this source reads. */
  hasSchema(): boolean {
    const names = new Set(
      (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
        .map(row => row.name),
    )
    return ['sessions', 'message_nodes', 'tool_call_state'].every(name => names.has(name))
  }

  sessions(): DevinSessionRow[] {
    return this.db.prepare(
      `SELECT id, working_directory, backend_type, model, agent_mode,
              created_at, last_activity_at, title, main_chain_id, hidden, metadata
       FROM sessions ORDER BY created_at`,
    ).all() as unknown as DevinSessionRow[]
  }

  /** Highest `row_id` of a session — the cheap "did anything move" probe. */
  maxRowId(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(row_id), 0) AS m FROM message_nodes WHERE session_id = ?`,
    ).get(sessionId) as { m: number }
    return row.m
  }

  /** Rows appended after `rowId`, in insertion order. */
  nodesAfter(sessionId: string, rowId: number): DevinNodeRow[] {
    return this.db.prepare(
      `SELECT row_id, node_id, parent_node_id, chat_message, created_at, metadata
       FROM message_nodes WHERE session_id = ? AND row_id > ? ORDER BY row_id`,
    ).all(sessionId, rowId) as unknown as DevinNodeRow[]
  }

  /** Rows at or before `rowId`, in insertion order (a consumed prefix). */
  nodesBefore(sessionId: string, rowId: number): DevinNodeRow[] {
    return this.db.prepare(
      `SELECT row_id, node_id, parent_node_id, chat_message, created_at, metadata
       FROM message_nodes WHERE session_id = ? AND row_id <= ? ORDER BY row_id`,
    ).all(sessionId, rowId) as unknown as DevinNodeRow[]
  }

  /** All rows of a session, in insertion order (replay / re-materialization). */
  nodes(sessionId: string): DevinNodeRow[] {
    return this.nodesAfter(sessionId, 0)
  }

  toolStates(sessionId: string): DevinToolRow[] {
    return this.db.prepare(
      `SELECT tool_call_id, tool_call_json, tool_call_update_json
       FROM tool_call_state WHERE session_id = ? ORDER BY tool_call_id`,
    ).all(sessionId) as unknown as DevinToolRow[]
  }

  /** Present in the schema but unpopulated in observed stores; read opportunistically. */
  subagentHeads(sessionId: string): DevinHeadRow[] {
    try {
      return this.db.prepare(
        `SELECT agent_id, chain_node_id, updated_at
         FROM subagent_heads WHERE session_id = ?`,
      ).all(sessionId) as unknown as DevinHeadRow[]
    } catch {
      return []
    }
  }

  close(): void {
    this.db.close()
  }
}
