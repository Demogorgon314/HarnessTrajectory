// The PORT ADDITIONS of src/fold/fold.ts — everything dsh-context did not
// need because the dsh harness recorded it:
//
//   - the DERIVED system remainder (Claude Code / Codex do not always record
//     the system prompt), plus the `toolsKnown` honesty marker;
//   - `tool/result` `data.fileOps` — synthesizer-stated file ops;
//   - `ContentBlock.tokens` — a synthesizer-stated block price;
//   - `RequestRecord.cacheWrite` — the client's token-usage card sums it.

import assert from './helpers/assert.ts'
import { describe, test } from 'vitest'
import type { FileOpInput } from '../../src/fold/fold.ts'
import type { TimelineEvent } from '../../src/fold/event.ts'
import { estimateMessage } from '../../src/fold/pricing.ts'
import {
  assistantMessage,
  header,
  systemMessage,
  toolCall,
  toolResult,
  userMessage,
} from './helpers/events.ts'
import { assertPlainJson, driveTimeline, row } from './helpers/drive.ts'

const text = (t: string) => [{ type: 'text', text: t }]

describe('the derived system remainder', () => {
  test('a transcript without a recorded prompt derives it from the provider prompt size', () => {
    const { state, view } = driveTimeline([
      header(1, { tools: [], model: 'claude-opus-5', provider: 'anthropic' }),
      userMessage(2, text('hello'), { kind: 'user' }),
      assistantMessage(3, { turn: 1, step: 1, usage: { inputTokens: 1000 } }),
    ])
    const record = row(state.requests, 0)
    const messages = state.sums.user // the one user node priced before the response
    assert.ok(messages > 0)
    assert.equal(record.system, 1000 - messages, 'prompt − everything we did price')
    assert.equal(record.systemDerived, true)
    assert.equal(record.total, 1000, 'the composition total now equals the reported prompt')
    // The live figure follows, so the composition card shows the same number.
    assert.equal(state.systemTokens, record.system)
    assert.equal(view.current.system, record.system)
    assert.equal(view.systemDerived, true)
    assertPlainJson(state)
  })

  test('the remainder clamps at zero when the priced surface already exceeds the prompt', () => {
    const { state, view } = driveTimeline([
      userMessage(1, text('x'.repeat(4000)), { kind: 'user' }),
      assistantMessage(2, { turn: 1, step: 1, usage: { inputTokens: 10 } }),
    ])
    assert.equal(row(state.requests, 0).system, 0)
    assert.equal(row(state.requests, 0).systemDerived, true)
    assert.equal(view.systemDerived, true, 'a zero remainder is still a derived figure')
  })

  test('it recomputes per request as the surface grows', () => {
    const { state } = driveTimeline([
      userMessage(1, text('hello'), { kind: 'user' }),
      assistantMessage(2, { turn: 1, step: 1, usage: { inputTokens: 500 } }),
      userMessage(3, text('again'), { kind: 'user' }),
      assistantMessage(4, { turn: 2, step: 1, usage: { inputTokens: 900 } }),
    ])
    assert.equal(row(state.requests, 0).total, 500)
    assert.equal(row(state.requests, 1).total, 900)
    assert.notEqual(row(state.requests, 0).system, row(state.requests, 1).system)
  })

  test('a request without any readable usage derives nothing', () => {
    const { state, view } = driveTimeline([
      userMessage(1, text('hello'), { kind: 'user' }),
      assistantMessage(2, { turn: 1, step: 1 }),
    ])
    assert.equal(row(state.requests, 0).system, 0)
    assert.ok(!('systemDerived' in row(state.requests, 0)))
    assert.equal(view.systemDerived, undefined)
  })

  test('a recorded header prompt suppresses the derivation entirely', () => {
    const { state, view } = driveTimeline([
      header(1, { system: 'You are an agent.', tools: [{ name: 'Bash' }] }),
      userMessage(2, text('hello'), { kind: 'user' }),
      assistantMessage(3, { turn: 1, step: 1, usage: { inputTokens: 100000 } }),
    ])
    assert.ok(!('systemDerived' in row(state.requests, 0)))
    assert.equal(view.systemDerived, undefined)
    assert.ok(row(state.requests, 0).system > 0, 'the recorded prompt keeps its own price')
    assert.ok(row(state.requests, 0).total < 100000, 'the record is not stretched to the prompt')
  })

  test('a recorded system/message node suppresses it too, and clears an earlier derivation', () => {
    const { state, view } = driveTimeline([
      userMessage(1, text('hello'), { kind: 'user' }),
      assistantMessage(2, { turn: 1, step: 1, usage: { inputTokens: 900 } }),
      systemMessage(3, {}),
      assistantMessage(4, { turn: 2, step: 1, usage: { inputTokens: 900 } }),
    ])
    assert.equal(row(state.requests, 0).systemDerived, true)
    assert.ok(!('systemDerived' in row(state.requests, 1)))
    assert.equal(view.systemDerived, undefined, 'the marker clears once the prompt is recorded')
    assert.equal(state.systemKnown, true)
  })

  test('toolsKnown marks a recorded tool list; an empty one leaves it unset', () => {
    const none = driveTimeline([header(1, { tools: [] })])
    assert.equal(none.view.toolsKnown, undefined, 'no tool list recorded → the client says "not recorded"')
    assert.equal(none.view.current.tools, 0)

    const some = driveTimeline([header(1, { tools: [{ name: 'Bash', description: 'run' }] })])
    assert.equal(some.view.toolsKnown, true)
    assert.ok(some.view.current.tools > 0)

    // A later model-change header repeating an empty list must not un-know it.
    const kept = driveTimeline([
      header(1, { tools: [{ name: 'Bash' }], model: 'a' }),
      header(2, { tools: [], model: 'b', reason: 'change' }),
    ])
    assert.equal(kept.view.toolsKnown, true)
  })
})

