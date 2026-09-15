/**
 * Server settings mirror: the dialog renders only what the server answered,
 * never its own echo of a keystroke — `settings.json` is the source of truth.
 */

import { createSnapshotStore, type SnapshotStore } from '@harness-trajectory/ui'
import type { ServerSettings, SettingsResponse } from '@harness-trajectory/core'
import { fetchSettings, putSettings } from './api.ts'

export interface SettingsState {
  /** The server's answer; null until the first load lands. */
  current: SettingsResponse | null
  /** A save is in flight; the dialog disables its input. */
  saving: boolean
  /** Files the last save dropped from the index (retention narrowed). */
  purged: number | null
  error: string | null
}

const INITIAL: SettingsState = { current: null, saving: false, purged: null, error: null }

export const settingsStore: SnapshotStore<SettingsState> = createSnapshotStore<SettingsState>(INITIAL)

/** Pull the persisted value; called each time the dialog opens. */
export async function loadSettings(): Promise<void> {
  try {
    const current = await fetchSettings()
    settingsStore.update(state => ({ ...state, current, error: null }))
  } catch (error) {
    settingsStore.update(state => ({ ...state, error: error instanceof Error ? error.message : String(error) }))
  }
}

/** Persist a change to one or more fields; the store adopts exactly what the server answers. */
export async function saveSettings(value: Partial<ServerSettings>): Promise<void> {
  settingsStore.update(state => ({ ...state, saving: true, error: null }))
  try {
    const answered = await putSettings(value)
    settingsStore.update(state => ({ ...state, current: answered, purged: answered.purged, saving: false }))
  } catch (error) {
    settingsStore.update(state => ({
      ...state,
      saving: false,
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}
