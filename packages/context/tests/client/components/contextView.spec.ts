// ContextView (src/client/components/contextView.tsx) — the Context tab root
// rendered for real: stats, session info, composition, trend chart, events,
// file activity, the agent network and the composed Context browser, driven
// by real fold-shaped values and real settings. Covers the view's own
// branches (loading, granularity/trend-mode state, kind filter, brief→browser
// locate bridge, file-activity locate, scroll ledger, breadcrumb navigation,
// the derived/unrecorded honesty markers, locale arms, error boundary).
//
// PORT NOTE — dsh-context drove this view off the harness projection seats
// (`useProjection`/`useChat`), the gateway history fetchers, the chat→Context
// jump relay, the sidebar host, the baseline gate, and the split detail
// channel. None of those exist here: every input is a prop, so those describes
// are gone and the ones below exercise the same view through the new boundary.

import { act, createElement as h, type ReactElement } from 'react'
import assert from '../helpers/assert.ts'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, test } from 'vitest'
import { ContextView, joinNodesOf, makeContextView, usageOfRequests } from '../../../src/client/components/contextView'
import type { ContextViewProps } from '../../../src/client/components/contextView'
import { createContextSettings } from '../../../src/client/settings'
import { createContextTranslate, DICT_EN } from '../../../src/client/i18n'
import type { AgentNodeInput } from '../../../src/client/agentTree'
import type { ContentBlock } from '../../../src/fold/event'
import type { ContextHeaders, ContextTimeline, RequestRecord } from '../../../src/shared/types'
import { click, flush, hover, makeKit, mount, query, queryAll, silenceWindowErrors, text, unhover } from '../helpers/kit'

const kit = makeKit()
const T0 = 1700000000000

let keyCounter = 0
function freshSettings() {
  keyCounter++
  return createContextSettings(`test.view.${keyCounter}`)
}

beforeEach(() => {
  localStorage.clear()
})

function timeline(over: Record<string, unknown> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 100, tools: 200, user: 300, inject: 50, skill: 0, assistant: 400, tool: 150, total: 1200 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  } as ContextTimeline
}

/** Two steps of one turn plus a turn-less trailing step, with their nodes. */
function richTimeline(over: Record<string, unknown> = {}): ContextTimeline {
  return timeline({
    model: 'claude-opus-5',
    provider: 'anthropic',
    contextWindow: 200000,
    toolCalls: 3,
    humanInputs: 1,
    images: 1,
    requests: [
      { seq: 2, turn: 1, step: 1, time: T0 + 1000, system: 100, tools: 200, user: 10, inject: 0, assistant: 20, tool: 0, total: 330, prompt: 350, output: 20, cacheRead: 100 },
      { seq: 4, turn: 1, step: 2, time: T0 + 3000, system: 100, tools: 200, user: 10, inject: 0, assistant: 60, tool: 30, total: 400 },
      { seq: 6, time: T0 + 5000, system: 100, tools: 200, user: 10, inject: 0, assistant: 80, tool: 30, total: 420 },
    ] satisfies RequestRecord[],
    events: [
      { seq: 3, time: T0 + 2000, kind: 'compaction', count: 2, turn: 1, step: 2, fromTurn: 1, fromStep: 1, tokens: 500 },
      { seq: 5, time: T0 + 4000, kind: 'inject', form: 'notice', name: 'heads-up', tokens: 12, turn: 1, step: 3 },
    ],
    nodes: [
      { seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 + 500 },
      { seq: 2, cat: 'assistant', tokens: 20, text: 'reply one', time: T0 + 1000 },
      { seq: 3, cat: 'tool', tokens: 30, tool: 'bash', text: 'file output', time: T0 + 2000 },
      { seq: 4, cat: 'assistant', tokens: 60, text: 'reply two', time: T0 + 3000 },
      { seq: 6, cat: 'assistant', tokens: 80, text: 'reply three', time: T0 + 5000 },
    ],
    droppedNodes: 2,
    ...over,
  })
}

const CONTENT: Record<number, ContentBlock[]> = {
  1: [{ type: 'text', text: 'hello there' }],
  2: [{ type: 'text', text: 'reply one' }, { type: 'tool-call', name: 'bash', callId: 'c1', arguments: '{"description":"list files"}' }],
  3: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file output' }] }],
  4: [{ type: 'text', text: 'reply two' }],
  6: [{ type: 'text', text: 'reply three' }],
}

