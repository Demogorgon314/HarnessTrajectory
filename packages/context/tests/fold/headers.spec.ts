// The header-epoch fold (src/fold/headers.ts) — the request-header EPOCH
// METADATA behind the timeline's envelope figures. Pure init/apply/view: each
// case drives real event envelopes through the real fold.
//
// Vendored from dsh-context `tests/host/headers.spec.ts` (Apache-2.0); the
// projection-definition and zod-schema assertions are gone (this port has
// neither), and the retention cap is the port's 500 rather than dsh's 50.

import assert from './helpers/assert.ts'
import { describe, test } from 'vitest'
import { estimateSystemTokens } from '../../src/shared/estimate.ts'
import type { HeadersState } from '../../src/fold/headers.ts'
import { HEADERS_MAX, applyHeaders, buildHeadersView, createHeadersState } from '../../src/fold/headers.ts'
import type { TimelineEvent } from '../../src/fold/event.ts'
import { foreign, header } from './helpers/events.ts'
import { assertPlainJson, row } from './helpers/drive.ts'

/** A raw request/header envelope with full control over the header payload. */
function headerEvent(seq: number, rawHeader: unknown): TimelineEvent {
  return { type: 'request/header', seq, time: seq * 1000, data: { header: rawHeader, reason: 'initial' } }
}

/** Fold events through the unit, pinning the plain-JSON state precondition on every result. */
function fold(events: TimelineEvent[]): HeadersState {
  let state = createHeadersState()
  for (const ev of events) state = applyHeaders(state, ev)
  assertPlainJson(state)
  return state
}

