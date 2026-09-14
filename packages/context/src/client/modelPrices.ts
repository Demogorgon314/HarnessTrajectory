/**
 * The client's model-price book (client/cost.ts prices from it): the
 * models.dev registry, fetched directly from its published `/api.json`
 * (dsh-context read the same registry through the @opencode-ai/models SDK;
 * this port drops the dependency and fetches the URL, keeping the payload
 * shape and every boundary check). The registry payload is untrusted wire
 * input, so `pricesBookOf` re-proves every field at the boundary — a
 * non-conforming provider/model/cost entry drops whole. The book keeps EVERY
 * provider that prices (keyed by the registry's own provider id), so a
 * provider id outside the rename table still prices by direct passthrough.
 * One fetch per page load, kicked on first subscribe; a failure degrades to
 * a visible state the cost cell notes, with a backed-off automatic retry —
 * never a spinner, and never an unhandled rejection.
 */

import { useSyncExternalStore } from 'react'
import { asRecord } from './services'
import type { ModelPrices, PriceTriple } from './cost'

/** The published models.dev registry. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** One finite non-negative registry figure, or null. */
function rateOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Extract the whole registry's per-model USD rates from a delivered
 * providers payload (`/api.json`), keyed by the registry's provider ids.
 * Any shape failure skips just that entry; a payload that is not a record
 * at all returns null (the store treats it as a failed fetch and retries).
 */
export function pricesBookOf(value: unknown): ModelPrices | null {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return null
  const book: ModelPrices = {}
  for (const providerId of Object.keys(data)) {
    const provider = asRecord(data[providerId])
    const modelList = provider !== null ? asRecord(provider.models) : null
    if (modelList === null) continue
    const models: Record<string, PriceTriple> = {}
    for (const id of Object.keys(modelList)) {
      const model = asRecord(modelList[id])
      const cost = model !== null ? asRecord(model.cost) : null
      if (cost === null) continue
      const miss = rateOf(cost.input)
      const out = rateOf(cost.output)
      if (miss === null || out === null) continue
      models[id] = {
        hit: rateOf(cost.cache_read) ?? miss,
        miss,
        write: rateOf(cost.cache_write) ?? miss,
        out,
      }
    }
    if (Object.keys(models).length > 0) book[providerId] = models
  }
  return book
}

/** The store's observable snapshot, identity-stable between transitions. */
export interface ModelPricesSnap {
  /** The extracted book, null until the first successful fetch. */
  prices: ModelPrices | null
  /** The last fetch failed (the cost cell notes the outage until a retry lands). */
  failed: boolean
}

type Loader = () => Promise<unknown>

const defaultLoader: Loader = async () => {
  const response = await fetch(MODELS_DEV_URL, { headers: { accept: 'application/json' } })
  // A non-2xx answer is a failed fetch, not a malformed book: throwing here
  // routes it through the store's retry arm rather than caching an empty book.
  if (!response.ok) throw new Error('models.dev ' + String(response.status))
  return await response.json() as unknown
}

/** The retry backoff base; each consecutive failure doubles the wait, capped at 3 doublings. */
const RETRY_BASE_MS = 30_000

let loader: Loader = defaultLoader
let snap: ModelPricesSnap = { prices: null, failed: false }
let inFlight = false
let failures = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function fail(): void {
  // Single-arm invariant: fail() runs exactly once per fetch cycle (only
  // fire() calls it, and both fire() callers — kick() and the timer
  // callback — are blocked while a timer is armed), so re-arming here can
  // never leak a timer.
  snap = { ...snap, failed: true }
  failures++
  timer = setTimeout(() => {
    timer = null
    void fire()
  }, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 3))
}

async function fire(): Promise<void> {
  inFlight = true
  try {
    const book = pricesBookOf(await loader())
    if (book !== null) {
      snap = { prices: book, failed: false }
      failures = 0
    } else {
      fail()
    }
  } catch {
    fail()
  }
  inFlight = false
  for (const fn of listeners) fn()
}

function kick(): void {
  if (snap.prices !== null || inFlight || timer !== null) return
  void fire()
}

/** The useSyncExternalStore seam: subscribing also kicks the first fetch. */
export const subscribeModelPrices = (fn: () => void): (() => void) => {
  listeners.add(fn)
  kick()
  return () => {
    listeners.delete(fn)
  }
}

export const getModelPricesSnap = (): ModelPricesSnap => snap

/** The stats board's read of the price book (null until the fetch lands). */
export function useModelPrices(): ModelPricesSnap {
  return useSyncExternalStore(subscribeModelPrices, getModelPricesSnap)
}

/** Test isolation: drop the book, the retry timer, and the listeners. */
export function resetModelPrices(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  snap = { prices: null, failed: false }
  inFlight = false
  failures = 0
  listeners.clear()
}

/** Test seam: replace the loader (the SDK fetch) with a stub; null restores the default. */
export function setModelPricesLoader(next: Loader | null): void {
  loader = next ?? defaultLoader
}