function agents(): AgentNodeInput[] {
  return [
    { id: 'main', label: 'Main session', head: null, requests: 3, billed: 100, durationMs: null, badge: null, running: false, completed: true, subagent: false, updatedAt: 2 },
    { id: 'kid', label: 'Explore the repo', parentId: 'main', head: null, requests: 1, billed: 10, durationMs: 1000, badge: 'Explore', running: false, completed: true, subagent: true, updatedAt: 1 },
  ]
}

function props(over: Partial<ContextViewProps> = {}): ContextViewProps {
  return {
    timeline: richTimeline(),
    headers: null,
    contentOf: (seq: number) => CONTENT[seq] ?? null,
    headerContentOf: () => null,
    agents: agents(),
    currentAgentId: 'main',
    onOpenAgent: () => {},
    sessionInfo: { harness: 'Claude Code' },
    t: kit.t,
    locale: 'en',
    settings: freshSettings(),
    ...over,
  }
}

/** A button whose text matches (case-sensitively) the given label. */
function buttonByText(container: ParentNode, label: string): HTMLElement {
  const hit = queryAll(container, 'button').find(b => text(b) === label)
  if (hit === undefined) throw new Error(`button not found: ${label}`)
  return hit
}

function viewOf(settings = freshSettings()) {
  return makeContextView(kit, settings)
}

describe('ContextView — loading and shell', () => {
  test('a null timeline renders the loading well, with the top bar already up', async () => {
    const View = viewOf()
    const m = await mount(h(View, props({ timeline: null })))
    assert.ok(text(m.container).includes(DICT_EN['loading']!))
    // The settings gear is part of the shell, not of the data.
    assert.equal(queryAll(m.container, '.lc-settings-gear').length, 1)
    await m.unmount()
  })

  test('a folded timeline renders every card', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    const rendered = text(m.container)
    assert.ok(rendered.includes(DICT_EN['stats.title']!), 'context stats')
    assert.ok(rendered.includes(DICT_EN['session.title']!), 'session info')
    assert.ok(rendered.includes(DICT_EN['tokens.title']!), 'token stats')
    assert.ok(rendered.includes(DICT_EN['timing.title']!), 'timing stats')
    assert.ok(rendered.includes(DICT_EN['overview.title']!), 'current composition')
    assert.ok(rendered.includes(DICT_EN['trend.title']!), 'trend')
    assert.ok(rendered.includes(DICT_EN['browser.title']!), 'browser')
    assert.ok(rendered.includes(DICT_EN['events.title']!), 'events')
    assert.ok(rendered.includes(DICT_EN['files.title']!), 'file activity')
    assert.ok(rendered.includes(DICT_EN['agents.title']!), 'agent network')
    assert.ok(rendered.includes(DICT_EN['footer']!), 'footer')
    // The composition card's subtitle names model · provider.
    assert.ok(rendered.includes('claude-opus-5 · anthropic'))
    await m.unmount()
  })

  test('an empty request log says so instead of drawing an empty chart', async () => {
    const View = viewOf()
    const m = await mount(h(View, props({ timeline: timeline() })))
    assert.ok(text(m.container).includes(DICT_EN['trend.empty']!))
    await m.unmount()
  })

  test('the session info card renders the facts it is given', async () => {
    const View = viewOf()
    const m = await mount(h(View, props({
      sessionInfo: {
        harness: 'Claude Code',
        model: 'claude-opus-5',
        provider: 'anthropic',
        contextWindow: 200000,
        version: '2.1.0',
        cwd: '/repo',
        startedAt: T0,
        resumeCommand: 'claude --resume abc',
        reportedCostUsd: 0.1234,
      },
    })))
    const card = query(m.container, '.lc-pi-grid')
    const rendered = text(card)
    assert.ok(rendered.includes('Claude Code'))
    assert.ok(rendered.includes('claude-opus-5 · anthropic'))
    assert.ok(rendered.includes('200.0k tokens'))
    assert.ok(rendered.includes('2.1.0'))
    assert.ok(rendered.includes('/repo'))
    assert.ok(rendered.includes('claude --resume abc'))
    assert.ok(rendered.includes('$0.1234'))
    // The resume row ships the browser's own copy control.
    assert.equal(queryAll(card, '.lc-rich-copy').length, 1)
    await m.unmount()
  })
})

