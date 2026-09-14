/**
 * Trajectory data contract. The snapshot shape lives in `@harness-trajectory/core`
 * so adapters and the server share it; this module keeps the local import path
 * the ported view code expects.
 */
export type { TrajectorySnapshot } from '@harness-trajectory/core'
export { EMPTY_TRAJECTORY_SNAPSHOT } from '@harness-trajectory/core'
