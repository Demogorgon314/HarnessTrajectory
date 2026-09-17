// Session-cost estimate (src/client/cost.ts): the model-price-book lookup
// (exact, case-insensitive, and the unambiguous cross-provider fallback), the
// USD→CNY conversion at the fixed 1 CNY = 0.15 USD, the null degradations,
// the numOf coercion of garbage bucket fields, and the money/rate formatting.

import assert from './helpers/assert.ts'
import { describe, test } from 'vitest'
import { estimateSessionCost, formatCost, formatPriceRate, offPeakOf, offRateOf, priceOf, toCurrency, tripleOf, unpricedCostModels, unpricedCostPairs, write1hOf } from '../../src/client/cost'
import type { ModelPrices } from '../../src/client/cost'
import type { ModelPriceRules } from '@harness-trajectory/core'
import type { CostBucketTotals } from '../../src/shared/types'

const M = 1_000_000

/** Real-shaped rates (deepseek-v4-flash on models.dev, no cache_write published). */
const FLASH = { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 }
const PRO = { hit: 0.003625, miss: 0.435, write: 0.435, out: 0.87 }
const KIMI = { hit: 0.19, miss: 0.95, write: 0.95, out: 4 }
const K3 = { hit: 0.3, miss: 3, write: 3, out: 15 }

/** The book is keyed by the models.dev provider ids, exactly as extracted. */
const BOOK: ModelPrices = {
  deepseek: { 'deepseek-v4-flash': FLASH, 'deepseek-v4-pro': PRO },
  moonshotai: { 'kimi-k2.7-code': KIMI, 'kimi-k3': K3 },
  'opencode-go': { 'deepseek-v4-flash': FLASH },
}

function bucket(cacheRead: number, uncached: number, cacheWrite: number, output: number): CostBucketTotals {
  return { cacheRead, uncached, cacheWrite, output }
}

function close(actual: number | null, expected: number, message?: string): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, message ?? `expected ~${expected}, got ${actual}`)
}

describe('toCurrency', () => {
  test('USD passes through; CNY divides the fixed 0.15 rate', () => {
    assert.equal(toCurrency(1.2, 'usd'), 1.2)
    close(toCurrency(1.2, 'cny'), 8)
    close(toCurrency(0.3, 'cny'), 2)
  })
})

