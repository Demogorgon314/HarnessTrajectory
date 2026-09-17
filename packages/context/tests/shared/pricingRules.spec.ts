/**
 * User model-price rules (src/shared/pricingRules.ts): the three-tier match
 * (exact → provider/* → bare model), the local-time peak-window evaluator
 * (timezone, weekend, fractional hours, unresolvable zones), and the fold's
 * period resolver — including the built-in DeepSeek schedule's parity with
 * the UTC table it replaced.
 */

import assert from '../fold/helpers/assert.ts'
import { describe, test } from 'vitest'
import {
  DEEPSEEK_PEAK, defaultCostPeriod, inPeakWindow, makeCostPeriod, matchRule, matchRuleKey,
} from '../../src/shared/pricingRules.ts'
import type { ModelPriceRules } from '@harness-trajectory/core'

// Beijing Time runs UTC+8 year-round: a schedule in Asia/Shanghai and its UTC
// translation must agree on every instant the tests probe.
const MON = (h: number) => Date.UTC(2024, 0, 1, h) // 2024-01-01, a Monday
const SAT = (h: number) => Date.UTC(2024, 0, 6, h) // 2024-01-06, a Saturday

describe('matchRule', () => {
  const rules: ModelPriceRules = {
    'cognition/swe-2-max': { rates: { input: 1, output: 2 } },
    'cognition/*': { rates: { input: 3, output: 4 } },
    'swe-2-max': { rates: { input: 5, output: 6 } },
    'kimi-code/k3/fast': { alias: 'moonshotai/kimi-k3' },
  }

  test('an exact provider/model match wins over wildcard and bare-model keys', () => {
    assert.equal(matchRule(rules, 'cognition', 'swe-2-max')?.rates?.input, 1)
  })

  test('a provider/* wildcard beats a bare model key', () => {
    assert.equal(matchRule(rules, 'cognition', 'other')?.rates?.input, 3)
  })

  test('a bare model key matches across providers — including the empty one', () => {
    assert.equal(matchRule(rules, 'unknown', 'swe-2-max')?.rates?.input, 5)
    assert.equal(matchRule(rules, '', 'swe-2-max')?.rates?.input, 5)
  })

  test('an empty provider can never match provider/model or provider/*', () => {
    assert.equal(matchRule(rules, '', 'other'), null)
  })

  test('a model id with slashes matches its exact key (first "/" splits provider off)', () => {
    assert.equal(matchRule(rules, 'kimi-code', 'k3/fast')?.alias, 'moonshotai/kimi-k3')
  })

  test('null, empty, and missing tables match nothing', () => {
    assert.equal(matchRule(null, 'cognition', 'swe-2-max'), null)
    assert.equal(matchRule({}, 'cognition', 'swe-2-max'), null)
    assert.equal(matchRule(rules, 'elsewhere', 'unknown'), null)
  })

  test('matchRuleKey names the winning row — the key an editor edits in place', () => {
    assert.equal(matchRuleKey(rules, 'cognition', 'swe-2-max'), 'cognition/swe-2-max')
    assert.equal(matchRuleKey(rules, 'cognition', 'other'), 'cognition/*')
    assert.equal(matchRuleKey(rules, 'unknown', 'swe-2-max'), 'swe-2-max')
    assert.equal(matchRuleKey(rules, 'kimi-code', 'k3/fast'), 'kimi-code/k3/fast')
    assert.equal(matchRuleKey(rules, 'elsewhere', 'unknown'), null)
    assert.equal(matchRuleKey(null, 'cognition', 'swe-2-max'), null)
  })
})

