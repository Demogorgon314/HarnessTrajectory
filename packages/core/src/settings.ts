/**
 * Server settings: the contract between the `settings.json` the server
 * persists under its cache directory (`apps/server/src/settings.ts`), the
 * `/api/settings` route, and the settings dialog in the web UI.
 */

export interface ServerSettings {
  /**
   * Index transcript contents for full-text search. Takes effect on the next
   * start: enabling builds the index then, disabling stops indexing and keeps
   * the file on disk. `HARNESS_TRAJECTORY_SEARCH=1` forces this on.
   */
  contentSearch: boolean
  /**
   * Transcript files not modified within this many days are left out of the
   * search index. They stay browsable; they just do not answer searches.
   * `0` indexes everything.
   */
  searchMaxAgeDays: number
  /**
   * User price rules for models the models.dev registry cannot price
   * (`packages/context` resolves them against the fold's (provider, model)
   * cost keys). Absent/empty means registry-only pricing.
   */
  modelPricing?: ModelPriceRules
}

/** User price rules, keyed by a fold (provider, model) match pattern. */
export type ModelPriceRules = Record<string, ModelPriceRule>

/**
 * Per-1M-token USD rates of one price entry. `input`/`output` are required;
 * the cache fields fall back to the input rate where absent — the same
 * semantics `pricesBookOf` gives a registry entry that publishes no cache
 * prices.
 */
export interface ModelRateInput {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  /** The 1-hour-TTL cache write rate; absent derives from `input` like the registry's. */
  cacheWrite1h?: number
}

/** When a period-priced model bills at LIST price; every other instant bills off-peak. */
export interface PeakSchedule {
  /** Local-time windows [startHour, endHour), fractional hours allowed (9.5 = 09:30). */
  peakHours: [number, number][]
  /** IANA timezone `peakHours` is expressed in (default 'UTC'). */
  timezone?: string
  /** Peak windows apply Mon–Fri only; weekends are off-peak all day. */
  weekdaysOnly?: boolean
}

/**
 * One price rule: `alias` borrows a models.dev 'provider/model' entry's rates
 * (the first '/' separates provider from model), `rates` states them
 * outright. With both present the alias resolves first and `rates` is the
 * fallback for a book that lacks the alias. `offPeak` marks the model as
 * period-priced: `factor` discounts the peak rates (0.5 = half), or `rates`
 * states the off-peak card outright. An alias imports ONLY the rate card —
 * the off-peak schedule is always the rule's own.
 */
export interface ModelPriceRule {
  alias?: string
  rates?: ModelRateInput
  offPeak?: PeakSchedule & { factor?: number; rates?: ModelRateInput }
}

export const SETTINGS_DEFAULTS: ServerSettings = {
  contentSearch: false,
  searchMaxAgeDays: 90,
}

/** Valid range for {@link ServerSettings.searchMaxAgeDays}; `0` means no limit. */
export const SEARCH_MAX_AGE_DAYS_MIN = 0
export const SEARCH_MAX_AGE_DAYS_MAX = 3650

/** What `GET /api/settings` answers. */
export interface SettingsResponse extends ServerSettings {
  /** False when this server runs without the index — regardless of the stored toggle. */
  searchEnabled: boolean
}

/** What `PUT /api/settings` answers: the value in effect and its side effects. */
export interface SettingsUpdateResponse extends SettingsResponse {
  /** Transcript files dropped from the index as the retention window narrowed. */
  purged: number
}

/** One finite non-negative rate, or undefined. */
function rateField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A validated rate card, or null when the required input/output pair is not there. */
function clampRates(raw: unknown): ModelRateInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const input = rateField(record['input'])
  const output = rateField(record['output'])
  if (input === undefined || output === undefined) return null
  const rates: ModelRateInput = { input, output }
  const cacheRead = rateField(record['cacheRead'])
  const cacheWrite = rateField(record['cacheWrite'])
  const cacheWrite1h = rateField(record['cacheWrite1h'])
  if (cacheRead !== undefined) rates.cacheRead = cacheRead
  if (cacheWrite !== undefined) rates.cacheWrite = cacheWrite
  if (cacheWrite1h !== undefined) rates.cacheWrite1h = cacheWrite1h
  return rates
}

