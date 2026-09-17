import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SETTINGS_DEFAULTS, type ServerSettings } from '@harness-trajectory/core'
import { SettingsController, readSettings, settingsPath, writeSettings } from '../src/settings.ts'
import type { SearchIndexer } from '../src/search/indexer.ts'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-settings-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('settings file', () => {
  it('lives in the cache directory beside the search index', () => {
    expect(settingsPath({ HARNESS_TRAJECTORY_CACHE_DIR: join('/tmp', 'ht') }))
      .toBe(join('/tmp', 'ht', 'settings.json'))
  })

  it('answers the defaults when the file is missing, corrupt, or holds junk values', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    expect(readSettings(path)).toEqual(SETTINGS_DEFAULTS)

    await writeFile(path, '{ not json')
    expect(readSettings(path)).toEqual(SETTINGS_DEFAULTS)

    await writeFile(path, JSON.stringify({ searchMaxAgeDays: -5 }))
    expect(readSettings(path)).toEqual(SETTINGS_DEFAULTS)
    await writeFile(path, JSON.stringify({ searchMaxAgeDays: '90' }))
    expect(readSettings(path)).toEqual(SETTINGS_DEFAULTS)
    await writeFile(path, JSON.stringify({ searchMaxAgeDays: 30.5 }))
    expect(readSettings(path)).toEqual(SETTINGS_DEFAULTS)
  })

  it('round-trips a written value, including 0 for no limit', async () => {
    const dir = await tempDir()
    const path = join(dir, 'nested', 'settings.json')
    writeSettings({ contentSearch: false, searchMaxAgeDays: 30 }, path)
    expect(readSettings(path)).toEqual({ contentSearch: false, searchMaxAgeDays: 30 })
    writeSettings({ contentSearch: true, searchMaxAgeDays: 0 }, path)
    expect(readSettings(path)).toEqual({ contentSearch: true, searchMaxAgeDays: 0 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ contentSearch: true, searchMaxAgeDays: 0 })
  })

  it('clamps each field on its own: one junk field does not reset the other', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({ contentSearch: true, searchMaxAgeDays: '90' }))
    expect(readSettings(path)).toEqual({ contentSearch: true, searchMaxAgeDays: SETTINGS_DEFAULTS.searchMaxAgeDays })
    await writeFile(path, JSON.stringify({ contentSearch: 'yes', searchMaxAgeDays: 30 }))
    expect(readSettings(path)).toEqual({ contentSearch: false, searchMaxAgeDays: 30 })
  })

  it('round-trips price rules and drops hand-edited junk inside them', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    writeSettings({
      contentSearch: false,
      searchMaxAgeDays: 90,
      modelPricing: {
        'cognition/swe-2-max': {
          rates: { input: 1.5, output: 6 },
          offPeak: { peakHours: [[9, 12], [14, 18]], timezone: 'Asia/Shanghai', weekdaysOnly: true, factor: 0.5 },
        },
      },
    }, path)
    expect(readSettings(path).modelPricing?.['cognition/swe-2-max']?.offPeak?.factor).toBe(0.5)

    await writeFile(path, JSON.stringify({
      modelPricing: { '/bad-key': { rates: { input: 1, output: 1 } }, ok: { rates: { input: 1, output: 2 } } },
    }))
    expect(readSettings(path).modelPricing).toEqual({ ok: { rates: { input: 1, output: 2 } } })
  })
})

describe('SettingsController', () => {
  /** An indexer double that records what the controller applied. */
  function fakeIndexer(): { indexer: SearchIndexer; applied: number[] } {
    const applied: number[] = []
    const indexer = {
      applyMaxAgeDays: (days: number) => {
        applied.push(days)
        return days === 30 ? 7 : 0
      },
    } as unknown as SearchIndexer
    return { indexer, applied }
  }

  it('persists a new value and applies it to the indexer', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    const { indexer, applied } = fakeIndexer()
    const controller = new SettingsController(path, () => indexer)

    const update = controller.update({ searchMaxAgeDays: 30 })
    expect(update).toEqual({ value: { contentSearch: false, searchMaxAgeDays: 30 }, purged: 7 })
    expect(applied).toEqual([30])
    expect(readSettings(path)).toEqual({ contentSearch: false, searchMaxAgeDays: 30 })
    expect(controller.read()).toEqual({ contentSearch: false, searchMaxAgeDays: 30 })
  })

  it('merges a partial update over the stored value instead of resetting the other field', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    const controller = new SettingsController(path, () => undefined)

    controller.update({ searchMaxAgeDays: 30 })
    const update = controller.update({ contentSearch: true })
    expect(update.value).toEqual({ contentSearch: true, searchMaxAgeDays: 30 })
    expect(readSettings(path)).toEqual({ contentSearch: true, searchMaxAgeDays: 30 })
    // …and back, still keeping the retention window.
    expect(controller.update({ contentSearch: false }).value).toEqual({ contentSearch: false, searchMaxAgeDays: 30 })
  })

  it('clamps a hostile value to the defaults before it touches disk or the indexer', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    const { indexer, applied } = fakeIndexer()
    const controller = new SettingsController(path, () => indexer)

    const update = controller.update({ searchMaxAgeDays: 999_999 })
    expect(update.value).toEqual(SETTINGS_DEFAULTS)
    expect(applied).toEqual([SETTINGS_DEFAULTS.searchMaxAgeDays])
    expect(readSettings(path)).toEqual(SETTINGS_DEFAULTS)
  })

  it('still persists when there is no indexer (search off); nothing purges', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    const controller = new SettingsController(path, () => undefined)
    const update = controller.update({ searchMaxAgeDays: 14 })
    expect(update).toEqual({ value: { contentSearch: false, searchMaxAgeDays: 14 }, purged: 0 })
    expect(readSettings(path)).toEqual({ contentSearch: false, searchMaxAgeDays: 14 })
  })

  it('a modelPricing update replaces the table wholesale and keeps the other fields', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    const controller = new SettingsController(path, () => undefined)

    controller.update({ contentSearch: true, modelPricing: { 'a/b': { rates: { input: 1, output: 1 } } } })
    // A rules-only PUT keeps the toggle; an empty table clears the field.
    const update = controller.update({ modelPricing: {} })
    expect(update.value).toEqual({ contentSearch: true, searchMaxAgeDays: 90 })
    expect(readSettings(path).modelPricing).toBeUndefined()
  })

  it('announces every persisted value through onChange, after retention applied', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    const { indexer, applied } = fakeIndexer()
    const seen: ServerSettings[] = []
    const controller = new SettingsController(path, () => indexer, value => { seen.push(value) })

    controller.update({ contentSearch: true })
    controller.update({ searchMaxAgeDays: 30 })
    expect(seen).toEqual([
      { contentSearch: true, searchMaxAgeDays: SETTINGS_DEFAULTS.searchMaxAgeDays },
      { contentSearch: true, searchMaxAgeDays: 30 },
    ])
    expect(applied).toEqual([SETTINGS_DEFAULTS.searchMaxAgeDays, 30])
  })
})
