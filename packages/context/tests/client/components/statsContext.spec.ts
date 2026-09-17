// StatsContext (src/client/components/statsContext.tsx) rendered with real
// React: the twelve-cell grid — session shape with the whole-session
// human-input tally, the chat-line cache-hit cell with its whole-session share
// tip, the priced cost cell with its per-model rate tooltip, and the derived
// second row (peak occupancy, wall-clock duration, compactions, subagents,
// cost per prompt, live images) — in both locales, against an injected
// model-price book (the store never reaches the network). The derived row's
// pure model (peakContextOf / durationOf / costPerPromptOf) is pinned on its
// own below the render tests. The context-event tallies live
// on the events card's kind filters (contextView.spec.ts); `countsOfRecords`
// still derives every count the split generation's wire head carries, pinned
// here.

import { createElement as h } from 'react'
import assert from '../helpers/assert.ts'
import { describe, test, beforeEach, afterEach } from 'vitest'
import { costPerPromptOf, countsOfRecords, durationOf, makeStatsContext, peakContextOf } from '../../../src/client/components/statsContext'
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

/** The Cost cell's figure — the last tile of the count row (index 5 of twelve). */
function costOf(container: HTMLElement): string {
  return cells(container).values[5] ?? ''
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
  test('folds the twelve-cell grid: shape stats, the cache-hit cell, cost, and the derived row', async () => {
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
    assert.equal(labels.length, 12)
    assert.deepEqual(labels, [
      'Turns', 'Steps', 'Human Inputs?', 'Tool Calls', 'Cache Hit?', 'Cost?',
      'Peak Context?', 'Duration?', 'Compactions?', 'Subagents?', 'Cost / Prompt?', 'Images?',
    ])
    // 1M uncached input at the book's $0.15 miss rate; $0.15 over 7 prompts is
    // $0.021. No records were handed in, so the two derived cells dash, and a
    // caller that knows of no agent family dashes the subagent cell.
    assert.deepEqual(values, ['3', '4', '7', '3', '66.66%', '$0.15', '—', '—', '2', '—', '$0.021', '0'])
    await m.unmount()
  })

  test('absent counters, usage, and cost degrade to zeros and the dash', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(cells(m.container).values, ['0', '0', '0', '0', '—', '—', '—', '—', '0', '—', '—', '0'])
    await m.unmount()
    // A usage report with nothing billed prompt-side dashes the hit too.
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: zero,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(cells(m2.container).values, ['0', '0', '0', '0', '—', '—', '—', '—', '0', '—', '—', '0'])
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
    // Nine of the twelve cells carry a bubble; the cost cell's is the third,
    // so the count row's tip order is unchanged by the derived row below it.
    assert.equal(queryAll(m.container, '.lc-stat-tip').length, 9)
    assert.equal(queryAll(m.container, '.lc-stat-q').length, 9)
    // PORT CHANGE — the bubble reveals from the badge only: it is a focusable button
    // that names its bubble, and neither the cell nor the bubble carries dsh's
    // whole-cell `group-hover/tip` reveal any more.
    for (const badge of queryAll(m.container, '.lc-stat-q')) {
      assert.equal(badge.tagName, 'BUTTON')
      assert.equal(badge.getAttribute('type'), 'button')
      const target = badge.getAttribute('aria-describedby')
      assert.ok(target, 'the badge points at its bubble')
      assert.equal(m.container.ownerDocument.getElementById(target!)?.getAttribute('role'), 'tooltip')
    }
    assert.equal(queryAll(m.container, '.group\\/tip').length, 0)
    assert.equal(m.container.innerHTML.includes('group-hover/tip'), false)
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
    assert.ok(costOf(m.container) === '$0.30')
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
    assert.equal(costOf(m.container), '$0.15')
    const note = text(queryAll(m.container, '.lc-stat-note')[0]!)
    assert.ok(note.includes('excludes 1 model'), note)
    assert.ok(note.includes('codex-auto-review'), note)
    // A floor is still a figure: the outage copy stays out of the bubble.
    assert.ok(!text(queryAll(m.container, '.lc-stat-tip')[2]!).includes('unavailable'))
    await m.unmount()
  })

  test('a session the book prices none of dashes and names the unpriced models', async () => {
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
    assert.equal(costOf(m.container), '—')
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[2]!).includes('Model prices are unavailable'))
    // Nothing priced still names what it could not price — that is precisely
    // where the "add a price rule" entry belongs.
    const note = text(queryAll(m.container, '.lc-stat-note')[0]!)
    assert.ok(note.includes('none of the 1 billed model'), note)
    assert.ok(note.includes('codex-auto-review'), note)
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
    assert.equal(costOf(m.container), '$0.45')
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
    assert.deepEqual(labels, [
      '轮次', '步数', '用户输入?', '工具调用', '缓存命中?', '预估费用?',
      '峰值上下文?', '总时长?', '压缩次数?', '子 Agent?', '每次输入费用?', '图片?',
    ])
    // $0.15 / 0.15 = ¥1; the rates convert through the same fixed rate.
    assert.deepEqual(values, ['1', '1', '0', '0', '66.66%', '¥1.00', '—', '—', '1', '—', '—', '0'])
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
    assert.ok(costOf(m.container) === '—')
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
    assert.ok(costOf(m.container) === '—')
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
    assert.ok(costOf(m.container) === '$0.30')
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
    assert.ok(costOf(m.container) === '—')
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
    assert.ok(costOf(m.container) === '$0.15')
    await m.unmount()
  })
})

/** One request record at a stamp, with whatever billing fields the case needs. */
function rec(time: number, fields: Partial<RequestRecord> = {}): RequestRecord {
  return { ...req(), time, ...fields }
}

