import type { ConversationNode, SourceLineTarget, ToolCallBlock, TrajectorySnapshot } from '@harness-trajectory/core'

export interface ChatModel {
  nodes: readonly ConversationNode[]
  tools: ReadonlyMap<string, ToolCallBlock>
  /** Both a call and its result resolve to the row that presents the call. */
  rowsBySeq: ReadonlyMap<number, number>
  rowsByCall: ReadonlyMap<string, number>
}

/** Join tool results to their original calls without changing conversation order. */
export function buildChatModel(snapshot: TrajectorySnapshot): ChatModel {
  const tools = new Map<string, ToolCallBlock>()
  const collect = (call: ToolCallBlock) => {
    tools.set(call.callId, call)
    for (const child of call.subCalls) collect(child)
  }
  for (const call of snapshot.runningCalls) collect(call)
  for (const node of snapshot.eventNodes) if (node.kind === 'tool-result') collect(node)

  const presented = new Set<string>()
  const mark = (id: string) => {
    presented.add(id)
    for (const child of tools.get(id)?.subCalls ?? []) mark(child.callId)
  }
  for (const node of snapshot.eventNodes) {
    if (node.kind === 'assistant') {
      for (const block of node.blocks) if (block.kind === 'tool-call') mark(block.callId)
    }
  }
  for (const block of snapshot.partial?.blocks ?? []) if (block.kind === 'tool-call') mark(block.callId)
  // Nested results belong to their parent disclosure even if the transcript
  // omitted the assistant call that normally owns that parent.
  for (const tool of tools.values()) for (const child of tool.subCalls) mark(child.callId)
  const nodes = snapshot.eventNodes.filter(node => node.kind !== 'tool-result' || !presented.has(node.callId))
  const rowsBySeq = new Map<number, number>()
  const rowsByCall = new Map<string, number>()
  const locate = (id: string, index: number) => {
    rowsByCall.set(id, index)
    const tool = tools.get(id)
    if (tool !== undefined && 'kind' in tool) rowsBySeq.set(tool.seq, index)
    for (const child of tool?.subCalls ?? []) locate(child.callId, index)
  }
  nodes.forEach((node, index) => {
    rowsBySeq.set(node.seq, index)
    if (node.kind === 'tool-result') locate(node.callId, index)
    if (node.kind === 'assistant') {
      for (const block of node.blocks) if (block.kind === 'tool-call') locate(block.callId, index)
    }
  })
  for (const block of snapshot.partial?.blocks ?? []) {
    if (block.kind === 'tool-call') locate(block.callId, nodes.length)
  }
  return { nodes, tools, rowsBySeq, rowsByCall }
}

export function chatTargetRow(model: ChatModel, target: SourceLineTarget): number | undefined {
  return target.kind === 'seq' ? model.rowsBySeq.get(target.seq) : model.rowsByCall.get(target.callId)
}
