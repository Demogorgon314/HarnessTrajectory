/**
 * `PriceRuleEditor` — the rule form shared by the settings "Model pricing"
 * section and the "price this model" dialog: match key (with one-click scope
 * shortcuts when a billed pair is known), an alias into the models.dev book
 * OR a custom USD/1M rate card, and an optional off-peak schedule (a factor
 * over peak, or its own rate card). Validation blocks submit; the error line
 * names the field to fix. The draft math lives in `price-rule-draft.ts`.
 */

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { modelPriceKeyOf, splitModelPriceKey, type ModelPriceRule } from '@harness-trajectory/core'
import { formatPriceRate, useModelPrices, type PriceTriple } from '@harness-trajectory/context/client'
import { ModelPicker, normalizeBilledModel, suggestedAliasOf } from './ModelPicker.tsx'
import {
  BROWSER_TZ, draftOf, fieldsOfTriple, RATE_FIELDS, ruleOf, SCHEDULE_PRESETS,
  type RateFields, type RuleDraft,
} from './price-rule-draft.ts'
import css from './pricing.module.css'
import base from './settings.module.css'

/** A labeled form row: the 80px label column, then whatever control the caller hands it. */
function Field({ label, top, children }: { label: string; top?: boolean | undefined; children: ReactNode }): ReactElement {
  return (
    <span className={css.field} {...(top === true ? { 'data-top': true } : {})}>
      <span className={css.fieldLabel}>{label}</span>
      <span className={css.fieldControl}>{children}</span>
    </span>
  )
}

/** A two-option segmented control over real (visually hidden) radios — tests find them by role/name. */
function SegmentedRadio<T extends string>({ ariaLabel, value, options, onChange }: {
  ariaLabel: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}): ReactElement {
  return (
    <span className={css.segment} role="radiogroup" aria-label={ariaLabel}>
      {options.map(option => (
        <label key={option.value} className={css.segmentItem}>
          <input
            type="radio"
            className={css.srOnly}
            checked={value === option.value}
            onChange={() => { onChange(option.value) }}
          />
          {option.label}
        </label>
      ))}
    </span>
  )
}

/** The Match scope shortcuts — buttons, not radios; the pressed one mirrors the current key. */
function SegmentedButtons({ options, active, onPick }: {
  options: readonly { key: string; label: string }[]
  active: string
  onPick: (key: string) => void
}): ReactElement {
  return (
    <span className={css.segment}>
      {options.map(option => (
        <button
          key={option.key}
          type="button"
          className={`${css.segmentItem} ${css.segmentBtn}`}
          aria-pressed={option.key === active}
          onClick={() => { onPick(option.key) }}
        >{option.label}</button>
      ))}
    </span>
  )
}

/** One labeled rate card (`RATE_FIELDS`) plus the caption and the copy-from-a-listed-model affordance. */
function RatesGrid({ fields, onChange, copyOpen, onCopyOpen, pinned, onCopyPick }: {
  fields: RateFields
  onChange: (partial: Partial<RateFields>) => void
  copyOpen: boolean
  onCopyOpen: () => void
  pinned?: readonly string[] | undefined
  onCopyPick: (id: string, price: PriceTriple) => void
}): ReactElement {
  return (
    <span className={css.ratesCell}>
      <span className={css.ratesGrid}>
        {RATE_FIELDS.map(spec => (
          <label key={spec.key} className={css.ratesField}>
            <span className={css.ratesFieldLabel}>{spec.label}</span>
            <input
              type="number"
              min={0}
              step="any"
              className={`${base.number} ${css.ratesInput}`}
              placeholder={spec.placeholder}
              aria-label={spec.label}
              title={`${spec.label} — USD per 1M tokens`}
              value={fields[spec.key]}
              onChange={event => { onChange({ [spec.key]: event.currentTarget.value }) }}
            />
          </label>
        ))}
      </span>
      <span className={css.ratesCaption}>USD per 1M tokens · cache fields optional</span>
      {copyOpen
        ? <ModelPicker value="" pinned={pinned} onPick={onCopyPick} />
        : (
          <button
            type="button"
            className={css.priceLink}
            onClick={onCopyOpen}
          >Copy rates from a listed model…</button>
        )}
    </span>
  )
}

export interface PriceRuleEditorProps {
  /** The match key and rule the form starts from (`{}` for a new rule). */
  seed: { key: string; rule: ModelPriceRule }
  /** The billed pair the dialog was opened for — enables the Match shortcuts. */
  pair?: { provider: string; model: string } | undefined
  /** Alias ids other rules already point at — pinned in the pickers. */
  usedAliases?: readonly string[] | undefined
  saving?: boolean | undefined
  submitLabel: string
  /** Focus the Match input on mount (the dialog; the inline list does not). */
  autoFocus?: boolean | undefined
  /** A validated (key, rule) pair; the caller owns merging it into the table. */
  onSubmit: (key: string, rule: ModelPriceRule) => void
  onCancel: () => void
}

