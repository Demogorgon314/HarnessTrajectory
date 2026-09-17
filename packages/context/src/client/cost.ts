/**
 * Session-cost estimate — prices the host-folded cumulative billed-token
 * totals (SessionCostUsage) from the client's model-price book
 * (client/modelPrices.ts): the models.dev registry, fetched from its
 * published /api.json. Book rates are USD per 1M tokens; the CNY display
 * converts at the fixed 1 CNY = 0.15 USD, and the total and the tooltip's
 * rates both go through `toCurrency`, so the printed figures can never
 * drift from the math that prices the session. DeepSeek's period-based list
 * prices off-peak at half: the fold already split those buckets (peak =
 * list price), so DeepSeek's `off` buckets simply price at half here —
 * never any other provider's.
 *
 * Two things the registry does not spell out and this module supplies:
 * a 1-HOUR cache write bills at 2x the input rate where the registry's
 * `cache_write` is the 5-minute rate (see CACHE_WRITE_1H_FACTOR), and a
 * ROUTED model id (`claude-opus-5[1m]`) prices off its untagged base id
 * (see `untaggedModel`). Known residuals it does NOT model, because no
 * registry publishes them: server-tool requests (web search / web fetch bill
 * per request) and a harness's own regional surcharges.
 */

import type { ModelPriceRule, ModelPriceRules, ModelRateInput } from '@harness-trajectory/core'
import type { SessionCostUsage } from '../shared/types'
import { isDeepSeekProvider, modelsDevProviderOf, vendorProviderOf } from '../shared/providers'
import { matchRule } from '../shared/pricingRules'
import { asRecord, numOf } from './services'

/** The display currencies the stats board ships; the locale picks one. */
export type CostCurrency = 'usd' | 'cny'

/** 1 CNY = 0.15 USD — the fixed CNY-display conversion rate. */
const USD_PER_CNY = 0.15

/** Off-peak DeepSeek rates are half the peak rates (the official list). */
const OFF_PEAK_FACTOR = 0.5

/**
 * A 1-HOUR cache write costs 2x the base input rate where the registry's
 * `cache_write` is the 5-MINUTE rate (1.25x input). The registry publishes no
 * 1h field, so the 1h rate is derived from the input rate by this factor —
 * checked against every Anthropic price tier the harness ships (5/25, 3/15,
 * 2/10, 10/50, 15/75: the 1h write is exactly 2x input in all of them) and
 * against a real `cost-state` record, which reproduces to the cent only when
 * the 1h share bills at 2x. Providers with no 1h TTL never fill the bucket,
 * so the factor can never reach them.
 */
const CACHE_WRITE_1H_FACTOR = 2

/**
 * Per-1M-token rates (USD): cache-hit input, cache-miss input, cache
 * write, output (reasoning included). Absent registry fields fall back to
 * the input rate (a provider that publishes no cache prices bills those
 * buckets as plain input). `write1h` is the 1-hour cache-write rate, present
 * only when the registry publishes one — {@link write1hOf} derives it
 * otherwise.
 */
export interface PriceTriple { hit: number; miss: number; write: number; out: number; write1h?: number }

/**
 * The client's price book: models.dev provider id → model id → USD rates,
 * extracted from the registry (modelPrices.ts). The fold keys the cost
 * totals by the dsh provider id; `priceOf` resolves the two via
 * modelsDevProviderOf (unmapped ids pass through verbatim).
 */
export type ModelPrices = Record<string, Record<string, PriceTriple>>

/** A USD amount in the display currency (CNY divides the fixed rate). */
export function toCurrency(usd: number, currency: CostCurrency): number {
  return currency === 'cny' ? usd / USD_PER_CNY : usd
}

/** The 1-hour cache-write rate: the registry's own figure, else {@link CACHE_WRITE_1H_FACTOR} x the input rate. */
export function write1hOf(rate: PriceTriple): number {
  return rate.write1h ?? rate.miss * CACHE_WRITE_1H_FACTOR
}

/** One rate triple at the given off-peak factor (the tooltip's `peak | off` pair). */
export function offPeakOf(rate: PriceTriple, factor = OFF_PEAK_FACTOR): PriceTriple {
  return {
    hit: rate.hit * factor,
    miss: rate.miss * factor,
    write: rate.write * factor,
    out: rate.out * factor,
    ...(rate.write1h === undefined ? {} : { write1h: rate.write1h * factor }),
  }
}

/**
 * A rule's stated rates as a price triple — the same fallback semantics the
 * registry extraction uses (absent cache fields bill at the input rate, an
 * absent 1h-write rate derives from the input rate downstream).
 */
export function tripleOf(rates: ModelRateInput): PriceTriple {
  return {
    hit: rates.cacheRead ?? rates.input,
    miss: rates.input,
    write: rates.cacheWrite ?? rates.input,
    out: rates.output,
    ...(rates.cacheWrite1h === undefined ? {} : { write1h: rates.cacheWrite1h }),
  }
}

