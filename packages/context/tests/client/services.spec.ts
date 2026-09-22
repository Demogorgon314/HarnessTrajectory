// Value narrowing (src/client/services.ts): the no-white-screen guards —
// numOf, timelineOf fast/slow paths, contextPressureOf, contextBreakdownOf,
// tokenUsageOf, timingOf, headersOf.
//
// PORT NOTE — the harness-service seats dsh-context also guarded here
// (conversationNodesOf, imageLoaderOf, workspaceOf, canOpenPathsOf,
// openPathVia, openResourceVia) are gone with the services they wrapped: this
// port's data plane is local and reaches the view as props.

import assert from './helpers/assert.ts'
import { describe, test } from 'vitest'
import {
  contextBreakdownOf,
  contextPressureOf,
  headersOf,
  numOf,
  timelineOf,
  timingOf,
  tokenUsageOf,
  unsupportedOf,
} from '../../src/client/services'
import type { TimingTotals } from '../../src/shared/types'

describe('numOf', () => {
  test('finite numbers pass through', () => {
    assert.equal(numOf(42), 42)
    assert.equal(numOf(0), 0)
    assert.equal(numOf(-1.5), -1.5)
  })

  test('NaN/Infinity degrade to 0', () => {
    assert.equal(numOf(NaN), 0)
    assert.equal(numOf(Infinity), 0)
    assert.equal(numOf(-Infinity), 0)
  })

  test('non-numbers and missing values degrade to 0', () => {
    assert.equal(numOf('7'), 0)
    assert.equal(numOf(undefined), 0)
    assert.equal(numOf(null), 0)
    assert.equal(numOf({}), 0)
  })
})

