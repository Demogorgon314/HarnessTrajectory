/**
 * Cursor synthesizer — synthetic `cursor.*` lines, real field names.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import { applyTimeline, createTimelineState } from '../../src/fold/fold.ts'
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
    expect(types).toContain('request/context')
    expect(types).toContain('system/message')
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/message')
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
    const context = events.find(event => event.type === 'request/context')
    expect(context?.data?.['contextWindow']).toBe(256_000)
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

  it('projects the usage snapshot as the latest checkpoint', () => {
    const synth = createCursorSynthesizer(FILE)
    const committed = transcript().flatMap(item => [...synth.push(item)])
    const preview = synth.preview?.() ?? []
    expect(preview.map(event => event.type)).toEqual(['assistant/message'])
    expect(preview[0]?.data?.['usage']).toEqual({ inputTokens: 22_201 })
    expect(synth.preview?.()).toEqual(preview)
    let state = createTimelineState()
    for (const event of [...committed, ...preview]) state = applyTimeline(state, event, DEFAULT_BOUNDS)
    expect(state.contextWindow).toBe(256_000)
    const last = state.requests[state.requests.length - 1]
    expect(last?.prompt).toBe(22_201)
  })

  it('prices official buckets onto system, tools, skill, and inject', () => {
    const synth = createCursorSynthesizer(FILE)
    const committed = [
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
    ].flatMap(item => [...synth.push(item)])
    const preview = synth.preview?.() ?? []
    let state = createTimelineState()
    for (const event of [...committed, ...preview]) state = applyTimeline(state, event, DEFAULT_BOUNDS)
    expect(state.systemTokens).toBe(505)
    expect(state.toolsTokens).toBe(800)
    expect(state.toolsKnown).toBe(true)
    expect(state.sums.skill).toBe(200)
    expect(state.sums.inject).toBe(300 + 120 + 80)
    const last = state.requests[state.requests.length - 1]
    expect(last?.prompt).toBe(20_000)
    expect(committed.some(event => {
      const text = JSON.stringify(event.data ?? {})
      return text.includes('summarized_conversation') || text.includes('"conversation"')
    })).toBe(false)
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
