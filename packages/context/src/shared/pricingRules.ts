/**
 * User model-price rules (`ServerSettings.modelPricing`, clamped in
 * `@harness-trajectory/core`) and the two places they reach:
 *
 * - the FOLD (fold/fold.ts `accumulateCost`) asks `makeCostPeriod` which
 *   pricing period a billed request lands in — `peak` or `off` — so a
 *   period-priced model's usage splits at fold time;
 * - the CLIENT (client/cost.ts) asks `matchRule` for the rule that prices a
 *   (provider, model) bucket and reads its `alias`/`rates`/`offPeak`.
 *
 * Match keys are looked up against the fold's own key face: `provider/model`
 * (first '/' splits them — a model id may itself carry slashes, e.g.
 * `kimi-code/k3`), then `provider/*`, then a bare `model`. The first hit in
 * that order wins, so a wildcard never shadows an exact row.
 *
 * PORT ADDITION — not part of the vendored dsh-context sources.
 */

import type { ModelPriceRule, ModelPriceRules, PeakSchedule } from '@harness-trajectory/core'
import { isDeepSeekProvider } from './providers.ts'

/** A billed request's pricing period (the `CostModelUsage` bucket names). */
export type CostPeriod = 'peak' | 'off'

/** The fold's period classifier: (provider, model, request time) → period. */
export type CostPeriodResolver = (provider: string, model: string, timeMs: number) => CostPeriod

/**
 * DeepSeek's official peak windows — Beijing Time 09:00–12:00 and 14:00–18:00,
 * Monday through Friday; every other instant (all weekend included) bills at
 * the half-price off-peak rate. Expressed as a `PeakSchedule` so the built-in
 * and user rules share one evaluator.
 */
export const DEEPSEEK_PEAK: Required<Pick<PeakSchedule, 'peakHours' | 'timezone' | 'weekdaysOnly'>> = {
  peakHours: [[9, 12], [14, 18]],
  timezone: 'Asia/Shanghai',
  weekdaysOnly: true,
}

/**
 * The KEY of the rule that prices one fold (provider, model) pair: exact
 * `provider/model`, then the `provider/*` wildcard, then a bare `model` key.
 * `provider` may be '' (a producer that names none) — only the bare-model
 * candidate can match then. The key, not just the rule, is what an
 * edit-in-place surface needs: a dialog re-saving under another key has to
 * know which row it replaces.
 */
export function matchRuleKey(
  rules: ModelPriceRules | null | undefined,
  provider: string,
  model: string,
): string | null {
  if (rules === null || rules === undefined) return null
  const candidates = provider === ''
    ? [model]
    : [`${provider}/${model}`, `${provider}/*`, model]
  for (const key of candidates) {
    const rule = rules[key]
    if (rule !== null && typeof rule === 'object') return key
  }
  return null
}

/**
 * The rule that prices one fold (provider, model) pair, or null — the rule
 * behind {@link matchRuleKey}'s winning key.
 */
export function matchRule(
  rules: ModelPriceRules | null | undefined,
  provider: string,
  model: string,
): ModelPriceRule | null {
  const key = matchRuleKey(rules, provider, model)
  return key === null ? null : rules?.[key] ?? null
}

/** `Intl` formatters are expensive to build; one per configured timezone. */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterOf(timezone: string): Intl.DateTimeFormat | null {
  let fmt = formatters.get(timezone)
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
      })
    } catch {
      return null
    }
    formatters.set(timezone, fmt)
  }
  return fmt
}

/**
 * Whether `timeMs` falls inside a schedule's LIST-price window: a peak-hours
 * hit on a day the schedule covers. `weekdaysOnly` makes Saturday/Sunday
 * off-peak all day. A timezone the runtime cannot resolve peaks nothing —
 * the rule then bills everything off-peak (a loud wrong is safer than a
 * quiet one: the figure under-reports rather than invents peak charges).
 */
export function inPeakWindow(schedule: PeakSchedule, timeMs: number): boolean {
  const fmt = formatterOf(schedule.timezone ?? 'UTC')
  if (fmt === null) return false
  const parts = fmt.formatToParts(new Date(timeMs))
  let weekday = ''
  let hour = 0
  let minute = 0
  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value
    else if (part.type === 'hour') hour = Number(part.value) % 24
    else if (part.type === 'minute') minute = Number(part.value)
  }
  if (schedule.weekdaysOnly === true && (weekday === 'Sat' || weekday === 'Sun')) return false
  const at = hour * 60 + minute
  for (const [start, end] of schedule.peakHours) {
    if (at >= start * 60 && at < end * 60) return true
  }
  return false
}

/** The built-in period rule: DeepSeek's schedule, peak elsewhere. */
export const defaultCostPeriod: CostPeriodResolver = (provider, _model, timeMs) =>
  isDeepSeekProvider(provider) && !inPeakWindow(DEEPSEEK_PEAK, timeMs) ? 'off' : 'peak'

/**
 * The session's period classifier. A matched rule's own `offPeak` schedule
 * wins — a rule CAN re-schedule even a DeepSeek model; a matched rule without
 * `offPeak` leaves the built-in DeepSeek check standing (rates and schedule
 * stay orthogonal), and everything else bills `peak`.
 */
export function makeCostPeriod(rules: ModelPriceRules | null | undefined): CostPeriodResolver {
  if (rules === null || rules === undefined || Object.keys(rules).length === 0) return defaultCostPeriod
  return (provider, model, timeMs) => {
    const rule = matchRule(rules, provider, model)
    if (rule !== null && rule.offPeak !== undefined) {
      return inPeakWindow(rule.offPeak, timeMs) ? 'peak' : 'off'
    }
    return defaultCostPeriod(provider, model, timeMs)
  }
}
