import { describe, expect, it } from 'vitest'
import {
  createClaudeParser, createCodexParser, createGrokParser,
  type HarnessKind, type SessionFileRef,
} from '@harness-trajectory/core'
import { ContextSession } from '../../src/fold/session.ts'

const file: SessionFileRef = { id: 'main', role: 'main', path: '/fake/main.jsonl' }
const timestamp = (seconds: number) => new Date(1_700_000_000_000 + seconds * 1000).toISOString()
type RecordValue = Record<string, unknown>

function session(kind: HarnessKind) {
  const context = new ContextSession(kind)
  return {
    context,
    push: (record: RecordValue) => context.push(JSON.stringify(record), file),
    view: () => context.timelineOf(file.id),
    text: () => context.timelineOf(file.id)?.nodes.flatMap(node =>
      context.contentOf(file.id, node.seq)?.flatMap(block => block.text === undefined ? [] : [block.text]) ?? [],
    ) ?? [],
  }
}
const user = (uuid: string, parentUuid: string | null, text = uuid): RecordValue => ({
  type: 'user', uuid, parentUuid, timestamp: timestamp(0), message: { role: 'user', content: text },
})
const assistant = (uuid: string, parentUuid: string, requestId = uuid, content: unknown[] = [{ type: 'text', text: uuid }]): RecordValue => ({
  type: 'assistant', uuid, parentUuid, requestId, timestamp: timestamp(1),
  message: { id: requestId, role: 'assistant', model: 'claude-test', content, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } },
})
const kimi = (id: string, origin: RecordValue = { kind: 'user' }): RecordValue => ({
  type: 'context.append_message', time: 1000, message: { id, role: 'user', origin, content: [{ type: 'text', text: id }] },
})
const grok = (update: RecordValue, meta: RecordValue = {}): RecordValue => ({
  timestamp: 1_700_000_002, method: 'session/update', params: { sessionId: file.id, update, _meta: meta },
})
const prompt = (text: string, index: number): RecordValue => grok({
  sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex: index },
})
const devin = (msg: RecordValue, time = 1000): RecordValue => ({ t: 'devin.msg', time, msg })

