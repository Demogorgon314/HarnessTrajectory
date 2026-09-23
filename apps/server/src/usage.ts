import { setImmediate } from 'node:timers/promises'
import { createSessionParser, type SessionParser, type SessionSummary, type UsageBucket, type UsageReport, type UsageProgress, type UsageStreamEvent } from '@harness-trajectory/core'
import { sessionKey, type SessionSource } from './source.ts'
import { CodexUsageHistory } from './usage-codex.ts'

const count = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0

/** Reuse the trajectory's request identity, replay suppression and usage corrections. */
async function collectSession(source: SessionSource, session: SessionSummary, codex: CodexUsageHistory, onRecords: (count: number) => void): Promise<UsageBucket[]> {
  const parsers = new Map<string, SessionParser>()
  const filters = new Map<string, (line: string) => Promise<boolean>>()
  await source.readAll(session.kind, session.id, async event => {
    if (event.type !== 'lines') return
    let parser = parsers.get(event.file.id)
    if (parser === undefined) {
      parser = createSessionParser(session.kind)
      parsers.set(event.file.id, parser)
      if (session.kind === 'codex') filters.set(event.file.id, codex.filter(event.file))
    }
    // Each child owns its own requests. Preserve inherited-history boundaries.
    const file = { ...event.file, role: 'main' as const }
    const filter = filters.get(event.file.id)
    for (const line of event.lines) {
      if (filter === undefined || await filter(line)) parser.push(line, file)
    }
    onRecords(event.lines.length)
    await setImmediate()
  })
  const buckets = new Map<string, UsageBucket>()
  for (const parser of parsers.values()) {
    for (const request of parser.snapshot().requests) {
      const route = request.provenance ?? request.requestConfig
      const model = route?.model || 'Unknown model'
      const provider = route?.provider.trim().toLowerCase() || 'Unknown provider'
      const time = request.completedAt ?? request.startedAt
      // Quarter-hours preserve local day/hour boundaries in :30 and :45 timezones.
      const hour = Number.isFinite(time) && time > 0 ? Math.floor(time / 900_000) * 900_000 : null
      const key = JSON.stringify([model, provider, hour])
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = { sessionId: session.id, kind: session.kind, model, provider, time: hour,
          requests: 0, measured: 0, turnTotals: 0, input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
        buckets.set(key, bucket)
      }
      bucket.requests += 1
      const usage = request.usage
      if (usage === undefined) continue
      bucket.measured += 1
      if (usage.scope === 'turn') bucket.turnTotals += 1
      const input = count(usage.inputTokens)
      const output = count(usage.outputTokens)
      const read = count(usage.cacheReadTokens)
      const write = count(usage.cacheWriteTokens)
      bucket.input += input + read + write
      bucket.output += output
      bucket.cacheRead += read
      bucket.cacheWrite += write
      bucket.reasoning += count(usage.reasoningTokens)
      // Reasoning is already inside output; cache is included in displayed input.
      bucket.total += usage.totalTokens === undefined ? input + read + write + output : count(usage.totalTokens)
    }
  }
  return [...buckets.values()]
}

interface UsageScan {
  report: UsageReport
  progress: UsageProgress
  revision: number
  error: string | null
  waiters: Set<() => void>
}

function publish(scan: UsageScan): void {
  scan.revision += 1
  scan.report.updatedAt = Date.now()
  for (const wake of scan.waiters) wake()
}

function waitForUpdate(scan: UsageScan, revision: number, signal: AbortSignal): Promise<void> {
  if (scan.revision !== revision || signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const wake = () => {
      scan.waiters.delete(wake)
      signal.removeEventListener('abort', wake)
      resolve()
    }
    scan.waiters.add(wake)
    signal.addEventListener('abort', wake, { once: true })
  })
}

/** Lazy, serialized scans; retain numeric summaries only, never parsers or transcript text. */
export class UsageService {
  private readonly cache = new Map<string, { stamp: string; buckets: UsageBucket[] }>()
  private pending: { scan: UsageScan; promise: Promise<UsageReport> } | undefined
  private codexRevision = 0

