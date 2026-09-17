/**
 * The price-rule editor's pure half: the peak-hours text grammar, the draft
 * shape the form edits, draft ↔ persisted-rule conversion, and small table
 * operations (`upsertRule`/`removeRule`/`aliasesOf`). No React — the spec for
 * this module runs without a DOM.
 */

import {
  isModelPriceKey, validTimezone,
  type ModelPriceRule, type ModelPriceRules, type ModelRateInput,
} from '@harness-trajectory/core'
import { DEEPSEEK_PEAK, type PriceTriple } from '@harness-trajectory/context/client'

/** A "9-12, 14:30-18" hour-window list → [startHour, endHour) pairs, or null. */
export function parsePeakHours(text: string): [number, number][] | null {
  const hour = (part: string): number | null => {
    const m = /^(\d{1,2})(?::([0-5]\d))?$/.exec(part.trim())
    if (m === null) return null
    const value = Number(m[1]) + (m[2] === undefined ? 0 : Number(m[2]) / 60)
    return value <= 24 ? value : null
  }
  const out: [number, number][] = []
  for (const piece of text.split(',')) {
    const ends = piece.split('-')
    if (ends.length !== 2) return null
    const start = hour(ends[0] ?? '')
    const end = hour(ends[1] ?? '')
    if (start === null || end === null || start >= end || end > 24) return null
    out.push([start, end])
  }
  return out.length > 0 ? out : null
}

/** Inverse of {@link parsePeakHours}, for editing an existing rule. */
export function formatPeakHours(hours: readonly [number, number][]): string {
  const hour = (value: number): string => {
    const h = Math.floor(value)
    const m = Math.round((value - h) * 60)
    return m === 0 ? String(h) : `${h}:${String(m).padStart(2, '0')}`
  }
  return hours.map(([start, end]) => `${hour(start)}-${hour(end)}`).join(', ')
}

/** '' → undefined; otherwise a finite ≥0 number, or undefined when unparsable. */
export function rateFieldOf(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const value = Number(text.trim())
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/** One rate-grid cell: the draft field, its label/placeholder, whether a blank rejects the rule, and the book field "copy rates" reads. */
export interface RateFieldSpec {
  key: keyof RateFields
  label: string
  placeholder: string
  required: boolean
  fromTriple?: ((price: PriceTriple) => number) | undefined
}

/**
 * The rate grid's five fields. `cacheWrite1h` has no `fromTriple` — the book's
 * 1-hour write rate is derived, not listed, so copying leaves it untouched.
 */
export const RATE_FIELDS: readonly RateFieldSpec[] = [
  { key: 'input', label: 'Input', placeholder: 'Input', required: true, fromTriple: price => price.miss },
  { key: 'output', label: 'Output', placeholder: 'Output', required: true, fromTriple: price => price.out },
  { key: 'cacheRead', label: 'Cache read', placeholder: 'optional', required: false, fromTriple: price => price.hit },
  { key: 'cacheWrite', label: 'Cache write', placeholder: 'optional', required: false, fromTriple: price => price.write },
  { key: 'cacheWrite1h', label: '1h write', placeholder: 'optional', required: false },
]

/** The rate grid's raw-text state; numeric fields stay raw until save. */
export interface RateFields {
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  cacheWrite1h: string
}

export function fieldsOfRates(rates: ModelRateInput | undefined): RateFields {
  const fields = { input: '', output: '', cacheRead: '', cacheWrite: '', cacheWrite1h: '' }
  for (const spec of RATE_FIELDS) {
    const value = rates?.[spec.key]
    fields[spec.key] = value === undefined ? '' : String(value)
  }
  return fields
}

/** The book entry as draft text for the fields `RATE_FIELDS` maps — "copy rates". */
export function fieldsOfTriple(price: PriceTriple): Partial<RateFields> {
  const out: Partial<RateFields> = {}
  for (const spec of RATE_FIELDS) {
    if (spec.fromTriple !== undefined) out[spec.key] = String(spec.fromTriple(price))
  }
  return out
}

export function ratesOf(fields: RateFields): ModelRateInput | null {
  const rates: ModelRateInput = { input: 0, output: 0 }
  for (const spec of RATE_FIELDS) {
    const value = rateFieldOf(fields[spec.key])
    if (value === undefined) {
      if (spec.required) return null
      continue
    }
    rates[spec.key] = value
  }
  return rates
}

/** The editor's working state; numeric fields stay raw text until save. */
export interface RuleDraft {
  key: string
  mode: 'alias' | 'rates'
  alias: string
  rates: RateFields
  offPeak: boolean
  offMode: 'factor' | 'rates'
  offFactor: string
  offRates: RateFields
  peakHours: string
  timezone: string
  weekdaysOnly: boolean
}

export function draftOf(key: string, rule: ModelPriceRule): RuleDraft {
  return {
    key,
    mode: rule.alias !== undefined ? 'alias' : 'rates',
    alias: rule.alias ?? '',
    rates: fieldsOfRates(rule.rates),
    offPeak: rule.offPeak !== undefined,
    offMode: rule.offPeak?.rates !== undefined ? 'rates' : 'factor',
    offFactor: rule.offPeak?.factor === undefined ? '0.5' : String(rule.offPeak.factor),
    offRates: fieldsOfRates(rule.offPeak?.rates),
    peakHours: rule.offPeak === undefined ? '' : formatPeakHours(rule.offPeak.peakHours),
    timezone: rule.offPeak?.timezone ?? '',
    weekdaysOnly: rule.offPeak?.weekdaysOnly === true,
  }
}

/**
 * The draft as a persisted rule, or the validation complaint to show. The
 * returned rule omits every field the draft left at its default/absent.
 */
export function ruleOf(draft: RuleDraft): { key: string; rule: ModelPriceRule } | string {
  const key = draft.key.trim()
  if (!isModelPriceKey(key)) return 'Match must be provider/model, provider/*, or a bare model id.'
  const rule: ModelPriceRule = {}
  if (draft.mode === 'alias') {
    const alias = draft.alias.trim()
    if (!/^[^/]+\/.+$/.test(alias)) return 'Alias must be a models.dev id like anthropic/claude-sonnet-4-5.'
    rule.alias = alias
  } else {
    const rates = ratesOf(draft.rates)
    if (rates === null) return 'Custom rates need at least input and output prices (USD per 1M tokens).'
    rule.rates = rates
  }
  if (draft.offPeak) {
    const peakHours = parsePeakHours(draft.peakHours)
    if (peakHours === null) return 'Peak hours must read like "9-12, 14-18" or "9:30-12".'
    const timezone = draft.timezone.trim()
    if (timezone !== '' && !validTimezone(timezone)) {
      return `Unknown timezone "${timezone}" — use an IANA name like Asia/Shanghai.`
    }
    const off: NonNullable<ModelPriceRule['offPeak']> = { peakHours }
    if (timezone !== '') off.timezone = timezone
    if (draft.weekdaysOnly) off.weekdaysOnly = true
    if (draft.offMode === 'factor') {
      const factor = rateFieldOf(draft.offFactor)
      if (factor === undefined) return 'The off-peak factor must be a number ≥ 0 (0.5 = half price).'
      off.factor = factor
    } else {
      const offRates = ratesOf(draft.offRates)
      if (offRates === null) return 'Off-peak rates need at least input and output prices.'
      off.rates = offRates
    }
    rule.offPeak = off
  }
  return { key, rule }
}

/** This browser's IANA zone — the timezone field's placeholder and hint. */
export const BROWSER_TZ: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
})()