describe('priceOf', () => {
  test('a mapped dsh provider id resolves to its models.dev branch', () => {
    assert.equal(priceOf(BOOK, 'deepseek-official', 'deepseek-v4-flash'), FLASH)
    assert.equal(priceOf(BOOK, 'kimi-coding', 'kimi-k2.7-code'), KIMI)
  })

  test('an unmapped dsh provider id passes through to the book verbatim', () => {
    assert.equal(priceOf(BOOK, 'opencode-go', 'deepseek-v4-flash'), FLASH)
    assert.equal(priceOf({ anthropic: { claude: KIMI } }, 'anthropic', 'claude'), KIMI)
  })

  test('a known provider falls back to a case-insensitive model match', () => {
    assert.equal(priceOf({ minimax: { 'MiniMax-M2.5': KIMI } }, 'minimax-cn', 'minimax-m2.5'), KIMI)
  })

  test('a short dsh model id suffix-matches its namespaced registry id', () => {
    assert.equal(priceOf(BOOK, 'kimi-coding', 'k3'), K3)
    assert.equal(priceOf(BOOK, 'kimi-coding', 'K3'), K3, 'the suffix tier is case-insensitive too')
  })

  test('several suffix candidates in one branch are ambiguous', () => {
    const book: ModelPrices = { moonshotai: { 'kimi-k3': K3, 'other-k3': KIMI } }
    assert.equal(priceOf(book, 'kimi-coding', 'k3'), null)
  })

  test('a known provider missing the model falls back to the book-wide scan', () => {
    // deepseek's own branch lacks the id; moonshotai is its only carrier.
    assert.equal(priceOf(BOOK, 'deepseek', 'kimi-k2.7-code'), KIMI)
    assert.equal(priceOf(BOOK, 'deepseek', 'mystery'), null, 'no branch carries it')
  })

  test('a provider the book does not carry prices the model only when unambiguous book-wide', () => {
    assert.equal(priceOf(BOOK, '', 'kimi-k2.7-code'), KIMI, 'unambiguous: exactly one branch carries it')
    assert.equal(priceOf(BOOK, 'future-provider', 'kimi-k2.7-code'), KIMI)
    assert.equal(priceOf(BOOK, '', 'deepseek-v4-flash'), FLASH, 'two carriers, but the vendor is one of them')
    assert.equal(priceOf(BOOK, '', 'mystery'), null)
  })

  test('several carriers resolve to the model\'s own vendor (the official list)', () => {
    // Billed under another provider's client id: the vendor branch wins over
    // a reseller's re-pricing of the same id.
    const book: ModelPrices = {
      anthropic: { 'claude-opus-5': K3 },
      mirror: { 'claude-opus-5': KIMI },
    }
    assert.equal(priceOf(book, 'openai', 'claude-opus-5'), K3, 'claude → anthropic')
    assert.equal(priceOf(book, 'openai', 'claude-opus-5[1m]'), K3, 'the routed id too')
    const gpt: ModelPrices = { azure: { 'gpt-9': KIMI }, openai: { 'gpt-9': PRO } }
    assert.equal(priceOf(gpt, 'copilot', 'gpt-9'), PRO, 'the billed client id prices at the vendor\'s list, not the reseller\'s')
    const miss: ModelPrices = { openai: { 'other-model': KIMI }, azure: { 'gpt-9': PRO } }
    assert.equal(priceOf(miss, 'openai', 'gpt-9'), PRO, 'the billed branch misses → the unique carrier prices')
    const prefixed: ModelPrices = { deepseek: { 'deepseek-v9': PRO }, reseller: { 'deepseek-v9': K3 } }
    assert.equal(priceOf(prefixed, 'kilo', 'deepseek-v9'), PRO, 'the model id prefixes the vendor provider id')
  })

  test('several carriers with no vendor among them still price nothing', () => {
    const book: ModelPrices = { 'reseller-a': { 'acme-x': KIMI }, 'reseller-b': { 'acme-x': K3 } }
    assert.equal(priceOf(book, 'openai', 'acme-x'), null)
    assert.equal(priceOf(book, '', 'acme-x'), null)
  })

  test('a null or missing book prices nothing', () => {
    assert.equal(priceOf(null, 'deepseek-official', 'deepseek-v4-flash'), null)
    assert.equal(priceOf(undefined, '', 'kimi-k2.7-code'), null)
  })
})