/** One context event at a stamp. */
function evAt(time: number, kind: ContextEventRecord['kind'] = 'compaction'): ContextEventRecord {
  return { seq: 0, time, kind }
}

describe('the derived row’s pure model', () => {
  test('peakContextOf takes the provider-reported prompt, falling back to the heuristic total', () => {
    assert.equal(peakContextOf([rec(0, { prompt: 100, total: 9_999 }), rec(1, { prompt: 300, total: 1 })]), 300)
    // A row folded before the fold carried `prompt` contributes its own total.
    assert.equal(peakContextOf([rec(0, { prompt: 100 }), rec(1, { total: 250 })]), 250)
    assert.equal(peakContextOf([]), null, 'no records, no peak')
    assert.equal(peakContextOf([rec(0)]), null, 'an all-zero log is not a measurement')
  })

  test('durationOf spans the first request to the last stamp in the log', () => {
    assert.equal(durationOf([], []), null)
    assert.equal(durationOf([rec(1_000)], []), null, 'one stamp spans nothing')
    assert.equal(durationOf([rec(1_000), rec(3_000), rec(9_000)], []), 8_000)
    // A compaction can land after the final request — the span has to include it.
    assert.equal(durationOf([rec(1_000), rec(3_000)], [evAt(9_000)]), 8_000)
    // An event inside the span never shortens it.
    assert.equal(durationOf([rec(1_000), rec(9_000)], [evAt(2_000)]), 8_000)
    // Out-of-order records still yield the true span.
    assert.equal(durationOf([rec(9_000), rec(1_000)], []), 8_000)
  })

  test('costPerPromptOf divides the estimate, and dashes where it cannot', () => {
    assert.equal(costPerPromptOf(1.5, 3), 0.5)
    assert.equal(costPerPromptOf(1.5, 0), null, 'a session with no human prompt has no per-prompt cost')
    assert.equal(costPerPromptOf(null, 3), null, 'an unpriced session has nothing to divide')
  })
})

describe('StatsContext — the derived second row', () => {
  const PROMPTS: RequestRecord[] = [
    rec(0, { prompt: 12_000, total: 12_000 }),
    rec(728_000, { prompt: 369_200, total: 369_200 }),
    rec(900_000, { prompt: 8_000, total: 8_000 }),
  ]

  test('the peak prompt reads as a share of the window, and as tokens without one', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 3, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      requests: [rec(0, { prompt: 148_000, total: 148_000 })],
      contextWindow: 200_000,
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m.container).values[6], '74%')
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[3]!).includes('share of the context window'))
    await m.unmount()
    // No window recorded: the cell falls back to the token formatter.
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 3, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      requests: PROMPTS,
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m2.container).values[6], '369.2k')
    await m2.unmount()
  })

  test('the duration is wall clock, including the idle time the Timing card leaves out', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 3, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      requests: PROMPTS,
      locale: 'en',
    }))
    await flush()
    // 900s from the first request to the last one.
    assert.equal(cells(m.container).values[7], '15m0s')
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[4]!).includes('idle'))
    await m.unmount()
    // A compaction after the final request extends the span past an hour.
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 3, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      requests: PROMPTS,
      events: [evAt(3_780_000)],
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m2.container).values[7], '1h3m')
    await m2.unmount()
    // One request alone spans nothing.
    const m3 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 1, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      requests: [rec(5_000)],
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m3.container).values[7], '—')
    await m3.unmount()
  })

  test('the compaction cell counts compactions and names the prunes beside them', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 2, prunes: 5 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m.container).values[8], '2')
    assert.equal(text(queryAll(m.container, '.lc-stat-tip')[5]!), 'Context compactions the session performed. +5 prunes.')
    await m.unmount()
    // No prunes, no mention of them.
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 1, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    assert.ok(!text(queryAll(m2.container, '.lc-stat-tip')[5]!).includes('prunes'))
    await m2.unmount()
  })

  test('the subagent cell counts children, and zero is a real answer', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      subagents: 3,
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m.container).values[9], '3')
    await m.unmount()
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      subagents: 0,
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m2.container).values[9], '0', 'a childless session says so')
    await m2.unmount()
  })

  test('cost per prompt divides the card’s own estimate, and dashes without prompts', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      humanInputs: 3,
      locale: 'en',
    }))
    await flush()
    // The Cost cell's $0.15 over three prompts.
    assert.equal(costOf(m.container), '$0.15')
    assert.equal(cells(m.container).values[10], '$0.050')
    await m.unmount()
    // The same cost with no human prompt has nothing to divide by.
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      humanInputs: 0,
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m2.container).values[10], '—')
    await m2.unmount()
  })

  test('the image cell reads the snapshot figure and defaults to zero', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      images: 4,
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m.container).values[11], '4')
    await m.unmount()
    // An older host carries no `images` at all — that reads as none.
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    await flush()
    assert.equal(cells(m2.container).values[11], '0')
    await m2.unmount()
  })

  test('the zh locale localizes the derived row’s bubbles too', async () => {
    const m = await mount(h(StatsContextZh, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 1, prunes: 2 },
      usage: null,
      requests: PROMPTS,
      contextWindow: 400_000,
      subagents: 1,
      images: 2,
      locale: 'zh',
    }))
    await flush()
    const values = cells(m.container).values
    assert.deepEqual(values.slice(6), ['92%', '15m0s', '1', '1', '—', '2'])
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.ok(tips[3]!.includes('上下文窗口'))
    assert.ok(tips[4]!.includes('耗时统计'))
    assert.equal(tips[5], '本会话执行的上下文压缩次数。 另有 2 次裁剪。')
    assert.ok(tips[6]!.includes('子 Agent'))
    assert.ok(tips[7]!.includes('预估费用除以用户输入次数'))
    assert.ok(tips[8]!.includes('图片块'))
    await m.unmount()
  })
})