describe('timelineOf', () => {
  const current = { system: 1, tools: 2, user: 3, inject: 4, skill: 0, assistant: 5, tool: 6, total: 7 }

  test('keeps current usage through sanitization and rejects malformed occupancy', () => {
    const contextUsage = { used: 20000, window: 100000, tools: 800 }
    assert.deepEqual(timelineOf({ contextUsage })?.contextUsage, contextUsage)
    for (const bad of [{ used: -1 }, { used: Infinity }, { used: 1, tools: 'bad' }]) {
      const wire = { current, requests: [], events: [], nodes: [], archive: [], contextUsage: bad }
      assert.equal(timelineOf(wire)?.contextUsage, undefined)
    }
  })

  test('non-records stay null', () => {
    assert.equal(timelineOf(null), null)
    assert.equal(timelineOf(undefined), null)
    assert.equal(timelineOf(5), null)
    assert.equal(timelineOf('x'), null)
  })

  test('a well-formed wire value passes through by reference', () => {
    const wire = {
      ok: true,
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      contextWindow: 128000,
      current,
      requests: [],
      events: [],
      nodes: [],
      archive: [],
      droppedNodes: 0,
    }
    assert.equal(timelineOf(wire), wire)
  })

  test('current missing/non-object rebuilds a zeroed breakdown', () => {
    for (const bad of [{}, { current: null }, { current: 7 }]) {
      assert.deepEqual(timelineOf(bad), {
        ok: true,
        current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
        requests: [],
        events: [],
        nodes: [],
        droppedNodes: 0,
        archive: [],
      })
    }
  })

  test('current with some non-number fields is numOf-coerced', () => {
    const out = timelineOf({ current: { system: 12, tools: 'x', user: undefined } })
    assert.ok(out !== null)
    assert.deepEqual(out.current, { system: 12, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 })
  })

  test('non-array collections become empty lists', () => {
    const out = timelineOf({
      current,
      requests: 'nope',
      events: 7,
      nodes: null,
      archive: undefined,
    })
    assert.ok(out !== null)
    assert.deepEqual(out.requests, [])
    assert.deepEqual(out.events, [])
    assert.deepEqual(out.nodes, [])
    assert.deepEqual(out.archive, [])
  })

  test('null/non-object collection entries are dropped', () => {
    const node = { kind: 'message', seq: 1 }
    const out = timelineOf({ current: 1, nodes: [node, null, 42, 's'] })
    assert.ok(out !== null)
    assert.deepEqual(out.nodes, [node])
  })

  test('a junk entry inside an otherwise well-formed value leaves the fast path and is dropped', () => {
    // The cheap pass-through requires every collection's entries to be records:
    // a null/primitive element would throw on the first downstream property
    // read (`req.seq` on null), so the value takes the sanitizing path instead.
    const good = { seq: 1, time: 1, system: 0, tools: 0, user: 1, inject: 0, assistant: 0, tool: 0, total: 1 }
    const out = timelineOf({ ok: true, current, requests: [good, null], events: [], nodes: [], archive: [], droppedNodes: 0 })
    assert.ok(out !== null)
    assert.deepEqual(out.requests, [good])
    const junkNodes = timelineOf({ ok: true, current, requests: [], events: [7], nodes: [], archive: [], droppedNodes: 0 })
    assert.ok(junkNodes !== null)
    assert.deepEqual(junkNodes.events, [])
  })

  test('model/provider/contextWindow: wrong-typed dropped, right-typed kept', () => {
    const kept = timelineOf({ current: 1, model: 'm', provider: 'p', contextWindow: 100 })
    assert.ok(kept !== null)
    assert.equal(kept.model, 'm')
    assert.equal(kept.provider, 'p')
    assert.equal(kept.contextWindow, 100)
    const dropped = timelineOf({ current: 1, model: 5, provider: {}, contextWindow: 'x' })
    assert.ok(dropped !== null)
    assert.ok(!('model' in dropped))
    assert.ok(!('provider' in dropped))
    assert.ok(!('contextWindow' in dropped))
  })

  test('images/toolCalls/humanInputs/surfaceFloor/archiveFloor are kept only when numbers', () => {
    const kept = timelineOf({ current: 1, images: 3, toolCalls: 2, humanInputs: 5, surfaceFloor: 10, archiveFloor: 4 })
    assert.ok(kept !== null)
    assert.equal(kept.images, 3)
    assert.equal(kept.toolCalls, 2)
    assert.equal(kept.humanInputs, 5)
    assert.equal(kept.surfaceFloor, 10)
    assert.equal(kept.archiveFloor, 4)
    const dropped = timelineOf({ current: 1, images: 'n', toolCalls: {}, humanInputs: 'x', surfaceFloor: null, archiveFloor: true })
    assert.ok(dropped !== null)
    assert.ok(!('images' in dropped))
    assert.ok(!('toolCalls' in dropped))
    assert.ok(!('humanInputs' in dropped))
    assert.ok(!('surfaceFloor' in dropped))
    assert.ok(!('archiveFloor' in dropped))
  })

  test('cost is rebuilt per provider/model/period; garbage drops or zeroes', () => {
    const cost = {
      'deepseek-official': {
        'deepseek-v4-flash': {
          peak: { uncached: 5, cacheRead: 'x', cacheWrite: null, output: 7 },
          off: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
          junk: { uncached: 9, cacheRead: 0, cacheWrite: 0, output: 0 },
          broken: null,
          'broken-array': [],
        },
        'deepseek-v4-pro': { peak: [], off: null },
        'broken-null': null,
        'broken-array': [],
      },
      junk: 'not-a-record',
      empty: {},
    }
    const kept = timelineOf({ current: 1, cost })
    assert.ok(kept !== null)
    assert.deepEqual(kept.cost, {
      'deepseek-official': {
        'deepseek-v4-flash': {
          peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 7 },
          off: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
        },
        'deepseek-v4-pro': {},
      },
      empty: {},
    })
    assert.notEqual(kept.cost, cost, 'the served buckets are a rebuilt copy, never the raw value')
    for (const bad of [[], null, 5]) {
      const out = timelineOf({ current: 1, cost: bad })
      assert.ok(out !== null)
      assert.ok(!('cost' in out))
    }
  })

  test('a well-formed payload with a proven cost takes the fast path; a garbage cost diverts to the sanitizer', () => {
    const cost = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 } } } }
    const good = timelineOf({
      current: { system: 1, tools: 1, user: 1, inject: 1, skill: 1, assistant: 1, tool: 1, total: 8 },
      requests: [], events: [], nodes: [], archive: [],
      cost,
    })
    assert.ok(good !== null)
    assert.equal(good.cost, cost, 'the fast path passes a structurally proven cost through untouched')
    for (const bad of [[], 'junk']) {
      const diverted = timelineOf({
        current: { system: 1, tools: 1, user: 1, inject: 1, skill: 1, assistant: 1, tool: 1, total: 8 },
        requests: [], events: [], nodes: [], archive: [],
        cost: bad,
      })
      assert.ok(diverted !== null)
      assert.ok(!('cost' in diverted), 'a hostile cost drops through the sanitizer')
    }
  })

  test('droppedNodes is numOf-coerced', () => {
    assert.equal(timelineOf({ current: 1, droppedNodes: 4 })?.droppedNodes, 4)
    assert.equal(timelineOf({ current: 1, droppedNodes: 'x' })?.droppedNodes, 0)
  })

  test('the unsupported gate record survives the sanitizing slow path only when well-formed', () => {
    const kept = timelineOf({ current: 1, unsupported: { current: '0.1.1-rc.2', minimum: '0.1.2-rc.1' } })
    assert.ok(kept !== null)
    assert.deepEqual(kept.unsupported, { current: '0.1.1-rc.2', minimum: '0.1.2-rc.1' })
    for (const bad of ['x', null, {}, { current: 1, minimum: 'm' }, { current: 'c' }]) {
      const out = timelineOf({ current: 1, unsupported: bad })
      assert.ok(out !== null)
      assert.ok(!('unsupported' in out), JSON.stringify(bad))
    }
  })

  test('the split-generation slim head: counters/anchor/revision survive, the absent collections zero out', () => {
    const head = {
      ok: true,
      model: 'm',
      current,
      counts: { turns: 3, steps: 12, injects: 2, compactions: 1, prunes: 0 },
      last: { seq: 9, total: 100, prompt: 90 },
      detailRev: 12,
      fileOps: [{ seq: 2, path: 'a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
      fileOpsFloor: 5,
    }
    const out = timelineOf(head)
    assert.ok(out !== null)
    assert.deepEqual(out.counts, { turns: 3, steps: 12, injects: 2, compactions: 1, prunes: 0 })
    assert.deepEqual(out.last, { seq: 9, total: 100, prompt: 90 })
    assert.equal(out.detailRev, 12)
    assert.deepEqual(out.requests, [])
    assert.deepEqual(out.nodes, [])
    assert.deepEqual(out.archive, [])
    assert.equal(out.fileOps?.length, 1, 'the op log survives the head sanitize')
    assert.equal(out.fileOpsFloor, 5)
  })

  test('the slim head fields re-prove: partial counts zero per field, shapeless last/detailRev drop', () => {
    const out = timelineOf({ current, counts: { turns: 2, steps: 'many' }, last: { seq: 'x' }, detailRev: 'r' })
    assert.ok(out !== null)
    assert.deepEqual(out.counts, { turns: 2, steps: 0, injects: 0, compactions: 0, prunes: 0 })
    assert.ok(!('last' in out), 'a wrong-typed seq drops the anchor whole')
    assert.ok(!('detailRev' in out), 'a wrong-typed revision drops the marker (reads as the inline generation)')
    const noCounts = timelineOf({ current, counts: 'junk', last: null, detailRev: NaN })
    assert.ok(noCounts !== null)
    assert.ok(!('counts' in noCounts))
    assert.ok(!('last' in noCounts))
    assert.ok(!('detailRev' in noCounts))
    // A wrong-typed total drops the anchor too; a prompt-less anchor keeps just seq/total.
    const badTotal = timelineOf({ current, last: { seq: 1, total: 'x' } })
    assert.ok(badTotal !== null && !('last' in badTotal))
    const noPrompt = timelineOf({ current, last: { seq: 1, total: 7 } })
    assert.ok(noPrompt !== null)
    assert.deepEqual(noPrompt.last, { seq: 1, total: 7 })
  })

  test('a slim head carrying the (empty) collections passes through by reference, markers intact', () => {
    // The host's head builder emits the four collections as empty lists, so
    // the split generation rides the cheap pass-through path like any
    // well-formed value — the markers/counts survive untouched.
    const head = {
      ok: true,
      current,
      counts: { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0 },
      last: { seq: 1, total: 7 },
      detailRev: 1,
      requests: [],
      events: [],
      nodes: [],
      archive: [],
      droppedNodes: 0,
    }
    assert.equal(timelineOf(head), head)
  })
})