describe('the header-epoch fold', () => {
  test('init/apply/view fold header epoch metadata', () => {
    const init = createHeadersState()
    assert.deepEqual(init, { headers: [] })

    const state = applyHeaders(init, header(1, {
      system: 'You are an agent.',
      tools: [{ name: 'bash', description: 'run a command' }],
    }))
    assert.notEqual(state, init, 'a header event produces a new state')
    assertPlainJson(state)
    assert.equal(state.headers.length, 1)
    assert.equal(row(state.headers, 0).seq, 1)
    assert.equal(row(state.headers, 0).systemTokens, estimateSystemTokens('You are an agent.'))
    assert.equal(row(state.headers, 0).tools.length, 1)
    assert.equal(row(row(state.headers, 0).tools, 0).name, 'bash')

    const view = buildHeadersView(state)
    assert.equal(view.headers.length, 1)
    assert.equal(row(row(view.headers, 0).tools, 0).name, 'bash')
    assert.ok(!('description' in row(row(view.headers, 0).tools, 0)), 'descriptions stay with ContextSession')
    assert.ok(!('schema' in row(row(view.headers, 0).tools, 0)), 'schemas stay with ContextSession')
    assert.ok(!('system' in row(view.headers, 0)), 'system text stays with ContextSession')
  })

  test('a non-header event returns the same state reference', () => {
    const state = fold([header(1, { system: 'sys' })])
    assert.equal(applyHeaders(state, foreign(2)), state)
  })

  test('null, undefined, and non-object headers return the same state reference', () => {
    const state = fold([header(1, { system: 'sys' })])
    for (const [seq, raw] of [[2, null], [3, undefined], [4, 42]] as const) {
      assert.equal(applyHeaders(state, headerEvent(seq, raw)), state, `header ${String(raw)} is not an epoch`)
    }
  })

  test('a non-array tools field folds to an empty tool list', () => {
    const view = buildHeadersView(fold([headerEvent(1, { tools: 'nope' })]))
    assert.deepEqual(row(view.headers, 0).tools, [])
  })

  test('tool entries degrade bad names; descriptions and schemas never ride the record', () => {
    const view = buildHeadersView(fold([headerEvent(1, {
      tools: [
        { name: 42, description: 'kept' }, // non-string name → '?'
        { name: 'a', description: 7 },
        { name: 'b', description: '' },
        { name: 'c', description: 'ok', schema: { type: 'object' } },
      ],
    })]))
    const tools = row(view.headers, 0).tools
    assert.deepEqual(tools.map(t => t.name), ['?', 'a', 'b', 'c'])
    for (const tool of tools) {
      assert.ok(Number.isInteger(tool.tokens) && tool.tokens >= 0, 'tool tokens priced')
      assert.ok(!('description' in tool), 'descriptions stay out of the metadata')
      assert.ok(!('schema' in tool), 'schemas stay out of the metadata')
    }
  })

  test('systemTokens is omitted unless a non-empty system string was logged', () => {
    const view = buildHeadersView(fold([
      headerEvent(1, { system: 42 }),
      headerEvent(2, { system: '' }),
      headerEvent(3, { system: 'sys' }),
    ]))
    assert.ok(!('systemTokens' in row(view.headers, 0)))
    assert.ok(!('systemTokens' in row(view.headers, 1)))
    assert.equal(row(view.headers, 2).systemTokens, estimateSystemTokens('sys'))
  })

  test('the same epoch seq twice in a row returns the same state reference', () => {
    const state = fold([header(1, { system: 'a' })])
    assert.equal(applyHeaders(state, header(1, { system: 'b' })), state, 'duplicate epoch suppressed')
    assert.equal(state.headers.length, 1)
  })

  test(`retention caps at the ${HEADERS_MAX} newest epochs`, () => {
    const events = Array.from({ length: HEADERS_MAX + 5 }, (_, i) => header(i + 1, { system: `s${i + 1}` }))
    const state = fold(events)
    assert.equal(state.headers.length, HEADERS_MAX)
    assert.equal(row(state.headers, 0).seq, 6, 'the oldest five epochs dropped')
    assert.equal(row(state.headers, -1).seq, HEADERS_MAX + 5)
  })

  test('view() copies records and tools off the state', () => {
    const state = fold([headerEvent(1, { system: 'sys', tools: [{ name: 'bash' }] })])
    const view = buildHeadersView(state)
    row(row(view.headers, 0).tools, 0).name = 'mutated'
    row(view.headers, 0).time = -1
    assert.equal(row(row(state.headers, 0).tools, 0).name, 'bash', 'mutating the view must not alias state')
    assert.ok(row(state.headers, 0).time > 0)
  })

  test('a producer-provided plugin field rides the tool metadata verbatim', () => {
    const view = buildHeadersView(fold([headerEvent(1, {
      tools: [
        { name: 'mcp__github__get_issue', plugin: 'mcp:github' },
        { name: 'plain', plugin: '' }, // empty plugin behaves as absent
        { name: 'naked' },
      ],
    })]))
    const tools = row(view.headers, 0).tools
    assert.equal(row(tools, 0).plugin, 'mcp:github')
    assert.ok(!('plugin' in row(tools, 1)))
    assert.ok(!('plugin' in row(tools, 2)))
  })

  test('the resolver fills an absent plugin at view time and never overrides a logged one', () => {
    const resolve = (name: string): string | undefined =>
      name === 'Bash' ? 'builtin' : name === 'mcp__github__x' ? 'mcp:github' : undefined
    const state = fold([headerEvent(1, {
      tools: [
        { name: 'Bash' },
        { name: 'mcp__github__x' },
        { name: 'Bash', plugin: 'logged-owner' }, // logged wins over the resolver
        { name: 'unknown' },
      ],
    })])
    const tools = row(buildHeadersView(state, resolve).headers, 0).tools
    assert.equal(row(tools, 0).plugin, 'builtin')
    assert.equal(row(tools, 1).plugin, 'mcp:github')
    assert.equal(row(tools, 2).plugin, 'logged-owner')
    assert.ok(!('plugin' in row(tools, 3)))
    // The fill is a view-time projection: the folded state stays pure.
    assert.ok(!('plugin' in row(row(state.headers, 0).tools, 0)))
  })

  test('without a resolver no plugin is ever added', () => {
    const view = buildHeadersView(fold([headerEvent(1, { tools: [{ name: 'mcp__github__x' }] })]))
    assert.ok(!('plugin' in row(row(view.headers, 0).tools, 0)))
  })
})

