// `ContextSession` (src/fold/session.ts): per-file folds, content retention,
// revision memoization, and the file roster. Driven with a FAKE synthesizer —
// the real ones belong to the synth specs, and this spec must stay green
// while they are still stubs.

import assert from './helpers/assert.ts'
import { describe, test } from 'vitest'
import type { SessionFileRef } from '@harness-trajectory/core'
import type { TimelineEvent } from '../../src/fold/event.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta, SynthesizerFactory } from '../../src/synth/types.ts'
import { ContextSession } from '../../src/fold/session.ts'
import type { InputEvent } from '../../src/synth/requestInput.ts'

const MAIN: SessionFileRef = { id: 'main', role: 'main', path: '/sessions/main.jsonl' }
const CHILD: SessionFileRef = { id: 'agent-1', role: 'child', path: '/sessions/agent-1.jsonl', parentId: 'main' }
const CHILD2: SessionFileRef = { id: 'agent-2', role: 'child', path: '/sessions/agent-2.jsonl', parentId: 'main' }

/**
 * A synthesizer whose "JSONL line" is a JSON array of ready-made events (plus
 * an optional `meta` patch), so a spec states the event stream directly.
 * Anything unparseable emits nothing, exactly like a real synthesizer.
 */
interface FakeLine {
  events?: InputEvent[]
  meta?: Partial<Omit<SynthMeta, 'children'>> & { children?: [string, AgentSpawn][] }
  throws?: true
}

function fakeFactory(): SynthesizerFactory {
  return (): EventSynthesizer => {
    const meta: SynthMeta = { running: false, children: new Map<string, AgentSpawn>() }
    return {
      kind: 'claude',
      push(line: string): readonly TimelineEvent[] {
        let parsed: FakeLine
        try {
          parsed = JSON.parse(line) as FakeLine
        } catch {
          return []
        }
        if (parsed.throws === true) throw new Error('synthesizer blew up')
        if (parsed.meta !== undefined) {
          const { children, ...rest } = parsed.meta
          Object.assign(meta, rest)
          if (children !== undefined) meta.children = new Map(children)
        }
        return parsed.events ?? []
      },
      meta: () => meta,
    }
  }
}

const line = (value: FakeLine): string => JSON.stringify(value)

describe('whole-agent input measurements', () => {
  test('retains independent input and occupancy peaks across trimming, model changes and child activity', () => {
    const session = new ContextSession('codex', fakeFactory(), { bounds: { maxRequestSteps: 1 } })
    const first: InputEvent = { ...assistantEvent(1, 'a'), requestInput: {
      source: 'reported', tokens: 180_000, model: 'small', window: { tokens: 200_000, source: 'recorded', kind: 'usable' },
    } }
    const second: InputEvent = { ...assistantEvent(2, 'b'), requestInput: {
      source: 'reported', tokens: 300_000, model: 'large', window: { tokens: 1_000_000, source: 'recorded', kind: 'usable' },
    } }
    session.push(line({ events: [first, second] }), MAIN)
    const before = session.timelineOf(MAIN.id)
    assert.equal(before?.requests.length, 1)
    assert.equal(before?.requestInput?.peak?.tokens, 300_000)
    assert.equal(before?.requestInput?.highestRatio?.seq, 1)
    session.push(line({ events: [{ ...second, seq: 3, requestInput: { source: 'reported', tokens: 900_000 } }] }), CHILD)
    assert.equal(session.timelineOf(MAIN.id), before)
    session.push(line({ events: [{ ...assistantEvent(3, 'c'), requestInput: { source: 'reported', tokens: 1 } }] }), MAIN)
    assert.equal(session.timelineOf(MAIN.id)?.requestInput?.peak?.tokens, 300_000)
    assert.equal(before?.requestInput?.calls, 2, 'published snapshots stay immutable')
    const replay = new ContextSession('codex', fakeFactory(), { bounds: { maxRequestSteps: 1 } })
    replay.push(line({ events: [first, second] }), MAIN)
    assert.deepEqual(replay.timelineOf(MAIN.id)?.requestInput, before?.requestInput)
  })

  test('keeps estimates, unknowns and real zero distinct and ignores retained-context replay', () => {
    const session = new ContextSession('claude', fakeFactory())
    session.push(line({ events: [
      { ...assistantEvent(1, 'a'), requestInput: { source: 'reported', tokens: 0, window: { tokens: 1_000_000, source: 'inferred', kind: 'model' } } },
      { ...assistantEvent(2, 'b'), requestInput: { source: 'estimated', tokens: 1000 } },
      { ...assistantEvent(3, 'c'), requestInput: { source: 'unknown' } },
      { ...assistantEvent(4, 'd'), data: { replay: true }, requestInput: { source: 'reported', tokens: 9999 } },
    ] }), MAIN)
    const input = session.timelineOf(MAIN.id)?.requestInput
    assert.equal(input?.calls, 3)
    assert.equal(input?.reported, 1)
    assert.equal(input?.peak?.tokens, 0)
    assert.equal(input?.estimatedPeak?.tokens, 1000)
    assert.equal(input?.withWindow, 0)
  })
})