describe('tool/result data.fileOps (synthesizer-stated ops)', () => {
  const ops = (rows: FileOpInput[]): FileOpInput[] => rows

  test('stated ops win over the argument derivation and take the event stamps', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'Read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      toolResult(2, {
        callId: 'c1',
        content: text('ok'),
        time: 4242,
        fileOps: ops([{ kind: 'read', path: 'src/a.ts', read: { start: 5, count: 30 } }]),
      }),
    ])
    assert.deepEqual(state.fileOps, [{
      seq: 2, time: 4242, tool: 'Read', err: false,
      kind: 'read', path: 'src/a.ts', added: 0, removed: 0, read: { start: 5, count: 30 },
    }])
  })

  test('a stated op books even when the call event never folded', () => {
    const { state } = driveTimeline([
      toolResult(1, { callId: 'ghost', content: text('ok'), fileOps: ops([{ kind: 'write', path: 'b.ts', added: 3, removed: 1 }]) }),
    ])
    assert.deepEqual(row(state.fileOps, 0).tool, '', 'no pairing, no tool name — the row still counts')
    assert.deepEqual([row(state.fileOps, 0).added, row(state.fileOps, 0).removed], [3, 1])
  })

  test('an errored result flags every stated op', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'Edit' }),
      toolResult(2, { callId: 'c1', content: text('no'), error: true, fileOps: ops([{ kind: 'write', path: 'a.ts' }]) }),
    ])
    assert.equal(row(state.fileOps, 0).err, true)
  })

  test('the search shape rides through: detail, hits and the pattern marker', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'Grep' }),
      toolResult(2, {
        callId: 'c1',
        content: text('ok'),
        fileOps: ops([
          { kind: 'search', path: 'TODO', pattern: true, detail: 'TODO' },
          { kind: 'search', path: 'a.ts', detail: 'TODO', hits: 4 },
        ]),
      }),
    ])
    assert.deepEqual(state.fileOps.map(o => [o.path, o.pattern ?? false, o.hits ?? 0]), [
      ['TODO', true, 0],
      ['a.ts', false, 4],
    ])
  })

  test('malformed rows are dropped, not folded', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'Read' }),
      toolResult(2, {
        callId: 'c1',
        content: text('ok'),
        fileOps: [
          null,
          7,
          { kind: 'read' }, // no path
          { kind: 'sideways', path: 'a.ts' }, // unknown purpose
          { kind: 'read', path: '' }, // empty path
          { kind: 'read', path: 'good.ts', added: -5, removed: Number.NaN, hits: -1 },
        ],
      }),
    ])
    assert.deepEqual(state.fileOps.map(o => o.path), ['good.ts'])
    assert.deepEqual([row(state.fileOps, 0).added, row(state.fileOps, 0).removed], [0, 0], 'hostile counts clamp to 0')
    assert.ok(!('hits' in row(state.fileOps, 0)))
    assertPlainJson(state)
  })

  test('an empty stated array books nothing AND suppresses the fallback', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      toolResult(2, { callId: 'c1', content: text('ok'), fileOps: [] }),
    ])
    assert.deepEqual(state.fileOps, [], 'the synthesizer said "no ops" and is believed')
  })

  test('a non-array data.fileOps falls back to the argument derivation', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      toolResult(2, { callId: 'c1', content: text('ok'), fileOps: 'nope' }),
    ])
    assert.deepEqual(state.fileOps.map(o => [o.tool, o.path]), [['read', 'a.ts']])
  })

  test('the estimate-shaped read window is accepted too', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'Read' }),
      toolResult(2, { callId: 'c1', content: text('ok'), fileOps: [{ kind: 'read', path: 'a.ts', read: { count: 40, est: true } }] }),
    ])
    assert.deepEqual(row(state.fileOps, 0).read, { count: 40, est: true })
  })
})

