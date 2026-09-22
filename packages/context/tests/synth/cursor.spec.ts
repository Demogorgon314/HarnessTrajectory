/**
 * Cursor synthesizer — synthetic `cursor.*` lines, real field names.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import { applyTimeline, createTimelineState } from '../../src/fold/fold.ts'
import { ContextSession } from '../../src/fold/session.ts'
import { headlineOf } from '../../src/client/headline.ts'
import { createCursorSynthesizer } from '../../src/synth/cursor.ts'
import type { InputEvent } from '../../src/synth/requestInput.ts'

const FILE: SessionFileRef = {
  id: 'agent-1',
  role: 'main',
  path: 'cursor://sessions/agent-1',
}

const T0 = 1_700_000_000_000

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record)
}

function feed(lines: readonly string[]): InputEvent[] {
  const synth = createCursorSynthesizer(FILE)
  return lines.flatMap(item => [...synth.push(item)])
}

describe('cursor synthesizer', () => {
  it('archives compressed context and restores kept copies without recounting requests or system prompts', () => {
    const session = new ContextSession('cursor')
    const human = (text: string, requestId: string) => ({
      role: 'user', content: [{ type: 'text', text }], providerOptions: { cursor: { requestId } },
    })
    const answer = { role: 'assistant', content: [{ type: 'text', text: 'Kept answer' }] }
    const messages = [
      { role: 'system', content: 'Old system' }, human('Removed prompt', 'r1'),
      human('Kept prompt', 'r2'), answer,
      { role: 'user', content: 'Short summary', providerOptions: { cursor: { isSummary: true } } },
      { role: 'system', content: 'New system' }, human('Kept prompt', 'r2'), answer,
    ]
    for (const [index, message] of messages.entries()) {
      session.push(line({ type: 'cursor.message', blobId: String(index), index, time: T0 + index, message, ...(index >= 6 ? { replay: true } : {}) }), FILE)
    }
    const state = session.timelineOf(FILE.id)
    expect(state?.requests).toHaveLength(1)
    expect(state?.requestInput).toMatchObject({ calls: 1 })
    expect(state?.cost).toBeUndefined()
    expect(state?.nodes.map(node => node.text)).toEqual(['Short summary', 'Kept prompt', 'Kept answer'])
    expect(state?.archive.map(node => node.text)).toContain('Removed prompt')
    expect(state?.systems).toHaveLength(1)
    const system = state?.systems?.[0]
    expect(system).toBeDefined()
    if (system !== undefined) {
      expect(session.contentOf(FILE.id, system.seq)).toEqual([{ type: 'text', text: 'New system' }])
    }
  })

  const callId = 'call-1\nfc_1'

  function transcript(): string[] {
    return [
      line({
        type: 'cursor.session', time: T0, agentId: 'agent-1', title: 'Fix the parser',
        cwd: '/work/project', model: 'grok-4.7-high', createdAt: T0, updatedAt: T0 + 4_000,
        usage: {
          used: 22_201, window: 256_000,
          buckets: [
            { key: 'system_prompt', label: 'System prompt', tokens: 505, chars: 1_954 },
            { key: 'tools', label: 'Tools', tokens: 8_000, chars: 30_000 },
            { key: 'conversation', label: 'Conversation', tokens: 5_950, chars: 14_877 },
          ],
        },
      }),
      line({
        type: 'cursor.message', index: 0, blobId: 'sys', time: T0,
        message: { role: 'system', content: 'You are a coding assistant.' },
      }),
      line({
        type: 'cursor.message', index: 1, blobId: 'env', time: T0,
        message: { role: 'user', content: '<user_info>os</user_info>' },
      }),
      line({
        type: 'cursor.message', index: 2, blobId: 'user', time: T0 + 1_000,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<timestamp>t</timestamp>\n<user_query>\nFix the parser\n</user_query>' }],
          providerOptions: { cursor: { requestId: 'req-1' } },
        },
      }),
      line({
        type: 'cursor.message', index: 3, blobId: 'asst', time: T0 + 2_000,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '', providerOptions: { cursor: { modelName: 'grok-4.7-high' } } },
            { type: 'text', text: 'Reading the file.' },
            { type: 'tool-call', toolCallId: callId, toolName: 'Read', args: { path: 'a.ts' } },
          ],
        },
      }),
      line({
        type: 'cursor.message', index: 4, blobId: 'tool', time: T0 + 3_000,
        message: {
          role: 'tool',
          content: [{
            type: 'tool-result', toolCallId: callId, toolName: 'Read', result: 'export const answer = 1\n',
          }],
          providerOptions: { cursor: { highLevelToolCallResult: { isError: false } } },
        },
      }),
    ]
  }

  it('emits a system segment, an injection, a request, reasoning, and a tool call', () => {
    const synth = createCursorSynthesizer(FILE)
    const events = transcript().flatMap(item => [...synth.push(item)])
    const types = events.map(event => event.type)
    expect(types).toContain('system/message')
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/message')
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
    const humans = events.filter(event => event.type === 'user/message' && event.data?.['source'] &&
      (event.data['source'] as { kind?: string }).kind === 'user')
    expect(humans).toHaveLength(1)
    const assistant = events.find(event => event.type === 'assistant/message')
    const content = (assistant?.data?.['message'] as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
    expect(content?.some(block => block.type === 'reasoning' && block.text === '')).toBe(true)
    const call = events.find(event => event.type === 'tool/call')
    expect(call?.data?.['callId']).toBe(callId)
    const result = events.find(event => event.type === 'tool/result')
    expect((result?.data?.['message'] as { source?: { callId?: string } } | undefined)?.source?.callId).toBe(callId)
    expect(synth.meta().contextWindow).toBe(256_000)
    expect(synth.meta().model).toBe('grok-4.7-high')
    expect(synth.meta().running).toBe(false)
  })

  it('shows recorded occupancy without manufacturing requests, calls or billed tokens', () => {
    const session = new ContextSession('cursor')
    const lines = transcript()
    session.push(lines[0] ?? '', FILE)
    const initial = session.timelineOf(FILE.id)
    expect(initial?.requests).toEqual([])
    expect(initial?.requestInput?.calls).toBe(0)
    expect(initial?.cost).toBeUndefined()
    expect(initial?.timing?.calls ?? 0).toBe(0)
    for (const item of lines.slice(1)) session.push(item, FILE)
    const current = session.timelineOf(FILE.id)
    expect(current).not.toBeNull()
    if (current === null) return
    expect(headlineOf(current)).toMatchObject({ tokens: 22_201, window: 256_000 })
    expect(current.requests).toHaveLength(1)
    expect(current.requests[0]?.prompt).toBeUndefined()
    expect(current.requestInput).toMatchObject({ calls: 1, reported: 0, estimated: 0 })
    expect(current.cost).toBeUndefined()
    expect(current.timing?.calls).toBe(1)
    expect(session.timelineOf(FILE.id)).toBe(current)
  })

  it('retains real system content and recorded bucket sizes without fabricating schemas or messages', () => {
    const session = new ContextSession('cursor')
    const lines = [
      line({
        type: 'cursor.session', time: T0, agentId: 'agent-1', model: 'grok-4.7-high',
        usage: {
          used: 20_000, window: 256_000,
          buckets: [
            { key: 'system_prompt', label: 'System prompt', tokens: 505, chars: 1 },
            { key: 'tools', label: 'Tools', tokens: 800, chars: 1 },
            { key: 'rules', label: 'Rules', tokens: 300, chars: 1 },
            { key: 'skills', label: 'Skills', tokens: 200, chars: 1 },
            { key: 'mcp', label: 'MCP', tokens: 120, chars: 1 },
            { key: 'subagents', label: 'Subagents', tokens: 80, chars: 1 },
            { key: 'conversation', label: 'Conversation', tokens: 9_000, chars: 1 },
            { key: 'summarized_conversation', label: 'Summary', tokens: 1_000, chars: 1 },
          ],
        },
      }),
      line({
        type: 'cursor.message', index: 0, blobId: 'sys', time: T0,
        message: { role: 'system', content: 'You are a coding assistant.' },
      }),
    ]
    for (const item of lines) session.push(item, FILE)
    const state = session.timelineOf(FILE.id)
    expect(state?.current).toMatchObject({ system: 505, tools: 800, skill: 200, inject: 500 })
    expect(state?.toolsKnown).not.toBe(true)
    expect(state?.requests).toEqual([])
    expect(state?.nodes).toEqual([])
    expect(state?.systems).toHaveLength(1)
    const system = state?.systems?.at(-1)
    expect(system).toBeDefined()
    if (system === undefined) return
    expect(session.contentOf(FILE.id, system.seq)).toEqual([{ type: 'text', text: 'You are a coding assistant.' }])
    expect(session.headerContentOf(FILE.id, system.seq)?.system).toBe('You are a coding assistant.')
    expect(session.headersOf(FILE.id)?.headers.flatMap(header => header.tools)).toEqual([])
  })

  it('replaces current buckets on same-model updates, zeroes and removals without changing history', () => {
    const session = new ContextSession('cursor')
    for (const item of transcript()) session.push(item, FILE)
    const before = session.timelineOf(FILE.id)
    const baselineInject = before?.current.inject ?? 0
    const baselineNodes = before?.nodes
    const snapshot = (tokens: number) => line({
      type: 'cursor.session', model: 'grok-4.7-high', time: T0 + 5_000,
      usage: { used: tokens, window: 100_000, buckets: [
        { key: 'system_prompt', tokens }, { key: 'tools', tokens },
        { key: 'rules', tokens }, { key: 'skills', tokens },
      ] },
    })
    for (const tokens of [100, 200, 0]) {
      session.push(snapshot(tokens), FILE)
      const current = session.timelineOf(FILE.id)
      expect(current?.current).toMatchObject({ system: tokens, tools: tokens, inject: baselineInject + tokens, skill: tokens })
      expect(current?.requests).toEqual(before?.requests)
      expect(current?.requestInput).toEqual(before?.requestInput)
      expect(current?.timing).toEqual(before?.timing)
      expect(current?.cost).toBeUndefined()
      expect(current?.nodes).toEqual(baselineNodes)
      if (current !== null) expect(headlineOf(current).tokens).toBe(tokens)
      // Re-reading and repeating an unchanged snapshot must preserve identity.
      expect(session.timelineOf(FILE.id)).toBe(current)
      session.push(snapshot(tokens), FILE)
      expect(session.timelineOf(FILE.id)).toBe(current)
    }
    expect(before?.current.tools).toBe(8_000)
    session.push(snapshot(300), FILE)
    session.push(line({ type: 'cursor.session', model: 'grok-4.7-high', usage: { used: 400, window: 100_000, buckets: [] } }), FILE)
    const removed = session.timelineOf(FILE.id)
    expect(removed?.current).toMatchObject({ tools: 0, skill: 0, inject: baselineInject })
    expect(removed?.current.system).toBeGreaterThan(0)
    session.push(line({ type: 'cursor.session', model: 'grok-4.7-high' }), FILE)
    expect(session.timelineOf(FILE.id)?.contextUsage).toBeUndefined()
    expect(session.timelineOf(FILE.id)?.contextWindow).toBeUndefined()
  })

  it('counts a tool-only assistant response as one request with unknown input', () => {
    const session = new ContextSession('cursor')
    session.push(line({ type: 'cursor.message', message: { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: callId, toolName: 'Read', args: { path: 'a.ts' } },
    ] } }), FILE)
    const current = session.timelineOf(FILE.id)
    expect(current?.requests).toHaveLength(1)
    expect(current?.requestInput).toMatchObject({ calls: 1, reported: 0 })
    expect(current?.requests[0]?.prompt).toBeUndefined()
    expect(current?.cost).toBeUndefined()
  })

  it('books step and tool windows from the turn span', () => {
    const synth = createCursorSynthesizer(FILE)
    const callId = 'call-1\nfc_1'
    const events = [
      line({
        type: 'cursor.message', index: 0, blobId: 'a', time: T0 + 2_000,
        span: {
          start: T0 + 2_000, end: T0 + 4_000,
          calls: [{ id: callId, start: T0 + 2_500, end: T0 + 3_800 }],
          blocks: [{ kind: 'reasoning', start: T0 + 2_000, end: T0 + 2_400 }],
        },
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'hmm' },
            { type: 'tool-call', toolCallId: callId, toolName: 'Shell', args: { command: 'true' } },
          ],
        },
      }),
      line({
        type: 'cursor.message', index: 1, blobId: 't', time: T0 + 3_800,
        message: {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: callId, toolName: 'Shell', result: 'ok' }],
        },
      }),
    ].flatMap(item => [...synth.push(item)])
    let state = createTimelineState()
    for (const event of events) state = applyTimeline(state, event, DEFAULT_BOUNDS)
    expect(state.timing?.wallMs).toBe(2_000)
    expect(state.timing?.genMs).toBeGreaterThan(0)
    expect(state.timing?.toolsMs).toBe(1_300)
  })

  it('returns nothing for a malformed line', () => {
    expect(feed(['{', 'null', '{"type":"cursor.message"}'])).toEqual([])
  })
})
