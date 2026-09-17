import { describe, expect, it } from 'vitest'
import { clampSettings, isModelPriceKey, modelPriceKeyOf, SETTINGS_DEFAULTS, splitModelPriceKey, validTimezone } from '../src/index.ts'

describe('isModelPriceKey', () => {
  it('accepts provider/model, provider/*, and a bare model id', () => {
    expect(isModelPriceKey('cognition/swe-2-max')).toBe(true)
    expect(isModelPriceKey('cognition/*')).toBe(true)
    expect(isModelPriceKey('swe-2-max')).toBe(true)
    // A model id may itself carry slashes — only the FIRST one splits.
    expect(isModelPriceKey('kimi-code/k3/extra')).toBe(true)
  })

  it('rejects empty keys and empty sides', () => {
    expect(isModelPriceKey('')).toBe(false)
    expect(isModelPriceKey('/model')).toBe(false)
    expect(isModelPriceKey('provider/')).toBe(false)
    expect(isModelPriceKey('/')).toBe(false)
  })
})

describe('splitModelPriceKey / modelPriceKeyOf', () => {
  it('splits at the first slash; a bare key has an empty provider', () => {
    expect(splitModelPriceKey('cognition/swe-2-max')).toEqual({ provider: 'cognition', model: 'swe-2-max' })
    expect(splitModelPriceKey('kimi-code/k3/extra')).toEqual({ provider: 'kimi-code', model: 'k3/extra' })
    expect(splitModelPriceKey('swe-2-max')).toEqual({ provider: '', model: 'swe-2-max' })
  })

  it('returns null for keys that name no concrete pair', () => {
    expect(splitModelPriceKey('')).toBeNull()
    expect(splitModelPriceKey('*')).toBeNull()
    expect(splitModelPriceKey('p/*')).toBeNull()
    expect(splitModelPriceKey('p/')).toBeNull()
    expect(splitModelPriceKey('/m')).toBeNull()
  })

  it('modelPriceKeyOf inverts the split', () => {
    expect(modelPriceKeyOf('cognition', 'swe-2-max')).toBe('cognition/swe-2-max')
    expect(modelPriceKeyOf('', 'swe-2-max')).toBe('swe-2-max')
  })
})

describe('validTimezone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(validTimezone('Asia/Shanghai')).toBe(true)
    expect(validTimezone('UTC')).toBe(true)
    expect(validTimezone('Not/AZone')).toBe(false)
  })
})

describe('clampSettings modelPricing', () => {
  it('leaves modelPricing absent unless something usable was configured', () => {
    expect(clampSettings({}).modelPricing).toBeUndefined()
    expect(clampSettings({ modelPricing: 'junk' }).modelPricing).toBeUndefined()
    expect(clampSettings({ modelPricing: [] }).modelPricing).toBeUndefined()
    expect(clampSettings({ modelPricing: {} }).modelPricing).toBeUndefined()
    expect(clampSettings({ modelPricing: { '': { alias: 'a/b' }, x: 4 } }).modelPricing).toBeUndefined()
  })

  it('round-trips a complete rule — alias, rates, and a full off-peak schedule', () => {
    const rule = {
      alias: 'deepseek/deepseek-v4-flash',
      rates: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15, cacheWrite1h: 0.3 },
      offPeak: {
        peakHours: [[9, 12], [14.5, 18]],
        timezone: 'Asia/Shanghai',
        weekdaysOnly: true,
        factor: 0.5,
      },
    }
    const out = clampSettings({ modelPricing: { 'cognition/swe-2-max': rule } })
    expect(out.modelPricing?.['cognition/swe-2-max']).toEqual(rule)
    // The unrelated fields still clamp on their own.
    expect(out.contentSearch).toBe(SETTINGS_DEFAULTS.contentSearch)
    expect(out.searchMaxAgeDays).toBe(SETTINGS_DEFAULTS.searchMaxAgeDays)
  })

  it('drops rules that can price nothing but keeps the salvageable ones', () => {
    const out = clampSettings({
      modelPricing: {
        'no-price': {},
        'bad-alias': { alias: 'noid' },
        'bad-rates': { rates: { input: 1 } },
        'bad-key/': { alias: 'a/b' },
        ok: { rates: { input: 0.1, output: 0.2 } },
      },
    })
    expect(out.modelPricing).toEqual({ ok: { rates: { input: 0.1, output: 0.2 } } })
  })

  it('keeps optional rate fields only when they are finite non-negative numbers', () => {
    const out = clampSettings({
      modelPricing: {
        m: { rates: { input: 1, output: 2, cacheRead: -1, cacheWrite: 'x', cacheWrite1h: 0.5 } },
      },
    })
    expect(out.modelPricing?.m?.rates).toEqual({ input: 1, output: 2, cacheWrite1h: 0.5 })
  })

  it('an invalid offPeak drops only that member — the rate mapping stands', () => {
    const base = { rates: { input: 1, output: 2 } }
    // No peakHours at all.
    expect(clampSettings({ modelPricing: { m: { ...base, offPeak: { factor: 0.5 } } } })
      .modelPricing?.m).toEqual(base)
    // No factor and no off rates.
    expect(clampSettings({ modelPricing: { m: { ...base, offPeak: { peakHours: [[9, 12]] } } } })
      .modelPricing?.m).toEqual(base)
    // Every window invalid.
    expect(clampSettings({ modelPricing: { m: { ...base, offPeak: { peakHours: [[12, 9]], factor: 0.5 } } } })
      .modelPricing?.m).toEqual(base)
  })

  it('filters malformed peak windows but keeps the valid ones', () => {
    const out = clampSettings({
      modelPricing: {
        m: {
          rates: { input: 1, output: 2 },
          offPeak: { peakHours: [[9, 12], [18, 9], [9, 25], 'x', [1]], factor: 0.5 },
        },
      },
    })
    expect(out.modelPricing?.m?.offPeak?.peakHours).toEqual([[9, 12]])
  })

  it('drops an unresolvable timezone and a false weekdaysOnly, keeps the rest', () => {
    const out = clampSettings({
      modelPricing: {
        m: {
          rates: { input: 1, output: 2 },
          offPeak: { peakHours: [[9, 12]], factor: 0.25, timezone: 'Not/AZone', weekdaysOnly: false },
        },
      },
    })
    expect(out.modelPricing?.m?.offPeak).toEqual({ peakHours: [[9, 12]], factor: 0.25 })
  })

  it('accepts explicit off-peak rates instead of a factor', () => {
    const out = clampSettings({
      modelPricing: {
        m: {
          rates: { input: 1, output: 2 },
          offPeak: { peakHours: [[9, 12]], rates: { input: 0.5, output: 1 } },
        },
      },
    })
    expect(out.modelPricing?.m?.offPeak).toEqual({ peakHours: [[9, 12]], rates: { input: 0.5, output: 1 } })
  })

  it('does not let a junk modelPricing field reset the other settings', () => {
    const out = clampSettings({ contentSearch: true, searchMaxAgeDays: 7, modelPricing: 42 })
    expect(out).toEqual({ contentSearch: true, searchMaxAgeDays: 7 })
  })
})
