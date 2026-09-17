/**
 * Session Info — the card beside Context stats, in the slot dsh-context gave
 * its Plugin Info card (and styled with the same `lc-pi-*` rows).
 *
 * It answers "where did this session come from and how did it run": the
 * harness that wrote the transcript, the model and provider, the context
 * window, the CLI version, when it started, the working directory, the
 * command that resumes it (with a copy control), and the cost the harness
 * itself reported when it recorded one.
 */

import { type ReactElement, type ReactNode } from 'react'
import type { ModelPriceRules } from '@harness-trajectory/core'
import { formatPriceRate, offRateOf, priceOf, toCurrency } from '../cost'
import type { CostCurrency } from '../cost'
import type { ContextLocale } from '../i18n'
import { matchRule } from '../../shared/pricingRules'
import { useModelPrices } from '../modelPrices'
import type { ViewKit } from '../viewkit'
import { makeRichText } from './richText'

/** Everything the card shows; every field is optional but `harness`. */
export interface SessionInfo {
  /** The harness identity as a node — the web app passes its mark plus label. */
  harness: ReactNode
  /** The harness's plain name, for the copy that has to name it in a sentence. */
  harnessName?: string | undefined
  model?: string | undefined
  provider?: string | undefined
  contextWindow?: number | undefined
  version?: string | undefined
  cwd?: string | undefined
  /** Epoch milliseconds of the first record. */
  startedAt?: number | undefined
  /** The shell command that resumes this session in its harness. */
  resumeCommand?: string | undefined
  /** Cumulative cost the harness recorded itself (never an estimate). */
  reportedCostUsd?: number | undefined
}

export interface SessionInfoProps {
  info: SessionInfo
  /**
   * PORT ADDITION — the same "price this model" affordance as the Cost cell's
   * note: when the host listens, the model row is a button reporting the
   * (provider, model) pair — unpriced pairs to price them, priced ones to
   * revisit or override the rate that resolved (rule or registry).
   */
  pricingRules?: ModelPriceRules | undefined
  onPriceModel?: ((provider: string, model: string) => void) | undefined
  /** Rates under the model row render in the host's currency (zh → ¥). */
  locale?: ContextLocale | undefined
}

export function makeSessionInfo(kit: ViewKit): (props: SessionInfoProps) => ReactElement {
  const { t, fmt, fmtTime } = kit
  const { RichCopy } = makeRichText(kit)

  const row = (key: string, label: string, value: ReactNode, hint?: string): ReactElement => (
    <div key={key} className="lc-pi-row">
      <div className="lc-pi-label">{label}</div>
      <div className="lc-pi-value" title={hint}>{value}</div>
    </div>
  )

  return function SessionInfoCard(props: SessionInfoProps): ReactElement {
    const { prices } = useModelPrices()
    const currency: CostCurrency = props.locale === 'zh' ? 'cny' : 'usd'
    const fmtRate = (usd: number): string => formatPriceRate(toCurrency(usd, currency), currency)
    const info = props.info
    const rows: ReactElement[] = []
    rows.push(row('harness', t('session.harness'), info.harness))
    if (info.model !== undefined && info.model !== '') {
      const provider = info.provider ?? ''
      const label = info.model + (provider !== '' ? ' · ' + provider : '')
      const rate = priceOf(prices, provider, info.model, props.pricingRules)
      let value: ReactNode = props.onPriceModel === undefined
        ? label
        : (
          <button
            type="button"
            className="lc-stat-price-link"
            title={t(rate === null ? 'stats.costPriceAdd' : 'stats.costPriceEdit')}
            onClick={() => props.onPriceModel?.(provider, info.model ?? '')}
          >{label}</button>
        )
      if (rate !== null) {
        // The priced model's own rate card under its name — the per-1M
        // figures, `peak|off` pairs when a schedule (rule or the provider's
        // built-in) gives the off bucket a different rate.
        const off = offRateOf(matchRule(props.pricingRules ?? null, provider, info.model), provider, rate)
        const cells: [string, number, number][] = [
          [t('stats.costMiss'), rate.miss, off.miss],
          [t('stats.costOut'), rate.out, off.out],
          [t('stats.costHit'), rate.hit, off.hit],
          [t('stats.costWrite'), rate.write, off.write],
        ]
        const line = cells
          .map(([name, peak, offPeak]) => `${name} ${fmtRate(peak)}${offPeak === peak ? '' : '|' + fmtRate(offPeak)}`)
          .join(' · ')
        value = <span className="lc-pi-model">{value}<span className="lc-pi-price">{line}</span></span>
      }
      rows.push(row('model', t('session.model'), value, label))
    }
    if (info.contextWindow !== undefined && info.contextWindow > 0) {
      rows.push(row('window', t('session.window'), fmt(info.contextWindow) + ' tokens'))
    }
    if (info.version !== undefined && info.version !== '') {
      rows.push(row('version', t('session.version'), info.version, info.version))
    }
    if (info.startedAt !== undefined && Number.isFinite(info.startedAt) && info.startedAt > 0) {
      rows.push(row('started', t('session.started'), fmtTime(info.startedAt)))
    }
    if (info.cwd !== undefined && info.cwd !== '') {
      rows.push(row('cwd', t('session.cwd'), info.cwd, info.cwd))
    }
    if (info.reportedCostUsd !== undefined && Number.isFinite(info.reportedCostUsd)) {
      // The one figure on this card that is NOT about the shown agent: the
      // harness bills a session, subagents included, so the row says whose
      // number it is and what it covers. It can land EITHER SIDE of the Context
      // Stats estimate: it covers calls the transcript never records (so it
      // runs higher for Claude), but it settles at the vendor's own prices
      // while the estimate only knows the models.dev list (xAI bills
      // `grok-4.6-build` 66–71% BELOW list, so grok's runs far lower).
      const name = info.harnessName
      rows.push(
        <div key="cost" className="lc-pi-row lc-pi-cost">
          <div className="lc-pi-label">
            {name === undefined || name === '' ? t('session.cost') : t('session.costReported', { harness: name })}
          </div>
          <div className="lc-pi-value" title={t('session.costTip')}>
            {'$' + info.reportedCostUsd.toFixed(4)}
            <span className="lc-pi-scope">{t('session.costScope')}</span>
          </div>
        </div>,
      )
    }
    if (info.resumeCommand !== undefined && info.resumeCommand !== '') {
      // The command is the one row worth carrying away, so it pairs the
      // truncating value with the browser's own copy control.
      rows.push(
        <div key="resume" className="lc-pi-row lc-pi-resume">
          <div className="lc-pi-label">{t('session.resume')}</div>
          <div className="lc-pi-value lc-pi-cmd" title={info.resumeCommand}>{info.resumeCommand}</div>
          <RichCopy text={info.resumeCommand} />
        </div>,
      )
    }
    return (
      <div className="lc-card flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('session.title')}</span>
          <span className="lc-card-sub lc-pi-hint">{t('session.hint')}</span>
        </div>
        <div className="lc-pi-grid">{rows}</div>
      </div>
    )
  }
}
