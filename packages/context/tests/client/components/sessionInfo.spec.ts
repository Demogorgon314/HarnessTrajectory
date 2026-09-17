// SessionInfo (src/client/components/sessionInfo.tsx): the model row is a
// button whenever the host listens — unpriced pairs to price them, priced
// ones (registry or a user rule) to revisit the rule — and shows the resolved
// rate card under the name when a rate exists.

import { createElement as h } from 'react'
import assert from '../helpers/assert.ts'
import { describe, test, beforeEach, afterEach, vi } from 'vitest'
import { makeSessionInfo } from '../../../src/client/components/sessionInfo'
import type { SessionInfo } from '../../../src/client/components/sessionInfo'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { flush, makeKit, mount, query, queryAll, click } from '../helpers/kit'

const SessionInfoCard = makeSessionInfo(makeKit())
const SessionInfoCardZh = makeSessionInfo(makeKit('zh'))

const PROVIDERS = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6 } } } },
}

const INFO: SessionInfo = {
  harness: 'Devin CLI',
  model: 'swe-2-max',
  provider: 'cognition',
}

function modelRow(container: HTMLElement, label = 'Model'): HTMLElement {
  const row = queryAll(container, '.lc-pi-row')
    .find(el => el.querySelector('.lc-pi-label')?.textContent === label)
  assert.ok(row !== undefined, 'model row missing')
  return row
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(PROVIDERS))
})

afterEach(() => {
  resetModelPrices()
})

test('an unpriced model row is a button that reports the fold pair', async () => {
  const onPriceModel = vi.fn()
  const mounted = await mount(
    h(SessionInfoCard, { info: INFO, onPriceModel }),
  )
  await flush()
  const button = modelRow(mounted.container).querySelector('button.lc-stat-price-link')
  assert.ok(button !== null, 'unpriced model row is not a button')
  assert.equal(button.textContent, 'swe-2-max · cognition')
  await click(button as HTMLElement)
  assert.deepEqual(onPriceModel.mock.calls, [['cognition', 'swe-2-max']])
  await mounted.unmount()
})

test('a registry-priced model row is still a button — the override entry', async () => {
  const onPriceModel = vi.fn()
  const mounted = await mount(
    h(SessionInfoCard, {
      info: { ...INFO, model: 'deepseek-v4-flash', provider: 'deepseek' },
      onPriceModel,
    }),
  )
  await flush()
  const row = modelRow(mounted.container)
  const button = row.querySelector('button.lc-stat-price-link')
  assert.ok(button !== null, 'priced model row keeps the edit entry')
  assert.equal(button.textContent, 'deepseek-v4-flash · deepseek')
  assert.equal(button.getAttribute('title'), 'View or edit this model\'s price rule')
  await click(button as HTMLElement)
  assert.deepEqual(onPriceModel.mock.calls, [['deepseek', 'deepseek-v4-flash']])
  const price = row.querySelector('.lc-pi-price')
  assert.ok(price !== null, 'the resolved rate card still shows under the button')
  await mounted.unmount()
})

test('a priced model row shows its rate card under the name', async () => {
  const mounted = await mount(
    h(SessionInfoCard, {
      info: { ...INFO, model: 'deepseek-v4-flash', provider: 'deepseek' },
    }),
  )
  await flush()
  const price = modelRow(mounted.container).querySelector('.lc-pi-price')
  // DeepSeek's built-in off-peak halves every field → peak|off pairs.
  assert.equal(price?.textContent, 'miss $0.15|$0.075 · output $0.6|$0.3 · hit $0.15|$0.075 · write $0.15|$0.075')
  await mounted.unmount()
})

test('the rate card renders in the host currency (zh → ¥)', async () => {
  const mounted = await mount(
    h(SessionInfoCardZh, {
      info: { ...INFO, model: 'deepseek-v4-flash', provider: 'deepseek' },
      locale: 'zh',
    }),
  )
  await flush()
  const price = modelRow(mounted.container, '模型').querySelector('.lc-pi-price')
  assert.equal(price?.textContent, '未命中 ¥1|¥0.5 · 输出 ¥4|¥2 · 命中 ¥1|¥0.5 · 写入 ¥1|¥0.5')
  await mounted.unmount()
})

test('a rule-priced model row shows the rule\'s own card, schedule pairs included', async () => {
  setModelPricesLoader(() => new Promise(() => {}))
  const mounted = await mount(
    h(SessionInfoCard, {
      info: INFO,
      pricingRules: {
        'cognition/swe-2-max': {
          rates: { input: 1.5, output: 6 },
          offPeak: { peakHours: [[9, 18]], timezone: 'Asia/Shanghai', factor: 0.5 },
        },
      },
    }),
  )
  await flush()
  const price = modelRow(mounted.container).querySelector('.lc-pi-price')
  assert.equal(price?.textContent, 'miss $1.5|$0.75 · output $6|$3 · hit $1.5|$0.75 · write $1.5|$0.75')
  await mounted.unmount()
})

test('a rule-priced model row stays clickable while the book is still loading', async () => {
  setModelPricesLoader(() => new Promise(() => {}))
  const onPriceModel = vi.fn()
  const mounted = await mount(
    h(SessionInfoCard, {
      info: INFO,
      pricingRules: { 'cognition/swe-2-max': { rates: { input: 1.5, output: 6 } } },
      onPriceModel,
    }),
  )
  await flush()
  const button = modelRow(mounted.container).querySelector('button.lc-stat-price-link')
  assert.ok(button !== null, 'rule-priced model row is a button')
  await click(button as HTMLElement)
  assert.deepEqual(onPriceModel.mock.calls, [['cognition', 'swe-2-max']])
  await mounted.unmount()
})

test('no host listener — no button, however unpriced', async () => {
  const mounted = await mount(h(SessionInfoCard, { info: INFO }))
  await flush()
  const row = modelRow(mounted.container)
  assert.equal(row.querySelector('button'), null)
  assert.equal(row.querySelector('.lc-pi-price'), null, 'nothing priced → no rate card')
  await mounted.unmount()
})
