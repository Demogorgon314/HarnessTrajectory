// AgentGraph (src/client/components/agentGraph.tsx) — the Agent network card
// rendered for real: tree rendering with donut/ring geometry, hover inspector,
// click/keyboard navigation, and every degrade arm (no anchor, no stats).
//
// PORT NOTE — dsh-context drove this card off a faithful in-memory
// `ctx.sessions` double (list snapshot + navigation + subagent-catalog
// refresh). This port hands the card its rows as props and navigates through
// `onOpenAgent`, so the fixtures are rows and the service arms (absent
// service, list feed, catalog refresh) are gone with the service.

import { act, createElement as h } from 'react'
import assert from '../helpers/assert.ts'
import { describe, test } from 'vitest'
import { makeAgentGraph, ringColorOf } from '../../../src/client/components/agentGraph'
import type { AgentNodeInput } from '../../../src/client/agentTree'
import { flush, hover, makeKit, mount, query, queryAll, text, unhover, wheel } from '../helpers/kit'

const kit = makeKit()

const GREEN = '#22c55e'

function head(tokens: number, window?: number, parts = true) {
  return {
    tokens,
    ...(window !== undefined ? { window } : {}),
    pct: window !== undefined ? Math.min(100, Math.round(tokens / window * 100)) : null,
    parts: parts ? [{ key: 'user', color: GREEN, value: tokens }] : [],
  }
}

/** One agent row, on the schema defaults the card reads. */
function row(id: string, over: Partial<AgentNodeInput> = {}): AgentNodeInput {
  return {
    id,
    label: id,
    head: null,
    requests: 0,
    billed: null,
    durationMs: null,
    badge: null,
    running: false,
    completed: false,
    subagent: over.parentId !== undefined,
    updatedAt: 1,
    ...over,
  }
}

