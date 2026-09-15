/**
 * Where the server keeps its own derived state. Harness roots stay read-only:
 * the only file this process ever writes is the search index, and it lives here.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Cache directory: `HARNESS_TRAJECTORY_CACHE_DIR`, else
 * `$XDG_CACHE_HOME/harness-trajectory`, else `~/.cache/harness-trajectory`.
 */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['HARNESS_TRAJECTORY_CACHE_DIR']
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const xdg = env['XDG_CACHE_HOME']
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.cache') : xdg
  return resolve(join(base, 'harness-trajectory'))
}

/** The SQLite file backing full-text search. */
export function searchDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), 'search.sqlite')
}

/** Env override that forces indexing on for one launch (`1`/`true`/`on`); the Settings toggle decides otherwise. */
export function searchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['HARNESS_TRAJECTORY_SEARCH']
  return value === '1' || value === 'true' || value === 'on'
}