describe('estimateSessionCost', () => {
  test('null usage or null book prices to null', () => {
    assert.equal(estimateSessionCost(null, BOOK, 'usd'), null)
    assert.equal(estimateSessionCost(undefined, BOOK, 'cny'), null)
    assert.equal(estimateSessionCost({}, null, 'usd'), null)
  })

  test('usage without any priced bucket returns null', () => {
    assert.equal(estimateSessionCost({}, BOOK, 'usd'), null)
    assert.equal(estimateSessionCost({ 'deepseek-official': { unknown: { peak: bucket(0, M, 0, 0) } } }, BOOK, 'usd'), null)
    assert.equal(estimateSessionCost({ unmapped: { 'acme-x': { peak: bucket(0, M, 0, 0) } } }, BOOK, 'usd'), null)
  })

  test('prices every period bucket at its own rate (hit / miss / write / out)', () => {
    const usage = {
      'deepseek-official': {
        'deepseek-v4-flash': { peak: bucket(M, M, M, M) },
        'deepseek-v4-pro': { peak: bucket(M, M, M, M) },
      },
      'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, M) } },
    }
    close(estimateSessionCost(usage, BOOK, 'usd'), 0.903 + (0.003625 + 0.435 + 0.435 + 0.87) + 0.95 + 4)
  })

  test('off-peak buckets price at half the book rate for DeepSeek only', () => {
    const split = { peak: bucket(0, M, 0, 0), off: bucket(0, M, 0, 0) }
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': split } }, BOOK, 'usd'), 0.15 + 0.075)
    close(
      estimateSessionCost({ 'kimi-coding': { 'kimi-k2.7-code': split } }, BOOK, 'usd'),
      0.95 + 0.95,
      'a flat-rate provider bills an off bucket at list price, never half',
    )
  })

  test('a missing model is skipped while priced ones still sum', () => {
    const usage = { 'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, BOOK, 'usd'), 0.95)
  })

  test('the CNY currency converts the USD total at 1 CNY = 0.15 USD', () => {
    const usage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, BOOK, 'cny'), 1)
  })

  test('non-number bucket fields are coerced to zero by numOf', () => {
    const garbage = { cacheRead: NaN, uncached: 'x', cacheWrite: undefined, output: Infinity } as unknown as CostBucketTotals
    assert.equal(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': { peak: garbage } } }, BOOK, 'usd'), 0)
  })

  test('garbage fields degrade while real fields still price', () => {
    const mixed = { cacheRead: M, uncached: NaN, cacheWrite: M / 2, output: 'junk' } as unknown as CostBucketTotals
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': { peak: mixed } } }, BOOK, 'usd'), 0.003 + 0.5 * 0.15)
  })

  test('hostile provider branches, periods, and buckets are skipped, not fatal', () => {
    const usage = {
      junk: 'x',
      'kimi-coding': { broken: null, 'kimi-k2.7-code': { peak: 'junk', off: bucket(0, M, 0, 0) } },
      'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } },
    } as unknown as { [provider: string]: Record<string, Record<string, CostBucketTotals>> }
    close(estimateSessionCost(usage, BOOK, 'usd'), 0.15 + 0.95)
  })
})

describe('offPeakOf', () => {
  test('halves every rate component', () => {
    assert.deepEqual(offPeakOf(FLASH), { hit: 0.0015, miss: 0.075, write: 0.075, out: 0.3 })
  })

  test('halves a published 1h rate too, and stays absent without one', () => {
    assert.deepEqual(offPeakOf({ ...FLASH, write1h: 0.3 }), {
      hit: 0.0015, miss: 0.075, write: 0.075, out: 0.3, write1h: 0.15,
    })
    assert.ok(!('write1h' in offPeakOf(FLASH)))
  })
})

describe('routed model ids', () => {
  // Claude Code names the 1M-context ROUTE `claude-opus-5[1m]` and books its
  // cost under that exact id; the registry carries only the base id.
  const OPUS = { hit: 0.5, miss: 5, write: 6.25, out: 25 }
  const TAGGED: ModelPrices = { anthropic: { 'claude-opus-5': OPUS } }

  test('a tagged id prices off its untagged base id', () => {
    assert.equal(priceOf(TAGGED, 'anthropic', 'claude-opus-5[1m]'), OPUS)
    assert.equal(priceOf(TAGGED, 'anthropic', 'claude-opus-5'), OPUS)
  })

  test('the exact tagged key still wins when the registry carries one', () => {
    const book: ModelPrices = { anthropic: { 'claude-opus-5': OPUS, 'claude-opus-5[1m]': K3 } }
    assert.equal(priceOf(book, 'anthropic', 'claude-opus-5[1m]'), K3)
  })

  test('stripping a tag never reaches a DIFFERENT model', () => {
    const book: ModelPrices = { anthropic: { 'claude-opus-5-1': OPUS } }
    assert.equal(priceOf(book, 'anthropic', 'claude-opus-5[1m]'), null)
    assert.equal(priceOf(book, 'anthropic', 'claude-opus-5'), null)
  })

  test('the cross-provider fallback untags too, and stays ambiguity-safe', () => {
    assert.equal(priceOf(TAGGED, 'future-provider', 'claude-opus-5[1m]'), OPUS)
    // Two carriers resolve to the vendor (claude → anthropic), not a guess.
    const two: ModelPrices = { anthropic: { 'claude-opus-5': OPUS }, mirror: { 'claude-opus-5': K3 } }
    assert.equal(priceOf(two, 'future-provider', 'claude-opus-5[1m]'), OPUS)
    // Two carriers, neither the model's vendor: still no guess.
    const resellers: ModelPrices = { 'reseller-a': { 'acme-9': K3 }, 'reseller-b': { 'acme-9': OPUS } }
    assert.equal(priceOf(resellers, 'future-provider', 'acme-9[1m]'), null)
  })
})

