/**
 * The Context card: what the session's context IS and how it evolved — a
 * six-cell grid of the session's shape (turns / steps / human inputs / live
 * tool calls), the whole-session cache-hit rate, and the whole-session cost
 * estimate.
 * Count figures only: nothing here is part of a spendable whole, so no pie —
 * proportions live in the composition card, and the context-event tallies
 * live on the events card's kind filters (contextView.tsx). The cache-hit
 * cell reads the official `tokenUsage` projection — the same source and
 * formula as the harness chat stats line under the composer, shown with one
 * decimal — and dashes until a provider reports usage. The cost cell prices
 * the host-folded cumulative billed totals (complete session log, never
 * trimmed) from the models.dev price book (modelPrices.ts) in the locale's
 * currency; its hover bubble (a '?' marker + styled DOM tip) explains the
 * whole-session estimate and lists the per-1M-token rates of the models this
 * session actually billed, straight from the same book (cost.ts), so printed
 * rates can never drift from the math. A book that has not loaded (or
 * failed) dashes the cell and notes the outage.
 *
 * PORT ADDITION — a session here is one transcript per agent, folded
 * separately, so the caller can hand the cell the SUMMED usage of the whole
 * family plus each agent's own share (`costParts`): the value then covers the
 * session, the bubble itemizes it, and the cell says how many subagents it
 * includes. Everything else on the board stays per-agent — those cards
 * describe one context window.
 *
 * PORT ADDITION — a SECOND row of six cells (peak occupancy, wall-clock
 * duration, compactions, subagents, cost per human prompt, live images) fills
 * the card to its neighbour's height and answers what the count row cannot:
 * how full the window ever got, how long the session stayed open (idle time
 * included, unlike the Timing card's active time), what maintenance it took,
 * and what one prompt cost. The two derived cells read the request records
 * (peak `prompt`, first/last stamp) — the only collections this card touches.
 *
 * The counts arrive precomputed: the split-generation wire head carries them
 * (shared/types.ts `TimelineCounts` — computed over the retained records),
 * and the caller derives them from the collections on the inline generation
 * (`countsOfRecords`). The count cells themselves never touch the
 * collections — only the two derived cells above do.
 */

import { type ReactElement, type ReactNode, useId } from 'react'
import type { ContextEventRecord, RequestRecord, SessionCostUsage, TimelineCounts, TokenUsage } from '../../shared/types'
import { estimateSessionCost, formatCost, formatPriceRate, offPeakOf, priceOf, toCurrency, unpricedCostModels, write1hOf } from '../cost'
import type { CostCurrency, ModelPrices, PriceTriple } from '../cost'
import { cacheHitPercent } from '../format'
import { useModelPrices } from '../modelPrices'
import { asRecord, numOf } from '../services'
import { isDeepSeekProvider } from '../../shared/providers'
import type { ViewKit } from '../viewkit'

/**
 * One billed model's tooltip row: its display label and USD rates (`offRate`
 * present only when the model billed off-peak). `write1h` is present only when
 * that model's buckets actually carry a 1-hour cache write — the rate is
 * materially higher than the 5m one, so a total that includes it has to say so.
 */
interface PriceRow {
  key: string
  label: string
  rate: PriceTriple
  offRate?: PriceTriple
  write1h?: number
  offWrite1h?: number
}

/** Whether any of a model's pricing periods booked a 1-hour cache write. */
/** Stable id fragment for a cell's tooltip, so its badge can point at it with `aria-describedby`. */
function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tip'
}

function wrote1h(periods: Record<string, unknown> | null): boolean {
  if (periods === null) return false
  for (const period of ['peak', 'off'] as const) {
    const bucket = asRecord(periods[period])
    if (bucket !== null && numOf(bucket.cacheWrite1h) > 0) return true
  }
  return false
}

/**
 * PORT ADDITION — one agent's share of the session cost. A session here is a
 * main transcript plus one file per subagent, each folded on its own, so the
 * Cost cell sums them (costMerge.ts) and the bubble itemizes who spent what.
 */
export interface CostPart {
  /** Stable key (the transcript id). */
  id: string
  /** The agent's caption, as the Agent Network shows it. */
  label: string
  /** That file's own cumulative billed totals. */
  cost: SessionCostUsage | undefined
}

/**
 * The rate rows for the models this session actually billed — the usage
 * keys priced against the book, in fold order. Hostile branches skip;
 * unpriced models drop (their buckets simply do not contribute). The label
 * carries the provider only when the session billed more than one; a model
 * with an off-peak bucket (DeepSeek's period-based list) shows the
 * peak | off-peak pair.
 */