describe('unsupportedOf', () => {
  test('well-formed records pass through as plain data', () => {
    assert.deepEqual(unsupportedOf({ current: '0.1.1-rc.2', minimum: '0.1.2-rc.1' }), { current: '0.1.1-rc.2', minimum: '0.1.2-rc.1' })
  })

  test('non-records and wrong-typed fields degrade to null', () => {
    assert.equal(unsupportedOf(null), null)
    assert.equal(unsupportedOf(undefined), null)
    assert.equal(unsupportedOf('x'), null)
    assert.equal(unsupportedOf(5), null)
    assert.equal(unsupportedOf({}), null)
    assert.equal(unsupportedOf({ current: 'c' }), null)
    assert.equal(unsupportedOf({ minimum: 'm' }), null)
    assert.equal(unsupportedOf({ current: 1, minimum: 'm' }), null)
    assert.equal(unsupportedOf({ current: 'c', minimum: null }), null)
  })
})

describe('contextPressureOf', () => {
  test('the three wire fields pass, each re-proved as a finite number', () => {
    assert.deepEqual(
      contextPressureOf({ pressureTokens: 10, projectedTokens: 30, contextWindow: 128000 }),
      { pressureTokens: 10, projectedTokens: 30, contextWindow: 128000 },
    )
  })

  test('wrong-typed/non-finite fields drop out individually; unknown fields never ride along', () => {
    // surfaceTokens is a state-internal field of the meter's fold — the strict
    // wire schema never delivers it, and the sanitizer must not either.
    assert.deepEqual(contextPressureOf({ pressureTokens: 10, surfaceTokens: 20 }), { pressureTokens: 10 })
    assert.deepEqual(contextPressureOf({ projectedTokens: 'x' }), {})
    assert.deepEqual(contextPressureOf({ contextWindow: Number.NaN }), {})
    assert.deepEqual(contextPressureOf({}), {})
  })

  test('non-records degrade to null', () => {
    assert.equal(contextPressureOf(null), null)
    assert.equal(contextPressureOf(undefined), null)
    assert.equal(contextPressureOf(42), null)
  })
})