const text = (t: string) => [{ type: 'text', text: t }]

function userEvent(seq: number, body: string): TimelineEvent {
  return { type: 'user/message', seq, time: seq * 1000, data: { content: text(body), source: { kind: 'user' } }, surfaceOp: 'append' }
}

function assistantEvent(seq: number, body: string, usage?: Record<string, number>): TimelineEvent {
  return {
    type: 'assistant/message',
    seq,
    time: seq * 1000,
    data: { message: { content: text(body) }, turn: 1, step: 1, ...(usage === undefined ? {} : { usage }) },
    surfaceOp: 'append',
  }
}

function headerEvent(seq: number): TimelineEvent {
  return {
    type: 'request/header',
    seq,
    time: seq * 1000,
    data: {
      header: {
        system: 'You are an agent.',
        tools: [
          { name: 'Bash', description: 'run a command', parameters: { type: 'object' } },
          { name: 'mcp__github__get_issue' },
        ],
        config: { model: 'claude-opus-5', provider: 'anthropic' },
      },
      reason: 'initial',
    },
  }
}

function session(): ContextSession {
  return new ContextSession('claude', fakeFactory())
}

describe('ContextSession folding', () => {
  test('an unseen file reads as null everywhere', () => {
    const ctx = session()
    assert.equal(ctx.timelineOf('nope'), null)
    assert.equal(ctx.headersOf('nope'), null)
    assert.equal(ctx.contentOf('nope', 1), null)
    assert.equal(ctx.headerContentOf('nope', 1), null)
    assert.equal(ctx.metaOf('nope'), null)
    assert.deepEqual(ctx.files(), [])
    assert.equal(ctx.revision, 0)
  })

  test('pushed lines fold into that file\'s timeline', () => {
    const ctx = session()
    ctx.push(line({ events: [headerEvent(1), userEvent(2, 'hello'), assistantEvent(3, 'hi', { inputTokens: 40, outputTokens: 5 })] }), MAIN)
    const timeline = ctx.timelineOf('main')
    assert.ok(timeline !== null)
    assert.equal(timeline.model, 'claude-opus-5')
    assert.equal(timeline.provider, 'anthropic')
    assert.equal(timeline.humanInputs, 1)
    assert.equal(timeline.requests.length, 1)
    assert.equal(timeline.nodes.length, 2)
    assert.equal(timeline.toolsKnown, true)
  })

  test('each file folds separately — a child is its own context', () => {
    const ctx = session()
    ctx.push(line({ events: [userEvent(1, 'main prompt'), assistantEvent(2, 'main reply')] }), MAIN)
    ctx.push(line({ events: [userEvent(1, 'child task')] }), CHILD)
    assert.equal(ctx.timelineOf('main')?.requests.length, 1)
    assert.equal(ctx.timelineOf('agent-1')?.requests.length, 0)
    assert.equal(ctx.timelineOf('agent-1')?.nodes.length, 1)
    assert.notEqual(ctx.timelineOf('main'), ctx.timelineOf('agent-1'))
  })

  test('the header epochs fold alongside the timeline', () => {
    const ctx = session()
    ctx.push(line({ events: [headerEvent(1)] }), MAIN)
    const headers = ctx.headersOf('main')
    assert.equal(headers?.headers.length, 1)
    assert.equal(headers?.headers[0]?.tools.length, 2)
    assert.ok((headers?.headers[0]?.systemTokens ?? 0) > 0)
    // The default resolver attributes MCP servers and nothing else.
    assert.equal(headers?.headers[0]?.tools[0]?.plugin, undefined)
    assert.equal(headers?.headers[0]?.tools[1]?.plugin, 'mcp:github')
  })

  test('malformed lines and a throwing synthesizer never take the session down', () => {
    const ctx = session()
    ctx.push('not json at all', MAIN)
    ctx.push(line({ throws: true }), MAIN)
    ctx.push(line({ events: [userEvent(1, 'still here')] }), MAIN)
    assert.equal(ctx.timelineOf('main')?.nodes.length, 1)
  })
})