function priceRowsOf(usage: SessionCostUsage | undefined, prices: ModelPrices | null): PriceRow[] {
  if (usage === undefined || prices === null) return []
  const rows: PriceRow[] = []
  const multi = Object.keys(usage).length > 1
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const rate = priceOf(prices, provider, model)
      if (rate === null) continue
      const periods = asRecord(models[model])
      // The peak | off-peak pair is DeepSeek's alone (shared/providers):
      // other providers bill everything at list price.
      const off = isDeepSeekProvider(provider) && periods !== null && periods.off !== undefined
        ? offPeakOf(rate)
        : undefined
      const has1h = wrote1h(periods)
      rows.push({
        key: provider + '/' + model,
        label: multi && provider !== '' ? `${model} · ${provider}` : model,
        rate,
        ...(off !== undefined ? { offRate: off } : {}),
        ...(has1h ? { write1h: write1hOf(rate) } : {}),
        ...(has1h && off !== undefined ? { offWrite1h: write1hOf(off) } : {}),
      })
    }
  }
  return rows
}

/**
 * The inline generation's counter derivation — the exact tally the card ran
 * over the served collections before the split (distinct turn values, record
 * count, per-kind event tallies). The host's split-generation counts match
 * it by construction (fold.ts buildTimelineHead).
 */
