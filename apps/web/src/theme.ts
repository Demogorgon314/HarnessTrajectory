/** Light/dark preference, applied the way the dsh theme boot script does (`data-ds-dark-theme` on body). */

import { createSnapshotStore, type SnapshotStore } from '@harness-trajectory/ui'

export type ThemePreference = 'light' | 'dark' | 'system'

export const themeStore: SnapshotStore<ThemePreference> = createSnapshotStore<ThemePreference>('system', {
  persist: { name: 'harness-trajectory.theme' },
})

function systemDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyTheme(preference: ThemePreference): void {
  const dark = preference === 'dark' || (preference === 'system' && systemDark())
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
}

/** Apply the stored preference now and keep the document in sync with changes. */
export function bootTheme(): void {
  applyTheme(themeStore.getSnapshot())
  themeStore.subscribe(() => { applyTheme(themeStore.getSnapshot()) })
  if (typeof matchMedia !== 'undefined') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyTheme(themeStore.getSnapshot())
    })
  }
}