describe('session parser regression boundaries', () => {
  it('projects Claude EOF without committing an arbitrary read boundary', () => {
    const s = session('claude')
    const parser = createClaudeParser()
    const push = (record: RecordValue) => { s.push(record); parser.push(JSON.stringify(record), file) }
    push(user('u1', null))
    push(assistant('a1', 'u1', 'r1'))
    const first = s.view()
    expect(first?.requests).toHaveLength(1)
    expect(first?.requestInput?.calls).toBe(1)
    expect(s.text()).toEqual(['u1', 'a1'])
    expect(s.view()).toBe(first)
    expect(s.context.metaOf(file.id)?.running).toBe(false)
    const trajectory = parser.snapshot()
    push(assistant('a2', 'a1', 'r1'))
    expect(s.text()).toEqual(['u1', 'a1', 'a2'])
    expect(s.view()?.requests).toHaveLength(1)
    expect(s.view()?.requestInput?.calls).toBe(1)
    expect(parser.snapshot().requests).toHaveLength(1)
    expect(parser.snapshot().requests[0]?.usage?.inputTokens).toBe(100)
    expect(trajectory.eventNodes.find(node => node.kind === 'assistant')).toMatchObject({ blocks: [{ kind: 'text', text: 'a1' }] })
    expect(parser.snapshot().eventNodes.find(node => node.kind === 'assistant')).toMatchObject({ timing: { firstTokenTime: null } })
    push({ type: 'system', subtype: 'turn_duration' })
    expect(s.view()?.requests).toHaveLength(1)
    expect(s.text()).toEqual(['u1', 'a1', 'a2'])
  })

  it('restores Claude branches while retaining historical requests', () => {
    const s = session('claude')
    for (const record of [user('u1', null), assistant('a1', 'u1'), user('u2', 'a1'), assistant('a2', 'u2'), user('u3', 'a1'), assistant('a3', 'u3')]) s.push(record)
    expect(s.text()).toEqual(['u1', 'a1', 'u3', 'a3'])
    expect(s.view()?.requests).toHaveLength(3)
    expect(s.view()?.humanInputs).toBe(3)
    s.push(user('u4', 'a1'))
    expect(s.text()).toEqual(['u1', 'a1', 'u4'])
    expect(s.view()?.requests).toHaveLength(3)
  })

  it('keeps one Claude request when parallel tool results arrive between sibling blocks', () => {
    const s = session('claude')
    const parser = createClaudeParser()
    const push = (record: RecordValue) => { s.push(record); parser.push(JSON.stringify(record), file) }
    push(user('u1', null))
    for (const id of ['1', '2']) {
      push(assistant(`a${id}`, 'u1', 'r1', [{ type: 'tool_use', id: `c${id}`, name: 'Read', input: { file_path: `/fake/${id}` } }]))
      push({ type: 'user', uuid: `t${id}`, parentUuid: `a${id}`, message: { content: [{ type: 'tool_result', tool_use_id: `c${id}`, content: 'ok' }] } })
    }
    const timing = s.view()?.timing
    push(user('u2', 't1'))
    expect(s.view()?.nodes.filter(node => node.cat === 'tool')).toHaveLength(2)
    expect(s.view()?.requests).toHaveLength(1)
    expect(s.view()?.timing?.toolCalls).toBe(timing?.toolCalls)
    expect(parser.snapshot().requests).toHaveLength(1)
    expect(parser.snapshot().requests[0]?.usage?.inputTokens).toBe(100)
  })

  it('replaces a regenerated Claude answer without needing a new human prompt', () => {
    const s = session('claude')
    s.push(user('u1', null))
    s.push(assistant('old', 'u1'))
    s.push(assistant('replacement', 'u1'))
    expect(s.text()).toEqual(['u1', 'replacement'])
    expect(s.view()?.requests).toHaveLength(2)
    expect(s.view()?.humanInputs).toBe(1)
    expect(s.view()?.requestInput?.calls).toBe(2)
  })

  it('keeps parallel Claude tool siblings and restores a pre-compaction branch', () => {
    const s = session('claude')
    s.push(user('u1', null))
    s.push(assistant('a1', 'u1', 'r1', [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/fake/a' } }]))
    s.push(assistant('a2', 'a1', 'r1', [{ type: 'tool_use', id: 'c2', name: 'Read', input: { file_path: '/fake/b' } }]))
    for (const [id, parent, call] of [['t1', 'a1', 'c1'], ['t2', 'a2', 'c2']]) {
      s.push({ type: 'user', uuid: id, parentUuid: parent, message: { content: [{ type: 'tool_result', tool_use_id: call, content: 'result' }] } })
    }
    s.push(user('u2', 'a2'))
    expect(s.view()?.nodes.filter(node => node.cat === 'tool')).toHaveLength(2)
    const timing = s.view()?.timing
    s.push(user('alternate', 'a2'))
    expect(s.view()?.nodes.filter(node => node.cat === 'tool').map(node => node.tool)).toEqual(['Read', 'Read'])
    expect(s.view()?.timing?.toolCalls).toBe(timing?.toolCalls)
    s.push({ type: 'system', uuid: 'compact', subtype: 'compact_boundary', compactMetadata: { preTokens: 500 } })
    s.push({ ...user('summary', 'compact', 'summary'), isCompactSummary: true })
    s.push(user('u3', 'u1'))
    expect(s.text()).toEqual(['u1', 'u3'])
    expect(s.view()?.requests).toHaveLength(1)
  })

  it('keeps standalone Codex outputs without inventing human inputs or calls', () => {
    const s = session('codex')
    const parser = createCodexParser()
    const record = { type: 'response_item', payload: { type: 'function_call_output', id: 'external', name: 'external_context', output: 'external data' } }
    s.push(record)
    parser.push(JSON.stringify(record), file)
    expect(s.text()).toEqual(['external data'])
    expect(s.view()?.humanInputs ?? 0).toBe(0)
    expect(parser.meta().promptCount).toBe(0)
    expect(parser.snapshot().runningCalls).toHaveLength(0)
    expect(parser.snapshot().eventNodes[0]?.kind).toBe('context')
  })

  it('keeps Codex realtime speech outside model context and ignores promoted mirrors', () => {
    const s = session('codex')
    const parser = createCodexParser()
    for (const payload of [
      { type: 'transcript_segment', role: 'user', text: 'spoken prompt' },
      { type: 'transcript_segment', role: 'assistant', text: 'spoken answer' },
      { type: 'bem_item_promoted', item_id: 'existing', presentation: { type: 'whole_item' } },
    ]) {
      const record = { type: 'realtime_item', payload }
      s.push(record); parser.push(JSON.stringify(record), file)
    }
    expect(parser.snapshot().eventNodes).toHaveLength(2)
    expect(parser.snapshot().requests).toHaveLength(0)
    expect(parser.meta().promptCount).toBe(0)
    expect(s.view()?.nodes).toHaveLength(0)
  })

  it.each(['skill_activation', 'plugin_command'])('undoes a Kimi %s anchor with its owned injection', kind => {
    const s = session('kimi')
    s.push(kimi('keep'))
    s.push(kimi('owned', { kind: 'injection', ownerPromptId: 'slash' }))
    s.push(kimi('slash', { kind, trigger: 'user-slash', skillName: 'review' }))
    s.push({ type: 'context.undo', count: 1 })
    expect(s.text()).toEqual(['keep'])
    expect(s.view()?.humanInputs).toBe(1)
    s.push({ type: 'context.undo', count: 1 })
    expect(s.text()).toEqual([])
  })

  it('does not treat model-invoked Kimi skills as undo anchors', () => {
    const s = session('kimi')
    s.push(kimi('keep'))
    s.push(kimi('discard'))
    s.push(kimi('skill', { kind: 'skill_activation', trigger: 'model', skillName: 'review' }))
    s.push({ type: 'context.undo', count: 1 })
    expect(s.text()).toEqual(['keep'])
    s.push({ type: 'context.undo', count: -1 })
    expect(s.text()).toEqual(['keep'])
  })

  it('counts Grok chunks once and reuses prompt indices after rewind', () => {
    const s = session('grok')
    const parser = createGrokParser()
    const push = (record: RecordValue) => { s.push(record); parser.push(JSON.stringify(record), file) }
    push(prompt('part 1', 0)); push(prompt('part 2', 0))
    expect(s.view()?.humanInputs).toBe(1)
    expect(parser.meta().promptCount).toBe(1)
    push(prompt('abandon', 1))
    push(grok({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }))
    expect(s.text()).toEqual(['part 1', 'part 2'])
    push(prompt('replacement', 1))
    expect(s.text()).toEqual(['part 1', 'part 2', 'replacement'])
    expect(s.view()?.humanInputs).toBe(3)
    expect(parser.meta().promptCount).toBe(3)
    push(grok({ sessionUpdate: 'rewind_marker', target_prompt_index: 0 }))
    expect(s.text()).toEqual([])
  })

  it('restores Grok checkpoints across compaction without booking old requests again', () => {
    const s = session('grok')
    s.push(prompt('keep', 0))
    s.push(grok({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }, { streamStartMs: 1000 }))
    s.push(grok({ sessionUpdate: 'turn_completed', usage: { inputTokens: 100, outputTokens: 20 } }))
    s.push(prompt('discard', 1))
    s.push(grok({ sessionUpdate: 'auto_compact_completed', tokens_before: 100, tokens_after: 10, summary_preview: 'summary' }))
    expect(s.text()).toEqual(['summary'])
    s.push(grok({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }))
    expect(s.text()).toEqual(['keep', 'answer'])
    expect(s.view()?.requests).toHaveLength(1)
    expect(s.view()?.humanInputs).toBe(2)
    s.push(prompt('replace', 1))
    s.push(grok({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }))
    expect(s.text()).toEqual(['keep', 'answer'])
    expect(s.view()?.requests).toHaveLength(1)
  })

  it('does not allow Kimi undo to cross compaction or clear boundaries', () => {
    const s = session('kimi')
    s.push(kimi('old'))
    s.push({ type: 'context.apply_compaction', summary: 'summary', contextSummary: 'summary' })
    s.push({ type: 'context.undo', count: 1 })
    expect(s.text()).toEqual(['summary'])
    s.push(kimi('new'))
    s.push({ type: 'context.undo', count: 2 })
    expect(s.text()).toEqual(['summary', 'new'])
    s.push({ type: 'context.undo', count: 1 })
    expect(s.text()).toEqual(['summary'])
    s.push({ type: 'context.clear' })
    s.push({ type: 'context.undo', count: 1 })
    expect(s.text()).toEqual([])
  })

  it('groups Grok parallel tools by stream and starts a new request for a new stream', () => {
    const s = session('grok')
    const parser = createGrokParser()
    for (const record of [
      prompt('read both', 0),
      ...['c1', 'c2'].map(toolCallId => grok({ sessionUpdate: 'tool_call', toolCallId, title: 'read_file', rawInput: {} }, { streamStartMs: 1000 })),
      grok({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }, { streamStartMs: 2000 }),
      grok({ sessionUpdate: 'turn_completed', usage: { inputTokens: 100, outputTokens: 20 } }),
    ]) { s.push(record); parser.push(JSON.stringify(record), file) }
    expect(parser.snapshot().requests).toHaveLength(2)
    expect(s.view()?.requests).toHaveLength(2)
    const first = parser.snapshot().eventNodes.find(node => node.kind === 'assistant')
    expect(first?.kind === 'assistant' ? first.blocks.filter(block => block.kind === 'tool-call') : []).toHaveLength(2)
  })

  it.each(['completed', 'failed'])('settles Devin ACP %s once and replaces it with late content', status => {
    const s = session('devin')
    s.push(devin({ role: 'assistant', message_id: 'a', content: '', tool_calls: [{ id: 'c', name: 'shell', arguments: '{}' }] }))
    const terminal = { t: 'devin.tool', id: 'c', time: 2000, update: { status, content: [{ type: 'text', text: 'UI only' }] } }
    s.push(terminal)
    expect(s.context.metaOf(file.id)?.running).toBe(false)
    const timing = s.view()?.timing
    s.push(terminal)
    s.push(devin({ role: 'tool', message_id: 'result', tool_call_id: 'c', content: 'real result' }, 3000))
    expect(s.view()?.nodes.filter(node => node.cat === 'tool')).toHaveLength(1)
    expect(s.view()?.nodes.find(node => node.cat === 'tool')?.tool).toBe('shell')
    expect(s.view()?.timing).toEqual(timing)
    const node = s.view()?.nodes.find(node => node.cat === 'tool')
    expect(node === undefined ? null : s.context.contentOf(file.id, node.seq)).toEqual([
      { type: 'tool-result', toolCallId: 'c', isError: false, content: [{ type: 'text', text: 'real result' }] },
    ])
  })

  it('keeps a Devin background child running through receipt and late sidecar binding', () => {
    const s = session('devin')
    s.push(devin({ role: 'assistant', tool_calls: [{ id: 'spawn', name: 'run_subagent', arguments: JSON.stringify({ task: 'inspect', is_background: true }) }] }))
    s.push(devin({ role: 'tool', tool_call_id: 'spawn', content: 'launched', metadata: { extensions: { 'subagent/agent_id': 'child' } } }, 2000))
    expect(s.context.metaOf(file.id)?.children.get('child')?.completedAt).toBeUndefined()
    s.push({ t: 'devin.session', agents: [{ id: 'child', fileId: 'agent-child' }] })
    expect(s.context.metaOf(file.id)?.children.has('child')).toBe(false)
    expect(s.context.metaOf(file.id)?.children.get('agent-child')?.startedAt).toBe(1000)
    s.push(devin({ role: 'system', content: 'completed', metadata: { extensions: { 'subagent/agent_id': 'child', 'subagent/chain_node_id': 42 } } }, 4000))
    expect(s.context.metaOf(file.id)?.children.get('agent-child')?.completedAt).toBe(4000)
  })

  it.each([{ background: false, success: true }, { background: true, success: false }])('settles a Devin foreground or failed spawn: %j', ({ background, success }) => {
    const s = session('devin')
    s.push(devin({ role: 'assistant', tool_calls: [{ id: 'spawn', name: 'run_subagent', arguments: JSON.stringify({ task: 'inspect', is_background: background }) }] }))
    s.push(devin({ role: 'tool', tool_call_id: 'spawn', content: 'result', metadata: { extensions: { 'subagent/agent_id': 'child', 'chisel/tool_result_meta': { success } } } }, 2000))
    expect(s.context.metaOf(file.id)?.children.get('child')?.completedAt).toBe(2000)
  })

  it('preserves Devin completion if the receipt and sidecar arrive afterwards', () => {
    const s = session('devin')
    s.push(devin({ role: 'assistant', tool_calls: [{ id: 'spawn', name: 'run_subagent', arguments: '{"task":"inspect","is_background":true}' }] }))
    s.push(devin({ role: 'system', content: 'done', metadata: { extensions: { 'subagent/agent_id': 'child', 'subagent/chain_node_id': 42 } } }, 4000))
    s.push(devin({ role: 'tool', tool_call_id: 'spawn', content: 'launched', metadata: { extensions: { 'subagent/agent_id': 'child' } } }, 2000))
    s.push({ t: 'devin.session', agents: [{ id: 'child', fileId: 'agent-child' }] })
    expect(s.context.metaOf(file.id)?.children.get('agent-child')?.completedAt).toBe(4000)
  })
})
