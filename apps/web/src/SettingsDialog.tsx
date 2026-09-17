/**
 * Settings: the sidebar gear opens a centred panel in the deepseek-harness
 * shape — a left nav rail of sections beside a scrollable content column.
 * Everything rendered here comes from the settings store, which mirrors the
 * server's persisted value.
 */

import { useEffect, useRef, useState } from 'react'
import { SEARCH_MAX_AGE_DAYS_MAX, SEARCH_MAX_AGE_DAYS_MIN, type ModelPriceRules } from '@harness-trajectory/core'
import { icons, useSnapshotSelector } from '@harness-trajectory/ui'
import { ModelPricing } from './ModelPricing.tsx'
import { loadSettings, saveSettings, settingsStore } from './settings-store.ts'
import css from './settings.module.css'

const { IconDataOutline16, IconSettingsOutline16 } = icons

const SECTIONS = [
  { id: 'general', label: 'General', Icon: IconSettingsOutline16 },
  { id: 'pricing', label: 'Model pricing', Icon: IconDataOutline16 },
] as const
type SectionId = (typeof SECTIONS)[number]['id']

export interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const state = useSnapshotSelector(settingsStore, value => value)
  const [draft, setDraft] = useState('')
  const [section, setSection] = useState<SectionId>('general')
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const days = state.current?.searchMaxAgeDays

  useEffect(() => {
    if (!open) return
    void loadSettings()
    setSection('general')
    closeRef.current?.focus()
  }, [open])

  // The draft follows the persisted value, including a save that lands while
  // the dialog is open or an external edit of settings.json.
  useEffect(() => {
    setDraft(days === undefined ? '' : String(days))
  }, [days])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  if (!open) return null

  const current = state.current
  const toggle = current?.contentSearch ?? false
  const live = current?.searchEnabled ?? false
  const active = SECTIONS.find(entry => entry.id === section) ?? SECTIONS[0]

  const commit = () => {
    const next = Number(draft)
    const valid = Number.isInteger(next)
      && next >= SEARCH_MAX_AGE_DAYS_MIN && next <= SEARCH_MAX_AGE_DAYS_MAX
      && String(next) === draft.trim()
    if (!valid || days === undefined || next === days) {
      setDraft(days === undefined ? '' : String(days))
      return
    }
    void saveSettings({ searchMaxAgeDays: next })
  }

  return (
    <div className={css.overlay}>
      <button type="button" className={css.mask} aria-label="Close settings" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-label="Settings">
        <nav className={css.nav}>
          <div className={css.navTitle}>Settings</div>
          <div className={css.navList}>
            {SECTIONS.map(entry => (
              <button
                key={entry.id}
                type="button"
                className={css.navCell}
                data-active={entry.id === active.id || undefined}
                onClick={() => { setSection(entry.id) }}
              >
                <entry.Icon size={15} className={css.navIcon} />
                <span className={css.navLabel}>{entry.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.contentHeader}>
            <span className={css.title}>{active.label}</span>
            <button ref={closeRef} type="button" className={css.close} aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className={css.options}>
            {section === 'general' && (
              <>
                <div className={css.row}>
                  <span className={css.rowText}>
                    <span className={css.rowLabel}>Content search</span>
                    <span className={css.rowHint}>
                      Index transcript contents into one SQLite file under the cache directory for full-text
                      search. Turning this off keeps the file; indexing just stops.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    className={css.toggle}
                    checked={toggle}
                    disabled={state.saving || current === null}
                    aria-label="Content search"
                    onChange={() => { void saveSettings({ contentSearch: !toggle }) }}
                  />
                </div>
                {toggle !== live && (
                  <p className={css.note}>
                    {toggle
                      ? 'Saved, but the search index could not be opened — see the server log. The setting stays on; the next launch retries.'
                      : 'Search is forced on for this launch (HARNESS_TRAJECTORY_SEARCH=1); the persisted setting stays off.'}
                  </p>
                )}
                <div className={css.row}>
                  <span className={css.rowText}>
                    <span className={css.rowLabel}>Index retention (days)</span>
                    <span className={css.rowHint}>
                      Transcripts not modified within this many days stay out of the search index; they remain
                      browsable. 0 indexes everything. Widening the window re-indexes older sessions on the
                      next start.
                    </span>
                  </span>
                  <input
                    type="number"
                    className={css.number}
                    min={SEARCH_MAX_AGE_DAYS_MIN}
                    max={SEARCH_MAX_AGE_DAYS_MAX}
                    step={1}
                    value={draft}
                    disabled={state.saving || state.current === null}
                    aria-label="Index retention days"
                    onChange={(event) => { setDraft(event.currentTarget.value) }}
                    onBlur={commit}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                  />
                </div>
                {state.purged !== null && state.purged > 0 && (
                  <p className={css.note}>Dropped {state.purged} older transcript files from the index.</p>
                )}
              </>
            )}
            {section === 'pricing' && (
              <ModelPricing
                rules={current?.modelPricing ?? {}}
                saving={state.saving || current === null}
                onSave={(rules: ModelPriceRules) => { void saveSettings({ modelPricing: rules }) }}
              />
            )}
            {state.error !== null && <p className={css.error}>{state.error}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
