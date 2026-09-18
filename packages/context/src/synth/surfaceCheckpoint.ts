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

/**
 * Filter a family of checkpoints while preserving each historical endpoint.
 * Reuse this function for all roots in one removal: shared prefixes are visited
 * once, unchanged prefixes retain identity, and long histories need no recursion.
 */
export function createSurfaceFilter<T>(keep: (value: T) => boolean):
  (root: SurfaceCheckpoint<T> | null) => SurfaceCheckpoint<T> | null {
  const filtered = new Map<SurfaceCheckpoint<T>, SurfaceCheckpoint<T> | null>()
  return root => {
    const path: SurfaceCheckpoint<T>[] = []
    let cursor = root
    while (cursor !== null && !filtered.has(cursor)) {
      path.push(cursor)
      cursor = cursor.previous
    }
    let previous = cursor === null ? null : filtered.get(cursor) ?? null
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const node = path[index]
      if (node === undefined) continue
      if (keep(node.value)) previous = previous === node.previous ? node : { value: node.value, previous }
      filtered.set(node, previous)
    }
    return previous
  }
}
