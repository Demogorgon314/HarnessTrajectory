import type { UsageBucket } from '@harness-trajectory/core'

export function dateKey(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function dayOffset(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00`)
  date.setDate(date.getDate() + offset)
  return dateKey(date.getTime())
}

export interface UsageFilters {
  start: string
  end: string
  kind: string
  model: string
  provider: string
  query: string
}

export function filterUsage<T extends Pick<UsageBucket, 'time' | 'kind' | 'model' | 'provider' | 'sessionId'>>(buckets: readonly T[], filters: UsageFilters): T[] {
  const query = filters.query.trim().toLowerCase()
  return buckets.filter(bucket => {
    const day = bucket.time === null ? null : dateKey(bucket.time)
    return (!filters.kind || bucket.kind === filters.kind)
      && (!filters.model || bucket.model === filters.model)
      && (!filters.provider || bucket.provider === filters.provider)
      && (!query || `${bucket.kind} ${bucket.model} ${bucket.provider} ${bucket.sessionId}`.toLowerCase().includes(query))
      && (!filters.start || (day !== null && day >= filters.start))
      && (!filters.end || (day !== null && day <= filters.end))
  })
}

export function sumUsage(buckets: readonly UsageBucket[], field: keyof Pick<UsageBucket,
  'total' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'requests' | 'measured' | 'turnTotals'>): number {
  return buckets.reduce((sum, bucket) => sum + bucket[field], 0)
}

export function rankUsage(buckets: readonly UsageBucket[], key: (bucket: UsageBucket) => string): [string, number][] {
  const totals = new Map<string, number>()
  for (const bucket of buckets) totals.set(key(bucket), (totals.get(key(bucket)) ?? 0) + bucket.total)
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export function activityStreak(days: ReadonlySet<string>, today: string): { current: number; longest: number } {
  let longest = 0
  let run = 0
  let previous = ''
  for (const day of [...days].sort()) {
    run = dayOffset(previous || day, 1) === day ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = day
  }
  let cursor = days.has(today) ? today : dayOffset(today, -1)
  let current = 0
  while (days.has(cursor)) { current += 1; cursor = dayOffset(cursor, -1) }
  return { current, longest }
}