describe('inPeakWindow', () => {
  test('DeepSeek windows in Beijing time, boundaries included/excluded', () => {
    assert.equal(inPeakWindow(DEEPSEEK_PEAK, MON(1)), true, '01:00 UTC = 09:00 Beijing — peak opens')
    assert.equal(inPeakWindow(DEEPSEEK_PEAK, MON(4)), false, '04:00 UTC = 12:00 Beijing — peak closed')
    assert.equal(inPeakWindow(DEEPSEEK_PEAK, MON(6)), true, '06:00 UTC = 14:00 Beijing — peak reopens')
    assert.equal(inPeakWindow(DEEPSEEK_PEAK, MON(10)), false, '10:00 UTC = 18:00 Beijing — peak closed')
  })

  test('weekdaysOnly leaves the weekend off-peak all day', () => {
    assert.equal(inPeakWindow(DEEPSEEK_PEAK, SAT(2)), false, 'Sat 10:00 Beijing')
    const everyDay = { ...DEEPSEEK_PEAK, weekdaysOnly: false }
    assert.equal(inPeakWindow(everyDay, SAT(2)), true)
  })

  test('fractional hours price at minute precision', () => {
    const schedule = { peakHours: [[9.5, 12] as [number, number]], timezone: 'Asia/Shanghai' }
    assert.equal(inPeakWindow(schedule, MON(1)), false, '09:00 Beijing — before the window')
    assert.equal(inPeakWindow(schedule, MON(1) + 30 * 60_000), true, '09:30 Beijing — window opens')
  })

  test('a timezone the runtime cannot resolve peaks nothing', () => {
    assert.equal(inPeakWindow({ peakHours: [[0, 24]], timezone: 'Not/AZone' }, MON(2)), false)
  })

  test('an absent timezone reads as UTC', () => {
    assert.equal(inPeakWindow({ peakHours: [[2, 4]] }, MON(2)), true)
    assert.equal(inPeakWindow({ peakHours: [[2, 4]] }, MON(4)), false)
  })
})

describe('defaultCostPeriod', () => {
  test('DeepSeek splits on its built-in schedule; everyone else is always peak', () => {
    assert.equal(defaultCostPeriod('deepseek-official', 'deepseek-v4-flash', MON(2)), 'peak')
    assert.equal(defaultCostPeriod('deepseek-official', 'deepseek-v4-flash', MON(5)), 'off')
    assert.equal(defaultCostPeriod('deepseek-official', 'deepseek-v4-flash', SAT(2)), 'off')
    assert.equal(defaultCostPeriod('kimi-coding', 'kimi-k3', MON(5)), 'peak')
    assert.equal(defaultCostPeriod('', 'anything', MON(5)), 'peak')
  })
})

describe('makeCostPeriod', () => {
  const offPeak = { peakHours: [[9, 12] as [number, number]], timezone: 'Asia/Shanghai', factor: 0.5 }

  test('no rules returns the built-in resolver itself', () => {
    assert.equal(makeCostPeriod(null), defaultCostPeriod)
    assert.equal(makeCostPeriod(undefined), defaultCostPeriod)
    assert.equal(makeCostPeriod({}), defaultCostPeriod)
  })

  test("a matched rule's offPeak schedule drives the split, provider-agnostic", () => {
    const resolve = makeCostPeriod({ 'cognition/swe-2-max': { rates: { input: 1, output: 1 }, offPeak } })
    assert.equal(resolve('cognition', 'swe-2-max', MON(2)), 'peak', '10:00 Beijing is inside 9-12')
    assert.equal(resolve('cognition', 'swe-2-max', MON(5)), 'off', '13:00 Beijing is outside')
    assert.equal(resolve('cognition', 'other', MON(5)), 'peak', 'unmatched models keep the built-in')
  })

  test('a rule CAN re-schedule a DeepSeek model', () => {
    const resolve = makeCostPeriod({ 'deepseek-official/*': { rates: { input: 1, output: 1 }, offPeak } })
    // Mon 13:00 Beijing: inside the rule's 9-12 window? No → off, even though
    // DeepSeek's own table would bill 14-18 peak. The rule's schedule wins.
    assert.equal(resolve('deepseek-official', 'deepseek-v4-flash', MON(6)), 'off')
    assert.equal(resolve('deepseek-official', 'deepseek-v4-flash', MON(2)), 'peak')
  })

  test('a matched rule without offPeak leaves the built-in DeepSeek check standing', () => {
    const resolve = makeCostPeriod({ 'deepseek-official/*': { rates: { input: 1, output: 1 } } })
    assert.equal(resolve('deepseek-official', 'deepseek-v4-flash', MON(2)), 'peak')
    assert.equal(resolve('deepseek-official', 'deepseek-v4-flash', MON(5)), 'off')
  })
})
