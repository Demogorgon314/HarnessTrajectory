import { useEffect, useState } from 'react'
import type { UsageProgress, UsageReport } from '@harness-trajectory/core'
import { Tooltip } from '@harness-trajectory/ui'
import { streamUsage } from './api.ts'
import { HarnessMark, harnessMeta } from './harnesses.tsx'
import { UsageFilter } from './UsageFilter.tsx'
import { activityStreak, dateKey, dayOffset, filterUsage, rankUsage, sumUsage } from './usage-summary.ts'
import css from './usage.module.css'

const compact = (value: number): string => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
const sessionKey = (bucket: { kind: string; sessionId: string }): string => `${bucket.kind}/${bucket.sessionId}`
const HEAT_OPACITIES = [0.06, 0.25, 0.5, 0.75, 1]

function Ranking({ title, rows, total, labels }: {
  title: string; rows: [string, number][]; total: number; labels?: ReadonlyMap<string, string>
}) {
  return <section className={css.card}>
    <h3>{title}</h3>
    {rows.length === 0 && <p className={css.muted}>No recorded usage</p>}
    {rows.slice(0, 8).map(([key, value]) => <div className={css.rank} key={key}>
      <div><span title={labels?.get(key) ?? key}>{labels?.get(key) ?? key}</span>
        <span>{compact(value)} · {total > 0 ? (value / total * 100).toFixed(1) : '0'}%</span></div>
      <progress aria-label={labels?.get(key) ?? key} value={value} max={Math.max(1, rows[0]?.[1] ?? 0)} />
    </div>)}
  </section>
}