describe('ContextView — interactions', () => {
  test('granularity and trend-mode toggles re-render the chart', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    assert.equal(queryAll(m.container, '.lc-bar').length, 3, 'three step bars')
    await click(buttonByText(m.container, DICT_EN['gran.turn']!))
    // Turn 1's two steps collapse; the turn-less trailing step stays its own bar.
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    await click(buttonByText(m.container, DICT_EN['gran.step']!))
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)

    await click(buttonByText(m.container, DICT_EN['gran.delta']!))
    assert.ok(queryAll(m.container, '.lc-detail-num-up').length + queryAll(m.container, '.lc-detail-num-down').length > 0)
    await click(buttonByText(m.container, DICT_EN['gran.total']!))
    await m.unmount()
  })

  test('the adaptive switch toggles on and off', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    const adaptive = buttonByText(m.container, DICT_EN['trend.adaptive']!)
    assert.ok(!adaptive.className.includes('lc-gran-on'))
    await click(adaptive)
    assert.ok(buttonByText(m.container, DICT_EN['trend.adaptive']!).className.includes('lc-gran-on'))
    await m.unmount()
  })

  test('the settings defaults seed the chart at mount', async () => {
    const settings = freshSettings()
    settings.set('defaultGranularity', 'turn')
    settings.set('defaultTrendMode', 'delta')
    const View = viewOf(settings)
    const m = await mount(h(View, props({ settings })))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    assert.ok(buttonByText(m.container, DICT_EN['gran.delta']!).className.includes('lc-gran-on'))
    await m.unmount()
  })

  test('the event kind filter narrows the list and restores on the second click', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    assert.equal(queryAll(m.container, '.lc-events .lc-event').length, 2)
    const inject = query(m.container, 'button[data-kind="inject"]')
    await click(inject)
    assert.equal(queryAll(m.container, '.lc-events .lc-event').length, 1)
    await click(inject)
    assert.equal(queryAll(m.container, '.lc-events .lc-event').length, 2)
    await m.unmount()
  })

  test('hovering a bar moves the browser preview and the file scope', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    const bars = queryAll(m.container, '.lc-bar')
    await hover(bars[0]!)
    assert.ok(text(m.container).includes('Turn 1 · Step 1 of 2'))
    await unhover(bars[0]!)
    await m.unmount()
  })

  test('clicking a bar pins it and the browser follows the pin', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    const bars = queryAll(m.container, '.lc-bar')
    await click(bars[0]!)
    assert.ok(queryAll(m.container, '.lc-bar-selected').length === 1)
    // The browser's step picker now names that step instead of the live surface.
    const picker = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.notEqual(picker.value, 'live')
    await m.unmount()
  })

  test('brief rows locate their node in the browser (input, mid response, live response)', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')

    // Pin the second bar: brief = opener + inputs (node 3) + response (node 4).
    await click(query(m.container, '.lc-bar[data-seq="4"]'))
    const briefRows = queryAll(m.container, '.lc-brief-row')
    assert.equal(briefRows.length, 3)

    // The In row reveals node 3 (tool) inside the step's OWN surface.
    const inRow = briefRows.find(r => text(r).includes(DICT_EN['brief.input']!))
    assert.ok(inRow !== undefined)
    await click(inRow)
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('file output'))

    // The response of a middle bar first appears in the NEXT step's surface.
    const replyRow = briefRows.find(r => text(r).includes('reply two'))
    assert.ok(replyRow !== undefined)
    await click(replyRow)
    assert.equal(pick.value, '6')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply two'))

    // The last bar's response lands on the LIVE surface.
    await click(query(m.container, '.lc-bar[data-seq="6"]'))
    const lastReply = queryAll(m.container, '.lc-brief-row').find(r => text(r).includes('reply three'))
    assert.ok(lastReply !== undefined)
    await click(lastReply)
    assert.equal(pick.value, 'live')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply three'))
    await m.unmount()
  })
})

