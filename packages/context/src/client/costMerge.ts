/**
 * Merge the cumulative billed-token totals of several folded transcripts into
 * one `SessionCostUsage`.
 *
 * Each file of a session is folded separately — a subagent is its own context
 * — so each carries its own cost usage. The stats board's Cost cell, though,
 * answers "what did this SESSION cost", which is the main agent plus every
 * subagent it delegated to. This is the sum: per provider, per model, per
 * pricing period, the four buckets added.
 *
 * PORT ADDITION — dsh-context never needed it: there, every session was its
 * own top-level session and the host folded one cost record per session.
 *
 * The inputs are fold output, but they may also be delivered values, so every
 * level is re-proved: a branch that is not a plain record is skipped whole and
 * bucket fields go through a finite-number guard, so garbage can only ever add
 * zero — never NaN. The result is plain JSON with a null prototype nowhere: it
 * is handed straight to `estimateSessionCost`.
 */

import type { CostBucketTotals, CostModelUsage, SessionCostUsage } from '../shared/types'
import { asRecord, numOf } from './services'

/**
 * Sum one bucket into an accumulator, creating it on first sight.
 *
 * `cacheWrite1h` is a SUBSET of `cacheWrite` that bills at a different rate,
 * so it has to survive the merge — dropping it would silently re-price every
 * subagent's 1h cache writes at the cheaper 5-minute rate. It rides along only
 * once a 1h write has actually been seen, which keeps the merged bucket's
 * shape identical to the fold's for the common no-1h session.
 */
function addBucket(into: CostBucketTotals | undefined, from: Record<string, unknown>): CostBucketTotals {
  const base = into ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const out: CostBucketTotals = {
    uncached: base.uncached + numOf(from.uncached),
    cacheRead: base.cacheRead + numOf(from.cacheRead),
    cacheWrite: base.cacheWrite + numOf(from.cacheWrite),
    output: base.output + numOf(from.output),
  }
  const write1h = (base.cacheWrite1h ?? 0) + Math.max(0, numOf(from.cacheWrite1h))
  if (write1h > 0) out.cacheWrite1h = write1h
  return out
}

/**
 * A JSON-delivered record can carry an own `__proto__` key; assigning it would
 * set the prototype instead of a branch, so it is skipped everywhere.
 */
function ownKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter(key => key !== '__proto__')
}

/**
 * Add every part's totals together.
 * @param parts - one usage record per folded file; `undefined` entries (a file
 * that has billed nothing yet) are skipped.
 * @returns the summed usage, or undefined when no part carried anything — the
 * Cost cell then dashes exactly as it does for a single unbilled file.
 */
export function mergeCostUsage(parts: readonly (SessionCostUsage | undefined)[]): SessionCostUsage | undefined {
  const out: SessionCostUsage = {}
  let any = false
  for (const part of parts) {
    const providers = asRecord(part)
    if (providers === null || Array.isArray(providers)) continue
    for (const provider of ownKeys(providers)) {
      const models = asRecord(providers[provider])
      if (models === null || Array.isArray(models)) continue
      const branch = out[provider] ?? {}
      for (const model of ownKeys(models)) {
        const periods = asRecord(models[model])
        if (periods === null || Array.isArray(periods)) continue
        const copy: CostModelUsage = { ...branch[model] }
        for (const period of ['peak', 'off'] as const) {
          const bucket = asRecord(periods[period])
          if (bucket === null || Array.isArray(bucket)) continue
          copy[period] = addBucket(copy[period], bucket)
          any = true
        }
        branch[model] = copy
      }
      out[provider] = branch
    }
  }
  return any ? out : undefined
}