export function PriceRuleEditor({ seed, pair, usedAliases, saving, submitLabel, autoFocus, onSubmit, onCancel }: PriceRuleEditorProps): ReactElement {
  const { prices, failed } = useModelPrices()
  const [draft, setDraft] = useState<RuleDraft>(() => draftOf(seed.key, seed.rule))
  const [error, setError] = useState<string | null>(null)
  /** The user asked to type the alias by hand (normally the picker writes it). */
  const [manualAlias, setManualAlias] = useState(false)
  /** Which rate grid the "copy from a listed model" picker is feeding. */
  const [copyFor, setCopyFor] = useState<'rates' | 'offRates' | null>(null)

  // The billed pair behind the match key (`provider/model` or a bare model);
  // wildcard/empty keys carry no seed.
  const seedPair = useMemo(() => splitModelPriceKey(seed.key) ?? undefined, [seed.key])
  // The billed pair the dialog names beats the pair parsed out of the key.
  const effectivePair = pair ?? seedPair

  // A book entry with the billed model's exact id prefills the alias — the
  // "default to a listed model" case — but never over a draft the user has
  // already touched (typed alias or rates).
  const suggested = useMemo(
    () => (effectivePair === undefined ? null : suggestedAliasOf(prices, effectivePair.provider, effectivePair.model)),
    [prices, effectivePair],
  )
  useEffect(() => {
    if (suggested === null) return
    setDraft(d => (d.alias === '' && d.rates.input === '' && d.rates.output === ''
      ? { ...d, mode: 'alias', alias: suggested }
      : d))
  }, [suggested])

  // The book entry behind the typed/picked alias, for the Selected chip's rates.
  const aliasPrice = useMemo(() => {
    const parts = splitModelPriceKey(draft.alias)
    return parts === null ? undefined : prices?.[parts.provider]?.[parts.model]
  }, [prices, draft.alias])

  const patch = (partial: Partial<RuleDraft>) => {
    setDraft(d => ({ ...d, ...partial }))
  }
  const patchRates = (partial: Partial<RateFields>) => {
    setDraft(d => ({ ...d, rates: { ...d.rates, ...partial } }))
  }
  const patchOffRates = (partial: Partial<RateFields>) => {
    setDraft(d => ({ ...d, offRates: { ...d.offRates, ...partial } }))
  }

  const submit = () => {
    const result = ruleOf(draft)
    if (typeof result === 'string') {
      setError(result)
      return
    }
    onSubmit(result.key, result.rule)
  }

  const copyRates = (apply: (partial: Partial<RateFields>) => void) =>
    (id: string, price: PriceTriple) => {
      apply(fieldsOfTriple(price))
      setCopyFor(null)
    }

  // One-click match keys for the billed pair; the text input stays for keys
  // outside the pair's reach. A provider-less pair collapses "This model" and
  // "Any provider" to the same key — shown once.
  const matchOptions = effectivePair === undefined ? [] : [
    { label: 'This model', key: modelPriceKeyOf(effectivePair.provider, effectivePair.model) },
    ...(effectivePair.provider === '' ? [] : [{ label: `All ${effectivePair.provider} models`, key: `${effectivePair.provider}/*` }]),
    { label: 'Any provider', key: effectivePair.model },
  ].filter((option, index, all) => all.findIndex(other => other.key === option.key) === index)

  const pickerQuery = effectivePair === undefined ? undefined : normalizeBilledModel(effectivePair.model)

  return (
    <form className={css.priceEditor} onSubmit={event => { event.preventDefault(); submit() }}>
      <Field label="Match">
        <span className={css.controlColumn}>
          {matchOptions.length > 0 && (
            <SegmentedButtons
              options={matchOptions}
              active={draft.key.trim()}
              onPick={key => { patch({ key }) }}
            />
          )}
          <input
            type="text"
            className={`${base.text} ${css.fieldInput}`}
            placeholder="cognition/swe-2-max"
            aria-label="Match"
            autoFocus={autoFocus}
            value={draft.key}
            onChange={event => { patch({ key: event.currentTarget.value }) }}
          />
        </span>
      </Field>
      {matchOptions.length > 0 && (
        <span className={css.priceHint}>Or type a match by hand.</span>
      )}
      <Field label="Price">
        <SegmentedRadio
          ariaLabel="Price source"
          value={draft.mode}
          options={[
            { value: 'alias', label: 'Alias to a models.dev entry' },
            { value: 'rates', label: 'Custom rates' },
          ]}
          onChange={mode => { patch({ mode }) }}
        />
      </Field>
      {draft.mode === 'alias'
        ? (
          <>
            <Field label="Model" top>
              <ModelPicker
                value={draft.alias}
                initialQuery={pickerQuery}
                suggested={suggested}
                pinned={usedAliases}
                onPick={id => { patch({ alias: id }) }}
              />
            </Field>
            <Field label="Selected">
              {draft.alias === ''
                ? <span className={css.priceDim}>Pick a model above.</span>
                : (
                  <span className={css.aliasChip}>
                    <span className={css.aliasChipId}>{`→ ${draft.alias}`}</span>
                    {aliasPrice !== undefined && (
                      <span className={css.aliasChipRates}>
                        in {formatPriceRate(aliasPrice.miss, 'usd')} · out {formatPriceRate(aliasPrice.out, 'usd')}
                        {' '}· hit {formatPriceRate(aliasPrice.hit, 'usd')} · write {formatPriceRate(aliasPrice.write, 'usd')}
                      </span>
                    )}
                    <button
                      type="button"
                      className={css.aliasChipClear}
                      aria-label="Clear alias"
                      onClick={() => { patch({ alias: '' }) }}
                    >✕</button>
                  </span>
                )}
            </Field>
            {(failed || manualAlias) && (
              <Field label="Alias">
                <input
                  type="text"
                  className={`${base.text} ${css.fieldInput}`}
                  placeholder="deepseek/deepseek-v4-flash"
                  aria-label="Alias"
                  value={draft.alias}
                  onChange={event => { patch({ alias: event.currentTarget.value }) }}
                />
              </Field>
            )}
            {!failed && !manualAlias && (
              <button
                type="button"
                className={`${css.priceHint} ${css.priceLink}`}
                onClick={() => { setManualAlias(true) }}
              >Type it manually</button>
            )}
          </>
        )
        : (
          <Field label="Rates" top>
            <RatesGrid
              fields={draft.rates}
              onChange={patchRates}
              copyOpen={copyFor === 'rates'}
              onCopyOpen={() => { setCopyFor('rates') }}
              pinned={usedAliases}
              onCopyPick={copyRates(patchRates)}
            />
          </Field>
        )}
      <Field label="Schedule">
        <label className={css.priceCheck}>
          <input
            type="checkbox"
            className={css.check}
            checked={draft.offPeak}
            onChange={event => { patch({ offPeak: event.currentTarget.checked }) }}
          />
          Off-peak pricing
        </label>
      </Field>
      {draft.offPeak && (
        <span className={css.priceOff}>
          <Field label="Preset">
            {SCHEDULE_PRESETS.map(preset => (
              <button
                key={preset.id}
                type="button"
                className={base.btnGhost}
                title={preset.title}
                onClick={() => { patch(preset.patch) }}
              >{preset.label}</button>
            ))}
          </Field>
          <Field label="Peak hours">
            <input
              type="text"
              className={`${base.text} ${css.fieldInput}`}
              placeholder="9-12, 14-18"
              aria-label="Peak hours"
              value={draft.peakHours}
              onChange={event => { patch({ peakHours: event.currentTarget.value }) }}
            />
          </Field>
          <Field label="Timezone">
            <input
              type="text"
              className={`${base.text} ${css.fieldInput}`}
              placeholder={BROWSER_TZ}
              aria-label="Timezone"
              value={draft.timezone}
              onChange={event => { patch({ timezone: event.currentTarget.value }) }}
            />
          </Field>
          <span className={css.priceHint}>Blank = this browser's zone ({BROWSER_TZ}). IANA names like Asia/Shanghai.</span>
          <Field label="Weekdays">
            <label className={css.priceCheck}>
              <input
                type="checkbox"
                className={css.check}
                checked={draft.weekdaysOnly}
                onChange={event => { patch({ weekdaysOnly: event.currentTarget.checked }) }}
              />
              Weekdays only (weekends all off-peak)
            </label>
          </Field>
          <Field label="Off rate">
            <SegmentedRadio
              ariaLabel="Off-peak rate"
              value={draft.offMode}
              options={[
                { value: 'factor', label: 'Factor of peak' },
                { value: 'rates', label: 'Custom rates' },
              ]}
              onChange={offMode => { patch({ offMode }) }}
            />
          </Field>
          {draft.offMode === 'factor'
            ? (
              <Field label="Factor">
                <input
                  type="number"
                  min={0}
                  step="any"
                  className={`${base.number} ${css.factorNumber}`}
                  value={draft.offFactor}
                  onChange={event => { patch({ offFactor: event.currentTarget.value }) }}
                />
                <span className={css.priceInlineHint}>0.5 = half price</span>
              </Field>
            )
            : (
              <Field label="Off rates" top>
                <RatesGrid
                  fields={draft.offRates}
                  onChange={patchOffRates}
                  copyOpen={copyFor === 'offRates'}
                  onCopyOpen={() => { setCopyFor('offRates') }}
                  pinned={usedAliases}
                  onCopyPick={copyRates(patchOffRates)}
                />
              </Field>
            )}
        </span>
      )}
      {error !== null && <span role="alert" className={base.error}>{error}</span>}
      <span className={css.priceActions}>
        <button type="submit" className={css.btnPrimary} disabled={saving === true}>
          {saving === true ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className={base.btnGhost} onClick={onCancel}>Cancel</button>
      </span>
    </form>
  )
}