describe('1h cache writes', () => {
  const OPUS = { hit: 0.5, miss: 5, write: 6.25, out: 25 }
  const BOOK_1H: ModelPrices = { anthropic: { 'claude-opus-5': OPUS } }

  test('the derived 1h rate is twice the input rate; a published one wins', () => {
    assert.equal(write1hOf(OPUS), 10)
    assert.equal(write1hOf({ ...OPUS, write1h: 9 }), 9)
  })

  test('the 1h share bills at the 1h rate and the remainder at the 5m rate', () => {
    const usage = { anthropic: { 'claude-opus-5[1m]': { peak: { ...bucket(0, 0, M, 0), cacheWrite1h: M / 2 } } } }
    // Half a million at $10/M + half a million at $6.25/M.
    close(estimateSessionCost(usage, BOOK_1H, 'usd'), 5 + 3.125)
  })

  test('a write bucket with no 1h share bills entirely at the 5m rate', () => {
    const usage = { anthropic: { 'claude-opus-5': { peak: bucket(0, 0, M, 0) } } }
    close(estimateSessionCost(usage, BOOK_1H, 'usd'), 6.25)
  })

  test('a 1h share beyond the write bucket cannot bill more tokens than were written', () => {
    const usage = { anthropic: { 'claude-opus-5': { peak: { ...bucket(0, 0, M, 0), cacheWrite1h: 5 * M } } } }
    close(estimateSessionCost(usage, BOOK_1H, 'usd'), 10)
  })

  test('a negative 1h share is ignored rather than crediting the write bucket', () => {
    const usage = { anthropic: { 'claude-opus-5': { peak: { ...bucket(0, 0, M, 0), cacheWrite1h: -5 * M } } } }
    close(estimateSessionCost(usage, BOOK_1H, 'usd'), 6.25)
  })
})

describe('unpricedCostModels', () => {
  test('names only the billed models the book cannot price', () => {
    const usage = {
      deepseek: { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) }, 'mystery-model': { peak: bucket(0, M, 0, 0) } },
    }
    assert.deepEqual(unpricedCostModels(usage, BOOK), ['mystery-model'])
  })

  test('a fully priced session names nothing', () => {
    assert.deepEqual(unpricedCostModels({ deepseek: { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }, BOOK), [])
  })

  test('a routed id counts as priced once its base id resolves', () => {
    const book: ModelPrices = { anthropic: { 'claude-opus-5': { hit: 0.5, miss: 5, write: 6.25, out: 25 } } }
    assert.deepEqual(unpricedCostModels({ anthropic: { 'claude-opus-5[1m]': { peak: bucket(0, M, 0, 0) } } }, book), [])
  })

  test('no book at all means every billed model is unpriced', () => {
    const usage = { deepseek: { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }
    assert.deepEqual(unpricedCostModels(usage, null), ['deepseek-v4-flash'])
    assert.deepEqual(unpricedCostModels(null, BOOK), [])
  })

  test('a multi-provider session qualifies each name with its provider', () => {
    const usage = {
      deepseek: { 'mystery-model': { peak: bucket(0, M, 0, 0) } },
      anthropic: { 'other-model': { peak: bucket(0, M, 0, 0) } },
    }
    assert.deepEqual(unpricedCostModels(usage, BOOK), ['mystery-model · deepseek', 'other-model · anthropic'])
  })
})

