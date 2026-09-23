import { createHash } from 'node:crypto'
import { asString, isRecord, parseJsonLine, type SessionFileRef } from '@harness-trajectory/core'
import type { SessionSource } from './source.ts'

function fingerprint(line: string): string {
  // Parse/stringify tolerates whitespace changes in copied JSONL records.
  return createHash('sha256').update(JSON.stringify(parseJsonLine(line)) ?? line).digest('hex')
}

/** Scan-local parent timelines: many forks share one replay, without retaining message text. */
export class CodexUsageHistory {
  private readonly parents = new Map<string, Promise<string[]>>()

  constructor(private readonly source: SessionSource) {}

  private timeline(id: string): Promise<string[]> {
    let pending = this.parents.get(id)
    if (pending === undefined) {
      pending = (async () => {
        const records: string[] = []
        await this.source.readAll('codex', id, event => {
          if (event.type === 'lines' && event.file.id === id) {
            for (const line of event.lines) records.push(fingerprint(line))
          }
        })
        // Do not cache a plausible zero when a fork's parent is unavailable.
        if (records.length === 0) throw new Error('Codex fork parent unavailable')
        return records
      })()
      this.parents.set(id, pending)
    }
    return pending
  }

  filter(file: SessionFileRef): (line: string) => Promise<boolean> {
    let ownerSeen = false
    let parent: string[] | undefined
    let parentOffset = 0
    let inheritedPrefix = true
    return async line => {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return false
      if (record.type === 'session_meta' && isRecord(record.payload)) {
        if (asString(record.payload.id) !== file.id) return false
        if (!ownerSeen) {
          ownerSeen = true
          const fork = asString(record.payload.forked_from_id)
          // history_base is already replayed before this header; its foreign
          // headers are excluded above. Same-thread revert history stays owned.
          if (fork !== undefined && fork !== file.id && !isRecord(record.payload.history_base)) {
            parent = await this.timeline(fork)
          }
        }
        return true
      }
      if (!ownerSeen) return false
      if (parent !== undefined && inheritedPrefix) {
        const match = parent.indexOf(fingerprint(line), parentOffset)
        if (match >= 0) {
          parentOffset = match + 1
          return false
        }
        // Only a copied prefix belongs to the parent. Equal records after the
        // first divergence must not suppress newly generated work.
        inheritedPrefix = false
      }
      return true
    }
  }
}
