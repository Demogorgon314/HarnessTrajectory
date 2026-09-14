/**
 * Agent-graph derivation — the pure model behind the Agent network card at
 * the foot of the Context tab.
 *
 * dsh-context folded the harness's session-list snapshot (lineage rows plus
 * each session's live projection values) into the current session's agent
 * family. This viewer has no session list: the web app knows every transcript
 * file of the session (main plus one per subagent) and folds each separately,
 * so it hands in ready `AgentNodeInput` rows and this module keeps exactly
 * what it always did with them — the ancestor walk, the DFS, the sibling
 * order, the overflow tally, and the tidy layout.
 *
 * Vendored from dsh-context (Apache-2.0, see ../../NOTICE).
 */

import type { PartsPart } from './categories'
import type { Headline } from './headline'

/** Per-node context stats, as the card renders them. */
export interface AgentStats {
  /** Occupancy + composition parts (null = nothing known about this agent's context). */
  head: Headline | null
  /** Retained request records of that file's timeline. */
  requests: number
  /** Total billed tokens across that file's whole log (null = no usage reported yet). */
  billed: number | null
  /** Active milliseconds of the agent (first → last request), null when unknown. */
  durationMs: number | null
  /** A short descriptor chip (a Claude subagent type, say); null renders no badge. */
  badge: string | null
}

/**
 * One agent the caller knows about: its transcript file id, its caption, its
 * parent (absent for the main file), and the stats folded from its own
 * timeline. Everything is already proven by the caller — this module owns the
 * tree shape, not the data boundary.
 */
export interface AgentNodeInput extends AgentStats {
  id: string
  label: string
  parentId?: string | undefined
  running: boolean
  completed: boolean
  /** False only for the main agent. */
  subagent: boolean
  /** Sibling order tiebreak: freshest activity first. */
  updatedAt?: number | undefined
}

/** One render-ready tree node. */
export interface AgentNode extends AgentStats {
  id: string
  label: string
  parentId?: string | undefined
  /** Layout column (root = 0), assigned during the DFS. */
  depth: number
  /** Which level-1 subtree this node belongs to (root = -1) — drives the family link hue. */
  family: number
  isCurrent: boolean
  running: boolean
  completed: boolean
  subagent: boolean
}

export interface AgentForest {
  /** DFS pre-order (parents ahead of their children). */
  nodes: AgentNode[]
  edges: { from: string; to: string }[]
  /** Subtree members dropped by AGENT_TREE_LIMIT. */
  overflow: number
  /** True when the current agent stands alone (no relatives visible). */
  solo: boolean
}

/** The card stays readable up to this many nodes; the rest folds into an overflow note. */
export const AGENT_TREE_LIMIT = 25

/** Donut geometry: node disc radius and the fused composition/occupancy ring radius (SVG units). */
export const AGENT_NODE_R = 26
export const AGENT_RING_R = 20
/* Horizontal cell pitch adapts to the stage width between these bounds; each
   node owns one cell, so the caption box (cell minus an 8px gutter) can never
   clip at a neighbor or the stage edge. */
const SLOT_MAX = 184
const SLOT_MIN = 112
const CAPTION_GUTTER = 8
/* Vertical pitch between depth levels: node radius + caption zone (up to 3
   wrapped lines + the tokens line) + a dedicated 28px link channel below it. */
const LEVEL_H = 154
/* Bottom edge of a node cell — links exit here, below the caption zone, so a
   connector never crosses a label. */
const CELL_H = AGENT_NODE_R + 64
const PAD_Y = 56

interface AgentChild {
  id: string
  row: AgentNodeInput
}

/**
 * Build the current agent's family from the caller's rows: walk up
 * `parentId` to the topmost known ancestor, then DFS its whole subtree. Null
 * when there is no anchor — no current agent, or no row to stand on.
 * @param inputs - every known agent of this session, in any order.
 * @param currentId - the agent whose context the view is showing.
 */
