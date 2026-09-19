import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSearchService, type SearchService } from '../src/search/index.ts'
import { SearchLifecycle, type SearchableSource } from '../src/search/lifecycle.ts'
import type { SearchIndexer } from '../src/search/indexer.ts'

function source(path: string) {
  let indexer: SearchIndexer | undefined
  const register = () => {
    const key = { path, kind: 'claude' as const, sessionId: path, fileId: path }
    indexer?.beginFile(key, { size: 0, mtimeMs: Date.now() })
    indexer?.noteProgress(key, { size: 0, mtimeMs: Date.now(), indexedBytes: 0, indexedLines: 0 })
    indexer?.flush()
  }
  return {
    start: vi.fn(async () => { register() }),
    enableSearch: vi.fn(async (next: SearchIndexer) => { indexer = next; register() }),
    disableSearch: vi.fn(() => { indexer = undefined }),
    livePaths: () => [path],
  } satisfies SearchableSource
}

describe('SearchLifecycle', () => {
  let dir: string
  let lifecycle: SearchLifecycle | undefined

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ht-search-lifecycle-')) })
  afterEach(async () => {
    await lifecycle?.close()
    lifecycle = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it('finishes startup once with every source, preserving later sources in the index', async () => {
    const first = source(join(dir, 'first'))
    const second = source(join(dir, 'second'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    second.start.mockImplementation(async () => { entered.resolve(); await release.promise })
    const ready = vi.fn()
    lifecycle = new SearchLifecycle([first, second], {
      path: join(dir, 'search.sqlite'), onError: error => { throw error }, onReady: ready,
    })
    lifecycle.setEnabled(true, 0)
    const service = lifecycle.current()
    const startup = lifecycle.start()
    await entered.promise
    expect(service?.indexer.stats().ready).toBe(false)
    expect(ready).not.toHaveBeenCalled()
    release.resolve()
    await startup
    expect(service?.store.fileCount()).toBe(2)
    expect(service?.indexer.stats().ready).toBe(true)
    expect(ready).toHaveBeenCalledOnce()
  })

  it('waits for discovery before enabling search requested during startup', async () => {
    const first = source(join(dir, 'first'))
    const second = source(join(dir, 'second'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    first.start.mockImplementation(async () => { entered.resolve(); await release.promise })
    lifecycle = new SearchLifecycle([first, second], {
      path: join(dir, 'search.sqlite'), onError: error => { throw error }, onReady: () => { ready.resolve() },
    })
    const startup = lifecycle.start()
    await entered.promise
    lifecycle.setEnabled(true, 0)
    expect(lifecycle.current()).toBeDefined()
    expect(first.enableSearch).not.toHaveBeenCalled()
    release.resolve()
    await startup
    await ready.promise
    expect(second.start).toHaveBeenCalledOnce()
    expect(lifecycle.current()?.store.fileCount()).toBe(2)
  })

  it('detaches during startup without closing a store still borrowed by a source', async () => {
    const first = source(join(dir, 'first'))
    const second = source(join(dir, 'second'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let service: SearchService | undefined
    first.start.mockImplementation(async () => {
      entered.resolve()
      await release.promise
      // A read captured the old service before the toggle; its store stays alive.
      expect(service?.store.fileCount()).toBe(1)
    })
    const ready = vi.fn()
    lifecycle = new SearchLifecycle([first, second], {
      path: join(dir, 'search.sqlite'), onError: error => { throw error }, onReady: ready,
    })
    lifecycle.setEnabled(true, 0)
    service = lifecycle.current()
    if (service === undefined) throw new Error('search did not open')
    const close = vi.spyOn(service, 'close')
    const startup = lifecycle.start()
    await entered.promise
    lifecycle.setEnabled(false, 0)
    expect(lifecycle.current()).toBeUndefined()
    expect(first.disableSearch).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    release.resolve()
    await startup
    await lifecycle.close()
    expect(close).toHaveBeenCalledOnce()
    expect(second.enableSearch).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })

  it('serializes on/off/on and recovers after an interrupted backfill fails', async () => {
    const participant = source(join(dir, 'first'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const errors: unknown[] = []
    participant.enableSearch.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('interrupted read')
    })
    const services: SearchService[] = []
    lifecycle = new SearchLifecycle([participant], {
      path: join(dir, 'search.sqlite'), onError: error => { errors.push(error) },
      onReady: () => { ready.resolve() },
      createService: options => {
        const service = createSearchService(options)
        vi.spyOn(service, 'close')
        services.push(service)
        return service
      },
    })
    await lifecycle.start()
    lifecycle.setEnabled(true, 0)
    await entered.promise
    lifecycle.setEnabled(false, 0)
    lifecycle.setEnabled(true, 0)
    expect(participant.enableSearch).toHaveBeenCalledTimes(1)
    expect(services[0]?.close).not.toHaveBeenCalled()
    release.resolve()
    await ready.promise
    expect(services[0]?.close).toHaveBeenCalledOnce()
    expect(services[1]?.close).not.toHaveBeenCalled()
    expect(lifecycle.current()?.store.fileCount()).toBe(1)
    expect(errors).toHaveLength(1)
  })
})
