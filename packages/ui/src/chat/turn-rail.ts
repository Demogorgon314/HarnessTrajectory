import type { ConversationNode, TrajectorySnapshot } from '@harness-trajectory/core'
import { chatNodeTurn } from './flow.ts'

/** Preview budgets, sized to the rail card's clamps (one prompt line, up to
   three response lines). Anything past a budget is invisible; copying whole
   transcripts into rail state would grow with the loaded window. */
const PROMPT_PREVIEW_LIMIT = 50
const RESPONSE_PREVIEW_LIMIT = 120

/** Join block text, collapse whitespace, and cap at `limit` with a trailing ellipsis when clipped. */
function preview(parts: Iterable<string>, limit: number): string {
  let text = ''
  let unread = false
  for (const part of parts) {
    if (text.length >= limit * 2) {
      unread = true
      break
    }
    // Per-part bound: this runs on every rail rebuild, so one huge text block
    // must not be concatenated whole for a preview this short.
    const clipped = part.length > limit * 2
    const chunk = clipped ? part.slice(0, limit * 2) : part
    text += text === '' ? chunk : ` ${chunk}`
    if (clipped) {
      unread = true
      break
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return unread ? `${normalized}…` : normalized
}

/** One rail mark: the turn's first node anchors paging, previews fill the hover card. */
export interface ChatTurnItem {
  readonly turn: number
  /** First node index attributed to the turn; the window target while paged out. */
  readonly index: number
  /** Whether the turn's first node sits inside the rendered window. */
  readonly loaded: boolean
  readonly prompt: string
  readonly response: string
}

/**
 * Project the snapshot's turns into rail marks, ordered by turn number.
 * There is no host turn outline: every turn the adapters located is offered,
 * and a mark whose first node is above the paged window reads as unloaded —
 * navigating to it extends the window instead of scrolling.
 */
function turnRailItems(
  nodes: readonly ConversationNode[],
  snapshot: TrajectorySnapshot,
  first: number,
  previews: WeakMap<ConversationNode, string>,
): readonly ChatTurnItem[] {
  const byTurn = new Map<number, { index: number; prompt: string | null; response: string }>()
  nodes.forEach((node, index) => {
    const turn = chatNodeTurn(node, snapshot)
    if (turn === undefined) return
    let item = byTurn.get(turn)
    if (item === undefined) {
      item = { index, prompt: null, response: '' }
      byTurn.set(turn, item)
    }
    if (item.prompt === null && node.kind === 'user') {
      item.prompt = previews.get(node) ?? preview(
        node.content.flatMap(block => block.type === 'text' ? [block.text] : []),
        PROMPT_PREVIEW_LIMIT,
      )
      previews.set(node, item.prompt)
    }
    if (node.kind === 'assistant') {
      const response = previews.get(node) ?? preview(
        node.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []),
        RESPONSE_PREVIEW_LIMIT,
      )
      previews.set(node, response)
      if (response !== '') item.response = response
    }
  })
  return [...byTurn.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([turn, item]) => ({
      turn,
      index: item.index,
      loaded: item.index >= first,
      prompt: item.prompt ?? '',
      response: item.response,
    }))
}

/**
 * One view's navigation projection. Snapshots replace their arrays even for
 * unrelated streaming deltas; immutable nodes let us reuse bounded previews,
 * and unchanged marks retain their array identity so the rail doesn't follow
 * again or rebuild its buttons. Locations are still read on every projection:
 * an adapter can locate an existing node after its initial emission.
 */
export function createTurnRailSelector() {
  const previews = new WeakMap<ConversationNode, string>()
  let previous: readonly ChatTurnItem[] = []
  return (nodes: readonly ConversationNode[], snapshot: TrajectorySnapshot, first: number): readonly ChatTurnItem[] => {
    const next = turnRailItems(nodes, snapshot, first, previews)
    if (next.length === previous.length && next.every((item, index) => {
      const old = previous[index]
      return old !== undefined && item.turn === old.turn && item.index === old.index
        && item.loaded === old.loaded && item.prompt === old.prompt && item.response === old.response
    })) return previous
    previous = next
    return next
  }
}