/**
 * The price of a matched rule's OFF-peak buckets: the rule's own off-peak
 * rate card when it states one, else its factor over the peak triple (factor
 * absent — an unclamped hand-edit — degrades to the DeepSeek convention). A
 * rule without `offPeak` leaves the provider's own scheme in force: DeepSeek
 * still halves, every other provider's `off` bucket (which its schedule then
 * never produces) would bill at list price.
 */
export function offRateOf(rule: ModelPriceRule | null, provider: string, rate: PriceTriple): PriceTriple {
  const off = rule?.offPeak
  if (off !== undefined) {
    return off.rates !== undefined ? tripleOf(off.rates) : offPeakOf(rate, off.factor ?? OFF_PEAK_FACTOR)
  }
  return isDeepSeekProvider(provider) ? offPeakOf(rate) : rate
}

/** One book branch (a provider's models), as far as runtime can prove it. */
function branchOf(book: ModelPrices, id: string): Record<string, PriceTriple> | null {
  const v: unknown = book[id]
  return v !== null && typeof v === 'object' ? (v as Record<string, PriceTriple>) : null
}

/**
 * One branch's model id → rates, as far as runtime can prove it: exact own
 * key first (the book is untrusted wire data), then case-insensitively, then
 * by id SUFFIX — dsh spells some models short (`k3`) where the registry
 * namespaces them (`kimi-k3`). Several suffix candidates (e.g. `k3` vs a
 * hypothetical `other-k3`) are ambiguous and price nothing.
 */
function lookup(models: Record<string, PriceTriple>, model: string): PriceTriple | null {
  if (Object.hasOwn(models, model)) return models[model] ?? null
  const m = model.toLowerCase()
  let found: PriceTriple | null = null
  let seen: string | null = null
  for (const id in models) {
    const lower = id.toLowerCase()
    if (lower !== m && !lower.endsWith('-' + m)) continue
    if (seen !== null && seen !== lower) return null
    seen = lower
    found = models[id] ?? null
  }
  return found
}

/**
 * A routed model id without its variant tag. A harness may name the ROUTE
 * rather than the model — Claude Code spells the 1M-context route
 * `claude-opus-5[1m]` and books its cost under that exact string — while the
 * registry carries only the base id. Stripping the tag happens HERE, at
 * lookup time, and nowhere else: the fold's cost keys stay byte-identical to
 * the harness's own `cost-state.modelUsage` keys, so a per-model comparison
 * against the harness's reported figure lines up 1:1 and the tooltip names
 * the route the session actually took. Pricing off the base id is what the
 * harness itself does (its rate tables are keyed by the base model; a tagged
 * route has no separate price list).
 */
function untaggedModel(model: string): string {
  return model.replace(/\[[^\]]*\]\s*$/, '')
}

/** `lookup` over the routed id, then over its untagged base id. */
function lookupRouted(models: Record<string, PriceTriple>, model: string): PriceTriple | null {
  const direct = lookup(models, model)
  if (direct !== null) return direct
  const base = untaggedModel(model)
  return base === model ? null : lookup(models, base)
}

/**
 * The registry lookup for one (provider, model): the provider id resolves
 * through modelsDevProviderOf (unmapped ids pass through) and prices by model
 * id — exact, case-insensitive, suffix, or (for a routed id) the same three
 * over the untagged base id. A billed branch that does not carry the model —
 * or a provider the book lacks outright (a harness client id like
 * `cognition`, or `anthropic` proxying a DeepSeek model) — falls back to a
 * book-wide scan: exactly one hit prices; several resolve to the model's own
 * VENDOR (the official list, not a reseller's re-pricing — a provider id the
 * model's own name prefixes, or the MODEL_VENDOR_PROVIDERS map); a still-tied
 * scan prices nothing rather than guessing between resellers.
 */
function registryPriceOf(prices: ModelPrices, provider: string, model: string): PriceTriple | null {
  const own = modelsDevProviderOf(provider)
  const direct = branchOf(prices, own)
  const hit = direct === null ? null : lookupRouted(direct, model)
  if (hit !== null) return hit
  const vendor = vendorProviderOf(model)
  const lower = model.toLowerCase()
  let found: PriceTriple | null = null
  let candidates = 0
  for (const id of Object.keys(prices)) {
    if (id === own) continue
    const models = branchOf(prices, id)
    if (models === null) continue
    const rate = lookupRouted(models, model)
    if (rate === null) continue
    candidates += 1
    if (id === vendor || lower.startsWith(id + '-')) return rate
    if (found === null) found = rate
  }
  return candidates === 1 ? found : null
}

/** An alias's `provider/model` split at the FIRST '/' (model ids may carry slashes). */
function aliasPriceOf(prices: ModelPrices, alias: string): PriceTriple | null {
  const slash = alias.indexOf('/')
  if (slash <= 0 || slash === alias.length - 1) return null
  const branch = branchOf(prices, alias.slice(0, slash))
  return branch === null ? null : lookupRouted(branch, alias.slice(slash + 1))
}

