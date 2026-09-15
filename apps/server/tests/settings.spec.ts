import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SETTINGS_DEFAULTS } from '@harness-trajectory/core'
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
    writeSettings({ searchMaxAgeDays: 30 }, path)
    expect(readSettings(path)).toEqual({ searchMaxAgeDays: 30 })
    writeSettings({ searchMaxAgeDays: 0 }, path)
    expect(readSettings(path)).toEqual({ searchMaxAgeDays: 0 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ searchMaxAgeDays: 0 })
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
    const controller = new SettingsController(path, indexer)

    const update = controller.update({ searchMaxAgeDays: 30 })
    expect(update).toEqual({ value: { searchMaxAgeDays: 30 }, purged: 7 })
    expect(applied).toEqual([30])
    expect(readSettings(path)).toEqual({ searchMaxAgeDays: 30 })
    expect(controller.read()).toEqual({ searchMaxAgeDays: 30 })
  })

  it('clamps a hostile value to the defaults before it touches disk or the indexer', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    const { indexer, applied } = fakeIndexer()
    const controller = new SettingsController(path, indexer)

    const update = controller.update({ searchMaxAgeDays: 999_999 })
    expect(update.value).toEqual(SETTINGS_DEFAULTS)
    expect(applied).toEqual([SETTINGS_DEFAULTS.searchMaxAgeDays])
    expect(readSettings(path)).toEqual(SETTINGS_DEFAULTS)
  })

  it('still persists when there is no indexer (search off); nothing purges', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    const controller = new SettingsController(path, undefined)
    const update = controller.update({ searchMaxAgeDays: 14 })
    expect(update).toEqual({ value: { searchMaxAgeDays: 14 }, purged: 0 })
    expect(readSettings(path)).toEqual({ searchMaxAgeDays: 14 })
  })
})
