/** Shared transcript-role classification for the per-harness path classifiers. */

export interface Classified {
  /**
   * Pre-meta identity. Codex: the rollout id (last filename UUID), the value
   * `history_base` references. Other harnesses: the path-derived session/file id.
   */
  id: string
  role: 'main' | 'child'
  parentId?: string
  /** Codex only: rollout id and filename thread id (the first UUID). */
  rolloutId?: string
  threadUuid?: string
}