export function agentForestOf(inputs: readonly AgentNodeInput[], currentId: string | undefined): AgentForest | null {
  if (currentId === undefined || currentId === '') return null

  const rows = new Map<string, AgentNodeInput>()
  for (const row of inputs) rows.set(row.id, row)
  if (!rows.has(currentId)) {
    rows.set(currentId, {
      id: currentId, label: currentId, head: null, requests: 0, billed: null, durationMs: null,
      badge: null, running: false, completed: false, subagent: false, updatedAt: 0,
    })
  }

  // Topmost known ancestor (chain guard: a lineage cycle anchors at the
  // first repeated id instead of looping).
  let root = currentId
  const chain = new Set<string>([currentId])
  for (;;) {
    const parent = rows.get(root)?.parentId
    if (parent === undefined || !rows.has(parent) || chain.has(parent)) break
    chain.add(parent)
    root = parent
  }
  const rootRow = rows.get(root)
  /* v8 ignore next 2 -- root is currentId (inserted above) or a parent
     verified with rows.has, so its row always exists. */
  if (rootRow === undefined) return null

  const childrenOf = new Map<string, AgentChild[]>()
  for (const [id, row] of rows) {
    if (row.parentId === undefined || !rows.has(row.parentId)) continue
    const list = childrenOf.get(row.parentId) ?? []
    list.push({ id, row })
    childrenOf.set(row.parentId, list)
  }
  // Sibling order: running agents first, then freshest activity, id as the stable tiebreak.
  for (const kids of childrenOf.values()) {
    kids.sort((a, b) => {
      const runDelta = Number(b.row.running) - Number(a.row.running)
      if (runDelta !== 0) return runDelta
      const timeDelta = (b.row.updatedAt ?? 0) - (a.row.updatedAt ?? 0)
      return timeDelta !== 0 ? timeDelta : (a.id < b.id ? -1 : 1)
    })
  }

  // Subtree size first (same seen-set semantics as the DFS), so the overflow
  // note is exact even when the cap cuts the walk short.
  const measure = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    let total = 1
    for (const kid of childrenOf.get(id) ?? []) total += measure(kid.id, seen)
    return total
  }
  const total = measure(root, new Set())

  const nodes: AgentNode[] = []
  const edges: { from: string; to: string }[] = []
  const visit = (id: string, row: AgentNodeInput, parentId: string | undefined, depth: number, seen: Set<string>, family: number): void => {
    if (seen.has(id) || nodes.length >= AGENT_TREE_LIMIT) return
    seen.add(id)
    const node: AgentNode = {
      head: row.head,
      requests: row.requests,
      billed: row.billed,
      durationMs: row.durationMs,
      badge: row.badge,
      id,
      label: row.label,
      ...(parentId !== undefined ? { parentId } : {}),
      depth,
      family,
      isCurrent: id === currentId,
      running: row.running,
      completed: row.completed,
      subagent: row.subagent,
    }
    nodes.push(node)
    if (parentId !== undefined) edges.push({ from: parentId, to: id })
    // A level-1 child's index seeds the family hue; deeper nodes inherit it.
    const kids = childrenOf.get(id) ?? []
    kids.forEach((kid, ki) => {
      visit(kid.id, kid.row, id, depth + 1, seen, depth === 0 ? ki : family)
    })
  }
  visit(root, rootRow, undefined, 0, new Set(), -1)

  return { nodes, edges, overflow: Math.max(0, total - nodes.length), solo: nodes.length === 1 }
}

export interface AgentPoint {
  id: string
  x: number
  y: number
  depth: number
}

