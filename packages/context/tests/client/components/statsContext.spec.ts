// StatsContext (src/client/components/statsContext.tsx) rendered with real
// React: the six-cell grid — session shape with the whole-session human-input
// tally, the chat-line cache-hit cell with its whole-session share tip, and
// the priced cost cell with its per-model rate tooltip — in both locales,
// against an injected model-price
// book (the store never reaches the network). The context-event tallies live
// on the events card's kind filters (contextView.spec.ts); `countsOfRecords`
// still derives every count the split generation's wire head carries, pinned
// here.

import { createElement as h } from 'react'
import assert from '../helpers/assert.ts'
import { describe, test, beforeEach, afterEach } from 'vitest'
import { countsOfRecords, makeStatsContext } from '../../../src/client/components/statsContext'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import type { ContextEventRecord, RequestRecord, SessionCostUsage, TokenUsage } from '../../../src/shared/types'
import { flush, makeKit, mount, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const StatsContext = makeStatsContext(kit)
const StatsContextZh = makeStatsContext(kitZh)

/** A minimal real-shaped slice of the models.dev /api.json payload. */
const PROVIDERS = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
  zhipuai: { models: { 'glm-5.3-flash': { cost: { input: 0.075, output: 0.25, cache_read: 0.015, cache_write: 0 } } } },
}

const COST: SessionCostUsage = {
  'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
}
// Prompt-side billed input 300 (100 uncached + 200 read) → hit 66.66% truncated.
const USAGE: TokenUsage = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 }

function req(turn?: number): RequestRecord {
  return {
    time: 0, seq: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...(turn !== undefined ? { turn } : {}),
  }
}

function ev(kind: ContextEventRecord['kind']): ContextEventRecord {
  return { seq: 0, time: 0, kind }
}

function cells(container: HTMLElement): { labels: string[]; values: string[] } {
  const grid = queryAll(container, '.lc-stat')
  return {
    labels: grid.map(el => el.querySelector('.lc-stat-label')?.textContent ?? ''),
    values: grid.map(el => el.querySelector('.lc-stat-value')?.textContent ?? ''),
  }
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(PROVIDERS))
})

afterEach(() => {
  resetModelPrices()
})

describe('countsOfRecords (the inline generation derivation)', () => {
  test('tallies distinct turns, records, and the three priced event kinds', () => {
    // Two steps in turn 1, one in turn 2, one without a turn (folds as turn 0).
    const counts = countsOfRecords(
      [req(1), req(1), req(2), req()],
      [ev('inject'), ev('inject'), ev('inject'), ev('compaction'), ev('compaction'), ev('prune'), ev('model'), ev('mode')],
    )
    // model/mode events do not appear (only the three priced kinds do).
    assert.deepEqual(counts, { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1 })
  })

  test('empty collections tally zero', () => {
    assert.deepEqual(countsOfRecords([], []), { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 })
  })
})

