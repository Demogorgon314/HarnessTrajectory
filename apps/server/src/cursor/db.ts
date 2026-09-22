/**
 * One Cursor Agent session store (`~/.cursor/chats/<md5>/<agentId>/store.db`,
 * WAL, written live). Two tables: `meta(key, value)` and `blobs(id, data)`.
 *
 * `meta` key `'0'` is hex-encoded JSON (`agentId`, `latestRootBlobId`,
 * `name`, `mode`, `approvalMode`, `createdAt`, `lastUsedModel`, …). A value
 * that already starts with `{` is accepted as plain JSON. Garbage yields
 * undefined — never throws.
 *
 * `blobs.id` is the hex SHA-256 of `data`. Model messages are JSON (first
 * byte `{`); the root and the turn tree are protobuf. This module only
 * reads bytes. Callers decode them.
 *
 * Open read-only. One database per session, so the source keeps an LRU of
 * open handles rather than one process-wide connection.
 */

import { DatabaseSync } from 'node:sqlite'
import { isRecord } from '@harness-trajectory/core'

const TABLES = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)`,
]

/** Hex-encoded or plain JSON object from `meta.value`. Undefined when it is garbage. */
export function parseMetaValue(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const json = trimmed.startsWith('{') ? trimmed : hexToUtf8(trimmed)
  if (json === undefined) return undefined
  try {
    const parsed = JSON.parse(json) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function hexToUtf8(hex: string): string | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    if (!Number.isFinite(byte)) return undefined
    bytes[index] = byte
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Open one session store. `readOnly: false` exists so tests can build a
 * fixture with the same class; production always reads.
 */
export class CursorDb {
  readonly db: DatabaseSync

  constructor(readonly path: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, options.readOnly === false ? {} : { readOnly: true })
  }

  /** Create the two tables in a fresh (test) database. */
  createSchema(): void {
    for (const sql of TABLES) this.db.exec(sql)
  }

  /**
   * WAL data version for this connection. Unchanged means the database file
   * has not committed since the last read on this handle.
   */
  dataVersion(): number | undefined {
    try {
      const row = this.db.prepare(`PRAGMA data_version`).get() as { data_version: number } | undefined
      return typeof row?.data_version === 'number' ? row.data_version : undefined
    } catch {
      return undefined
    }
  }

  /** The `'0'` meta row, decoded. Undefined when the row is missing or garbage. */
  readMeta(): Record<string, unknown> | undefined {
    try {
      const row = this.db.prepare(`SELECT value FROM meta WHERE key = '0'`).get() as { value: string } | undefined
      if (row === undefined || typeof row.value !== 'string') return undefined
      return parseMetaValue(row.value)
    } catch {
      return undefined
    }
  }

  /** Raw blob bytes, or undefined when the id is absent. */
  readBlob(id: string): Uint8Array | undefined {
    try {
      const row = this.db.prepare(`SELECT data FROM blobs WHERE id = ?`).get(id) as { data: Uint8Array } | undefined
      if (row === undefined || !(row.data instanceof Uint8Array)) return undefined
      return row.data
    } catch {
      return undefined
    }
  }

  close(): void {
    this.db.close()
  }
}
