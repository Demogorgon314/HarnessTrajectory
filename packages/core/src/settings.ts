/**
 * Server settings: the contract between the `settings.json` the server
 * persists under its cache directory (`apps/server/src/settings.ts`), the
 * `/api/settings` route, and the settings dialog in the web UI.
 */

export interface ServerSettings {
  /**
   * Index transcript contents for full-text search. Takes effect on the next
   * start: enabling builds the index then, disabling stops indexing and keeps
   * the file on disk. `HARNESS_TRAJECTORY_SEARCH=1` forces this on.
   */
  contentSearch: boolean
  /**
   * Transcript files not modified within this many days are left out of the
   * search index. They stay browsable; they just do not answer searches.
   * `0` indexes everything.
   */
  searchMaxAgeDays: number
}

export const SETTINGS_DEFAULTS: ServerSettings = {
  contentSearch: false,
  searchMaxAgeDays: 90,
}

/** Valid range for {@link ServerSettings.searchMaxAgeDays}; `0` means no limit. */
export const SEARCH_MAX_AGE_DAYS_MIN = 0
export const SEARCH_MAX_AGE_DAYS_MAX = 3650

/** What `GET /api/settings` answers. */
export interface SettingsResponse extends ServerSettings {
  /** False when this server runs without the index — regardless of the stored toggle. */
  searchEnabled: boolean
}

/** What `PUT /api/settings` answers: the value in effect and its side effects. */
export interface SettingsUpdateResponse extends SettingsResponse {
  /** Transcript files dropped from the index as the retention window narrowed. */
  purged: number
}

/**
 * Coerce anything — a hand-edited `settings.json`, a crafted PUT body — into a
 * valid value. Each field falls back to its default on its own, so one junk
 * field does not reset the other.
 */
export function clampSettings(input: unknown): ServerSettings {
  const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  const toggle = record['contentSearch']
  const days = record['searchMaxAgeDays']
  return {
    contentSearch: typeof toggle === 'boolean' ? toggle : SETTINGS_DEFAULTS.contentSearch,
    searchMaxAgeDays: typeof days === 'number' && Number.isInteger(days)
      && days >= SEARCH_MAX_AGE_DAYS_MIN && days <= SEARCH_MAX_AGE_DAYS_MAX
      ? days
      : SETTINGS_DEFAULTS.searchMaxAgeDays,
  }
}
