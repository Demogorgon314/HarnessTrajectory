import { setImmediate } from 'node:timers/promises'
import { asNumber, asString, createSessionParser, cursorUsageOf, parseCursorLine, type SessionParser, type SessionSummary, type UsageBucket, type UsageReport, type UsageProgress, type UsageStreamEvent } from '@harness-trajectory/core'
import { sessionKey, type SessionSource } from './source.ts'
import { CodexUsageHistory } from './usage-codex.ts'
import { claudeUsageFilter } from './usage-claude.ts'
import { CopiedUsageHistory } from './usage-copied.ts'

const hasCopiedHistory = (kind: SessionSummary['kind']) => kind === 'codex' || kind === 'pi' || kind === 'dsh'

const count = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0

/** Reuse the trajectory's request identity, replay suppression and usage corrections. */
interface SessionUsage {
  buckets: UsageBucket[]
  context?: NonNullable<UsageReport['sessions'][number]['context']>
}

async function collectSession(source: SessionSource, session: SessionSummary, codex: CodexUsageHistory, copied: CopiedUsageHistory, onRecords: (count: number) => void): Promise<SessionUsage> {
  const parsers = new Map<string, SessionParser>()
  let context: SessionUsage['context']
  const filters = new Map<string, (line: string) => boolean | Promise<boolean>>()
  const ownership = new Map<string, { inherited: (line: string) => Promise<boolean>; lastInherited: boolean; excluded: Set<number> }>()
  await source.readAll(session.kind, session.id, async event => {
    if (event.type !== 'lines') return
    let parser = parsers.get(event.file.id)
    if (parser === undefined) {
      parser = createSessionParser(session.kind)
      parsers.set(event.file.id, parser)
      if (session.kind === 'codex') filters.set(event.file.id, codex.filter(event.file))
      if (session.kind === 'claude') filters.set(event.file.id, claudeUsageFilter(event.file))
      if (session.kind === 'pi' || session.kind === 'dsh') ownership.set(event.file.id, {
        inherited: copied.filter(session.kind, event.file.id), lastInherited: false, excluded: new Set(),
      })
    }
    // Each child owns its own requests. Preserve inherited-history boundaries.
    const file = { ...event.file, role: 'main' as const }
    const filter = filters.get(event.file.id)
    for (const line of event.lines) {
      const owner = ownership.get(event.file.id)
      if (owner !== undefined) {
        const inherited = await owner.inherited(line)
        if (owner.lastInherited && !inherited) {
          owner.excluded = new Set(parser.snapshot().requests.map(request => request.startSeq))
        }
        owner.lastInherited = inherited
      }
      if (session.kind === 'cursor') {
        const record = parseCursorLine(line)
        if (record?.tag === 'session') {
          const usage = cursorUsageOf(record.session['usage'])
          context = usage === undefined ? undefined : { used: count(usage.used), window: count(usage.window),
            time: asNumber(record.session['updatedAt']) ?? record.time, model: asString(record.session['model']) || 'Unknown model' }
        }
      }
      if (filter === undefined || await filter(line)) parser.push(line, file)
    }
    onRecords(event.lines.length)
    await setImmediate()
  })
  const buckets = new Map<string, UsageBucket>()
  for (const [id, parser] of parsers) {
    const owner = ownership.get(id)
    if (owner?.lastInherited) continue // Empty fork: every request is inherited.
    for (const request of parser.snapshot().requests) {
      if (owner?.excluded.has(request.startSeq)) continue
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
  return { buckets: [...buckets.values()], ...(context === undefined ? {} : { context }) }
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
  private readonly cache = new Map<string, SessionUsage & { stamp: string }>()
  private pending: { scan: UsageScan; promise: Promise<UsageReport> } | undefined
  private historyRevision = 0

  constructor(private readonly source: SessionSource) {
    source.on('change', (kind: SessionSummary['kind'], id: string) => {
      this.cache.delete(sessionKey(kind, id))
      // A changed/recovered parent can change which prefix a fork inherits.
      if (hasCopiedHistory(kind)) {
        this.historyRevision += 1
        for (const key of this.cache.keys()) {
          if (key.startsWith(`${kind} `)) this.cache.delete(key)
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
    const copied = new CopiedUsageHistory(this.source)
    const historyRevision = this.historyRevision
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
          if (kind === session.kind && (id === session.id || hasCopiedHistory(kind))) changed = true
        }
        this.source.on('change', onChange)
        try {
          cached = { stamp, ...await collectSession(this.source, session, codex, copied, count => {
            progress.records += count
            if (Date.now() - lastProgressAt >= 200) {
              lastProgressAt = Date.now()
              publish(scan)
            }
          }) }
          if (!changed && (!hasCopiedHistory(session.kind) || historyRevision === this.historyRevision)) this.cache.set(key, cached)
        } catch {
          report.failedSessions += 1
          cached = undefined
        } finally {
          this.source.off('change', onChange)
        }
      }
      if (cached !== undefined) for (const bucket of cached.buckets) report.buckets.push(bucket)
      report.sessions.push({ id: session.id, kind: session.kind, title: session.title,
        ...(cached?.context === undefined ? {} : { context: cached.context }) })
      progress.completed += 1
      publish(scan)
      await setImmediate()
    }
    return report
  }
}
