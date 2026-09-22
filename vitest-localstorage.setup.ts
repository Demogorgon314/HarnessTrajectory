/**
 * Node 25+ exposes `globalThis.localStorage` as a getter that returns
 * `undefined` unless `--localstorage-file` is set. That getter wins over
 * jsdom, so browser tests see no Storage. Install one in-memory Storage
 * (jsdom's own) when the global is missing. Each worker gets its own.
 */

import { JSDOM } from 'jsdom'

const current = globalThis.localStorage
if (current === undefined || typeof current.clear !== 'function') {
  const dom = new JSDOM('<!doctype html>', { url: 'http://localhost/' })
  const storage = dom.window.localStorage
  // Tests spy on the global `Storage` prototype. Node's `Storage` is a
  // different realm from jsdom's, so point the global at jsdom's constructor
  // — the same one `storage` inherits.
  const StorageCtor = dom.window.Storage
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage })
  Object.defineProperty(globalThis, 'Storage', { configurable: true, writable: true, value: StorageCtor })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, writable: true, value: storage })
    Object.defineProperty(window, 'Storage', { configurable: true, writable: true, value: StorageCtor })
  }
}