describe('contextBreakdownOf', () => {
  test('all three finite numbers pass through as a value', () => {
    assert.deepEqual(contextBreakdownOf({ systemTokens: 1, toolsTokens: 2, messageTokens: 3 }), {
      systemTokens: 1,
      toolsTokens: 2,
      messageTokens: 3,
    })
  })

  test('non-records degrade to null', () => {
    assert.equal(contextBreakdownOf(null), null)
    assert.equal(contextBreakdownOf('x'), null)
  })

  test('a missing/NaN/non-finite field degrades the whole value to null', () => {
    assert.equal(contextBreakdownOf({ toolsTokens: 2, messageTokens: 3 }), null)
    assert.equal(contextBreakdownOf({ systemTokens: NaN, toolsTokens: 2, messageTokens: 3 }), null)
    assert.equal(contextBreakdownOf({ systemTokens: 1, toolsTokens: 'x', messageTokens: 3 }), null)
    assert.equal(contextBreakdownOf({ systemTokens: 1, toolsTokens: Infinity, messageTokens: 3 }), null)
    assert.equal(contextBreakdownOf({ systemTokens: 1, toolsTokens: 2, messageTokens: undefined }), null)
    assert.equal(contextBreakdownOf({ systemTokens: 1, toolsTokens: 2, messageTokens: -Infinity }), null)
  })
})