/** Click an SVG node (jsdom's SVGElement has no HTMLElement.click). */
async function clickEl(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function family(): AgentNodeInput[] {
  return [
    row('root', { label: 'Main Agent', running: true, updatedAt: 10, head: head(500, 1000), billed: 1200, requests: 3 }),
    row('worker', {
      parentId: 'root', label: 'worker-bee', running: true, updatedAt: 8,
      head: head(830, 1000), billed: 150, requests: 5, durationMs: 42_000, badge: 'continuable',
    }),
    row('done', {
      parentId: 'root', completed: true, updatedAt: 6,
      head: { tokens: 950, window: 1000, pct: 95, parts: [] }, badge: 'one-shot',
    }),
  ]
}

describe('AgentGraph — degrade arms', () => {
  test('no current agent renders nothing (and mounts/unmounts cleanly)', async () => {
    const View = makeAgentGraph(kit)
    const m = await mount(h(View, { agents: family(), currentId: '', onOpenAgent: () => {} }))
    assert.equal(text(m.container), '')
    await m.unmount()
  })

  test('an unknown current agent still anchors on a synthesized row', async () => {
    const View = makeAgentGraph(kit)
    const m = await mount(h(View, { agents: [], currentId: 's1', onOpenAgent: () => {} }))
    assert.equal(queryAll(m.container, 'g.lc-agent-node').length, 1)
    assert.ok(text(m.container).includes('No subagents yet'))
    await m.unmount()
  })
})

describe('AgentGraph — the family tree', () => {
  test('renders nodes, chips, links, inspector, and the legend', async () => {
    const View = makeAgentGraph(kit)
    const m = await mount(h(View, { agents: family(), currentId: 'root', onOpenAgent: () => {} }))

    const nodes = queryAll(m.container, 'g.lc-agent-node')
    assert.equal(nodes.length, 3)

    // Chips: 3 agents, 2 running, combined context tokens (500 + 830 + 950).
    const rendered = text(m.container)
    assert.ok(rendered.includes('3 agents'))
    assert.ok(rendered.includes('2 running'))
    assert.ok(rendered.includes('2.3k tokens in context'))

    // The current node wears the brand self-ring and shows its own stats.
    const self = query(m.container, 'g.lc-agent-self')
    assert.equal(self.getAttribute('data-agent'), 'root')
    assert.equal(self.getAttribute('role'), 'img')
    assert.ok(text(self).includes('50%'))
    assert.ok(self.querySelector('.lc-agent-self-badge') !== null)
    assert.ok(query(m.container, 'g[data-agent="worker"]').querySelector('.lc-agent-self-badge') === null)

    // Links join both children: the running one layers a flowing pulse over the solid lineage stroke.
    const links = queryAll(m.container, 'path.lc-agents-link')
    assert.equal(links.length, 2)
    assert.equal(queryAll(m.container, 'path.lc-agents-link-live').length, 1)
    assert.equal(queryAll(m.container, 'path.lc-agents-flow').length, 1)

    // The worker node: its own label, running halo class, fused ring (composition + free remainder).
    const worker = query(m.container, 'g[data-agent="worker"]')
    assert.ok(text(worker).includes('worker-bee'))
    assert.ok(text(worker).includes('83%'))
    assert.ok(worker.classList.contains('lc-agent-running'))
    assert.ok(worker.querySelectorAll('circle.lc-agent-seg').length > 1)
    assert.ok(worker.querySelector('circle.lc-agent-free') !== null)

    // The finished child: no composition parts → one occupancy arc plus the free remainder, done halo class.
    const done = query(m.container, 'g[data-agent="done"]')
    assert.ok(text(done).includes('95%'))
    assert.ok(done.classList.contains('lc-agent-done'))
    assert.equal(done.querySelectorAll('circle.lc-agent-seg').length, 2)
    assert.ok(done.querySelector('circle.lc-agent-free') !== null)

    // The inspector mirrors the current node by default, with the self badge.
    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('Main Agent'))
    assert.ok(text(inspector).includes('current'))
    assert.ok(text(inspector).includes('500 / 1.0k · 50%'))
    assert.ok(text(inspector).includes('3 requests'))
    assert.ok(text(inspector).includes('1.2k billed'))
    assert.ok(!text(inspector).includes('click to open'))

    // The legend lists all six categories plus the free-window and running-edge keys.
    assert.equal(queryAll(m.container, '.lc-agents-legend-item').length, 9)

    // The stage cancels a horizontal swipe it cannot consume, so the browser never reads it as a history swipe
    // (jsdom reports zero scroll metrics, so a horizontal-dominant gesture always sits at the edge).
    const stage = query(m.container, '.lc-agents-stage')
    assert.equal(wheel(stage, 30, 0), true, 'horizontal swipe canceled at the stage edge')
    assert.equal(wheel(stage, 30, 120), false, 'vertical-dominant gestures stay with the page')

    await m.unmount()
  })

  test('hover moves the inspector, click/Enter opens the agent', async () => {
    const opened: string[] = []
    const View = makeAgentGraph(kit)
    const m = await mount(h(View, { agents: family(), currentId: 'root', onOpenAgent: (id: string) => opened.push(id) }))

    const worker = query(m.container, 'g[data-agent="worker"]')
    await hover(worker)
    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('worker-bee'))
    assert.ok(text(inspector).includes('continuable'))
    assert.ok(text(inspector).includes('5 requests'))
    assert.ok(text(inspector).includes('150 billed'))
    assert.ok(text(inspector).includes('42s'))
    assert.ok(text(inspector).includes('click to open'))
    assert.ok(worker.classList.contains('lc-agent-hover'))
    await unhover(worker)
    assert.ok(text(query(m.container, '.lc-agents-inspector')).includes('Main Agent'))

    // Click and keyboard both navigate; the current node never navigates.
    await clickEl(worker)
    assert.deepEqual(opened, ['worker'])

    await hover(query(m.container, 'g[data-agent="done"]'))
    const doneInspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(doneInspector).includes('one-shot'))
    assert.ok(text(doneInspector).includes('950 / 1.0k · 95%'))
    await unhover(query(m.container, 'g[data-agent="done"]'))
    await act(async () => {
      query(m.container, 'g[data-agent="done"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    assert.deepEqual(opened, ['worker', 'done'])
    await act(async () => {
      query(m.container, 'g[data-agent="worker"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
      )
    })
    assert.deepEqual(opened, ['worker', 'done'])
    await clickEl(query(m.container, 'g[data-agent="root"]'))
    assert.deepEqual(opened, ['worker', 'done'])

    await m.unmount()
  })

  test('new rows re-render the tree live', async () => {
    const View = makeAgentGraph(kit)
    const m = await mount(h(View, {
      agents: [row('root', { label: 'Main' })],
      currentId: 'root',
      onOpenAgent: () => {},
    }))
    assert.ok(text(m.container).includes('No subagents yet'))
    assert.equal(queryAll(m.container, 'g.lc-agent-node').length, 1)

    await m.update(h(View, {
      agents: [row('root', { label: 'Main' }), row('kid', { parentId: 'root', running: true, updatedAt: 2 })],
      currentId: 'root',
      onOpenAgent: () => {},
    }))
    await flush()
    assert.equal(queryAll(m.container, 'g.lc-agent-node').length, 2)
    assert.ok(!text(m.container).includes('No subagents yet'))
    assert.ok(text(m.container).includes('2 agents'))

    await m.unmount()
  })

  test('a family with no token data at all hides the totals chip', async () => {
    const View = makeAgentGraph(kit)
    const m = await mount(h(View, { agents: [row('root', { label: 'Main' })], currentId: 'root', onOpenAgent: () => {} }))
    assert.ok(text(m.container).includes('1 agents'))
    assert.ok(!text(m.container).includes('tokens in context'))
    await m.unmount()
  })

  test('overflow chip when the family exceeds the cap', async () => {
    const agents = [row('root', { label: 'Main' })]
    for (let i = 0; i < 30; i++) agents.push(row('kid' + i, { parentId: 'root', updatedAt: i }))
    const View = makeAgentGraph(kit)
    const m = await mount(h(View, { agents, currentId: 'root', onOpenAgent: () => {} }))
    assert.ok(text(m.container).includes('6 more not shown'))
    assert.ok(text(m.container).includes('31 agents'))
    await m.unmount()
  })

  test('stat-less nodes render dashes; zero occupancy draws no ring', async () => {
    const View = makeAgentGraph(kit)
    const m = await mount(h(View, {
      agents: [
        row('root', { label: 'Main' }),
        row('bare', { parentId: 'root', updatedAt: 2 }),
        row('zero', { parentId: 'root', updatedAt: 3, head: { tokens: 0, window: 1000, pct: 0, parts: [] } }),
        row('longname', { parentId: 'root', updatedAt: 4, label: 'a-very-long-descriptor-label' }),
        // Occupancy with no window: tokens with no denominator, no percentage.
        row('windowless', { parentId: 'root', updatedAt: 5, head: { tokens: 640, pct: null, parts: [] } }),
        // Usage reported but all-zero: the billed bit stays out of the inspector.
        row('flatusage', { parentId: 'root', updatedAt: 6, billed: 0 }),
      ],
      currentId: 'root',
      onOpenAgent: () => {},
    }))

    const bare = query(m.container, 'g[data-agent="bare"]')
    assert.ok(text(bare).includes('—'))
    assert.equal(bare.querySelectorAll('circle.lc-agent-seg').length, 0)

    const zero = query(m.container, 'g[data-agent="zero"]')
    assert.ok(text(zero).includes('0%'))
    // Zero occupancy on a known window: just the free outline.
    assert.equal(zero.querySelectorAll('circle.lc-agent-seg').length, 1)
    assert.ok(zero.querySelector('circle.lc-agent-free') !== null)

    // Long labels wrap in full — no ellipsis truncation.
    assert.ok(text(query(m.container, 'g[data-agent="longname"]')).includes('a-very-long-descriptor-label'))

    // The inspector for a stat-less node shows just the identity.
    await hover(bare)
    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('bare'))
    assert.equal(query(inspector, '.lc-agents-inspector-stats').textContent, '')

    // Windowless occupancy: a bare token figure, no ' / window' and no percentage.
    await hover(query(m.container, 'g[data-agent="windowless"]'))
    assert.equal(query(m.container, '.lc-agents-inspector-stats').textContent, '640')

    // All-zero usage: no billed bit at all.
    await hover(query(m.container, 'g[data-agent="flatusage"]'))
    assert.ok(!text(query(m.container, '.lc-agents-inspector')).includes('billed'))

    // Self with no stats: no percentage, no chips tokens.
    assert.ok(text(query(m.container, 'g.lc-agent-self')).includes('—'))

    await m.unmount()
  })

  test('zh locale renders translated chrome', async () => {
    const View = makeAgentGraph(makeKit('zh'))
    const m = await mount(h(View, { agents: family(), currentId: 'root', onOpenAgent: () => {} }))
    const rendered = text(m.container)
    assert.ok(rendered.includes('Agent 网络'))
    assert.ok(rendered.includes('3 个 Agent'))
    assert.ok(rendered.includes('当前'))
    await m.unmount()
  })
})

describe('ringColorOf', () => {
  test('occupancy thresholds', () => {
    assert.equal(ringColorOf(null), 'var(--dsw-alias-border-l1)')
    assert.equal(ringColorOf(95), 'var(--color-red-500)')
    assert.equal(ringColorOf(70), 'var(--color-amber-500)')
    assert.equal(ringColorOf(12), 'var(--color-green-500)')
  })
})