/** One rule row's terse summary, e.g. `→ deepseek/deepseek-v4-flash · off-peak ×0.5`. */
export function ruleSummary(rule: ModelPriceRule): string {
  const parts: string[] = []
  if (rule.alias !== undefined) parts.push(`→ ${rule.alias}`)
  if (rule.rates !== undefined) parts.push(`$${rule.rates.input}/$${rule.rates.output}`)
  if (rule.offPeak !== undefined) {
    parts.push(rule.offPeak.rates !== undefined
      ? 'off-peak rates'
      : `off-peak ×${rule.offPeak.factor ?? 0.5}`)
  }
  return parts.join(' · ')
}

/**
 * `rules` with `key` set to `rule`; a `prevKey` different from `key` is a
 * rename and its row goes away. Pure — callers own `onSave`.
 */
export function upsertRule(
  rules: ModelPriceRules,
  prevKey: string | null,
  key: string,
  rule: ModelPriceRule,
): ModelPriceRules {
  const next = { ...rules }
  if (prevKey !== null && prevKey !== key) delete next[prevKey]
  next[key] = rule
  return next
}

/** `rules` minus `key`. Pure. */
export function removeRule(rules: ModelPriceRules, key: string): ModelPriceRules {
  const next = { ...rules }
  delete next[key]
  return next
}

/** Distinct alias ids the table references, in first-seen table order. */
export function aliasesOf(rules: ModelPriceRules): string[] {
  return [...new Set(
    Object.values(rules).flatMap(rule => rule.alias === undefined ? [] : [rule.alias]),
  )]
}

/** A one-click off-peak schedule: what the button says and the draft fields it writes. */
export interface SchedulePreset {
  id: string
  label: string
  title: string
  patch: Pick<RuleDraft, 'peakHours' | 'timezone' | 'weekdaysOnly' | 'offMode' | 'offFactor'>
}

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek hours',
    title: 'Beijing 9–12 & 14–18 on weekdays, ×0.5 otherwise',
    patch: {
      peakHours: formatPeakHours(DEEPSEEK_PEAK.peakHours),
      timezone: DEEPSEEK_PEAK.timezone,
      weekdaysOnly: true,
      offMode: 'factor',
      offFactor: '0.5',
    },
  },
]