/** Whether an IANA timezone id is one this runtime's Intl understands. */
export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * A validated rule, or null when it can price nothing (neither `alias` nor
 * `rates`). An invalid `offPeak` drops only that member — the rule's rate
 * mapping still stands.
 */
function clampPriceRule(input: unknown): ModelPriceRule | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const alias = record['alias']
  const rates = clampRates(record['rates'])
  const rule: ModelPriceRule = {}
  if (typeof alias === 'string' && /^[^/]+\/.+$/.test(alias)) rule.alias = alias
  if (rates !== null) rule.rates = rates
  if (rule.alias === undefined && rule.rates === undefined) return null

  const offPeak = record['offPeak']
  if (typeof offPeak === 'object' && offPeak !== null && !Array.isArray(offPeak)) {
    const off = offPeak as Record<string, unknown>
    const hours = Array.isArray(off['peakHours'])
      ? off['peakHours'].filter((w): w is [number, number] =>
        Array.isArray(w) && w.length === 2
        && typeof w[0] === 'number' && Number.isFinite(w[0])
        && typeof w[1] === 'number' && Number.isFinite(w[1])
        && w[0] >= 0 && w[1] <= 24 && w[0] < w[1])
      : []
    const factor = rateField(off['factor'])
    const offRates = clampRates(off['rates'])
    if (hours.length > 0 && (factor !== undefined || offRates !== null)) {
      rule.offPeak = { peakHours: hours }
      if (factor !== undefined) rule.offPeak.factor = factor
      if (offRates !== null) rule.offPeak.rates = offRates
      const tz = off['timezone']
      if (typeof tz === 'string' && tz !== '' && validTimezone(tz)) rule.offPeak.timezone = tz
      if (off['weekdaysOnly'] === true) rule.offPeak.weekdaysOnly = true
    }
  }
  return rule
}

/**
 * A match key is `provider/model` (first '/' splits them; the model may hold
 * further slashes), `provider/*`, or a bare `model` — empty sides are junk.
 */
export function isModelPriceKey(key: string): boolean {
  if (key === '') return false
  const slash = key.indexOf('/')
  if (slash < 0) return true
  return slash > 0 && key.length > slash + 1
}

/**
 * `provider/model` split at the FIRST slash (the model may hold further
 * slashes); a bare key is `{ provider: '', model: key }`. Keys that name no
 * concrete pair — '', '*', 'p/*', 'p/' — return null.
 */
export function splitModelPriceKey(key: string): { provider: string; model: string } | null {
  if (key === '') return null
  const slash = key.indexOf('/')
  if (slash < 0) return key === '*' ? null : { provider: '', model: key }
  const provider = key.slice(0, slash)
  const model = key.slice(slash + 1)
  return provider === '' || model === '' || model === '*' ? null : { provider, model }
}

/** Inverse of {@link splitModelPriceKey}: '' provider → bare model, else `provider/model`. */
export function modelPriceKeyOf(provider: string, model: string): string {
  return provider === '' ? model : `${provider}/${model}`
}

/** The validated rule table; absent when nothing usable was configured. */
function clampModelPricing(input: unknown): ModelPriceRules | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const out: ModelPriceRules = {}
  for (const [key, value] of Object.entries(input)) {
    if (!isModelPriceKey(key)) continue
    const rule = clampPriceRule(value)
    if (rule !== null) out[key] = rule
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Coerce anything — a hand-edited `settings.json`, a crafted PUT body — into a
 * valid value. Each field falls back to its default on its own, so one junk
 * field does not reset the other.
 */
export function clampSettings(input: unknown): ServerSettings {
  const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  const toggle = record['contentSearch']
  const days = record['searchMaxAgeDays']
  const settings: ServerSettings = {
    contentSearch: typeof toggle === 'boolean' ? toggle : SETTINGS_DEFAULTS.contentSearch,
    searchMaxAgeDays: typeof days === 'number' && Number.isInteger(days)
      && days >= SEARCH_MAX_AGE_DAYS_MIN && days <= SEARCH_MAX_AGE_DAYS_MAX
      ? days
      : SETTINGS_DEFAULTS.searchMaxAgeDays,
  }
  const pricing = clampModelPricing(record['modelPricing'])
  if (pricing !== undefined) settings.modelPricing = pricing
  return settings
}
