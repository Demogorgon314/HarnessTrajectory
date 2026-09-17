/**
 * The "price this model" dialog: a Session Info model row or a cost-cell note
 * names a billed (provider, model), and clicking it opens this small modal —
 * a single `PriceRuleEditor` seeded with the rule that GOVERNS the pair
 * (`matchRuleKey`: exact, `provider/*`, or bare model — edited in place, a
 * rename replacing the old key), or with the fold key itself when no rule
 * applies yet. Saving merges the rule into the persisted `modelPricing`
 * table; the open session refolds under the new resolver on its next
 * runtime rebuild.
 */

import { useEffect, useMemo, type ReactElement } from 'react'
import { modelPriceKeyOf, type ModelPriceRule } from '@harness-trajectory/core'
import { matchRuleKey, priceOf, useModelPrices } from '@harness-trajectory/context/client'
import { useSnapshotSelector } from '@harness-trajectory/ui'
import { PriceRuleEditor } from './PriceRuleEditor.tsx'
import { aliasesOf, upsertRule } from './price-rule-draft.ts'
import { saveSettings, settingsStore } from './settings-store.ts'
import css from './settings.module.css'

export interface PriceRuleDialogProps {
  /** The fold's cost key, exactly as the session billed it. */
  provider: string
  model: string
  onClose: () => void
}

export function PriceRuleDialog({ provider, model, onClose }: PriceRuleDialogProps): ReactElement {
  const state = useSnapshotSelector(settingsStore, value => value)
  const { prices } = useModelPrices()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  // The rule the pair actually resolves to is the one to edit — its key may be
  // a wildcard or a bare model, not the billed `provider/model`. With none,
  // the billed pair seeds a fresh rule; a registry-priced pair then reads as
  // an override, not a gap.
  const rules = state.current?.modelPricing ?? {}
  const prevKey = matchRuleKey(rules, provider, model)
  const key = prevKey ?? modelPriceKeyOf(provider, model)
  const existing = prevKey === null ? undefined : rules[prevKey]
  const priced = priceOf(prices, provider, model, rules) !== null
  const usedAliases = useMemo(() => aliasesOf(rules), [rules])

  const submit = async (nextKey: string, rule: ModelPriceRule) => {
    await saveSettings({ modelPricing: upsertRule(rules, prevKey, nextKey, rule) })
    // A failed save stays open with the store's error line under the form.
    if (settingsStore.getSnapshot().error === null) onClose()
  }

  const label = provider === '' ? model : `${model} · ${provider}`
  return (
    <div className={css.overlay}>
      <button type="button" className={css.mask} aria-label="Close" onClick={onClose} />
      <div className={css.panelForm} role="dialog" aria-modal="true" aria-label={`Price ${model}`}>
        <header className={css.header}>
          <span className={css.title}>Price {model}</span>
          <button type="button" className={css.close} aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className={css.body}>
          <p className={css.note} data-lead>
            {existing !== undefined
              ? <><code>{label}</code> is priced by the rule below — adjust it or retarget the match.</>
              : priced
                ? <><code>{label}</code> is already priced from the models.dev list; a rule here overrides that rate.</>
                : <><code>{label}</code> has no entry in the models.dev list. Alias a listed model or state its rates.</>}
          </p>
          <PriceRuleEditor
            seed={{ key, rule: existing ?? {} }}
            pair={{ provider, model }}
            usedAliases={usedAliases}
            saving={state.saving || state.current === null}
            autoFocus
            submitLabel={existing === undefined ? 'Add rule' : 'Save rule'}
            onSubmit={submit}
            onCancel={onClose}
          />
          {state.error !== null && <p role="alert" className={css.error}>{state.error}</p>}
        </div>
      </div>
    </div>
  )
}
