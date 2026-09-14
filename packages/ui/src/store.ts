/**
 * Minimal observable snapshot store, replacing `@deepseek-ai/dsh-client-store`
 * for the handful of stores the trajectory view keeps.
 */
import { useSyncExternalStore } from 'react'

export interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  set(next: T): void
  update(mutator: (current: T) => T): void
}

/** Typed selector hook over a snapshot source. */
export type SnapshotSelectorHook<T> = <S>(select: (state: T) => S, equal?: (a: S, b: S) => boolean) => S

export function createSnapshotStore<T>(
  initial: T,
  options?: { persist?: { name: string } },
): SnapshotStore<T> {
  let state = initial
  const persistName = options?.persist?.name
  if (persistName !== undefined) {
    try {
      const stored = globalThis.localStorage?.getItem(persistName)
      if (stored !== null && stored !== undefined) state = JSON.parse(stored) as T
    } catch {
      // Storage may be unavailable (private mode, SSR, tests); keep the default.
    }
  }
  const listeners = new Set<() => void>()
  const store: SnapshotStore<T> = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      if (Object.is(next, state)) return
      state = next
      if (persistName !== undefined) {
        try {
          globalThis.localStorage?.setItem(persistName, JSON.stringify(next))
        } catch {
          // Ignore storage failures; the in-memory state still updates.
        }
      }
      for (const listener of listeners) listener()
    },
    update: (mutator) => { store.set(mutator(state)) },
  }
  return store
}

/**
 * React hook that selects from an observable snapshot. Re-renders only when
 * the selected value changes under the supplied equality (default `Object.is`).
 */
export function useSnapshotSelector<T, S>(
  source: ObservableSnapshot<T>,
  select: (state: T) => S,
  equal: (a: S, b: S) => boolean = Object.is,
): S {
  // Cache the last selection so an unchanged selection keeps its reference,
  // as useSyncExternalStore requires a stable getSnapshot result.
  let last: { input: T; output: S } | undefined
  const getSelected = () => {
    const input = source.getSnapshot()
    if (last !== undefined && Object.is(last.input, input)) return last.output
    const output = select(input)
    if (last !== undefined && equal(last.output, output)) {
      last = { input, output: last.output }
      return last.output
    }
    last = { input, output }
    return output
  }
  return useSyncExternalStore(source.subscribe, getSelected, getSelected)
}

/** Bind a selector hook to one source, matching the dsh `use<Name>` prop shape. */
export function selectorHook<T>(source: ObservableSnapshot<T>): SnapshotSelectorHook<T> {
  return (select, equal) => useSnapshotSelector(source, select, equal)
}
