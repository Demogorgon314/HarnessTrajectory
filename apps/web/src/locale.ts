import { createSnapshotStore, type SnapshotStore, type TrajectoryLocale } from '@harness-trajectory/ui'

/** Restore the chosen language, falling back to the browser language on first use. */
export function createLocaleStore(): SnapshotStore<TrajectoryLocale> {
  const fallback = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const store = createSnapshotStore<TrajectoryLocale>(fallback, {
    persist: { name: 'harness-trajectory.locale' },
  })
  const stored = store.getSnapshot()
  if (stored !== 'en' && stored !== 'zh') store.set(fallback)
  return store
}