describe('ContextSession content retention', () => {
  test('user, assistant, tool and system content is kept per seq', () => {
    const ctx = session()
    ctx.push(line({
      events: [
        userEvent(1, 'the whole prompt body'),
        assistantEvent(2, 'the whole reply body'),
        {
          type: 'tool/result', seq: 3, time: 3000, surfaceOp: 'append',
          data: {
            message: {
              source: { kind: 'tool', callId: 'c1' },
              content: [{ type: 'tool-result', toolCallId: 'c1', content: text('tool output body') }],
            },
          },
        },
        { type: 'system/message', seq: 4, time: 4000, surfaceOp: 'append', data: { message: { content: text('system body') } } },
      ],
    }), MAIN)
    assert.deepEqual(ctx.contentOf('main', 1), text('the whole prompt body'))
    assert.deepEqual(ctx.contentOf('main', 2), text('the whole reply body'))
    assert.equal(ctx.contentOf('main', 3)?.[0]?.type, 'tool-result')
    assert.deepEqual(ctx.contentOf('main', 4), text('system body'))
    assert.equal(ctx.contentOf('main', 99), null, 'an unknown seq reads null')
    assert.equal(ctx.contentOf('agent-1', 1), null, 'content is per file')
  })

  test('events that carry no content retain nothing', () => {
    const ctx = session()
    ctx.push(line({
      events: [
        { type: 'step/start', seq: 1, time: 1000 },
        { type: 'tool/call', seq: 2, time: 2000, data: { callId: 'c1', name: 'Bash', arguments: '{}' } },
        { type: 'user/message', seq: 3, time: 3000, data: { content: 'not-an-array' }, surfaceOp: 'append' },
      ],
    }), MAIN)
    assert.equal(ctx.contentOf('main', 1), null)
    assert.equal(ctx.contentOf('main', 2), null)
    assert.equal(ctx.contentOf('main', 3), null)
  })

  test('header content keeps the system text and the tool schemas', () => {
    const ctx = session()
    ctx.push(line({ events: [headerEvent(1)] }), MAIN)
    const content = ctx.headerContentOf('main', 1)
    assert.equal(content?.system, 'You are an agent.')
    assert.deepEqual(content?.tools, [
      { name: 'Bash', description: 'run a command', schema: { type: 'object' } },
      { name: 'mcp__github__get_issue' },
    ])
    assert.equal(ctx.headerContentOf('main', 2), null)
  })

  test('a header without a system prompt keeps only the tools', () => {
    const ctx = session()
    ctx.push(line({
      events: [{ type: 'request/header', seq: 1, time: 1000, data: { header: { tools: [{ name: 'Read' }] }, reason: 'change' } }],
    }), MAIN)
    const content = ctx.headerContentOf('main', 1)
    assert.ok(content !== null)
    assert.ok(!('system' in content))
    assert.deepEqual(content.tools, [{ name: 'Read' }])
  })

  test('a hostile header payload degrades instead of throwing', () => {
    const ctx = session()
    ctx.push(line({
      events: [{ type: 'request/header', seq: 1, time: 1000, data: { header: { tools: [null, 7, { name: 42 }] } } }],
    }), MAIN)
    assert.deepEqual(ctx.headerContentOf('main', 1)?.tools, [{ name: '?' }, { name: '?' }, { name: '?' }])
  })
})