describe('tokenUsageOf', () => {
  test('the four-bucket wire value passes as a value', () => {
    assert.deepEqual(
      tokenUsageOf({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
      { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    )
  })

  test('a missing/wrong-typed/non-finite bucket degrades the WHOLE value to null', () => {
    // The buckets sum into the billed total — a partial value would silently
    // undercount, so anything short of the strict wire shape is dropped whole.
    assert.equal(tokenUsageOf({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }), null, 'missing bucket')
    assert.equal(tokenUsageOf({ total: { input: 100 } }), null, 'a foreign record shape')
    const good = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
    for (const key of Object.keys(good) as (keyof typeof good)[]) {
      assert.equal(tokenUsageOf({ ...good, [key]: 'x' }), null, `${key} wrong-typed`)
      assert.equal(tokenUsageOf({ ...good, [key]: Number.NaN }), null, `${key} non-finite`)
    }
  })

  test('non-records degrade to null', () => {
    assert.equal(tokenUsageOf(null), null)
    assert.equal(tokenUsageOf(undefined), null)
    assert.equal(tokenUsageOf(3), null)
  })
})

describe('timingOf', () => {
  const wellFormed = {
    wallMs: 60_000, ttftMs: 8_000, genMs: 12_000, calls: 4, toolsMs: 30_000, toolCalls: 9,
    tools: { bash: { calls: 5, ms: 20_000 }, read: { calls: 4, ms: 10_000 } },
  }

  test('non-records stay null', () => {
    assert.equal(timingOf(null), null)
    assert.equal(timingOf(undefined), null)
    assert.equal(timingOf('x'), null)
    assert.equal(timingOf(5), null)
  })

  test('a well-formed value round-trips every scalar and row', () => {
    assert.deepEqual(timingOf(wellFormed), wellFormed)
  })

  test('wrong-typed or negative scalars zero out', () => {
    const out = timingOf({ wallMs: -1, ttftMs: 'x', genMs: NaN, calls: Infinity, toolsMs: Infinity, toolCalls: 3 })
    assert.deepEqual(out, { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 3, tools: {} })
  })

  test('rows failing the shape drop individually; the ranking survives', () => {
    const out = timingOf({
      wallMs: 10, tools: {
        good: { calls: 1, ms: 5 },
        noCalls: { ms: 5 },
        negMs: { calls: 1, ms: -5 },
        nullRow: null,
        numRow: 7,
      },
    })
    assert.deepEqual(out?.tools, { good: { calls: 1, ms: 5 } })
  })

  test('a non-record tools map degrades to an empty ranking', () => {
    for (const tools of [null, 'x', 5, [ { calls: 1, ms: 1 } ]]) {
      const out = timingOf({ wallMs: 1, tools })
      assert.deepEqual(out?.tools, {})
    }
  })

  test('a hostile __proto__ row is skipped, not assigned as the prototype', () => {
    const out = timingOf({ wallMs: 1, tools: JSON.parse('{"__proto__": {"calls": 1, "ms": 5}}') })
    assert.deepEqual(out?.tools, {})
    assert.equal(Object.getPrototypeOf(out?.tools ?? {}), Object.prototype)
  })

  test('the generation split passes through when well-formed', () => {
    const out = timingOf({ ...wellFormed, reasoningMs: 5_000, textMs: 2_000, toolArgMs: 3_000 })
    assert.deepEqual(out, { ...wellFormed, reasoningMs: 5_000, textMs: 2_000, toolArgMs: 3_000 })
  })

  test('absent split fields stay ABSENT — the card keeps the un-split shape', () => {
    const out = timingOf(wellFormed)
    assert.ok(out !== null)
    assert.equal(Object.hasOwn(out, 'reasoningMs'), false)
    assert.equal(Object.hasOwn(out, 'textMs'), false)
    assert.equal(Object.hasOwn(out, 'toolArgMs'), false)
  })

  test('a wrong-typed or negative split field drops alone, keeping the rest', () => {
    const out = timingOf({ ...wellFormed, reasoningMs: 'x', textMs: -5, toolArgMs: 1_000 })
    assert.equal(out?.reasoningMs, undefined)
    assert.equal(out?.textMs, undefined)
    assert.equal(out?.toolArgMs, 1_000)
  })

  test('the fast path rejects a non-finite split field (routed to the slow path)', () => {
    // timelineOf's fast path must not pass a payload through with a NaN bucket.
    const out = timingOf({ ...wellFormed, reasoningMs: Number.NaN })
    assert.equal(out?.reasoningMs, undefined)
    assert.equal(out?.wallMs, wellFormed.wallMs)
  })
})

describe('timelineOf — the live system-prompt nodes', () => {
  const current = { system: 1, tools: 2, user: 3, inject: 4, skill: 0, assistant: 5, tool: 6, total: 7 }
  const base = { ok: true, current, requests: [], events: [], nodes: [], archive: [], droppedNodes: 0 }

  test('a well-formed systems list passes through by reference (fast path)', () => {
    const wire = { ...base, systems: [{ seq: 3, time: 300, tokens: 42 }] }
    assert.equal(timelineOf(wire), wire)
  })

  test('a malformed list takes the sanitizing slow path: entries re-proved and seq-ordered', () => {
    const wire = {
      ...base,
      systems: [
        { seq: 9, time: 900, tokens: 5 },
        null,
        7,
        { seq: 'x', time: 1, tokens: 1 },
        { seq: 2, time: Number.NaN, tokens: 1 },
        { seq: 2, time: 200, tokens: 'nope' },
        { seq: 2, time: 200, tokens: 8 },
        { seq: 5, time: 500, tokens: 3 },
      ],
    }
    const out = timelineOf(wire)
    assert.ok(out !== (wire as unknown))
    assert.deepEqual(out?.systems, [
      { seq: 2, time: 200, tokens: 8 },
      { seq: 5, time: 500, tokens: 3 },
      { seq: 9, time: 900, tokens: 5 },
    ])
  })

  test('an all-record list with a non-numeric field takes the slow path: no partially numeric pass-through', () => {
    // Every entry is a real object, so the collection guard alone would wave the
    // list through; the fast path must still refuse it — a missing/non-finite
    // field would otherwise reach the browser's bar math as undefined/NaN.
    const wire = {
      ...base,
      systems: [
        { seq: 2, time: 200 },
        { seq: 4, time: Number.NaN, tokens: 7 },
        { seq: 6, time: 600, tokens: 9 },
      ],
    }
    const out = timelineOf(wire)
    assert.ok(out !== (wire as unknown))
    assert.deepEqual(out?.systems, [{ seq: 6, time: 600, tokens: 9 }])
  })

  test('an absent systems key stays absent; a non-list becomes empty', () => {
    assert.equal('systems' in (timelineOf(base) ?? {}), false)
    assert.deepEqual(timelineOf({ ...base, systems: 'nope' })?.systems, [])
  })
})

describe('timelineOf — timing integration', () => {
  const current = { system: 1, tools: 2, user: 3, inject: 4, skill: 0, assistant: 5, tool: 6, total: 7 }
  const base = { ok: true, current, requests: [], events: [], nodes: [], archive: [], droppedNodes: 0 }
  const timing: TimingTotals = { wallMs: 60_000, ttftMs: 8_000, genMs: 12_000, calls: 4, toolsMs: 30_000, toolCalls: 9, tools: { bash: { calls: 5, ms: 20_000 } } }

  test('a well-formed timing passes through by reference (fast path)', () => {
    const wire = { ...base, timing }
    assert.equal(timelineOf(wire), wire)
  })

  test('a malformed timing takes the sanitizing slow path', () => {
    const wire = { ...base, timing: { ...timing, tools: { bash: { calls: 'nope' } } } }
    const out = timelineOf(wire)
    assert.ok(out !== (wire as unknown))
    assert.deepEqual(out?.timing, { ...timing, tools: {} })
  })

  test('a non-record timing is omitted entirely (no null-valued key)', () => {
    const out = timelineOf({ ...base, timing: 'corrupt' })
    assert.ok(out !== null)
    assert.ok(!('timing' in out))
  })

  test('every timingFastOk rejection arm routes down the sanitizing slow path', () => {
    const sanitized = (timingValue: unknown): TimingTotals => {
      const out = timelineOf({ ...base, timing: timingValue })
      assert.ok(out !== null)
      return out.timing as TimingTotals
    }
    // A non-number scalar zeroes out.
    assert.deepEqual(sanitized({ ...timing, wallMs: 'x' }), { ...timing, wallMs: 0 })
    // A non-record tools map (null / array / scalar) degrades to an empty ranking.
    for (const tools of [null, [{ calls: 1, ms: 1 }], 5]) {
      assert.deepEqual(sanitized({ ...timing, tools }), { ...timing, tools: {} })
    }
    // A row failing the shape (null / scalar / non-number fields) drops alone.
    assert.deepEqual(sanitized({ ...timing, tools: { bash: null } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, tools: { bash: 5 } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, tools: { bash: { calls: 'x', ms: 1 } } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, tools: { bash: { calls: 1, ms: 'x' } } }), { ...timing, tools: {} })
    // A bad generation-split bucket routes down too and drops alone.
    assert.deepEqual(sanitized({ ...timing, reasoningMs: 'x' }), timing)
    assert.deepEqual(sanitized({ ...timing, textMs: Number.NaN }), timing)
    assert.deepEqual(sanitized({ ...timing, toolArgMs: -1 }), timing)
  })
})

describe('headersOf', () => {
  test('non-records degrade to null', () => {
    assert.equal(headersOf(null), null)
    assert.equal(headersOf(7), null)
  })

  test('a non-array headers field degrades to null', () => {
    assert.equal(headersOf({}), null)
    assert.equal(headersOf({ headers: 'x' }), null)
  })

  test('a null/non-object entry degrades the whole value to null', () => {
    assert.equal(headersOf({ headers: [null] }), null)
    assert.equal(headersOf({ headers: ['s'] }), null)
  })

  test('an entry with a non-array tools list degrades the whole value to null', () => {
    assert.equal(headersOf({ headers: [{ tools: 'x' }] }), null)
  })

  test('an entry with a defined non-numeric systemTokens degrades the whole value to null', () => {
    assert.equal(headersOf({ headers: [{ tools: [], systemTokens: 'x' }] }), null)
    assert.equal(headersOf({ headers: [{ tools: [], systemTokens: Number.NaN }] }), null)
  })

  test('a malformed tool entry degrades the whole value to null (the browser reads name/tokens blindly)', () => {
    assert.equal(headersOf({ headers: [{ tools: [42] }] }), null, 'primitive tool row')
    assert.equal(headersOf({ headers: [{ tools: [null] }] }), null, 'null tool row')
    assert.equal(headersOf({ headers: [{ tools: [{ name: 7, tokens: 10 }] }] }), null, 'non-string name')
    assert.equal(headersOf({ headers: [{ tools: [{ name: 'bash' }] }] }), null, 'missing tokens')
    assert.equal(headersOf({ headers: [{ tools: [{ name: 'bash', tokens: 'x' }] }] }), null, 'non-numeric tokens')
    assert.equal(headersOf({ headers: [{ tools: [{ name: 'bash', tokens: Number.NaN }] }] }), null, 'NaN tokens')
    assert.equal(headersOf({ headers: [{ tools: [{ name: 'bash', tokens: 1, plugin: 7 }] }] }), null, 'non-string plugin')
  })

  test('a tool entry with an optional plugin string passes', () => {
    const value = { headers: [{ seq: 1, time: 1, tools: [{ name: 'bash', tokens: 10, plugin: 'mcp:x' }] }] }
    assert.equal(headersOf(value), value)
  })

  test('a valid value passes through by reference', () => {
    const value = {
      headers: [
        { seq: 1, time: 1000, tools: [], systemTokens: 12 },
        { seq: 2, time: 2000, tools: [{ name: 'bash', tokens: 10 }] },
      ],
    }
    assert.equal(headersOf(value), value)
  })

  // PORT NOTE — dsh-context also normalized the pre-#37 wire generation here
  // (an epoch carrying the system TEXT but no `systemTokens` was priced with
  // the shared estimator). The local fold always prices the epoch, so that
  // branch and its three specs are gone: a text-only epoch simply stays
  // unpriced and the browser's own note explains it.
})
