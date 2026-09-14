/** Persisted sidebar geometry and fold state, with the dsh AppFrame clamps. */

import { createSnapshotStore, type SnapshotStore } from '@harness-trajectory/ui'

/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Rail width while collapsed. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail. */
export const SIDEBAR_AUTO_COLLAPSE = 1024

export function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)))
}

export interface SidebarState {
  /** Preferred expanded width in px. */
  width: number
  /** User-chosen collapse on wide viewports. */
  collapsed: boolean
  /** Project group keys (cwd) the user folded. */
  foldedGroups: readonly string[]
}

const DEFAULT_STATE: SidebarState = { width: SIDEBAR_DEFAULT, collapsed: false, foldedGroups: [] }

function sanitize(state: SidebarState): SidebarState {
  return {
    width: clampSidebarWidth(Number.isFinite(state.width) ? state.width : SIDEBAR_DEFAULT),
    collapsed: state.collapsed === true,
    foldedGroups: Array.isArray(state.foldedGroups) ? state.foldedGroups.filter(key => typeof key === 'string') : [],
  }
}

export const sidebarStore: SnapshotStore<SidebarState> = (() => {
  const store = createSnapshotStore<SidebarState>(DEFAULT_STATE, { persist: { name: 'harness-trajectory.sidebar' } })
  store.set(sanitize({ ...DEFAULT_STATE, ...store.getSnapshot() }))
  return store
})()

export function setSidebarWidth(width: number): void {
  sidebarStore.update(state => ({ ...state, width: clampSidebarWidth(width) }))
}

export function setSidebarCollapsed(collapsed: boolean): void {
  sidebarStore.update(state => ({ ...state, collapsed }))
}

export function toggleGroupFold(key: string): void {
  sidebarStore.update((state) => {
    const folded = new Set(state.foldedGroups)
    if (folded.has(key)) folded.delete(key)
    else folded.add(key)
    return { ...state, foldedGroups: [...folded] }
  })
}
