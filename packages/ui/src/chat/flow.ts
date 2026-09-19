import type { ConversationNode, TrajectorySnapshot } from '@harness-trajectory/core'

export type ChatFlowEntry =
  | { kind: 'message'; index: number }
  | { kind: 'process'; turn: number; indexes: number[]; reasoningIndex?: number; messages: number; tools: number }

/** Turn a node belongs to: its own field when it carries one, else its recorded location. */
export function chatNodeTurn(node: ConversationNode, snapshot: TrajectorySnapshot): number | undefined {
  if ('turn' in node) return node.turn
  const location = snapshot.eventLocations.get(node.seq)
  return location?.kind === 'step' || location?.kind === 'turn' ? location.turn.turn : undefined
}

/** Completed assistant tails own actions; preceding activity becomes a compact process. */
export function chatFlow(nodes: readonly ConversationNode[], snapshot: TrajectorySnapshot, start: number) {
  const lastByTurn = new Map<number, number>()
  const firstByTurn = new Map<number, number>()
  nodes.forEach((node, index) => {
    if (node.kind === 'assistant') {
      lastByTurn.set(node.turn, index)
      if (!firstByTurn.has(node.turn)) firstByTurn.set(node.turn, index)
    }
  })
  const answers = new Set<number>()
  const compactAnswers = new Set<number>()
  for (const [turn, index] of lastByTurn) {
    const node = nodes[index]
    if (node?.kind !== 'assistant' || snapshot.partial?.turn === turn
      || snapshot.runningCalls.some(call => call.turn === turn)) continue
    if (!node.blocks.some(block => block.kind === 'tool-call')
      && node.blocks.some(block => block.kind === 'text' || block.kind === 'image')) {
      answers.add(index)
      const location = snapshot.eventLocations.get(node.seq)
      // A text tail is not evidence that a turn ended. Old/incomplete records
      // without lifecycle facts remain expanded, as do partially paged turns.
      const beginning = firstByTurn.get(turn) ?? -1
      if ((location?.kind === 'turn' || location?.kind === 'step')
        && location.turn.status === 'closed' && beginning >= start) compactAnswers.add(index)
    }
  }
  const entries: ChatFlowEntry[] = []
  for (let index = start; index < nodes.length; index++) {
    const node = nodes[index]
    if (node === undefined) continue
    const turn = chatNodeTurn(node, snapshot)
    const answer = turn === undefined ? undefined : lastByTurn.get(turn)
    const inlineReasoning = answer === index && compactAnswers.has(index) && node.kind === 'assistant'
      && node.blocks.some(block => block.kind === 'reasoning')
    const inProcess = turn !== undefined && answer !== undefined && compactAnswers.has(answer)
      && index < answer && (node.kind === 'assistant' || node.kind === 'tool-result' || node.kind === 'model-retry')
    if (inlineReasoning && turn !== undefined) {
      const last = entries.at(-1)
      if (last?.kind === 'process' && last.turn === turn) last.reasoningIndex = index
      else entries.push({ kind: 'process', turn, indexes: [], reasoningIndex: index, messages: 0, tools: 0 })
    }
    if (!inProcess || turn === undefined) {
      entries.push({ kind: 'message', index })
      continue
    }
    const last = entries.at(-1)
    const process = last?.kind === 'process' && last.turn === turn ? last
      : { kind: 'process' as const, turn, indexes: [], messages: 0, tools: 0 }
    if (process !== last) entries.push(process)
    process.indexes.push(index)
    if (node.kind === 'assistant') {
      process.messages += node.blocks.some(block => block.kind === 'text') ? 1 : 0
      process.tools += node.blocks.filter(block => block.kind === 'tool-call').length
    } else if (node.kind === 'tool-result') process.tools++
  }
  const hiddenReasoning = new Set(entries.flatMap(entry => entry.kind === 'process'
    && entry.reasoningIndex !== undefined ? [entry.reasoningIndex] : []))
  return { entries, answers, hiddenReasoning }
}