describe('StatsContext', () => {
  test('folds the six-cell grid: shape stats, the cache-hit cell, and cost', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1 },
      humanInputs: 7,
      toolCalls: 3,
      usage: USAGE,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(text(m.container).includes('Context Stats'))
    const { labels, values } = cells(m.container)
    assert.equal(labels.length, 6)
    assert.deepEqual(labels, ['Turns', 'Steps', 'Human Inputs?', 'Tool Calls', 'Cache Hit?', 'Cost?'])
    // 1M uncached input at the book's $0.15 miss rate.
    assert.deepEqual(values, ['3', '4', '7', '3', '66.66%', '$0.15'])
    await m.unmount()
  })

  test('absent counters, usage, and cost degrade to zeros and the dash', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(cells(m.container).values, ['0', '0', '0', '0', '—', '—'])
    await m.unmount()
    // A usage report with nothing billed prompt-side dashes the hit too.
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: zero,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(cells(m2.container).values, ['0', '0', '0', '0', '—', '—'])
    await m2.unmount()
  })

  test('the cost bubble lists the billed models with their book rates', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.equal(queryAll(m.container, '.lc-stat-tip').length, 3)
    assert.equal(queryAll(m.container, '.lc-stat-q').length, 3)
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.ok(tips[0]!.includes('question answerings'), 'the human-inputs tip explains its tally')
    assert.ok(tips[1]!.includes('Cumulative cache-read'), 'the cache-hit tip names the whole-session share')
    const costTip = tips[2]
    assert.ok(costTip!.includes('Per-1M-token rates:'))
    assert.ok(costTip!.includes('deepseek-v4-flash'))
    assert.ok(costTip!.includes('hit $0.003'))
    assert.ok(costTip!.includes('miss $0.15'))
    assert.ok(costTip!.includes('write $0.15'))
    assert.ok(costTip!.includes('output $0.6'))
    assert.ok(costTip!.includes('peak windows'), 'a DeepSeek session explains the peak/off-peak scheme')
    assert.ok(!costTip!.includes('peak|off-peak'), 'a peak-only session needs no pair header')
    await m.unmount()
  })

  test('a non-DeepSeek session never sees DeepSeek-specific notes', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: { 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2]!)
    assert.ok(costTip.includes('glm-5.3-flash'))
    assert.ok(!costTip.includes('DeepSeek'), 'the DeepSeek scheme note stays out of other providers’ bubbles')
    await m.unmount()
  })

  test('a multi-provider session names the provider on each model row', async () => {
    const two: SessionCostUsage = {
      'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: two,
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2]!)
    assert.ok(costTip.includes('deepseek-v4-flash · deepseek-official'))
    assert.ok(costTip.includes('glm-5.3-flash · zai-coding-cn'))
    // 1M × $0.15 + 2M × $0.075 = $0.30.
    assert.ok(cells(m.container).values.at(-1) === '$0.30')
    await m.unmount()
  })

  test('a partly priced session keeps its figure and names what it leaves out', async () => {
    // PORT ADDITION — the real case: a Codex session billing `codex-auto-review`
    // (not in models.dev) beside a priced model. The estimate is a floor, so
    // the cell prints it AND says which models it could not price.
    const mixed: SessionCostUsage = {
      'deepseek-official': {
        'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } },
        'codex-auto-review': { peak: { uncached: 5_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } },
      },
    }
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: mixed,
      locale: 'en',
    }))
    await flush()
    // Only the priced model's 1M uncached tokens reach the figure.
    assert.equal(cells(m.container).values.at(-1), '$0.15')
    const note = text(queryAll(m.container, '.lc-stat-note')[0]!)
    assert.ok(note.includes('excludes 1 model'), note)
    assert.ok(note.includes('codex-auto-review'), note)
    // A floor is still a figure: the outage copy stays out of the bubble.
    assert.ok(!text(queryAll(m.container, '.lc-stat-tip')[2]!).includes('unavailable'))
    await m.unmount()
  })

  test('a session the book prices none of dashes and keeps the outage note', async () => {
    const none: SessionCostUsage = {
      'deepseek-official': { 'codex-auto-review': { peak: { uncached: 5_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: none,
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m.container).values.at(-1), '—')
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[2]!).includes('Model prices are unavailable'))
    // Nothing priced is not a partial figure — no "excludes" line.
    assert.equal(queryAll(m.container, '.lc-stat-note').length, 0)
    await m.unmount()
  })

  test('a fully priced session carries no scope note at all', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.equal(queryAll(m.container, '.lc-stat-note').length, 0)
    await m.unmount()
  })

  test('a model that booked a 1-hour cache write prints that rate beside the 5m one', async () => {
    // `cacheWrite1h` is a SUBSET of `cacheWrite`; its presence is what makes
    // the higher rate part of the total, so the bubble has to show it.
    const with1h: SessionCostUsage = {
      'deepseek-official': {
        'deepseek-v4-flash': { peak: { uncached: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 400_000, output: 0 } },
      },
    }
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: with1h,
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2]!)
    // The book publishes no cache_write rate for this model, so both fall back
    // to the input rate ($0.15) and its 1h multiple.
    assert.ok(costTip.includes('write $0.15'), costTip)
    assert.ok(costTip.includes('1h $0.3'), costTip)
    await m.unmount()
  })

  test('a model without a 1-hour write keeps the original four rate cells', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(!text(queryAll(m.container, '.lc-stat-tip')[2]!).includes('1h'))
    await m.unmount()
  })

  test('several agents itemize the cost bubble and the cell names the scope', async () => {
    // PORT ADDITION — a session is one transcript per agent, so the caller
    // hands the cell the summed usage plus each agent's own share.
    const share = (uncached: number): SessionCostUsage => ({
      'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    })
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: share(3_000_000),
      costParts: [
        { id: 'main', label: 'Port the Context tab', cost: share(1_000_000) },
        { id: 'kid', label: 'Explore the repo', cost: share(2_000_000) },
        // An agent that never reached the model contributes no line.
        { id: 'idle', label: 'Never ran', cost: undefined },
      ],
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2]!)
    assert.ok(costTip.includes('By agent:'))
    assert.ok(costTip.includes('Port the Context tab · $0.15'))
    assert.ok(costTip.includes('Explore the repo · $0.30'))
    assert.ok(!costTip.includes('Never ran'), 'an unbilled agent has no line')
    assert.ok(costTip.includes('Total · $0.45'))
    // The per-1M rate list stays.
    assert.ok(costTip.includes('Per-1M-token rates:'))
    assert.equal(cells(m.container).values.at(-1), '$0.45')
    assert.equal(text(queryAll(m.container, '.lc-stat-note')[0]!), 'incl. 1 subagents')
    await m.unmount()
  })

  test('one billing agent keeps the bubble exactly as it was', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      costParts: [
        { id: 'main', label: 'Port the Context tab', cost: COST },
        { id: 'kid', label: 'Explore the repo', cost: undefined },
      ],
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2]!)
    assert.ok(!costTip.includes('By agent:'))
    assert.equal(queryAll(m.container, '.lc-stat-note').length, 0)
    await m.unmount()
  })

  test('the zh locale localizes labels and prices the cost in CNY at 1 CNY = 0.15 USD', async () => {
    const m = await mount(h(StatsContextZh, {
      counts: { turns: 1, steps: 1, injects: 0, compactions: 1, prunes: 0 },
      usage: USAGE,
      cost: COST,
      locale: 'zh',
    }))
    await flush()
    assert.ok(text(m.container).includes('上下文统计'))
    const { labels, values } = cells(m.container)
    assert.deepEqual(labels, ['轮次', '步数', '用户输入?', '工具调用', '缓存命中?', '预估费用?'])
    // $0.15 / 0.15 = ¥1; the rates convert through the same fixed rate.
    assert.deepEqual(values, ['1', '1', '0', '0', '66.66%', '¥1.00'])
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[1]!).includes('整个会话累计'), 'the cache-hit tip localizes too')
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2]!)
    assert.ok(costTip.includes('每百万 tokens 价格'))
    assert.ok(costTip.includes('命中 ¥0.02'))
    assert.ok(costTip.includes('未命中 ¥1'))
    assert.ok(costTip.includes('写入 ¥1'))
    assert.ok(costTip.includes('输出 ¥4'))
    await m.unmount()
  })

  test('usage with no book yet stays a dash until the fetch lands', async () => {
    setModelPricesLoader(() => new Promise(() => {}))
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: USAGE,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(cells(m.container).values.at(-1) === '—')
    assert.ok(!text(m.container).includes('unavailable'), 'a pending fetch is not a failure')
    await m.unmount()
  })

  test('a failed price fetch dashes the cell and notes the outage in the tip', async () => {
    setModelPricesLoader(() => Promise.reject(new Error('down')))
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: USAGE,
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(cells(m.container).values.at(-1) === '—')
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2]!)
    assert.ok(costTip.includes('unavailable'))
    assert.ok(!costTip.includes('Per-1M-token rates'))
    await m.unmount()
  })

  test('a DeepSeek off-peak bucket prices at half and the tooltip shows the peak|off pair', async () => {
    const split: SessionCostUsage = {
      'deepseek-official': {
        'deepseek-v4-flash': {
          peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          off: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    }
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: split,
      locale: 'en',
    }))
    await flush()
    // 1M at the $0.15 peak miss rate + 2M at the $0.075 half-price rate.
    assert.ok(cells(m.container).values.at(-1) === '$0.30')
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2]!)
    assert.ok(costTip.includes('Per-1M-token rates (peak|off-peak)'), 'an off-peak bucket names the pair in the header')
    assert.ok(costTip.includes('hit $0.003|$0.0015'))
    assert.ok(costTip.includes('miss $0.15|$0.075'))
    assert.ok(costTip.includes('write $0.15|$0.075'))
    assert.ok(costTip.includes('output $0.6|$0.3'))
    await m.unmount()
  })

  test('a session whose models the book cannot price notes the outage too', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: USAGE,
      cost: { 'future-provider': { 'mystery-model': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      locale: 'en',
    }))
    await flush()
    assert.ok(cells(m.container).values.at(-1) === '—')
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[2]!).includes('unavailable'))
    await m.unmount()
  })

  test('a hostile cost branch is skipped by the tooltip rows, not fatal', async () => {
    const hostile = {
      junk: 5,
      'zai-coding-cn': {
        'glm-5.3-flash': {
          peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    } as unknown as SessionCostUsage
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: USAGE,
      cost: hostile,
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[2]!)
    assert.ok(costTip.includes('glm-5.3-flash'))
    assert.ok(!costTip.includes('junk'))
    // No row may show the peak|off-peak pair — that is DeepSeek's alone.
    const rows = queryAll(m.container, '.lc-stat-tip-row').map(el => text(el))
    assert.ok(rows.every(r => !r.includes('|')))
    // Both buckets bill at list price: 2M × $0.075 — no half-price off-peak.
    assert.ok(cells(m.container).values.at(-1) === '$0.15')
    await m.unmount()
  })
})