/**
 * The rates for one folded (provider, model) bucket, or null when nothing
 * prices it. A matching user rule speaks FIRST: `alias` borrows the registry
 * rates of the named entry (resolved against the registry only — rules never
 * chain), falling back to the rule's own `rates` when the book lacks the
 * alias; `rates` alone state the card outright. No rule — or no rule rate —
 * takes the registry path.
 */
export function priceOf(
  prices: ModelPrices | null | undefined,
  provider: string,
  model: string,
  rules?: ModelPriceRules | null,
): PriceTriple | null {
  const rule = matchRule(rules, provider, model)
  if (rule !== null) {
    if (prices !== null && prices !== undefined && rule.alias !== undefined) {
      const aliased = aliasPriceOf(prices, rule.alias)
      if (aliased !== null) return aliased
    }
    if (rule.rates !== undefined) return tripleOf(rule.rates)
    if (rule.alias !== undefined) return null
  }
  return prices === null || prices === undefined ? null : registryPriceOf(prices, provider, model)
}

/**
 * Price the session's cumulative billed-token totals. Cache reads bill at
 * the hit rate, uncached input at the miss rate, cache writes at the write
 * rate — split so the 1h-TTL share bills at {@link write1hOf} — and output
 * (reasoning included) at the out rate; `off` buckets (the Host splits
 * DeepSeek's period-based list at fold time) price at half.
 * Null when nothing was priced (no usage folded, no book yet, or no model
 * the book prices), so the cell can show a dash.
 *
 * A model the book cannot price contributes NOTHING rather than a guess, so
 * a mixed-model session's figure is a floor, not a total: pair every printed
 * estimate with {@link unpricedCostModels} so the reader is told which models
 * the figure leaves out.
 */
export function estimateSessionCost(
  usage: SessionCostUsage | null | undefined,
  prices: ModelPrices | null | undefined,
  currency: CostCurrency,
  rules?: ModelPriceRules | null,
): number | null {
  // No early bail on `prices === null`: a rule's own rate card prices a
  // session even while the registry fetch is in flight or failed.
  if (usage === null || usage === undefined) return null
  let total = 0
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const rate = priceOf(prices, provider, model, rules)
      const periods = asRecord(models[model])
      if (rate === null || periods === null) continue
      // The period's own card: `off` prices through the matching rule's
      // offPeak (or the provider's built-in scheme — see offRateOf).
      const off = offRateOf(matchRule(rules, provider, model), provider, rate)
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        const r = period === 'off' ? off : rate
        // `cacheWrite1h` is a SUBSET of `cacheWrite`: the 1h share bills at
        // the 1h rate and the remainder at the 5m rate, so the two can never
        // between them bill more tokens than the write bucket holds.
        const write = numOf(bucket.cacheWrite)
        const write1h = Math.min(Math.max(0, numOf(bucket.cacheWrite1h)), write)
        total += (numOf(bucket.cacheRead) * r.hit + numOf(bucket.uncached) * r.miss
          + (write - write1h) * r.write + write1h * write1hOf(r)
          + numOf(bucket.output) * r.out) / 1e6
        any = true
      }
    }
  }
  return any ? toCurrency(total, currency) : null
}

/** One billed model the book prices not: its fold key and its display label. */
export interface UnpricedModel {
  provider: string
  model: string
  /** `model · provider` when the session billed more than one provider. */
  label: string
}

/**
 * The billed (provider, model) keys the book cannot price — every one of them
 * is tokens the session really spent that {@link estimateSessionCost} left
 * out. A session whose models ALL price returns an empty list; a session that
 * prices none returns every key it billed (the cell's "no prices" case).
 * The pair travels with the label so a caller can offer "add a price rule
 * for this" straight off the fold key.
 */
export function unpricedCostPairs(
  usage: SessionCostUsage | null | undefined,
  prices: ModelPrices | null | undefined,
  rules?: ModelPriceRules | null,
): UnpricedModel[] {
  if (usage === null || usage === undefined) return []
  const providers = Object.keys(usage)
  const multi = providers.length > 1
  const out: UnpricedModel[] = []
  for (const provider of providers) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      if (priceOf(prices, provider, model, rules) !== null) continue
      if (asRecord(models[model]) === null) continue
      out.push({ provider, model, label: multi && provider !== '' ? `${model} · ${provider}` : model })
    }
  }
  return out
}

/** The unpriced pairs' display labels (the cell note's wording). */
export function unpricedCostModels(
  usage: SessionCostUsage | null | undefined,
  prices: ModelPrices | null | undefined,
  rules?: ModelPriceRules | null,
): string[] {
  return unpricedCostPairs(usage, prices, rules).map(u => u.label)
}

export function formatCost(amount: number, currency: CostCurrency): string {
  const symbol = currency === 'cny' ? '¥' : '$'
  return symbol + (amount >= 1 ? amount.toFixed(2) : amount.toPrecision(2))
}

/** Price-list figure: the same money format as formatCost, trailing zeros trimmed (¥3.00 → ¥3, $0.0070 → $0.007). */
export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return formatCost(amount, currency).replace(/0+$/, '').replace(/\.$/, '')
}
