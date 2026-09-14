import { createSnapshotStore, type SnapshotStore } from '../store.ts'

/**
 * Create the browser-wide trajectory duration preference source.
 * @returns a persisted source shared by every session view.
 */
export function createTrajectoryDurationStore(): SnapshotStore<boolean> {
  return createSnapshotStore(false, {
    persist: { name: 'harness-trajectory.duration' },
  })
}