export interface AgentLink {
  to: string
  running: boolean
  /** Family hue of the child's level-1 subtree — parents are told apart by color. */
  color: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface AgentLayout {
  width: number
  height: number
  /** Caption box width for this layout — follows the resolved slot pitch. */
  captionW: number
  points: AgentPoint[]
  links: AgentLink[]
}

/**
 * Tidy top-down tree layout: one row per depth level, siblings claim leaf
 * slots, parents center over their children. Fully responsive to the stage's
 * visible width: the slot pitch stretches up to SLOT_MAX and compresses down
 * to SLOT_MIN (captions wrap tighter); a level that still overflows wraps
 * into bands of at most a per-level node count derived from the stage width —
 * vertical room is cheaper than horizontal scrolling. Links exit a parent at
 * its cell bottom (below the caption zone) and enter the child at its top,
 * so a connector never crosses a label.
 */
export function layoutForest(forest: AgentForest, stageWidth = 0): AgentLayout {
  // Children lists in DFS order (nodes are DFS pre-order, so plain iteration appends in visit order).
  const childrenOf = new Map<string, AgentNode[]>()
  for (const n of forest.nodes) {
    if (n.parentId === undefined) continue
    const kids = childrenOf.get(n.parentId) ?? []
    kids.push(n)
    childrenOf.set(n.parentId, kids)
  }

  // Tidy x: leaves claim successive slots; internal nodes center over their children.
  const slotOf = new Map<string, number>()
  let leafSlots = 0
  const place = (node: AgentNode): number => {
    const kids = childrenOf.get(node.id) ?? []
    if (kids.length === 0) {
      const slot = leafSlots
      leafSlots++
      slotOf.set(node.id, slot)
      return slot
    }
    let first = 0
    let last = 0
    kids.forEach((kid, index) => {
      const slot = place(kid)
      if (index === 0) first = slot
      last = slot
    })
    const slot = (first + last) / 2
    slotOf.set(node.id, slot)
    return slot
  }
  /* v8 ignore next 1 -- a forest always holds at least the (possibly
     synthesized) current node. */
  if (forest.nodes.length > 0) place(forest.nodes[0]!)

  // Cell model: the layout is exactly `leafSlots` cells wide. While the cells
  // fit the stage at the minimum pitch, the pitch simply adapts; beyond that,
  // levels wrap into bands of `perLevel` cells — vertical room is cheaper
  // than horizontal scrolling, and the stage never overflows.
  const perLevel = stageWidth > 0 ? Math.max(2, Math.floor(stageWidth / SLOT_MIN)) : 0

  if (perLevel > 0 && leafSlots > perLevel) {
    // Wrapped layout: bands of at most perLevel cells, interleaved by kinship
    // — after each parent band come the bands of exactly those parents'
    // children (sibling groups never split unless one group alone exceeds the
    // band). DFS order is preserved at every level, so trunks from parents to
    // child bands match monotonically and never cross.
    const bandSlot = Math.min(SLOT_MAX, stageWidth / perLevel)
    const width = perLevel * bandSlot
    const points: AgentPoint[] = []
    let row = 0
    const emitBand = (nodes: AgentNode[], depth: number): void => {
      // A short (last) band centers its cells instead of hugging the left edge.
      const inset = (width - nodes.length * bandSlot) / 2
      nodes.forEach((node, i) => {
        points.push({ id: node.id, x: inset + (i + 0.5) * bandSlot, y: PAD_Y + row * LEVEL_H, depth })
      })
      row++
      let band: AgentNode[] = []
      const flush = (): void => {
        if (band.length === 0) return
        const packed = band
        band = []
        emitBand(packed, depth + 1)
      }
      for (const node of nodes) {
        const kids = childrenOf.get(node.id) ?? []
        for (let start = 0; start < kids.length; start += perLevel) {
          const group = kids.slice(start, start + perLevel)
          if (band.length + group.length > perLevel) flush()
          band.push(...group)
          if (band.length === perLevel) flush()
        }
      }
      flush()
    }
    /* v8 ignore next 1 -- a forest always holds at least the current node. */
    if (forest.nodes.length > 0) emitBand([forest.nodes[0]!], 0)
    return {
      width,
      height: PAD_Y + (row - 1) * LEVEL_H + CELL_H + 28,
      captionW: bandSlot - CAPTION_GUTTER,
      points,
      links: linksOf(forest, points),
    }
  }

  // Tidy rows: adaptive pitch (0 = unmeasured stage → the natural maximum).
  const slot = stageWidth > 0 && leafSlots > 1 ? Math.min(SLOT_MAX, stageWidth / leafSlots) : SLOT_MAX
  const points: AgentPoint[] = forest.nodes.map(node => ({
    id: node.id,
    /* v8 ignore next 1 -- place() visits every node: the forest is exactly
       the root's subtree by construction. */
    x: (slotOf.get(node.id) ?? 0) * slot + slot / 2,
    y: PAD_Y + node.depth * LEVEL_H,
    depth: node.depth,
  }))
  const maxDepth = points.reduce((max, p) => Math.max(max, p.depth), 0)
  return {
    width: leafSlots * slot,
    // The deepest level still carries its full caption cell below the node.
    height: PAD_Y + maxDepth * LEVEL_H + CELL_H + 28,
    captionW: slot - CAPTION_GUTTER,
    points,
    links: linksOf(forest, points),
  }
}

/**
 * Family hue by level-1 subtree index: the golden angle keeps consecutive
 * families maximally separated on the color wheel without a hand-tuned palette.
 */
export function familyHue(index: number): string {
  return `hsl(${Math.round(index * 137.508) % 360} 58% 52%)`
}

/** Parent→child links: exit the parent's cell bottom, enter the child's top. */
function linksOf(forest: AgentForest, points: AgentPoint[]): AgentLink[] {
  const pointOf = new Map(points.map(p => [p.id, p]))
  const nodeOf = new Map(forest.nodes.map(n => [n.id, n]))
  const runningIds = new Set(forest.nodes.filter(n => n.running).map(n => n.id))
  const links: AgentLink[] = []
  for (const edge of forest.edges) {
    const from = pointOf.get(edge.from)
    const to = pointOf.get(edge.to)
    /* v8 ignore next 2 -- edges are emitted only for visited parent/child
       pairs, so both points always exist. */
    if (from === undefined || to === undefined) continue
    links.push({
      to: edge.to,
      running: runningIds.has(edge.to),
      /* v8 ignore next 1 -- edges only connect visited nodes. */
      color: familyHue(nodeOf.get(edge.to)?.family ?? 0),
      x1: from.x,
      y1: from.y + CELL_H,
      x2: to.x,
      y2: to.y - AGENT_NODE_R - 10,
    })
  }
  return links
}

export interface RingSeg {
  key: string
  /** Segment color; unused for the free remainder (styled by its CSS class). */
  color: string
  /** Arc length along the circle's circumference. */
  len: number
  /** Arc start, as a (negative) stroke dash offset. */
  offset: number
  /** True for the unoccupied-window remainder. */
  free: boolean
}

/**
 * One fused ring per agent — the exact semantics of the chat composer's own
 * context ring: the composition parts, scaled to the occupancy share of the
 * window, fill the circle, and a neutral remainder marks the free window.
 * With no known window the composition fills the whole circle; with no
 * composition (pressure-only rows) a single threshold-colored arc carries
 * the occupancy; a known window with zero occupancy draws the free outline.
 */
export function ringSegments(parts: PartsPart[], pct: number | null, radius: number, fallbackColor: string): RingSeg[] {
  const circumference = 2 * Math.PI * radius
  const occ = pct === null ? 1 : Math.min(100, Math.max(0, pct)) / 100
  let total = 0
  for (const p of parts) total += p.value > 0 ? p.value : 0
  const segs: RingSeg[] = []
  let offset = 0
  if (total > 0) {
    for (const p of parts) {
      if (p.value <= 0) continue
      const len = circumference * (p.value / total) * occ
      if (len <= 0) continue
      segs.push({ key: p.key, color: p.color, len, offset, free: false })
      offset += len
    }
  } else if (pct !== null && occ > 0) {
    // Pressure-only node: a solid occupancy arc in the threshold color.
    segs.push({ key: 'fill', color: fallbackColor, len: circumference * occ, offset: 0, free: false })
    offset = circumference * occ
  }
  if (pct !== null && offset < circumference) {
    segs.push({ key: 'free', color: '', len: circumference - offset, offset, free: true })
  }
  return segs
}

/**
 * Compact duration: `42s`, `3m05s`, `1h07m` (shared by both locales).
 * Deliberately distinct from format.ts's `fmtDuration` (the timing card's
 * `12.3s` / `3m25s`): the inspector's caption column needs whole-second,
 * fixed-width text.
 */
export function fmtDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
