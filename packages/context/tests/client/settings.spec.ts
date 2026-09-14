// Display preferences (src/client/settings.ts): defaults, the observable
// store, preference parsing, and the persisted `set` path.
//
// PORT NOTE — dsh-context bound a Host-served settings scope and this spec
// drove that contract (attach/sync, optimistic echo, rejected-write rollback,
// the `defaultPlacement` degradation). This port persists to localStorage and
// has no placement field, so the suite covers the same behaviours against the
// storage seam instead.

import assert from './helpers/assert.ts'
import { beforeEach, describe, test } from 'vitest'
import { createContextSettings, SETTINGS_KEY, type SettingsState } from '../../src/client/settings'

let keyCounter = 0
/** One storage key per test, so no spec can see another's writes. */
function freshKey(): string {
  keyCounter++
  return `test.context.settings.${keyCounter}`
}

beforeEach(() => {
  localStorage.clear()
})

describe('createContextSettings defaults', () => {
  test('an empty store starts ready on the schema defaults, writable', () => {
    const s = createContextSettings(freshKey())
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'ready',
      granularity: 'step',
      mode: 'total',
      toolSort: 'count',
      fileSort: 'count',
      writable: true,
    } satisfies SettingsState)
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultToolSort(), 'count')
    assert.equal(s.defaultFileSort(), 'count')
  })

  test('the shipped key is namespaced to this app', () => {
    assert.equal(SETTINGS_KEY, 'harness-trajectory.context.settings')
  })

  test('subscribers are notified on change and unsubscribe stops', () => {
    const s = createContextSettings(freshKey())
    let seen = 0
    const off = s.store.subscribe(() => { seen++ })
    s.set('defaultGranularity', 'turn')
    assert.equal(seen, 1)
    off()
    s.set('defaultTrendMode', 'delta')
    assert.equal(seen, 1)
  })

  test('an unchanged value does not notify listeners', () => {
    const s = createContextSettings(freshKey())
    let seen = 0
    s.store.subscribe(() => { seen++ })
    s.set('defaultGranularity', 'step')
    assert.equal(seen, 0)
  })

  test('an invalid value is dropped without notifying or persisting', () => {
    const key = freshKey()
    const s = createContextSettings(key)
    let seen = 0
    s.store.subscribe(() => { seen++ })
    s.set('defaultGranularity', 'nonsense')
    assert.equal(seen, 0)
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(localStorage.getItem(key), null)
  })
})

describe('persistence', () => {
  test('every field round-trips through a fresh face', () => {
    const key = freshKey()
    const a = createContextSettings(key)
    a.set('defaultGranularity', 'turn')
    a.set('defaultTrendMode', 'delta')
    a.set('defaultToolSort', 'size')
    a.set('defaultFileSort', 'path')
    const b = createContextSettings(key)
    assert.deepEqual(b.store.getSnapshot(), {
      status: 'ready',
      granularity: 'turn',
      mode: 'delta',
      toolSort: 'size',
      fileSort: 'path',
      writable: true,
    } satisfies SettingsState)
  })

  test('one write never drops the fields written before it', () => {
    const key = freshKey()
    const a = createContextSettings(key)
    a.set('defaultToolSort', 'name')
    a.set('defaultFileSort', 'latest')
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    assert.deepEqual(stored, { defaultToolSort: 'name', defaultFileSort: 'latest' })
  })

  test('a stored record with unknown values keeps the defaults for those fields', () => {
    const key = freshKey()
    localStorage.setItem(key, JSON.stringify({ defaultGranularity: 'turn', defaultTrendMode: 'sideways' }))
    const s = createContextSettings(key)
    assert.equal(s.defaultGranularity(), 'turn')
    assert.equal(s.defaultTrendMode(), 'total')
  })

  test('a corrupt or non-object record degrades to the defaults, never a throw', () => {
    const bad = freshKey()
    localStorage.setItem(bad, '{not json')
    assert.equal(createContextSettings(bad).defaultGranularity(), 'step')
    const primitive = freshKey()
    localStorage.setItem(primitive, '7')
    assert.equal(createContextSettings(primitive).defaultTrendMode(), 'total')
    const empty = freshKey()
    localStorage.setItem(empty, '')
    assert.equal(createContextSettings(empty).defaultFileSort(), 'count')
  })

  test('a blocked store keeps the in-memory echo instead of failing', () => {
    const key = freshKey()
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('blocked') }
    try {
      const s = createContextSettings(key)
      s.set('defaultFileSort', 'latest')
      assert.equal(s.defaultFileSort(), 'latest')
      assert.equal(s.store.getSnapshot().writable, true)
    } finally {
      Storage.prototype.setItem = original
    }
  })

  test('a store that throws on read starts on the defaults', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('blocked') }
    try {
      const s = createContextSettings(freshKey())
      assert.equal(s.defaultGranularity(), 'step')
    } finally {
      Storage.prototype.getItem = original
    }
  })
})