export function TokenUsage() {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState<UsageProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [period, setPeriod] = useState('30')
  const [kind, setKind] = useState('')
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState('')
  const [query, setQuery] = useState('')
  const today = dateKey(Date.now())
  const [customStart, setCustomStart] = useState(dayOffset(today, -29))
  const [customEnd, setCustomEnd] = useState(today)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setProgress(null)
    let partial: UsageReport | null = null
    void streamUsage(event => {
      if (controller.signal.aborted) return
      setProgress(event.progress)
      // Keep the displayed report until this scan supplies data. Accumulate
      // separately so refreshing neither blanks the charts nor adds old totals.
      if (!event.progress.done && event.report.buckets.length === 0 && event.report.sessions.length === 0) return
      partial = { ...event.report,
        buckets: [...(partial?.buckets ?? []), ...event.report.buckets],
        sessions: [...(partial?.sessions ?? []), ...event.report.sessions],
      }
      setReport(partial)
    }, controller.signal).catch(() => {
      if (!controller.signal.aborted) setError('Loading interrupted. Results may be incomplete. Refresh to retry.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [refresh])

  const buckets = report?.buckets ?? []
  const start = period === 'all' ? '' : period === 'custom' ? customStart : dayOffset(today, 1 - Number(period))
  const end = period === 'all' ? '' : period === 'custom' ? customEnd : today
  const invalidRange = period === 'custom' && (!start || !end || start > end)
  const filters = { start, end, kind, model, provider, query }
  const selected = invalidRange ? [] : filterUsage(buckets, filters)
  const total = sumUsage(selected, 'total')
  const allFiltered = filterUsage(buckets, { ...filters, start: '', end: '' })
  const daily = rankUsage(selected.filter(bucket => bucket.time !== null), bucket => dateKey(bucket.time ?? 0))
  const days = new Map(daily)
  const activeDays = new Set(daily.filter(([, value]) => value > 0).map(([day]) => day))
  const streak = activityStreak(activeDays, today)
  const best = daily[0]
  const sessionLabels = new Map(report?.sessions.map(session => [`${session.kind}/${session.id}`, session.title]) ?? [])
  const toolLabels = new Map(buckets.map(bucket => [bucket.kind, harnessMeta(bucket.kind).label]))
  const rangeDays = start && end ? Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000) + 1 : 0
  const previous = rangeDays > 0 ? sumUsage(filterUsage(buckets, { ...filters,
    start: dayOffset(start, -rangeDays), end: dayOffset(start, -1) }), 'total') : 0
  const lifetime = sumUsage(allFiltered, 'total')
  const milestone = [1e6, 1e7, 1e8, 1e9, 5e9, 1e10, 1e11, 1e12].find(value => value > lifetime)
  const heat = new Map(rankUsage(allFiltered.filter(bucket => bucket.time !== null), bucket => dateKey(bucket.time ?? 0)))
  const heatEnd = new Date(`${today}T12:00:00`).getDay()
  const heatStart = dayOffset(today, -364 - heatEnd)
  const heatMax = Math.max(1, ...[...heat].filter(([day]) => day >= heatStart && day <= today).map(([, value]) => value))
  const hours = Array.from({ length: 24 }, (_, hour) => sumUsage(selected.filter(bucket =>
    bucket.time !== null && new Date(bucket.time).getHours() === hour), 'total'))
  const hourMax = Math.max(1, ...hours)
  const weekdays = Array.from({ length: 7 }, (_, day) => sumUsage(selected.filter(bucket =>
    bucket.time !== null && new Date(bucket.time).getDay() === day), 'total'))
  const chartDays = rangeDays > 0 && rangeDays <= 366
    ? Array.from({ length: rangeDays }, (_, i) => dayOffset(start, i))
    : [...days.keys()].sort()
  // Long histories are grouped into at most 90 chronological bars.
  const stride = Math.max(1, Math.ceil(chartDays.length / 90))
  const trend = chartDays.filter((_, i) => i % stride === 0).map((day, i) => ({
    day, value: chartDays.slice(i * stride, (i + 1) * stride).reduce((sum, key) => sum + (days.get(key) ?? 0), 0),
  }))
  const trendMax = Math.max(1, ...trend.map(bar => bar.value))

  return <div className={css.dashboard}>
    <div className={css.filters}>
      <div className={css.toolbar}>
      <div className={css.periods}>{[['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['all', 'All'], ['custom', 'Custom']].map(([value, label]) =>
        <button key={value} type="button" aria-pressed={period === value} onClick={() => { setPeriod(value ?? '30') }}>{label}</button>)}</div>
        <div className={css.refreshActions}>
          <div className={css.loadingSlot}>
            {loading && <div className={css.loading} role="status"
              title={`${progress?.currentSession ?? 'Preparing local statistics…'} · ${(progress?.records ?? 0).toLocaleString()} records read. Results are partial while scanning.`}>
              <div className={css.loadingText}>
                <span>{progress === null ? 'Connecting…' : `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} sessions`}</span>
                <span>{progress !== null && progress.total > 0 ? `${Math.floor(progress.completed / progress.total * 100)}%` : ''}</span>
              </div>
              <progress aria-label="Token usage loading progress"
                {...(progress === null ? {} : { value: progress.completed, max: Math.max(1, progress.total) })} />
            </div>}
          </div>
          <button type="button" disabled={loading} onClick={() => { setRefresh(value => value + 1) }}>Refresh</button>
        </div>
      </div>
      <UsageFilter label="Usage tool" value={kind} onChange={setKind}
        options={[{ id: '', label: 'All tools' }, ...[...toolLabels].map(([id, label]) => ({
          id, label, icon: <HarnessMark kind={id} size={16} />,
        }))]} />
      <UsageFilter label="Usage model" value={model} onChange={setModel}
        options={[{ id: '', label: 'All models' }, ...[...new Set(buckets.map(bucket => bucket.model))].sort().map(id => ({ id, label: id }))]} />
      <UsageFilter label="Usage provider" value={provider} onChange={setProvider}
        options={[{ id: '', label: 'All providers' }, ...[...new Set(buckets.map(bucket => bucket.provider))].sort().map(id => ({ id, label: id }))]} />
      <input aria-label="Filter token usage" placeholder="Filter model, provider, tool or session ID" value={query} onChange={event => { setQuery(event.target.value) }} />
      {period === 'custom' && <><input type="date" aria-label="Usage start date" value={customStart} onChange={event => { setCustomStart(event.target.value) }} /><input type="date" aria-label="Usage end date" value={customEnd} onChange={event => { setCustomEnd(event.target.value) }} /></>}
    </div>
    {invalidRange && <p role="alert">Choose a valid start and end date.</p>}
    {error && <p role="alert">{error}</p>}
    {report !== null && <>
      <section className={`${css.card} ${css.hero}`}>
        <div className={css.caption}><span>Your work, in tokens</span><span>{streak.current} day streak · Longest {streak.longest}</span></div>
        <div className={css.headline} data-testid="usage-total">{total.toLocaleString('en')}</div>
        <p>{sumUsage(selected, 'requests').toLocaleString('en')} requests · {new Set(selected.map(sessionKey)).size} sessions · {activeDays.size} active days
          {previous > 0 && <> · {((total / previous - 1) * 100).toFixed(1)}% vs previous period</>}</p>
        <p className={css.muted}>{best ? `Peak day: ${best[0]} · ${compact(best[1])} tokens` : total > 0 ? 'Recorded usage has no request dates.' : 'No recorded token usage for these filters.'}</p>
        <div className={css.bars} role="img" aria-label="Daily token trend">{trend.map(bar =>
          <Tooltip key={bar.day} side="top" delayMs={80} label={`${bar.day}${stride > 1 ? ` · ${stride} days` : ''}\n${bar.value.toLocaleString()} tokens`}>
            <span className={css.bar} style={{ height: `${Math.max(2, bar.value / trendMax * 100)}%` }} />
          </Tooltip>)}</div>
        {milestone !== undefined && <div className={css.milestone}><div><span>Next milestone {compact(milestone)} · all time, current filters</span><span>{compact(milestone - lifetime)} to go</span></div><progress aria-label="Token milestone" value={lifetime} max={milestone} /></div>}
      </section>
      <div className={css.metrics}>{([['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['reasoning', 'Reasoning']] as const).map(([field, label]) => <section className={css.card} key={field}><span className={css.muted}>{label}</span><strong>{compact(sumUsage(selected, field))}</strong><span className={css.muted}>{total > 0 ? (sumUsage(selected, field) / total * 100).toFixed(1) : '0'}% of total</span></section>)}</div>
      <section className={css.card}><div className={css.caption}><h3>Activity</h3><span>Last 53 weeks · current tool/model filters</span></div>
        <div className={css.heatScroll}><div className={css.heat} role="img" aria-label="Daily token activity over the last 53 weeks">{Array.from({ length: 371 }, (_, i) => {
          const day = dayOffset(heatStart, i)
          const value = heat.get(day) ?? 0
          return <Tooltip key={day} side="top" delayMs={80} disabled={day > today} label={`${day}\n${value.toLocaleString()} tokens`}>
            <span className={css.heatCell} style={{ opacity: day > today ? 0 : HEAT_OPACITIES[Math.ceil(Math.sqrt(value / heatMax) * 4)] }} />
          </Tooltip>
        })}</div></div>
        <div className={css.legend} aria-label="Activity intensity: less to more tokens">
          <span>Less</span>
          <span className={css.legendScale} aria-hidden="true">{HEAT_OPACITIES.map(opacity =>
            <span key={opacity} className={css.swatch} style={{ opacity }} />)}</span>
          <span>More</span>
        </div>
      </section>
      <div className={css.grid}>
        <Ranking title="Models" rows={rankUsage(selected, bucket => bucket.model)} total={total} />
        <section className={css.card}>
          <h3>Rhythm</h3>
          <p className={css.muted}>Local time · Peak {hours.indexOf(Math.max(...hours))}:00</p>
          <div className={css.bars} role="img" aria-label="Tokens by hour">{hours.map((value, hour) =>
            <Tooltip key={hour} side="top" delayMs={80} label={`${hour}:00–${hour + 1}:00\n${value.toLocaleString()} tokens`}>
              <span className={css.bar} style={{ height: `${Math.max(2, value / hourMax * 100)}%` }} />
            </Tooltip>)}</div>
          <div className={css.caption}><span>00:00</span><span>12:00</span><span>23:00</span></div>
          <div className={css.weekdays}>{weekdays.map((value, day) =>
            <Tooltip key={day} side="top" delayMs={80} label={`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]}\n${value.toLocaleString()} tokens`}>
              <div>
                <progress aria-label={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]} value={value} max={Math.max(1, ...weekdays)} />
                <span className={css.weekdayLabel}>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]}</span>
              </div>
            </Tooltip>)}</div>
        </section>
        <Ranking title="Tools" rows={rankUsage(selected, bucket => bucket.kind)} labels={toolLabels} total={total} />
        <Ranking title="Providers" rows={rankUsage(selected, bucket => bucket.provider)} total={total} />
        <Ranking title="Top sessions" rows={rankUsage(selected, sessionKey)} labels={sessionLabels} total={total} />
      </div>
      <p className={css.footnote}>{report.sessions.length} local sessions scanned · Updated {new Date(report.updatedAt).toLocaleString()}. {report.failedSessions > 0 && `${report.failedSessions} sessions could not be read; refresh to retry.`}<br />
        Usage recorded on {sumUsage(selected, 'measured')} of {sumUsage(selected, 'requests')} requests; {sumUsage(selected, 'turnTotals')} figures are turn totals. Missing usage is not estimated. Input includes cache read and cache write ({compact(sumUsage(selected, 'cacheWrite'))}); reasoning is included in output. Cards overlap.<br />
        Dates use your local timezone. Undated usage appears only under All. Counts reflect available session histories, including children and compaction. Codex forks exclude verified inherited history; other harness forks may share history. Transcripts are read locally to extract usage; only numeric summaries and session labels reach this panel. Nothing is uploaded.</p>
    </>}
  </div>
}
