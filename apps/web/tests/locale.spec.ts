import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocaleStore } from '../src/locale.ts'

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('language preference', () => {
  test('restores explicit choices across fresh stores even when browser language differs', () => {
    const first = createLocaleStore()
    first.set('zh')
    const reopened = createLocaleStore()
    expect(reopened.getSnapshot()).toBe('zh')
    reopened.set('en')
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    expect(createLocaleStore().getSnapshot()).toBe('en')
  })

  test('follows the browser when no preference has been saved', () => {
    expect(createLocaleStore().getSnapshot()).toBe('en')
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-TW')
    expect(createLocaleStore().getSnapshot()).toBe('zh')
  })

  test.each(['not json', 'null', '42', '"fr"', '{}'])('ignores invalid stored preference %s', stored => {
    localStorage.setItem('harness-trajectory.locale', stored)
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    expect(createLocaleStore().getSnapshot()).toBe('zh')
  })

  test('still switches language when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
    const store = createLocaleStore()
    store.set('zh')
    expect(store.getSnapshot()).toBe('zh')
  })
})
