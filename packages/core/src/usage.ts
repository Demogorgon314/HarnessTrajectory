import type { HarnessKind } from './session.ts'

/** Numeric request facts, grouped by session, route and UTC quarter-hour; no message bodies. */
export interface UsageBucket {
  sessionId: string
  kind: HarnessKind
  model: string
  provider: string
  /** Null means the transcript supplied no usable request timestamp. */
  time: number | null
  requests: number
  measured: number
  turnTotals: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

export interface UsageReport {
  buckets: UsageBucket[]
  sessions: { id: string; kind: HarnessKind; title: string;
    /** Latest recorded context occupancy, never additive request/billing usage. */
    context?: { used: number; window: number; time: number | null; model: string }
  }[]
  updatedAt: number
  failedSessions: number
}

export interface UsageProgress {
  completed: number
  total: number
  /** Records read during this scan; cached sessions require no record reads. */
  records: number
  currentSession: string | null
  done: boolean
}

/** Each stream sends session/bucket additions once, followed by a final done update. */
export type UsageStreamEvent =
  | { type: 'progress'; report: UsageReport; progress: UsageProgress }
  | { type: 'error'; message: string }