describe('ContextSession memoization and revision', () => {
  test('timelineOf/headersOf return the SAME object until that file changes', () => {
    const ctx = session()
    ctx.push(line({ events: [headerEvent(1), userEvent(2, 'hello')] }), MAIN)
    const timeline = ctx.timelineOf('main')
    const headers = ctx.headersOf('main')
    assert.equal(ctx.timelineOf('main'), timeline, 'repeat reads are identity-stable')
    assert.equal(ctx.headersOf('main'), headers)

    ctx.push(line({ events: [userEvent(3, 'more')] }), MAIN)
    assert.notEqual(ctx.timelineOf('main'), timeline, 'a fold change invalidates the memo')
    // The header epochs did not change, but they share the file revision, so a
    // rebuilt value is deep-equal to the old one.
    assert.deepEqual(ctx.headersOf('main'), headers)
  })

  test('one file\'s changes never invalidate another file\'s memo', () => {
    const ctx = session()
    ctx.push(line({ events: [userEvent(1, 'main')] }), MAIN)
    ctx.push(line({ events: [userEvent(1, 'child')] }), CHILD)
    const childTimeline = ctx.timelineOf('agent-1')
    ctx.push(line({ events: [userEvent(2, 'main again')] }), MAIN)
    assert.equal(ctx.timelineOf('agent-1'), childTimeline)
  })

  test('revision bumps on every delivered line and on a new file', () => {
    const ctx = session()
    assert.equal(ctx.revision, 0)
    ctx.push(line({ events: [userEvent(1, 'hello')] }), MAIN)
    const afterFirst = ctx.revision
    assert.ok(afterFirst > 0)
    // A line that folds nothing still moves the revision: synthesizer meta
    // (running, model, children) can change without any event.
    ctx.push(line({ meta: { running: true } }), MAIN)
    assert.ok(ctx.revision > afterFirst)
    const afterMeta = ctx.revision
    ctx.push(line({ events: [userEvent(1, 'child')] }), CHILD)
    assert.ok(ctx.revision > afterMeta, 'a new file bumps too')
  })
})

describe('ContextSession roster and meta', () => {
  test('files() lists main transcripts first, then children in first-seen order', () => {
    const ctx = session()
    ctx.push(line({ events: [] }), CHILD2)
    ctx.push(line({ events: [] }), CHILD)
    ctx.push(line({ events: [] }), MAIN)
    assert.deepEqual(ctx.files().map(f => f.id), ['main', 'agent-2', 'agent-1'])
  })

  test('files() is identity-stable until the roster changes', () => {
    const ctx = session()
    ctx.push(line({ events: [] }), MAIN)
    const first = ctx.files()
    ctx.push(line({ events: [userEvent(1, 'x')] }), MAIN)
    assert.equal(ctx.files(), first)
    ctx.push(line({ events: [] }), CHILD)
    assert.notEqual(ctx.files(), first)
    assert.equal(ctx.files().length, 2)
  })

  test('a richer ref for a known file replaces the stored one', () => {
    const ctx = session()
    const bare: SessionFileRef = { id: 'agent-1', role: 'child', path: '/sessions/agent-1.jsonl' }
    ctx.push(line({ events: [] }), bare)
    assert.equal(ctx.files()[0]?.parentId, undefined)
    ctx.push(line({ events: [] }), CHILD)
    assert.equal(ctx.files()[0]?.parentId, 'main')
    assert.equal(ctx.files().length, 1, 'the same id is one file')
  })

  test('metaOf serves the synthesizer\'s live metadata', () => {
    const ctx = session()
    ctx.push(line({ meta: { label: 'Fix the bug', model: 'claude-opus-5', running: true, children: [['a1', { key: 'a1', label: 'sub task' }]] } }), MAIN)
    const meta = ctx.metaOf('main')
    assert.equal(meta?.label, 'Fix the bug')
    assert.equal(meta?.model, 'claude-opus-5')
    assert.equal(meta?.running, true)
    assert.equal(meta?.children.get('a1')?.label, 'sub task')
  })

  test('the kind and custom bounds ride the session', () => {
    const ctx = new ContextSession('codex', fakeFactory(), { bounds: { maxNodes: 1 } })
    assert.equal(ctx.kind, 'codex')
    ctx.push(line({ events: [userEvent(1, 'a'), userEvent(2, 'b'), userEvent(3, 'c')] }), MAIN)
    assert.equal(ctx.timelineOf('main')?.nodes.length, 1, 'the served window follows the bounds')
    assert.equal(ctx.timelineOf('main')?.droppedNodes, 2)
  })

  test('a custom tool-source resolver replaces the default', () => {
    const ctx = new ContextSession('claude', fakeFactory(), { resolveToolSource: name => `owner:${name}` })
    ctx.push(line({ events: [headerEvent(1)] }), MAIN)
    assert.equal(ctx.headersOf('main')?.headers[0]?.tools[0]?.plugin, 'owner:Bash')
  })
})
