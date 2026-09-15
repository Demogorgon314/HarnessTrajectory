/**
 * Settings dialog: sidebar gear → centred panel, the deepseek-harness
 * SettingsRoot shape (overlay, dialog, "label + description | control" rows)
 * reduced to the one section this app has. Everything rendered here comes
 * from the settings store, which mirrors the server's persisted value.
 */

import { useEffect, useRef, useState } from 'react'
import { SEARCH_MAX_AGE_DAYS_MAX, SEARCH_MAX_AGE_DAYS_MIN } from '@harness-trajectory/core'
import { useSnapshotSelector } from '@harness-trajectory/ui'
import { loadSettings, saveSettings, settingsStore } from './settings-store.ts'
import css from './settings.module.css'

export interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const state = useSnapshotSelector(settingsStore, value => value)
  const [draft, setDraft] = useState('')
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const days = state.current?.searchMaxAgeDays

  useEffect(() => {
    if (!open) return
    void loadSettings()
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
        <header className={css.header}>
          <span className={css.title}>Settings</span>
          <button ref={closeRef} type="button" className={css.close} aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className={css.body}>
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
          {state.current !== null && !state.current.searchEnabled && (
            <p className={css.note}>
              Search is off on this server (start it with HARNESS_TRAJECTORY_SEARCH=1). The value is
              still saved and applies when search is on.
            </p>
          )}
          {state.purged !== null && state.purged > 0 && (
            <p className={css.note}>Dropped {state.purged} older transcript files from the index.</p>
          )}
          {state.error !== null && <p className={css.error}>{state.error}</p>}
        </div>
      </div>
    </div>
  )
}
