// mergeCostUsage (src/client/costMerge.ts) — the session-wide cost roll-up:
// every folded transcript's billed totals added per provider / model / period,
// with the same no-NaN boundary discipline as the rest of the client half.

import assert from './helpers/assert.ts'
import { describe, test } from 'vitest'
import { mergeCostUsage } from '../../src/client/costMerge'
import type { CostBucketTotals, SessionCostUsage } from '../../src/shared/types'

function bucket(over: Partial<CostBucketTotals> = {}): CostBucketTotals {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...over }
}

describe('mergeCostUsage', () => {
  test('nothing to merge stays undefined', () => {
    assert.equal(mergeCostUsage([]), undefined)
    assert.equal(mergeCostUsage([undefined, undefined]), undefined)
    // A record with no readable bucket has billed nothing.
    assert.equal(mergeCostUsage([{ anthropic: { 'claude-opus-5': {} } }]), undefined)
  })

  test('a single part passes its totals through', () => {
    const one: SessionCostUsage = {
      anthropic: { 'claude-opus-5': { peak: bucket({ uncached: 10, cacheRead: 20, cacheWrite: 5, output: 3 }) } },
    }
    assert.deepEqual(mergeCostUsage([one]), {
      anthropic: { 'claude-opus-5': { peak: { uncached: 10, cacheRead: 20, cacheWrite: 5, output: 3 } } },
    })
  })

  test('the same model in two files sums bucket by bucket', () => {
    const main: SessionCostUsage = {
      anthropic: { 'claude-opus-5': { peak: bucket({ uncached: 10, cacheRead: 20, cacheWrite: 5, output: 3 }) } },
    }
    const child: SessionCostUsage = {
      anthropic: { 'claude-opus-5': { peak: bucket({ uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 }) } },
    }
    assert.deepEqual(mergeCostUsage([main, child]), {
      anthropic: { 'claude-opus-5': { peak: { uncached: 11, cacheRead: 22, cacheWrite: 8, output: 7 } } },
    })
  })

  test('the 1h cache-write share survives the merge and sums', () => {
    const main: SessionCostUsage = {
      anthropic: { 'claude-opus-5': { peak: bucket({ cacheWrite: 10, cacheWrite1h: 6 }) } },
    }
    const child: SessionCostUsage = {
      anthropic: { 'claude-opus-5': { peak: bucket({ cacheWrite: 4, cacheWrite1h: 4 }) } },
    }
    assert.deepEqual(mergeCostUsage([main, child]), {
      anthropic: { 'claude-opus-5': { peak: { uncached: 0, cacheRead: 0, cacheWrite: 14, output: 0, cacheWrite1h: 10 } } },
    })
  })

  test('a part with no 1h share leaves the merged bucket at the four-key shape', () => {
    const one: SessionCostUsage = { anthropic: { m: { peak: bucket({ cacheWrite: 10 }) } } }
    assert.deepEqual(mergeCostUsage([one, one]), {
      anthropic: { m: { peak: { uncached: 0, cacheRead: 0, cacheWrite: 20, output: 0 } } },
    })
  })

  test('different providers, models and periods stay side by side', () => {
    const a: SessionCostUsage = {
      anthropic: { 'claude-opus-5': { peak: bucket({ output: 1 }) } },
      deepseek: { 'deepseek-v4': { off: bucket({ output: 2 }) } },
    }
    const b: SessionCostUsage = {
      anthropic: { 'claude-haiku-5': { peak: bucket({ output: 4 }) } },
      deepseek: { 'deepseek-v4': { peak: bucket({ output: 8 }) } },
    }
    assert.deepEqual(mergeCostUsage([a, b]), {
      anthropic: {
        'claude-opus-5': { peak: bucket({ output: 1 }) },
        'claude-haiku-5': { peak: bucket({ output: 4 }) },
      },
      deepseek: {
        'deepseek-v4': { off: bucket({ output: 2 }), peak: bucket({ output: 8 }) },
      },
    })
  })

  test('the inputs are never mutated and the result never aliases them', () => {
    const main: SessionCostUsage = { anthropic: { m: { peak: bucket({ output: 1 }) } } }
    const child: SessionCostUsage = { anthropic: { m: { peak: bucket({ output: 2 }) } } }
    const merged = mergeCostUsage([main, child])
    assert.equal(main.anthropic?.m?.peak?.output, 1, 'the first part is untouched')
    assert.equal(child.anthropic?.m?.peak?.output, 2, 'the second part is untouched')
    assert.notEqual(merged?.anthropic, main.anthropic)
    assert.notEqual(merged?.anthropic?.m, main.anthropic?.m)
    assert.notEqual(merged?.anthropic?.m?.peak, main.anthropic?.m?.peak)
  })

  test('undefined parts drop out of the sum', () => {
    const one: SessionCostUsage = { anthropic: { m: { peak: bucket({ output: 7 }) } } }
    assert.deepEqual(mergeCostUsage([undefined, one, undefined]), {
      anthropic: { m: { peak: bucket({ output: 7 }) } },
    })
  })

  test('hostile branches are skipped and junk figures add zero, never NaN', () => {
    const hostile = {
      anthropic: 'not-a-record',
      openai: { 'gpt-6': 7, good: { peak: { uncached: 'x', cacheRead: Number.NaN, cacheWrite: null, output: 5 } } },
      bad: [1, 2, 3],
    } as unknown as SessionCostUsage
    const merged = mergeCostUsage([hostile])
    assert.deepEqual(merged, { openai: { good: { peak: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 5 } } } })
    assert.equal(Number.isNaN(merged?.openai?.good?.peak?.output), false)
  })

  test('an own __proto__ key never reaches the prototype', () => {
    const polluted = JSON.parse('{"__proto__":{"x":{"peak":{"output":1}}},"openai":{"__proto__":{"peak":{"output":1}},"m":{"peak":{"output":2}}}}') as SessionCostUsage
    const merged = mergeCostUsage([polluted])
    assert.deepEqual(merged, { openai: { m: { peak: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 2 } } } })
    assert.equal(({} as { x?: unknown }).x, undefined, 'Object.prototype is clean')
  })
})