export function countsOfRecords(requests: readonly RequestRecord[], events: readonly ContextEventRecord[]): TimelineCounts {
  const turns = new Set<number>()
  for (const req of requests) turns.add(req.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  for (const ev of events) {
    if (ev.kind === 'inject') injects++
    else if (ev.kind === 'compaction') compactions++
    else if (ev.kind === 'prune') prunes++
  }
  return { turns: turns.size, steps: requests.length, injects, compactions, prunes }
}

/**
 * PORT ADDITION — the largest prompt this agent ever sent, in tokens:
 * `RequestRecord.prompt` is the provider-reported prompt size (input +
 * cacheRead + cacheWrite), so the peak is the high-water mark of the context
 * window's occupancy. Rows folded before the fold carried `prompt` fall back
 * to their heuristic `total`. Null when no record carries a usable figure —
 * a peak of zero is not a measurement.
 */
export function peakContextOf(requests: readonly RequestRecord[]): number | null {
  let peak = 0
  for (const req of requests) {
    const value = req.prompt ?? req.total
    if (!Number.isFinite(value)) continue
    if (value > peak) peak = value
  }
  return peak > 0 ? peak : null
}

/**
 * PORT ADDITION — the session's WALL-CLOCK span: the first request's stamp to
 * the last stamp the log carries (the last request, or a later context event —
 * a compaction can land after the final request). Unlike the Timing card's
 * active time this counts the gaps, so it answers "how long was this session
 * open", not "how long did it work". Null when the log holds fewer than two
 * distinct stamps (nothing elapsed to report).
 */
export function durationOf(
  requests: readonly RequestRecord[],
  events: readonly ContextEventRecord[] = [],
): number | null {
  let first: number | null = null
  let last: number | null = null
  for (const req of requests) {
    if (!Number.isFinite(req.time)) continue
    if (first === null || req.time < first) first = req.time
    if (last === null || req.time > last) last = req.time
  }
  if (first === null || last === null) return null
  for (const ev of events) {
    if (Number.isFinite(ev.time) && ev.time > last) last = ev.time
  }
  const ms = last - first
  return ms > 0 ? ms : null
}

/**
 * PORT ADDITION — what one human prompt cost on average: the card's own cost
 * estimate over the whole-session human-input tally. Null when either half is
 * missing (no priced cost, or a session the user never prompted — dividing by
 * zero would print an infinity).
 */
export function costPerPromptOf(cost: number | null, humanInputs: number): number | null {
  if (cost === null || !(humanInputs > 0)) return null
  return cost / humanInputs
}

export interface StatsContextProps {
  /** The session-shape tally (host-precomputed on the split generation). */
  counts: TimelineCounts
  /** The whole-session human-input tally (the user's messages + question answers; absent on older hosts). */
  humanInputs?: number | undefined
  /** Tool calls with a result live in the current context (absent on older hosts). */
  toolCalls?: number | undefined
  /** The official tokenUsage projection — the cache-hit cell's source (null until a provider reports). */
  usage: TokenUsage | null
  cost?: SessionCostUsage | undefined
  /** PORT ADDITION — per-agent cost shares; two or more entries itemize the bubble. */
  costParts?: readonly CostPart[] | undefined
  /**
   * PORT ADDITION — the shown agent's request records, read ONLY by the two
   * derived cells (peak occupancy, wall-clock span). Empty/absent dashes them.
   */
  requests?: readonly RequestRecord[] | undefined
  /** PORT ADDITION — the shown agent's context events; only their stamps are read (a trailing compaction extends the span). */
  events?: readonly ContextEventRecord[] | undefined
  /** PORT ADDITION — the route's context window, when the log records one: it turns the peak into a share. */
  contextWindow?: number | undefined
  /** PORT ADDITION — image blocks live in the current context (Snapshot.images; absent reads as zero). */
  images?: number | undefined
  /** PORT ADDITION — child agents of the session, main agent excluded. Absent (not zero) dashes the cell. */
  subagents?: number | undefined
  locale: string
}

export function makeStatsContext(kit: ViewKit): (props: StatsContextProps) => ReactElement {
  const { t, fmt, fmtDuration } = kit
  return function StatsContext(props: StatsContextProps): ReactElement {
    const currency: CostCurrency = props.locale === 'zh' ? 'cny' : 'usd'
    const { prices, failed } = useModelPrices()
    const tipIdBase = useId()
    const cost = estimateSessionCost(props.cost, prices, currency)
    const fmtRate = (usd: number): string => formatPriceRate(toCurrency(usd, currency), currency)
    const rows = priceRowsOf(props.cost, prices)
    // DeepSeek's peak/off-peak scheme is explained only when the session
    // actually billed a DeepSeek provider — other sessions see nothing of it.
    const deepseek = props.cost !== undefined && Object.keys(props.cost).some(p => isDeepSeekProvider(p))
    const anyPair = rows.some(r => r.offRate !== undefined)
    // PORT ADDITION — which billed models the book could NOT price. The
    // estimate leaves them out entirely, so the cell has to say so: with a
    // figure it is a floor ("excludes …"), with no figure at all it is the
    // book outage dsh-context already noted. Settled-book only: while the
    // fetch is still in flight every model reads as unpriced.
    const settled = failed || prices !== null
    const unpricedModels = settled ? unpricedCostModels(props.cost, prices) : []
    const nonePriced = cost === null && unpricedModels.length > 0
    const partial = cost !== null && unpricedModels.length > 0
    // PORT ADDITION — the per-agent itemization. Only agents that actually
    // billed are listed (a subagent that never reached the model contributes
    // no line), and the block appears only when more than one did, so a
    // childless session's bubble is exactly the one dsh-context showed.
    const parts = (props.costParts ?? [])
      .map(part => ({ id: part.id, label: part.label, amount: estimateSessionCost(part.cost, prices, currency) }))
      .filter((part): part is { id: string; label: string; amount: number } => part.amount !== null && part.amount > 0)
    const costTip: ReactNode = [
      t('stats.costTip') + (deepseek ? ' ' + t('stats.costTipDeepseek') : ''),
      parts.length > 1 ? (
        <span key="parts" className="lc-stat-tip-prices">
          <span className="lc-stat-tip-head">{t('stats.costByAgent')}</span>
          {parts.map(part => (
            <span key={part.id} className="lc-stat-tip-row">
              <b className="lc-stat-tip-model">{part.label}</b>
              {' · '}
              {formatCost(part.amount, currency)}
            </span>
          ))}
          <span className="lc-stat-tip-row lc-stat-tip-total">
            <b className="lc-stat-tip-model">{t('stats.costTotal')}</b>
            {' · '}
            {cost === null ? '—' : formatCost(cost, currency)}
          </span>
        </span>
      ) : null,
      rows.length > 0 ? (
        <span key="prices" className="lc-stat-tip-prices">
          <span className="lc-stat-tip-head">
            {anyPair ? t('stats.costPriceHeadPair') : t('stats.costPriceHead')}
          </span>
          {rows.map((r) => {
            const cells: [string, number, number | undefined][] = [
              [t('stats.costHit'), r.rate.hit, r.offRate?.hit],
              [t('stats.costMiss'), r.rate.miss, r.offRate?.miss],
              [t('stats.costWrite'), r.rate.write, r.offRate?.write],
              // A 1h cache write bills far above the 5m one; printed only for
              // the models whose buckets actually booked one, so the reader can
              // see which rate produced the total.
              ...(r.write1h === undefined
                ? []
                : [[t('stats.costWrite1h'), r.write1h, r.offWrite1h] as [string, number, number | undefined]]),
              [t('stats.costOut'), r.rate.out, r.offRate?.out],
            ]
            return (
              <span key={r.key} className="lc-stat-tip-row">
                <b className="lc-stat-tip-model">{r.label}</b>
                {cells.map(([name, peak, off]) => (
                  <span key={name}>{' · '}{name} {off === undefined ? fmtRate(peak) : `${fmtRate(peak)}|${fmtRate(off)}`}</span>
                ))}
              </span>
            )
          })}
        </span>
      ) : null,
      nonePriced ? <span key="unavailable">{t('stats.costUnavailable')}</span> : null,
    ]
    // The harness chat stats line's own formula, shown two decimals deep:
    // prompt-side cache reads over the whole billed input (output excluded),
    // dashed until reported.
    const hit = props.usage === null ? null
      : cacheHitPercent(
        numOf(props.usage.cacheReadTokens),
        numOf(props.usage.uncachedInputTokens) + numOf(props.usage.cacheReadTokens) + numOf(props.usage.cacheWriteTokens),
      )
    /** The scope lines under a value; each keeps its full text in the title. */
    const notes = (lines: readonly (string | null)[]): ReactNode => {
      const shown = lines.filter((line): line is string => line !== null)
      if (shown.length === 0) return undefined
      return shown.map(line => <span key={line} className="lc-stat-note" title={line}>{line}</span>)
    }
    // PORT ADDITION — the second row's derived figures. The peak prompt reads
    // as a SHARE whenever the route's window is known (the figure the reader
    // actually judges: "how full did this get"), and falls back to the token
    // count when it is not.
    const peak = peakContextOf(props.requests ?? [])
    const window = props.contextWindow
    const peakValue = peak === null ? '—'
      : window !== undefined && window > 0 ? `${Math.round((peak / window) * 100)}%`
        : fmt(peak)
    const durationMs = durationOf(props.requests ?? [], props.events ?? [])
    const prunes = props.counts.prunes
    const compactionsTip = t('stats.compactionsTip') + (prunes > 0 ? ' ' + t('stats.compactionsPrunes', { n: prunes }) : '')
    const perPrompt = costPerPromptOf(cost, props.humanInputs ?? 0)
    // PORT CHANGE — dsh reveals a cell's bubble on hover anywhere over the cell. With
    // nine of twelve cells tipped and the bubble spanning the card, that flashed a
    // bubble over the cards below on any mouse movement, so the reveal now rides the
    // '?' badge only: hover or keyboard focus on the badge (stats.css `:has()` rules),
    // and the badge is a real button so it is reachable without a mouse.
    const cell = (label: string, value: string | number, tip?: ReactNode, note?: ReactNode): ReactElement => {
      const tipId = tip === undefined ? undefined : `${tipIdBase}-${slug(label)}`
      return (
        <div className={'lc-stat' + (tip === undefined ? '' : ' lc-stat-tipped')}>
          <span className="lc-stat-label">
            {label}
            {tipId !== undefined && (
              <button type="button" className="lc-stat-q" aria-label={t('stats.tipBadge')} aria-describedby={tipId}>?</button>
            )}
          </span>
          <b className="lc-stat-value">{typeof value === 'number' ? fmt(value) : value}</b>
          {note !== undefined && note}
          {tipId !== undefined && <span id={tipId} className="lc-tip lc-stat-tip" role="tooltip">{tip}</span>}
        </div>
      )
    }
    return (
      <div className="lc-card lc-col-stats flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.title')}</span>
        </div>
        {/* The count grid: auto-fit keeps every cell ≥108px (the floor where the longest
            English label still fits), so cells fill the card — 3 across at the default
            half-card, 6 across on a wide card, 2 on a phone-width one. */}
        <div className="lc-stats grid grid-cols-[repeat(auto-fit,minmax(108px,1fr))] gap-1.5">
          {cell(t('stats.turns'), props.counts.turns)}
          {cell(t('stats.steps'), props.counts.steps)}
          {cell(t('stats.humanInputs'), props.humanInputs ?? 0, t('stats.humanInputsTip'))}
          {cell(t('stats.toolCalls'), props.toolCalls ?? 0)}
          {cell(t('stats.cacheHit'), hit === null ? '—' : `${hit}%`, t('stats.cacheHitTip'))}
          {cell(
            t('stats.cost'),
            cost === null ? '—' : formatCost(cost, currency),
            costTip,
            // Two scope notes, both about what the figure does NOT say on its
            // own: whose spending it covers, and which billed models it had to
            // leave out.
            notes([
              parts.length > 1 ? t('stats.costChildren', { n: parts.length - 1 }) : null,
              partial ? t('stats.costPartial', { n: unpricedModels.length, models: unpricedModels.join(', ') }) : null,
            ]),
          )}
          {/* The second row: the same six-cell rhythm, answering what the shape
              figures above cannot — how full the window ever got, how long the
              session was open, what maintenance it took, how many agents and
              images it carried, and what one prompt cost. */}
          {cell(t('stats.peakContext'), peakValue, t('stats.peakContextTip'))}
          {cell(t('stats.duration'), durationMs === null ? '—' : fmtDuration(durationMs), t('stats.durationTip'))}
          {cell(t('stats.compactions'), props.counts.compactions, compactionsTip)}
          {cell(t('stats.subagents'), props.subagents ?? '—', t('stats.subagentsTip'))}
          {cell(
            t('stats.costPerPrompt'),
            perPrompt === null ? '—' : formatCost(perPrompt, currency),
            t('stats.costPerPromptTip'),
          )}
          {cell(t('stats.images'), props.images ?? 0, t('stats.imagesTip'))}
        </div>
      </div>
    )
  }
}
