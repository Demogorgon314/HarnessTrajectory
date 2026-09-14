/**
 * Per-user display preferences of the Context dashboard.
 *
 * dsh-context bound a Host-served settings namespace; this viewer has no
 * settings service, so the same `ContextSettings` face is backed by
 * `localStorage` under one key. The observable-store shape, the preference
 * vocabulary, and the optimistic `set` echo are unchanged, so the settings
 * rows and the cards that read the defaults at mount are untouched.
 *
 * `defaultPlacement` is gone with the right-Sidebar placement (this port has
 * a single Context tab); every other field survives.
 *
 * Vendored from dsh-context (Apache-2.0, see ../../NOTICE).
 */

import type { DefaultFileSort, DefaultGranularity, DefaultToolSort, DefaultTrendMode } from '../shared/types'

export type { DefaultFileSort, DefaultGranularity, DefaultToolSort, DefaultTrendMode } from '../shared/types'

/** The fields this port's settings popover edits (placement dropped). */
export type SettingsField = 'defaultGranularity' | 'defaultTrendMode' | 'defaultToolSort' | 'defaultFileSort'

/** The storage key of the persisted preference record. */
export const SETTINGS_KEY = 'harness-trajectory.context.settings'

/** The preference snapshot the rows render and the view reads at mount. */
export interface SettingsState {
  /** Kept from dsh-context so the rows' disabled/unavailable arms stay identical; localStorage is always ready. */
  status: 'loading' | 'ready' | 'unavailable'
  granularity: DefaultGranularity
  mode: DefaultTrendMode
  toolSort: DefaultToolSort
  fileSort: DefaultFileSort
  writable: boolean
}

export interface ContextSettings {
  /** Observable snapshot store (useSyncExternalStore-shaped). */
  store: { subscribe(listener: () => void): () => void; getSnapshot(): SettingsState }
  defaultGranularity(): DefaultGranularity
  defaultTrendMode(): DefaultTrendMode
  defaultToolSort(): DefaultToolSort
  defaultFileSort(): DefaultFileSort
  /** Persist one preference choice. */
  set(field: SettingsField, value: string): void
}

type Prefs = {
  granularity?: DefaultGranularity
  mode?: DefaultTrendMode
  toolSort?: DefaultToolSort
  fileSort?: DefaultFileSort
}

function prefsOf(value: unknown): Prefs {
  if (value === null || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  return {
    ...(v.defaultGranularity === 'step' || v.defaultGranularity === 'turn' ? { granularity: v.defaultGranularity } : {}),
    ...(v.defaultTrendMode === 'total' || v.defaultTrendMode === 'delta' ? { mode: v.defaultTrendMode } : {}),
    ...(v.defaultToolSort === 'size' || v.defaultToolSort === 'count' || v.defaultToolSort === 'name' ? { toolSort: v.defaultToolSort } : {}),
    ...(v.defaultFileSort === 'count' || v.defaultFileSort === 'latest' || v.defaultFileSort === 'path' ? { fileSort: v.defaultFileSort } : {}),
  }
}

/** The persisted record, or `{}` for absent/corrupt/blocked storage (private windows throw on read). */
function readStore(key: string): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (typeof raw !== 'string' || raw === '') return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    // Unavailable or hostile storage: the defaults stand, never an error.
    return {}
  }
}

function writeStore(key: string, record: Record<string, string>): boolean {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(record))
    return true
  } catch {
    // Quota, private mode, or a host that blocks storage: the in-memory echo
    // still holds for this page load.
    return false
  }
}

/**
 * Build the settings face over localStorage.
 * @param key - storage key; override in tests for isolation.
 */
export function createContextSettings(key: string = SETTINGS_KEY): ContextSettings {
  const stored = prefsOf(readStore(key))
  let raw: Record<string, string> = {}
  const initial = readStore(key)
  for (const field of ['defaultGranularity', 'defaultTrendMode', 'defaultToolSort', 'defaultFileSort'] as const) {
    const v = initial[field]
    if (typeof v === 'string') raw[field] = v
  }
  let state: SettingsState = {
    status: 'ready',
    granularity: stored.granularity ?? 'step',
    mode: stored.mode ?? 'total',
    toolSort: stored.toolSort ?? 'count',
    fileSort: stored.fileSort ?? 'count',
    writable: true,
  }
  const listeners = new Set<() => void>()
  const publish = (next: SettingsState): void => {
    if (next.status === state.status && next.granularity === state.granularity
      && next.mode === state.mode && next.toolSort === state.toolSort && next.fileSort === state.fileSort
      && next.writable === state.writable) return
    state = next
    for (const listener of listeners) listener()
  }
  return {
    store: {
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => state,
    },
    defaultGranularity: () => state.granularity,
    defaultTrendMode: () => state.mode,
    defaultToolSort: () => state.toolSort,
    defaultFileSort: () => state.fileSort,
    set(field, value) {
      const prefs = prefsOf({ [field]: value })
      // An unreadable value never reaches storage — the rows only ever offer
      // the vocabulary above, so this guards drift, not the UI.
      if (Object.keys(prefs).length === 0) return
      raw = { ...raw, [field]: value }
      // A blocked store (private window, quota) still keeps the in-memory
      // echo for this page load, so the rows stay writable either way.
      writeStore(key, raw)
      publish({ ...state, ...prefs })
    },
  }
}
