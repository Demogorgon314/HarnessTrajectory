/**
 * Persistent surface checkpoints share their prefix. Capturing one per prompt
 * or UUID costs O(1), rather than copying a growing conversation every time.
 * Only restoring or replacing a compacted surface walks its nodes.
 */
export interface SurfaceCheckpoint<T> {
  readonly value: T
  readonly previous: SurfaceCheckpoint<T> | null
}

export function appendSurface<T>(previous: SurfaceCheckpoint<T> | null, value: T): SurfaceCheckpoint<T> {
  return { previous, value }
}

export function surfaceValues<T>(checkpoint: SurfaceCheckpoint<T> | null): T[] {
  const values: T[] = []
  for (let node = checkpoint; node !== null; node = node.previous) values.push(node.value)
  return values.reverse()
}

export function checkpointSurface<T>(values: readonly T[]): SurfaceCheckpoint<T> | null {
  let checkpoint: SurfaceCheckpoint<T> | null = null
  for (const value of values) checkpoint = appendSurface(checkpoint, value)
  return checkpoint
}