describe('ContentBlock.tokens (synthesizer-stated block price)', () => {
  test('a stated price replaces the heuristic and still pays block overhead', () => {
    // 1600×1200 at Claude's ceil(w*h/750) ≈ 2560 tokens — far above the
    // DeepSeek calculator's 384 cap, which is exactly why the override exists.
    const priced = estimateMessage({ content: [{ type: 'image', attachment: { width: 1600, height: 1200 }, tokens: 2560 }] })
    assert.equal(priced, 2560 + 4 + 4, 'stated content + block overhead + role framing')
    const heuristic = estimateMessage({ content: [{ type: 'image', attachment: { width: 1600, height: 1200 } }] })
    assert.ok(heuristic < 400, 'without the override the vision calculator caps at 384')
  })

  test('it applies to any block type, not just images', () => {
    assert.equal(estimateMessage({ content: [{ type: 'text', text: 'anything at all', tokens: 11 }] }), 11 + 8)
  })

  test('hostile values are ignored and the block prices normally', () => {
    const plain = estimateMessage({ content: [{ type: 'text', text: 'abcd' }] })
    for (const tokens of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(estimateMessage({ content: [{ type: 'text', text: 'abcd', tokens }] }), plain, String(tokens))
    }
    assert.equal(estimateMessage({ content: [{ type: 'text', text: 'abcd', tokens: '9' as unknown as number }] }), plain)
  })

  test('a stated zero is honoured (a free block), not treated as absent', () => {
    assert.equal(estimateMessage({ content: [{ type: 'text', text: 'x'.repeat(400), tokens: 0 }] }), 8)
  })

  test('the fold prices a surface node through the override', () => {
    const { state } = driveTimeline([
      userMessage(1, [{ type: 'image', attachment: { width: 1600, height: 1200 }, tokens: 2560 }], { kind: 'user' }),
    ])
    assert.equal(row(state.surface, 0).tokens, 2560 + 8)
    assert.equal(row(state.surface, 0).imgs, 1, 'it is still an image for the stats board')
  })
})

describe('RequestRecord.cacheWrite', () => {
  test('a cache-write bucket rides the record beside cacheRead', () => {
    const { state } = driveTimeline([
      assistantMessage(1, { usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 } }),
    ])
    const record = row(state.requests, 0)
    assert.equal(record.prompt, 60)
    assert.equal(record.cacheRead, 20)
    assert.equal(record.cacheWrite, 30)
    assert.equal(record.output, 40)
    // The client's token-usage card: uncached = prompt − cacheRead − cacheWrite.
    assert.equal((record.prompt ?? 0) - (record.cacheRead ?? 0) - (record.cacheWrite ?? 0), 10)
  })

  test('it stays ABSENT when the provider reported no cache-write bucket', () => {
    const { state } = driveTimeline([assistantMessage(1, { usage: { inputTokens: 10 } })])
    assert.ok(!('cacheWrite' in row(state.requests, 0)))
    assertPlainJson(state)
  })

  test('a reported zero is a real value', () => {
    const { state } = driveTimeline([assistantMessage(1, { usage: { inputTokens: 10, cacheWriteTokens: 0 } })])
    assert.equal(row(state.requests, 0).cacheWrite, 0)
  })

  test('it is sanitized like every other bucket', () => {
    const { state } = driveTimeline([assistantMessage(1, { usage: { inputTokens: 10, cacheWriteTokens: -4.6 } })])
    assert.equal(row(state.requests, 0).cacheWrite, 0)
    assert.equal(row(state.requests, 0).prompt, 10)
  })
})

describe('the local deriveEventMessage', () => {
  test('an assistant/message with no message payload folds as a usage-only settlement', () => {
    // dsh let this throw out of the fold (its `deriveEventMessage`
    // dereferenced data.message.content) and relied on the catch to drop the
    // event whole. The local reader returns "no message" instead, so the
    // request record still lands — a Claude group that carried usage but no
    // content is a real shape, not a corrupt one.
    const malformed: TimelineEvent = { type: 'assistant/message', seq: 1, time: 1000, data: {} }
    const { state } = driveTimeline([malformed])
    assert.equal(state.requests.length, 1)
    assert.equal(row(state.surface, 0).tokens, 0)
    assert.equal(row(state.surface, 0).cat, 'assistant')
    assertPlainJson(state)
  })

  test('a user/message reads its payload directly as the message', () => {
    const { state } = driveTimeline([userMessage(1, text('hi there'), { kind: 'user' })])
    assert.equal(row(state.surface, 0).text, 'hi there')
    assert.equal(row(state.surface, 0).cat, 'user')
  })

  test('a tool/result reads data.message, not the envelope', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'Bash' }),
      toolResult(2, { callId: 'c1', content: text('command output') }),
    ])
    assert.equal(row(state.surface, 0).tool, 'Bash')
    assert.ok(row(state.surface, 0).tokens > 8, 'the nested content was priced')
  })
})
