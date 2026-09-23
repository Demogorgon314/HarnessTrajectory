import { createHash } from 'node:crypto'
import { asString, isRecord, parseJsonLine } from '@harness-trajectory/core'
import type { SessionSource } from './source.ts'

const fingerprint = (record: unknown) => createHash('sha256').update(JSON.stringify(record) ?? '').digest('hex')

/** Pi and DSH retain copied records for context, but their requests belong to the parent. */
export class CopiedUsageHistory {
  private readonly timelines = new Map<string, Promise<string[]>>()

  constructor(private readonly source: SessionSource) {}

  private async parent(kind: 'pi' | 'dsh', reference: string): Promise<string[]> {
    // Pi stores a transcript path; DSH stores a session id. Resolve only through
    // discovered sources, never open arbitrary paths supplied by a transcript.
    const session = this.source.list().find(session => session.kind === kind && (session.id === reference
      || this.source.get(kind, session.id)?.files.some(file => file.path === reference)))
    if (session === undefined) throw new Error('Fork parent unavailable')
    const key = `${kind} ${session.id}`
    let pending = this.timelines.get(key)
    if (pending === undefined) {
      pending = (async () => {
        const hashes: string[] = []
        await this.source.readAll(kind, session.id, event => {
          if (event.type !== 'lines' || event.file.id !== session.id) return
          for (const line of event.lines) {
            const record = parseJsonLine(line)
            if (isRecord(record) && record.type !== 'session') hashes.push(fingerprint(record))
          }
        })
        return hashes
      })()
      this.timelines.set(key, pending)
    }
    return pending
  }

  filter(kind: 'pi' | 'dsh', id: string): (line: string) => Promise<boolean> {
    let headerSeen = false
    let parent: string[] | undefined
    let offset = 0
    let prefix = true
    return async line => {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return false
      if (record.type === 'session') {
        if (!headerSeen) {
          headerSeen = true
          const reference = asString(record.parentSession)
          if (reference !== undefined && reference !== id) parent = await this.parent(kind, reference)
        }
        return false
      }
      if (parent === undefined || !prefix) return false
      const match = parent.indexOf(fingerprint(record), offset)
      if (match < 0) { prefix = false; return false }
      offset = match + 1
      return true
    }
  }
}
