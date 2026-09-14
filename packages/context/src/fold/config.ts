/**
 * Vendored from dsh-context `src/host/config.ts` (Apache-2.0, see ../../NOTICE),
 * with the zod/cordis schema replaced by a hand-rolled strict validator (this
 * package carries no validator dependency).
 *
 * Retention bounds for the fold. They tune the fold's retention /
 * presentation slice only — the state SHAPE is independent of them, so
 * changing a bound never changes what the fold means.
 *
 * The defaults are deliberately far larger than dsh's: dsh trimmed for wire
 * size (every push frame carried the whole value), while this viewer folds a
 * transcript locally and wants the WHOLE session listable.
 */

export interface Config {
  /** Cap on kept per-step request records (the hard step backstop). */
  maxRequestSteps?: number
  /** Newest whole-turn window kept; trimming crosses whole turns, never mid-turn. */
  maxKeptTurns?: number
  maxEvents?: number
  /**
   * Served surface nodes (newest carry the signal; live inject/skill nodes
   * are pinned — they land first and are few). A pathological-session
   * backstop, not a display budget.
   */
  maxNodes?: number
  /** Removed (shadowed) surface nodes kept for per-step reconstruction. */
  maxArchiveNodes?: number
  /** Fold-derived file-operation records kept (the File Activity card's raw material). */
  maxFileOps?: number
}

export const DEFAULT_BOUNDS: Required<Config> = {
  maxRequestSteps: 5000,
  maxKeptTurns: 2000,
  maxEvents: 2000,
  maxNodes: 20000,
  maxArchiveNodes: 5000,
  maxFileOps: 5000,
}

export type FoldBounds = Required<Config>

const BOUND_KEYS = [
  'maxRequestSteps',
  'maxKeptTurns',
  'maxEvents',
  'maxNodes',
  'maxArchiveNodes',
  'maxFileOps',
] as const satisfies readonly (keyof Config)[]

/**
 * Resolve a partial bounds object against the defaults. Strict on keys and
 * values (the same contract dsh's zod schema enforced): an unknown key or a
 * non-integer / below-1 / non-number bound throws instead of silently
 * folding with a nonsense retention window. `undefined` / `{}` resolve to the
 * defaults.
 */
export function resolveBounds(config?: Config | null): FoldBounds {
  if (config === undefined || config === null) return { ...DEFAULT_BOUNDS }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('fold bounds: expected an object')
  }
  const input = config as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!(BOUND_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`fold bounds: unknown key ${JSON.stringify(key)}`)
    }
  }
  const resolved: FoldBounds = { ...DEFAULT_BOUNDS }
  for (const key of BOUND_KEYS) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new RangeError(`fold bounds: ${key} must be an integer >= 1`)
    }
    resolved[key] = value
  }
  return resolved
}