  constructor(private readonly source: SessionSource) {
    source.on('change', (kind: SessionSummary['kind'], id: string) => {
      this.cache.delete(sessionKey(kind, id))
      // A changed/recovered parent can change which prefix a fork inherits.
      if (kind === 'codex') {
        this.codexRevision += 1
        for (const key of this.cache.keys()) {
          if (key.startsWith('codex ')) this.cache.delete(key)
        }
      }
    })
  }

  read(): Promise<UsageReport> {
    return this.start().promise
  }

  /** Slow consumers coalesce progress and pull only unseen additions; no per-client queue. */
  async *stream(signal: AbortSignal): AsyncGenerator<UsageStreamEvent> {
    if (signal.aborted) return
    const { scan } = this.start()
    let bucketCursor = 0
    let sessionCursor = 0
    while (!signal.aborted) {
      const revision = scan.revision
      if (scan.error !== null) {
        yield { type: 'error', message: scan.error }
        return
      }
      const { report, progress } = scan
      const event: UsageStreamEvent = { type: 'progress', progress: { ...progress },
        report: { ...report, buckets: report.buckets.slice(bucketCursor), sessions: report.sessions.slice(sessionCursor) } }
      bucketCursor = report.buckets.length
      sessionCursor = report.sessions.length
      yield event
      if (event.progress.done) return
      await waitForUpdate(scan, revision, signal)
    }
  }

  private start(): { scan: UsageScan; promise: Promise<UsageReport> } {
    if (this.pending !== undefined) return this.pending
    const sessions = this.source.list()
    const scan: UsageScan = {
      report: { buckets: [], sessions: [], updatedAt: Date.now(), failedSessions: 0 },
      progress: { completed: 0, total: sessions.length, records: 0, currentSession: null, done: false },
      revision: 0, error: null, waiters: new Set(),
    }
    // Defer collection so a new subscriber receives the initial 0/total frame immediately.
    const promise = Promise.resolve().then(() => this.collect(sessions, scan)).catch((error: unknown) => {
      scan.error = 'Could not finish reading token usage. Refresh to retry.'
      throw error
    }).finally(() => {
      scan.progress.done = true
      scan.progress.currentSession = null
      publish(scan)
      this.pending = undefined
    })
    // Stream consumers observe scan.error; JSON consumers observe the rejected promise.
    void promise.catch(() => {})
    this.pending = { scan, promise }
    return this.pending
  }

  private async collect(sessions: SessionSummary[], scan: UsageScan): Promise<UsageReport> {
    const live = new Set(sessions.map(session => sessionKey(session.kind, session.id)))
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key)
    const { report, progress } = scan
    const codex = new CodexUsageHistory(this.source)
    const codexRevision = this.codexRevision
    let lastProgressAt = 0
    for (const session of sessions) {
      progress.currentSession = session.title
      publish(scan)
      const key = sessionKey(session.kind, session.id)
      const stamp = `${session.updatedAt}:${session.bytes}:${session.childCount}`
      let cached = this.cache.get(key)
      if (cached?.stamp !== stamp) {
        let changed = false
        const onChange = (kind: SessionSummary['kind'], id: string) => {
          if (kind === session.kind && (id === session.id || kind === 'codex')) changed = true
        }
        this.source.on('change', onChange)
        try {
          cached = { stamp, buckets: await collectSession(this.source, session, codex, count => {
            progress.records += count
            if (Date.now() - lastProgressAt >= 200) {
              lastProgressAt = Date.now()
              publish(scan)
            }
          }) }
          if (!changed && (session.kind !== 'codex' || codexRevision === this.codexRevision)) this.cache.set(key, cached)
        } catch {
          report.failedSessions += 1
          cached = undefined
        } finally {
          this.source.off('change', onChange)
        }
      }
      if (cached !== undefined) for (const bucket of cached.buckets) report.buckets.push(bucket)
      report.sessions.push({ id: session.id, kind: session.kind, title: session.title })
      progress.completed += 1
      publish(scan)
      await setImmediate()
    }
    return report
  }
}
