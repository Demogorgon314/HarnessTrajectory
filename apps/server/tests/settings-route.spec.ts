import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTINGS_DEFAULTS, type SettingsResponse, type SettingsUpdateResponse } from '@harness-trajectory/core'
import { createApp } from '../src/app.ts'
import { SessionIndex } from '../src/index.ts'
import { createSearchService, type SearchService } from '../src/search/index.ts'
import { SettingsController, readSettings } from '../src/settings.ts'

describe('/api/settings', () => {
  let dir: string
  let index: SessionIndex
  let service: SearchService
  let controller: SettingsController
  let app: ReturnType<typeof createApp>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-settings-route-'))
    service = createSearchService({ path: ':memory:', flushDelayMs: 5 })
    controller = new SettingsController(join(dir, 'settings.json'), service.indexer)
    index = new SessionIndex({ roots: [], watch: false })
    await index.start()
    app = createApp({ index, search: service, settings: controller })
  })

  afterEach(async () => {
    index.stop()
    service.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('answers the defaults until something is persisted', async () => {
    const body = await (await app.request('/api/settings')).json() as SettingsResponse
    expect(body).toEqual({ ...SETTINGS_DEFAULTS, searchEnabled: true })
  })

  it('persists a PUT, applies it to the indexer, and reports the purge', async () => {
    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ searchMaxAgeDays: 30 }),
    })
    expect(put.status).toBe(200)
    const updated = await put.json() as SettingsUpdateResponse
    expect(updated).toMatchObject({ searchMaxAgeDays: 30, purged: 0, searchEnabled: true })
    expect(readSettings(join(dir, 'settings.json'))).toEqual({ searchMaxAgeDays: 30 })
    expect(service.indexer.shouldIndex({ mtimeMs: Date.now() - 10 * 86_400_000 })).toBe(true)
    expect(service.indexer.shouldIndex({ mtimeMs: Date.now() - 60 * 86_400_000 })).toBe(false)

    const body = await (await app.request('/api/settings')).json() as SettingsResponse
    expect(body).toEqual({ searchMaxAgeDays: 30, searchEnabled: true })
  })

  it('clamps a hostile value and rejects a body that is not JSON', async () => {
    const clamped = await (await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ searchMaxAgeDays: 'many' }),
    })).json() as SettingsUpdateResponse
    expect(clamped.searchMaxAgeDays).toBe(SETTINGS_DEFAULTS.searchMaxAgeDays)

    const response = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ nope',
    })
    expect(response.status).toBe(400)
  })

  it('still answers when the server runs without search', async () => {
    const bare = createApp({
      index,
      settings: new SettingsController(join(dir, 'other.json'), undefined),
    })
    const body = await (await bare.request('/api/settings')).json() as SettingsResponse
    expect(body).toEqual({ ...SETTINGS_DEFAULTS, searchEnabled: false })
    const put = await bare.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ searchMaxAgeDays: 14 }),
    })
    expect(put.status).toBe(200)
    expect(await put.json() as SettingsUpdateResponse)
      .toMatchObject({ searchMaxAgeDays: 14, purged: 0, searchEnabled: false })
  })
})