describe('ContextView — the browser join', () => {
  test('the fold content reaches the browser rows', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    // The tool category holds one row (the live surface's tool result); a
    // single-item category opens its row with the category.
    const toolRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.tool']!))
    assert.ok(toolRow !== undefined)
    // The collapsed row previews by the CALL's arguments — recovered from the
    // assistant message that issued it (see joinNodesOf).
    await click(toolRow)
    const open = query(m.container, '.lc-br-elem-on')
    assert.ok(text(open).includes('list files'), 'call-argument preview')
    assert.ok(text(open).includes('file output'), 'result body')
    await m.unmount()
  })

  test('joinNodesOf rebuilds the chat-window join from the fold content', () => {
    const joined = joinNodesOf(richTimeline(), seq => CONTENT[seq] ?? null)
    assert.deepEqual(joined.map(n => n.seq), [1, 2, 3, 4, 6])
    assert.equal(joined[1]?.kind, 'assistant')
    const toolNode = joined.find(n => n.seq === 3)
    assert.equal(toolNode?.kind, 'tool-result')
    // The result recovers the call that issued it, so rows can preview by arguments.
    assert.equal(toolNode?.call?.name, 'bash')
    assert.equal(toolNode?.call?.argsRaw, '{"description":"list files"}')
    // The wrapper block unwraps to the inner blocks the body renderer reads.
    assert.deepEqual(toolNode?.content, [{ type: 'text', text: 'file output' }])
  })

  test('joinNodesOf skips seqs the fold kept no content for', () => {
    const joined = joinNodesOf(richTimeline(), seq => (seq === 2 ? CONTENT[2]! : null))
    assert.deepEqual(joined.map(n => n.seq), [2])
  })
})

describe('ContextView — honesty markers', () => {
  test('a derived system remainder marks the legend and the browser row', async () => {
    const View = viewOf()
    const m = await mount(h(View, props({
      timeline: richTimeline({ systemDerived: true }),
    })))
    assert.ok(text(query(m.container, '.lc-legend')).includes(DICT_EN['derived.mark']!))
    const systemRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.system']!))
    assert.ok(systemRow !== undefined)
    assert.ok(text(systemRow).includes(DICT_EN['derived.mark']!))
    // Opening it explains the gap rather than blaming retention.
    await click(systemRow)
    assert.ok(text(m.container).includes(DICT_EN['derived.systemBody']!))
    await m.unmount()
  })

  test('unrecorded tool schemas say so instead of claiming 0 items', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    const toolsRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.tools']!))
    assert.ok(toolsRow !== undefined)
    assert.ok(text(toolsRow).includes(DICT_EN['tools.unrecorded']!))
    assert.ok(!text(toolsRow).includes(DICT_EN['browser.items']!.replace('{n}', '0')))
    await click(toolsRow)
    assert.ok(text(m.container).includes(DICT_EN['tools.unrecordedBody']!))
    await m.unmount()
  })

  test('a recorded tool list counts its items normally', async () => {
    const headers: ContextHeaders = {
      headers: [{ seq: 1, time: T0, systemTokens: 100, tools: [{ name: 'bash', tokens: 200 }] }],
    }
    const View = viewOf()
    const m = await mount(h(View, props({
      timeline: richTimeline({ toolsKnown: true }),
      headers,
      headerContentOf: () => ({ system: 'You are an agent.', tools: [{ name: 'bash', description: 'run' }] }),
    })))
    const toolsRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.tools']!))
    assert.ok(toolsRow !== undefined)
    assert.ok(text(toolsRow).includes('1 Items'))
    await m.unmount()
  })
})

