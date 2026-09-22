/**
 * Recover context epochs from immutable roots, without treating SQLite row
 * order or message count as chronology. A candidate must belong to the current
 * prompt/item lineage. Ambiguous predecessors are deliberately left out.
 */
import { cursorUserClass } from '@harness-trajectory/core'
import { CursorDb } from './db.ts'
import { decodeRoot, decodeTurn, type CursorRoot, type CursorTurnSkeleton } from './proto.ts'

interface Candidate {
  root: CursorRoot
  turns: CursorTurnSkeleton[]
  summary: string | null
  rank: number
}

function prefix(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((id, index) => id === b[index])
}

function ancestor(a: Candidate, b: Candidate): boolean {
  return a.turns.length <= b.turns.length && a.turns.every((turn, index) => {
    const next = b.turns[index]
    return next !== undefined && turn.promptId !== undefined && turn.promptId === next.promptId
      && prefix(turn.itemIds, next.itemIds)
  })
}

function subsequence(a: readonly string[], b: readonly string[]): boolean {
  let index = 0
  for (const id of b) if (id === a[index]) index += 1
  return index === a.length
}

export class CursorHistory {
  private cached: { anchor: Candidate; roots: CursorRoot[] } | undefined
  private readonly summaries = new Map<string, boolean>()
  private readonly turns = new Map<string, CursorTurnSkeleton>()

  constructor(
    private readonly db: CursorDb,
    private readonly readMessage: (id: string) => Record<string, unknown> | undefined,
  ) {}

  /** Chronological, proven predecessor epochs, followed by the current root. */
  roots(current: CursorRoot): CursorRoot[] {
    // Bounded facts only; keep neither message text nor every historical root.
    if (this.summaries.size > 4096) this.summaries.clear()
    if (this.turns.size > 2048) this.turns.clear()
    const { summaries, turns } = this
    const inspect = (root: CursorRoot): Candidate | undefined => {
      if (root.messageIds.length === 0 || root.turnIds.length === 0) return undefined
      const chain: CursorTurnSkeleton[] = []
      for (const id of root.turnIds) {
        let turn = turns.get(id)
        if (turn === undefined) {
          const bytes = this.db.readBlob(id)
          turn = bytes === undefined ? undefined : decodeTurn(bytes)
          if (turn !== undefined) turns.set(id, turn)
        }
        if (turn?.promptId === undefined) return undefined
        chain.push(turn)
      }
      const summaryIds: string[] = []
      for (const id of root.messageIds) {
        let summary = summaries.get(id)
        if (summary === undefined) {
          const message = this.readMessage(id)
          if (message === undefined) return undefined
          summary = cursorUserClass(message) === 'summary'
          summaries.set(id, summary)
        }
        if (summary) summaryIds.push(id)
      }
      // Multiple summary markers have no verified epoch-order contract.
      if (summaryIds.length > 1) return undefined
      return {
        root, turns: chain, summary: summaryIds[0] ?? null,
        rank: chain.reduce((sum, turn) => sum + 1 + turn.itemIds.length, 0),
      }
    }
    const target = inspect(current)
    if (target === undefined || target.summary === null) return [current]
    if (this.cached?.anchor.summary === target.summary && ancestor(this.cached.anchor, target)) {
      return [...this.cached.roots, current]
    }
    const candidates: Candidate[] = [target]
    for (const bytes of this.db.binaryBlobs()) {
      const root = decodeRoot(bytes)
      if (root === undefined) continue
      const candidate = inspect(root)
      if (candidate !== undefined && ancestor(candidate, target)) candidates.push(candidate)
    }
    const predecessors: CursorRoot[] = []
    const visited = new Set<string>()
    let cursor = target
    while (cursor.summary !== null && !visited.has(cursor.summary)) {
      visited.add(cursor.summary)
      const epoch = candidates.filter(candidate => candidate.summary === cursor.summary && ancestor(candidate, cursor))
      const boundary = epoch.reduce((min, candidate) => Math.min(min, candidate.rank), cursor.rank)
      const anchors = epoch.filter(candidate => candidate.rank === boundary)
      const older = candidates.filter(candidate => candidate.summary !== cursor.summary
        && (candidate.summary === null || !visited.has(candidate.summary))
        && candidate.rank <= boundary && anchors.every(anchor => ancestor(candidate, anchor)))
      const rank = older.reduce((max, candidate) => Math.max(max, candidate.rank), -1)
      const frontier = older.filter(candidate => candidate.rank === rank)
      // At an equal turn frontier, an in-flight root may lack its final message.
      // Accept an extension only if it contains every alternative in order;
      // incomparable roots could be branches or an unknown format transition.
      const predecessor = frontier.find(candidate => frontier.every(other =>
        other.summary === candidate.summary && ancestor(other, candidate)
        && subsequence(other.root.messageIds, candidate.root.messageIds)))
      if (predecessor === undefined) break
      predecessors.unshift(predecessor.root)
      cursor = predecessor
    }
    if (predecessors.length > 0) this.cached = { anchor: target, roots: predecessors }
    return [...predecessors, current]
  }
}
