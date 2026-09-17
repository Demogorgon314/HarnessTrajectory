/**
 * The settings page's "Model pricing" section: the persisted rule list as
 * cards (key + terse summary, edit-in-place, two-step inline delete) plus
 * add/edit through `PriceRuleEditor`. Rules persist through `settings.json`
 * (`/api/settings`); the fold re-runs on the new table the next time a
 * session stream opens. The draft math lives in `price-rule-draft.ts`.
 */

import { useMemo, useState, type ReactElement } from 'react'
import type { ModelPriceRule, ModelPriceRules } from '@harness-trajectory/core'
import { icons } from '@harness-trajectory/ui'
import { PriceRuleEditor } from './PriceRuleEditor.tsx'
import { aliasesOf, removeRule, ruleSummary, upsertRule } from './price-rule-draft.ts'
import css from './pricing.module.css'
import base from './settings.module.css'

const { IconEditOutline16, IconTrashOutline16 } = icons

export interface ModelPricingProps {
  /** The persisted rules (already clamped server-side). */
  rules: ModelPriceRules
  saving: boolean
  onSave: (rules: ModelPriceRules) => void
}

export function ModelPricing({ rules, saving, onSave }: ModelPricingProps): ReactElement {
  /** The row being edited (`prevKey` null = a new rule; a rename deletes the old key). */
  const [editor, setEditor] = useState<{ key: string; rule: ModelPriceRule; prevKey: string | null } | null>(null)
  /** The row whose trash click armed the inline delete confirm. */
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  /** Alias ids rules already point at — the pickers pin them. */
  const usedAliases = useMemo(() => aliasesOf(rules), [rules])

  const remove = (key: string) => {
    onSave(removeRule(rules, key))
    if (editor?.prevKey === key) setEditor(null)
  }

  const submit = (key: string, rule: ModelPriceRule) => {
    if (editor === null) return
    onSave(upsertRule(rules, editor.prevKey, key, rule))
    setEditor(null)
  }

  const editorCard = (submitLabel: string) => (
    <PriceRuleEditor
      key={editor?.prevKey ?? 'new'}
      seed={{ key: editor?.key ?? '', rule: editor?.rule ?? {} }}
      usedAliases={usedAliases}
      saving={saving}
      submitLabel={submitLabel}
      onSubmit={submit}
      onCancel={() => { setEditor(null) }}
    />
  )

  const keys = Object.keys(rules)
  return (
    <div className={base.row} data-section="pricing">
      <div className={base.rowText}>
        <span className={base.rowHint}>
          Price models the models.dev list can't. A rule matches
          {' '}<code>provider/model</code>, <code>provider/*</code>, or a bare <code>model</code>,
          and either aliases a listed model or states its own USD/1M rates — optionally
          with a peak/off-peak schedule.
        </span>
        {keys.length === 0 && editor === null && (
          <div className={css.priceEmpty}>
            No price rules yet. Models the list can't price appear in the Cost cell of a
            session's Context tab — click one there, or add a rule here.
          </div>
        )}
        {keys.length > 0 && (
          <div className={css.priceRules}>
            {keys.map(key => (
              editor?.prevKey === key
                ? (
                  <div key={key} className={css.priceEditorCard}>
                    {editorCard('Save rule')}
                  </div>
                )
                : (
                  <div key={key} className={css.priceRule}>
                    <code className={css.priceRuleKey}>{key}</code>
                    <span className={css.priceRuleSummary}>{ruleSummary(rules[key] ?? {})}</span>
                    {confirmKey === key
                      ? (
                        <span className={css.priceConfirm}>
                          <span className={css.priceConfirmText}>Delete this rule?</span>
                          <button
                            type="button"
                            className={css.priceConfirmDelete}
                            disabled={saving}
                            onClick={() => { setConfirmKey(null); remove(key) }}
                          >Delete</button>
                          <button
                            type="button"
                            className={css.priceRuleButton}
                            onClick={() => { setConfirmKey(null) }}
                          >Keep</button>
                        </span>
                      )
                      : (
                        <span className={css.priceRuleActions}>
                          <button
                            type="button"
                            className={css.priceIconBtn}
                            title="Edit"
                            aria-label={`Edit price rule ${key}`}
                            disabled={saving}
                            onClick={() => { setConfirmKey(null); setEditor({ key, rule: rules[key] ?? {}, prevKey: key }) }}
                          >
                            <IconEditOutline16 size={14} />
                          </button>
                          <button
                            type="button"
                            className={css.priceIconBtn}
                            data-danger
                            title="Delete"
                            aria-label={`Delete price rule ${key}`}
                            disabled={saving}
                            onClick={() => { setConfirmKey(key) }}
                          >
                            <IconTrashOutline16 size={14} />
                          </button>
                        </span>
                      )}
                  </div>
                )
            ))}
          </div>
        )}
        {editor === null
          ? (
            <button
              type="button"
              className={css.priceAdd}
              disabled={saving}
              onClick={() => { setConfirmKey(null); setEditor({ key: '', rule: {}, prevKey: null }) }}
            >+ Add price rule</button>
          )
          : editor.prevKey === null && (
            <div className={css.priceEditorCard}>
              {editorCard('Add rule')}
            </div>
          )}
      </div>
    </div>
  )
}
