/**
 * Server settings: one JSON file under the cache directory, next to
 * `search.sqlite` — the only two files this process ever writes, and both
 * live outside the harness roots, which stay read-only.
 *
 * The file is the source of truth; the web dialog mirrors it through
 * `/api/settings` and always renders the persisted value, never its own
 * echo of a click.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { clampSettings, SETTINGS_DEFAULTS, type ServerSettings } from '@harness-trajectory/core'
import { cacheDir } from './cache.ts'
import type { SearchIndexer } from './search/indexer.ts'

/** The settings file, beside the search index. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), 'settings.json')
}

/** Settings on disk, or the defaults when the file is missing or unreadable. */
export function readSettings(path: string = settingsPath()): ServerSettings {
  try {
    return clampSettings(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return { ...SETTINGS_DEFAULTS }
  }
}

/** Persist atomically: a crash mid-write must not leave a torn JSON file. */
export function writeSettings(value: ServerSettings, path: string = settingsPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

/** What a settings change did: the value now in effect and its side effects. */
export interface SettingsUpdate {
  value: ServerSettings
  /** Transcript files dropped from the index as the retention window narrowed. */
  purged: number
}

/**
 * The live face of `settings.json`: reads and writes the file and pushes
 * changes into the search indexer. The indexer is read through a getter
 * because the Content search toggle creates and tears it down at runtime;
 * `onChange` is what performs that dance (main.ts wires it). Without an
 * indexer values still persist; they apply the next time search runs.
 */
export class SettingsController {
  constructor(
    private readonly path: string,
    private readonly indexer: () => SearchIndexer | undefined,
    private readonly onChange?: (value: ServerSettings) => void,
  ) {}

  read(): ServerSettings {
    return readSettings(this.path)
  }

  /**
   * Persist a (possibly partial) change: the body is merged over the stored
   * value, so a client that only sends the field it edited cannot reset the
   * other one to its default.
   */
  update(input: unknown): SettingsUpdate {
    const current = readSettings(this.path)
    const value = clampSettings(typeof input === 'object' && input !== null ? { ...current, ...input } : current)
    writeSettings(value, this.path)
    // Retention applies to whatever indexer is live right now; the toggle
    // itself is then announced so search can start or stop without a restart.
    const purged = this.indexer()?.applyMaxAgeDays(value.searchMaxAgeDays) ?? 0
    this.onChange?.(value)
    return { value, purged }
  }
}