describe('formatCost', () => {
  test('amounts of at least 1 use fixed two-decimal notation', () => {
    assert.equal(formatCost(3.456, 'usd'), '$3.46')
    assert.equal(formatCost(1, 'usd'), '$1.00')
  })

  test('amounts below 1 use two-significant-digit precision', () => {
    assert.equal(formatCost(0.014, 'usd'), '$0.014')
    assert.equal(formatCost(0.5, 'usd'), '$0.50')
  })

  test('the CNY currency uses the yen symbol', () => {
    assert.equal(formatCost(12.3, 'cny'), '¥12.30')
    assert.equal(formatCost(0.66, 'cny'), '¥0.66')
  })
})

describe('formatPriceRate', () => {
  test('trims trailing zeros from a fixed-notation figure', () => {
    assert.equal(formatPriceRate(3.0, 'cny'), '¥3')
    assert.equal(formatPriceRate(4.5, 'cny'), '¥4.5')
  })

  test('trims trailing zeros from a precision-notation figure', () => {
    assert.equal(formatPriceRate(0.007, 'usd'), '$0.007')
    assert.equal(formatPriceRate(0.1, 'usd'), '$0.1')
  })

  test('strips the dot left behind when every decimal was a zero', () => {
    assert.equal(formatPriceRate(9.0, 'cny'), '¥9')
    assert.equal(formatPriceRate(1.5, 'cny'), '¥1.5')
  })
})

