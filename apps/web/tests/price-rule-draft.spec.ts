/**
 * The price-rule editor's pure helpers: the peak-hours text grammar, draft ↔
 * rule conversion, table operations, the rate-field spec, and the DeepSeek
 * schedule preset. No DOM.
 */

import { describe, expect, it } from 'vitest'
import type { ModelPriceRules } from '@harness-trajectory/core'
import {
  aliasesOf, draftOf, fieldsOfTriple, parsePeakHours, removeRule, ruleOf, SCHEDULE_PRESETS, upsertRule,
} from '../src/price-rule-draft.ts'

describe('parsePeakHours', () => {
  it('reads comma-separated windows at minute precision', () => {
    expect(parsePeakHours('9-12, 14-18')).toEqual([[9, 12], [14, 18]])
    expect(parsePeakHours('9:30-12')).toEqual([[9.5, 12]])
    expect(parsePeakHours('0-24')).toEqual([[0, 24]])
  })

  it('rejects junk, reversed, and out-of-range windows', () => {
    expect(parsePeakHours('')).toBeNull()
    expect(parsePeakHours('nine')).toBeNull()
    expect(parsePeakHours('12-9')).toBeNull()
    expect(parsePeakHours('9-25')).toBeNull()
    expect(parsePeakHours('9-12-14')).toBeNull()
    expect(parsePeakHours('9:75-12')).toBeNull()
  })
})

describe('upsertRule / removeRule / aliasesOf', () => {
  const rules: ModelPriceRules = {
    'a/b': { alias: 'x/m' },
    'c/d': { alias: 'x/m', rates: { input: 1, output: 2 } },
    'e/f': { rates: { input: 3, output: 4 } },
  }

  it('upsert replaces the row at key; a rename deletes the old key', () => {
    expect(upsertRule(rules, 'a/b', 'a/b', { rates: { input: 9, output: 9 } }))
      .toEqual({ ...rules, 'a/b': { rates: { input: 9, output: 9 } } })
    expect(upsertRule(rules, 'a/b', 'g/h', { rates: { input: 9, output: 9 } }))
      .toEqual({ 'c/d': rules['c/d'], 'e/f': rules['e/f'], 'g/h': { rates: { input: 9, output: 9 } } })
    // prevKey null adds without deleting anything.
    expect(upsertRule(rules, null, 'a/b', { rates: { input: 9, output: 9 } })['a/b'])
      .toEqual({ rates: { input: 9, output: 9 } })
  })

  it('removeRule drops only the named row', () => {
    expect(removeRule(rules, 'c/d')).toEqual({ 'a/b': rules['a/b'], 'e/f': rules['e/f'] })
  })

  it('aliasesOf dedups in table order and skips alias-less rules', () => {
    expect(aliasesOf(rules)).toEqual(['x/m'])
    expect(aliasesOf({})).toEqual([])
  })
})

describe('fieldsOfTriple', () => {
  it('maps miss/out/hit/write and leaves cacheWrite1h untouched', () => {
    expect(fieldsOfTriple({ miss: 1, out: 4, hit: 0.1, write: 1.25 })).toEqual({
      input: '1', output: '4', cacheRead: '0.1', cacheWrite: '1.25',
    })
  })
})

describe('ruleOf ∘ draftOf', () => {
  it('round-trips a full off-peak custom-rates rule', () => {
    const rule = {
      rates: { input: 1.5, output: 6, cacheRead: 0.3, cacheWrite: 1.5, cacheWrite1h: 3 },
      offPeak: {
        peakHours: [[9, 12], [14.5, 18]] as [number, number][],
        timezone: 'Asia/Shanghai',
        weekdaysOnly: true,
        rates: { input: 0.5, output: 1 },
      },
    }
    expect(ruleOf(draftOf('x/y', rule))).toEqual({ key: 'x/y', rule })
  })

  it('round-trips an alias rule with a factor schedule', () => {
    const rule = {
      alias: 'deepseek/deepseek-v4-flash',
      offPeak: { peakHours: [[9, 12], [14, 18]] as [number, number][], factor: 0.5 },
    }
    expect(ruleOf(draftOf('deepseek/*', rule))).toEqual({ key: 'deepseek/*', rule })
  })
})

describe('SCHEDULE_PRESETS', () => {
  it('the DeepSeek preset carries the shared peak table', () => {
    const preset = SCHEDULE_PRESETS.find(p => p.id === 'deepseek')
    expect(preset?.patch).toEqual({
      peakHours: '9-12, 14-18',
      timezone: 'Asia/Shanghai',
      weekdaysOnly: true,
      offMode: 'factor',
      offFactor: '0.5',
    })
    expect(parsePeakHours(preset?.patch.peakHours ?? '')).toEqual([[9, 12], [14, 18]])
  })
})
