import type { SessionSource } from '../source.ts'
import { createSearchService, type SearchService, type SearchServiceOptions } from './index.ts'
import type { SearchIndexer } from './indexer.ts'

/** Sources borrow an indexer; only SearchLifecycle may finish or close it. */
export interface SearchableSource extends Pick<SessionSource, 'start' | 'livePaths'> {
  enableSearch(indexer: SearchIndexer): void | Promise<void>
  disableSearch(): void
}

interface SearchLifecycleOptions {
  path: string
  onError: (error: unknown) => void
  onReady?: (service: SearchService) => void
  createService?: (options: SearchServiceOptions) => SearchService
}

/**
 * Owns search across discovery and runtime toggles. Detaching is immediate;
 * closing waits for outstanding source reads before releasing their store.
 * A replacement service cannot backfill until that retirement has finished.
 */
export class SearchLifecycle {
  private service: SearchService | undefined
  private work: Promise<void> = Promise.resolve()
  private started = false
  private closed = false

  constructor(
    private readonly sources: readonly SearchableSource[],
    private readonly options: SearchLifecycleOptions,
  ) {}

  current(): SearchService | undefined {
    return this.service
  }

  setEnabled(enabled: boolean, maxAgeDays: number): void {
    if (this.closed) return
    if (!enabled) {
      this.detach()
      return
    }
    if (this.service !== undefined) return
    let service: SearchService
    try {
      service = (this.options.createService ?? createSearchService)({ path: this.options.path, maxAgeDays })
    } catch (error) {
      this.options.onError(error)
      return
    }
    this.service = service
    if (this.started) {
      this.work = this.work.then(async () => {
        if (this.service !== service) return
        try {
          for (const source of this.sources) {
            if (this.service !== service) return
            await source.enableSearch(service.indexer)
          }
          this.finish(service)
        } catch (error) {
          this.options.onError(error)
        }
      })
    }
  }

  /** Attach before discovery to preserve one-pass indexing and restart cursors. */
  start(): Promise<void> {
    if (this.started || this.closed) throw new Error('search lifecycle has already started or closed')
    this.started = true
    const service = this.service
    const startup = this.work.then(async () => {
      for (const source of this.sources) {
        if (service !== undefined && this.service === service) await source.enableSearch(service.indexer)
        await source.start()
      }
      if (service !== undefined) this.finish(service)
    })
    // The caller handles discovery failures. Retirement still runs after one.
    this.work = startup.catch(() => {})
    return startup
  }

  private finish(service: SearchService): void {
    if (this.service !== service) return
    service.indexer.finishBackfill(this.sources.flatMap(source => [...source.livePaths()]))
    this.options.onReady?.(service)
  }

  private detach(): void {
    const service = this.service
    if (service === undefined) return
    this.service = undefined
    for (const source of this.sources) source.disableSearch()
    this.work = this.work.then(() => { service.close() })
  }

  /** Wait for in-flight reads and retired services before closing source/cache resources. */
  async close(): Promise<void> {
    this.closed = true
    this.detach()
    await this.work
  }
}