describe('user price rules', () => {
  // K3's book rates are {hit: .3, miss: 3, write: 3, out: 15}.
  const RULES: ModelPriceRules = {
    'cognition/swe-2-max': { alias: 'moonshotai/kimi-k3' },
    'cognition/swe-lite': { rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5, cacheWrite1h: 3 } },
    'peak-billed': { rates: { input: 2, output: 4 }, offPeak: { peakHours: [[9, 12]], factor: 0.25 } },
    'off-card': { rates: { input: 2, output: 4 }, offPeak: { peakHours: [[9, 12]], rates: { input: 0.5, output: 1 } } },
  }

  test('an alias borrows the named registry entry', () => {
    assert.equal(priceOf(BOOK, 'cognition', 'swe-2-max', RULES), K3)
  })

  test('an alias the book lacks falls back to the rule’s own rates', () => {
    const rules: ModelPriceRules = { 'x/y': { alias: 'nowhere/model', rates: { input: 7, output: 8 } } }
    assert.deepEqual(priceOf(BOOK, 'x', 'y', rules), { hit: 7, miss: 7, write: 7, out: 8 })
    // With no fallback card the model stays honestly unpriced.
    assert.equal(priceOf(BOOK, 'x', 'y', { 'x/y': { alias: 'nowhere/model' } }), null)
  })

  test('an alias never chains back into the rules', () => {
    // 'x/y' aliases to a key only the RULES table prices — the book has no
    // 'cognition' branch, so the alias misses and the fallback card bills.
    const rules: ModelPriceRules = {
      ...RULES,
      'x/y': { alias: 'cognition/swe-lite', rates: { input: 9, output: 9 } },
    }
    assert.deepEqual(priceOf(BOOK, 'x', 'y', rules), { hit: 9, miss: 9, write: 9, out: 9 })
  })

  test('a rates-only rule prices even with no book at all', () => {
    assert.deepEqual(priceOf(null, 'cognition', 'swe-lite', RULES), {
      hit: 0.1, miss: 1, write: 1.5, out: 2, write1h: 3,
    })
  })

  test('a rule shadows the book’s own entry', () => {
    const rules: ModelPriceRules = { 'deepseek-official/deepseek-v4-flash': { rates: { input: 1, output: 1 } } }
    assert.deepEqual(priceOf(BOOK, 'deepseek-official', 'deepseek-v4-flash', rules), {
      hit: 1, miss: 1, write: 1, out: 1,
    })
  })

  test('unmatched models keep the registry path untouched', () => {
    assert.equal(priceOf(BOOK, 'deepseek-official', 'deepseek-v4-flash', RULES), FLASH)
    assert.equal(priceOf(BOOK, 'elsewhere', 'unknown', RULES), null)
  })

  test('tripleOf fills absent cache fields with the input rate, like the book does', () => {
    assert.deepEqual(tripleOf({ input: 2, output: 8 }), { hit: 2, miss: 2, write: 2, out: 8 })
    assert.deepEqual(tripleOf({ input: 2, output: 8, cacheRead: 0.5, cacheWrite1h: 4 }), {
      hit: 0.5, miss: 2, write: 2, out: 8, write1h: 4,
    })
  })

  test('offRateOf: rule card > rule factor > the provider’s built-in scheme', () => {
    const rate = { hit: 1, miss: 2, write: 2, out: 4 }
    assert.deepEqual(
      offRateOf(RULES['off-card'] ?? null, 'x', rate),
      { hit: 0.5, miss: 0.5, write: 0.5, out: 1 },
      'an explicit off-peak card prices the off buckets outright',
    )
    assert.deepEqual(
      offRateOf(RULES['peak-billed'] ?? null, 'x', rate),
      { hit: 0.25, miss: 0.5, write: 0.5, out: 1 },
      'a factor discounts every component of the peak card',
    )
    assert.deepEqual(offRateOf(null, 'deepseek-official', rate), { hit: 0.5, miss: 1, write: 1, out: 2 })
    assert.deepEqual(offRateOf(null, 'x', rate), rate, 'a flat provider’s off bucket bills at list')
  })

  test('estimateSessionCost prices a rule-matched model the book lacks', () => {
    const usage = { cognition: { 'swe-lite': { peak: bucket(0, M, 0, M) } } }
    close(estimateSessionCost(usage, null, 'usd', RULES), 1 + 2, 'no book needed — the rule states the card')
    close(estimateSessionCost(usage, BOOK, 'usd', RULES), 1 + 2)
  })

  test('estimateSessionCost prices the off bucket through the rule’s offPeak', () => {
    const usage = { anywhere: { 'peak-billed': { peak: bucket(0, M, 0, 0), off: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, null, 'usd', RULES), 2 + 0.5, 'off = 0.25 × the $2 input rate')
    const card = { anywhere: { 'off-card': { off: bucket(0, M, 0, M) } } }
    close(estimateSessionCost(card, null, 'usd', RULES), 0.5 + 1, 'explicit off rates bill as stated')
  })

  test('a rule without offPeak leaves DeepSeek’s built-in halving in force', () => {
    const rules: ModelPriceRules = { 'deepseek-official/*': { rates: { input: 2, output: 6 } } }
    const usage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0), off: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, null, 'usd', rules), 2 + 1, 'the rule reprices; the schedule stays DeepSeek’s')
  })

  test('unpricedCostPairs shrinks to what no rule and no book prices', () => {
    const usage = {
      cognition: { 'swe-2-max': { peak: bucket(0, M, 0, 0) }, 'swe-mini': { peak: bucket(0, M, 0, 0) } },
    }
    assert.deepEqual(unpricedCostPairs(usage, BOOK, RULES), [
      { provider: 'cognition', model: 'swe-mini', label: 'swe-mini' },
    ])
    assert.deepEqual(unpricedCostModels(usage, BOOK, RULES), ['swe-mini'])
    assert.deepEqual(unpricedCostPairs(usage, BOOK), [
      { provider: 'cognition', model: 'swe-2-max', label: 'swe-2-max' },
      { provider: 'cognition', model: 'swe-mini', label: 'swe-mini' },
    ])
  })
})
