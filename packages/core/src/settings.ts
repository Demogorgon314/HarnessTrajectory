/**
 * Server settings: the contract between the `settings.json` the server
 * persists under its cache directory (`apps/server/src/settings.ts`), the
 * `/api/settings` route, and the settings dialog in the web UI.
 */

export interface ServerSettings {
  /**
   * Transcript files not modified within this many days are left out of the
   * search index. They stay browsable; they just do not answer searches.
   * `0` indexes everything.
   */
  searchMaxAgeDays: number
}

export const SETTINGS_DEFAULTS: ServerSettings = {
  searchMaxAgeDays: 90,
}

/** Valid range for {@link ServerSettings.searchMaxAgeDays}; `0` means no limit. */
export const SEARCH_MAX_AGE_DAYS_MIN = 0
export const SEARCH_MAX_AGE_DAYS_MAX = 3650

/** What `GET /api/settings` answers. */
export interface SettingsResponse extends ServerSettings {
  /** False when the server runs without the search index. */
  searchEnabled: boolean
}

/** What `PUT /api/settings` answers: the value in effect and its side effects. */
export interface SettingsUpdateResponse extends SettingsResponse {
  /** Transcript files dropped from the index as the retention window narrowed. */
  purged: number
}

/**
 * Coerce anything — a hand-edited `settings.json`, a crafted PUT body — into a
 * valid value, falling back field by field to the defaults.
 */
export function clampSettings(input: unknown): ServerSettings {
  const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  const days = record['searchMaxAgeDays']
  if (typeof days === 'number' && Number.isInteger(days)
    && days >= SEARCH_MAX_AGE_DAYS_MIN && days <= SEARCH_MAX_AGE_DAYS_MAX) {
    return { searchMaxAgeDays: days }
  }
  return { ...SETTINGS_DEFAULTS }
}