describe('hostile tool entries', () => {
  test('null and primitive tool entries degrade to unnamed JSON-priced tools', () => {
    const view = buildHeadersView(fold([headerEvent(1, {
      tools: [null, 42, 'x', { name: 'bash' }],
    })]))
    const tools = row(view.headers, 0).tools
    assert.deepEqual(tools.map(t => t.name), ['?', '?', '?', 'bash'])
    for (const tool of tools) {
      assert.ok(Number.isInteger(tool.tokens) && tool.tokens >= 0, 'tool tokens priced')
      assert.ok(!('schema' in tool), 'the raw entry never rides the metadata record')
    }
  })

  test('wrong-shaped plain JSON keeps the state lossless and bounded', () => {
    // Content-sized junk (nested schema bodies) must not leak into the
    // metadata state — only name/tokens/plugin ever ride a stored tool.
    const state = fold([headerEvent(1, {
      tools: [
        null,
        42,
        [],
        { name: 123, extra: { deep: [true, 'x'] } }, // wrong-typed name, nested junk
        { name: 'read', parameters: { type: 'object', properties: {} } },
      ],
    })])
    assert.equal(row(state.headers, 0).tools.length, 5)
    for (const tool of row(state.headers, 0).tools) {
      assert.deepEqual(Object.keys(tool).filter(k => k !== 'name' && k !== 'tokens' && k !== 'plugin'), [])
    }
  })
})

describe('read-compat over content-bearing rows', () => {
  /** A legacy state: content-bearing records, the shape dsh v1 rows carried. */
  function legacyState(): HeadersState {
    return {
      headers: [
        {
          seq: 1, time: 1000, system: 'You are an agent.',
          tools: [
            { name: 'bash', tokens: 12, description: 'run a command', schema: { type: 'object' } },
            { name: 'mcp__gh__issue', tokens: 8, plugin: 'mcp:github' },
          ],
        },
        { seq: 9, time: 9000, tools: [{ name: 'read', tokens: 5, description: 'read a file', schema: {} }] },
      ],
    }
  }

  test('the view normalizes a content-bearing row to metadata', () => {
    const view = buildHeadersView(legacyState())
    assert.equal(row(view.headers, 0).systemTokens, estimateSystemTokens('You are an agent.'), 'legacy system text priced at view time')
    assert.ok(!('system' in row(view.headers, 0)), 'system text stripped from the view')
    assert.deepEqual(row(view.headers, 0).tools, [
      { name: 'bash', tokens: 12 },
      { name: 'mcp__gh__issue', tokens: 8, plugin: 'mcp:github' },
    ], 'descriptions and schemas stripped; attribution kept')
    assert.ok(!('systemTokens' in row(view.headers, 1)), 'a legacy epoch without system text stays absent')
    assert.deepEqual(row(view.headers, 1).tools, [{ name: 'read', tokens: 5 }])
  })

  test('the resolver fills plugins on seeded legacy entries at view time', () => {
    const view = buildHeadersView(legacyState(), name => (name === 'bash' ? 'builtin' : undefined))
    assert.equal(row(row(view.headers, 0).tools, 0).plugin, 'builtin', 'absent plugin resolved')
    assert.equal(row(row(view.headers, 0).tools, 1).plugin, 'mcp:github', 'logged plugin never overridden')
  })

  test('new epochs fold alongside seeded legacy epochs and the cap keeps trimming', () => {
    let state: HeadersState = legacyState()
    state = applyHeaders(state, header(10, { system: 'next', tools: [{ name: 'write' }] }))
    assert.equal(state.headers.length, 3)
    const view = buildHeadersView(state)
    assert.equal(row(view.headers, 2).systemTokens, estimateSystemTokens('next'))
    assert.ok(!('system' in row(state.headers, 2)), 'new folds stay metadata-only in state')
    assert.ok('system' in row(state.headers, 0), 'seeded legacy epochs keep their shape until they age out')

    // Retention: the oldest epochs leave regardless of generation.
    for (let seq = 11; seq <= HEADERS_MAX + 10; seq++) state = applyHeaders(state, header(seq, { system: 's' }))
    assert.equal(state.headers.length, HEADERS_MAX)
    assert.equal(row(state.headers, 0).seq, 11, 'the seeded legacy epoch aged out first')
  })
})