describe('ContextView — the agent network', () => {
  test('a child node navigates through onOpenAgent', async () => {
    const opened: string[] = []
    const View = viewOf()
    const m = await mount(h(View, props({ onOpenAgent: (id: string) => opened.push(id) })))
    const kid = query(m.container, 'g[data-agent="kid"]')
    assert.ok(text(kid).includes('Explore the repo'))
    await act(async () => {
      kid.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.deepEqual(opened, ['kid'])
    await m.unmount()
  })

  test('a child view shows a breadcrumb back to the main agent', async () => {
    const opened: string[] = []
    const View = viewOf()
    const m = await mount(h(View, props({ currentAgentId: 'kid', onOpenAgent: (id: string) => opened.push(id) })))
    const crumb = query(m.container, '.lc-crumb')
    assert.ok(text(crumb).includes('Main session'))
    await click(crumb)
    assert.deepEqual(opened, ['main'])
    await m.unmount()
  })

  test('the main view shows no breadcrumb', async () => {
    const View = viewOf()
    const m = await mount(h(View, props()))
    assert.equal(queryAll(m.container, '.lc-crumb').length, 0)
    await m.unmount()
  })
})

describe('ContextView — file activity', () => {
  test('the op log drives the card and a row locates in the browser', async () => {
    const View = viewOf()
    const m = await mount(h(View, props({
      timeline: richTimeline({
        fileOps: [
          { seq: 3, path: 'src/a.ts', kind: 'read', tool: 'Read', time: T0 + 2000, err: false, added: 0, removed: 0 },
        ],
      }),
    })))
    assert.ok(text(m.container).includes('src/a.ts'))
    await click(query(m.container, '.lc-fa-item button'))
    const opLink = query(m.container, '.lc-fa-op-link')
    await click(opLink)
    // The browser opened the tool category with the op's result row expanded.
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('file output'))
    await m.unmount()
  })
})

describe('ContextView — scroll ledger', () => {
  test('the position is saved per agent and restored on return', async () => {
    const View = viewOf()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const render = async (el: ReactElement) => { await act(async () => { root.render(el) }) }

    await render(h(View, props({ currentAgentId: 'ledger-a' })))
    const scroller = query(container, '.lc-root')
    scroller.scrollTop = 123
    await render(h(View, props({ currentAgentId: 'ledger-b' })))
    assert.equal(query(container, '.lc-root').scrollTop, 0, 'a fresh agent starts at the top')
    await render(h(View, props({ currentAgentId: 'ledger-a' })))
    assert.equal(query(container, '.lc-root').scrollTop, 123)
    await act(async () => { root.unmount() })
    container.remove()
  })
})

describe('ContextView — locale', () => {
  test('zh renders the translated chrome', async () => {
    const zhKit = makeKit('zh')
    const View = makeContextView(zhKit, freshSettings())
    const m = await mount(h(View, props({ t: zhKit.t, locale: 'zh' })))
    const rendered = text(m.container)
    assert.ok(rendered.includes('上下文统计'))
    assert.ok(rendered.includes('会话信息'))
    assert.ok(rendered.includes('Agent 网络'))
    await m.unmount()
  })

  test('the exported ContextView builds its kit from the t prop', async () => {
    const t = createContextTranslate('zh')
    const m = await mount(h(ContextView, props({ t, locale: 'zh' })))
    assert.ok(text(m.container).includes('上下文统计'))
    await m.unmount()
  })
})

describe('ContextView — error boundary', () => {
  test('a throwing subtree degrades to the error card', async () => {
    const restore = silenceWindowErrors()
    const View = viewOf()
    // A hostile `contentOf` throws inside the join, under the boundary.
    const m = await mount(h(View, props({
      contentOf: () => { throw new Error('boom') },
    })))
    assert.ok(text(m.container).includes(DICT_EN['error']!))
    assert.ok(text(m.container).includes('boom'))
    // Retry resets the boundary.
    await click(query(m.container, '.lc-error-retry'))
    await flush()
    restore()
    await m.unmount()
  })
})

describe('usageOfRequests', () => {
  test('sums the request records into the provider usage buckets', () => {
    assert.deepEqual(
      usageOfRequests([
        { seq: 1, time: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, prompt: 1000, cacheRead: 600, cacheWrite: 100, output: 50 },
        { seq: 2, time: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, prompt: 200, output: 10 },
      ]),
      { uncachedInputTokens: 500, outputTokens: 60, cacheReadTokens: 600, cacheWriteTokens: 100 },
    )
  })

  test('a log with no reported usage stays null (the cache-hit cell shows a dash)', () => {
    assert.equal(usageOfRequests([
      { seq: 1, time: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 },
    ]), null)
    assert.equal(usageOfRequests([]), null)
  })

  test('a cache split larger than the prompt never drives the uncached bucket negative', () => {
    const usage = usageOfRequests([
      { seq: 1, time: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, prompt: 100, cacheRead: 900 },
    ])
    assert.equal(usage?.uncachedInputTokens, 0)
  })
})
