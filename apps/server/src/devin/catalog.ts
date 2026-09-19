/** Restart-only listing snapshots. Chain state is rebuilt before any live consumption. */
import { createHash } from 'node:crypto'
import { asNumber, asString, isRecord, type AgentFileMeta } from '@harness-trajectory/core'
import { createMetaScanner, hydrateMeta, META_SCANNER_VERSION, serializeMeta } from '../meta.ts'
import type { SourceEntry } from '../source.ts'
import type { DevinDb, DevinSessionRow } from './db.ts'

/** Bump when the snapshot shape or reconstructed stream semantics change. */
const VERSION = 1

export function catalogFingerprint(db: DevinDb, identity: string | null, row: DevinSessionRow): string {
  return createHash('sha256').update(JSON.stringify([
    VERSION, META_SCANNER_VERSION, identity, row, db.nodeStats(row.id),
    db.subagentHeads(row.id), db.toolStates(row.id),
  ])).digest('hex')
}

export function serializeCatalog(entries: readonly SourceEntry[], maxRowId: number): string {
  return JSON.stringify({ maxRowId, entries: entries.map(entry => ({
    id: entry.ref.id, role: entry.ref.role, agent: entry.ref.agent,
    size: entry.size, mtimeMs: entry.mtimeMs, lines: entry.lines, meta: serializeMeta(entry.meta),
  })) })
}

export function parseCatalog(saved: string, sessionId: string): { entries: SourceEntry[]; maxRowId: number } | undefined {
  try {
    const data: unknown = JSON.parse(saved)
    if (!isRecord(data) || !Array.isArray(data['entries'])) return undefined
    const maxRowId = asNumber(data['maxRowId'])
    if (maxRowId === undefined || maxRowId < 0) return undefined
    const entries: SourceEntry[] = []
    const ids = new Set<string>()
    for (const value of data['entries']) {
      if (!isRecord(value)) return undefined
      const id = asString(value['id'])
      const role = value['role']
      const size = asNumber(value['size'])
      const mtimeMs = asNumber(value['mtimeMs'])
      const lines = asNumber(value['lines'])
      const savedMeta = asString(value['meta'])
      if (id === undefined || ids.has(id) || (role !== 'main' && role !== 'child')
        || size === undefined || mtimeMs === undefined || lines === undefined || savedMeta === undefined) return undefined
      ids.add(id)
      const meta = createMetaScanner('devin')
      if (!hydrateMeta(meta, savedMeta)) return undefined
      const path = `devin://sessions/${sessionId}${role === 'child' ? `/${id}` : ''}`
      const rawAgent = value['agent']
      let agent: AgentFileMeta | undefined
      if (isRecord(rawAgent)) {
        const agentId = asString(rawAgent['agentId'])
        if (agentId === undefined) return undefined
        agent = { agentId }
        for (const key of ['agentId', 'toolUseId', 'description', 'agentType', 'model'] as const) {
          const field = asString(rawAgent[key])
          if (field !== undefined) agent[key] = field
        }
        if (rawAgent['isFork'] === true) agent.isFork = true
      }
      entries.push({
        kind: 'devin', sessionId, path, size, mtimeMs, lines, meta,
        ref: { id, role, path, ...(role === 'child' ? { parentId: sessionId } : {}), ...(agent === undefined ? {} : { agent }) },
      })
    }
    if (entries.filter(entry => entry.ref.role === 'main').length !== 1) return undefined
    if (entries.find(entry => entry.ref.role === 'main')?.ref.id !== sessionId) return undefined
    return { entries, maxRowId }
  } catch {
    return undefined
  }
}
