import { describe, expect, it } from 'vitest'
import type { SessionFileRef } from '@harness-trajectory/core'
import { ContextSession } from '../../src/fold/session.ts'
import { disjointInput } from '../../src/synth/requestInput.ts'

const file: SessionFileRef = { id: 'main', role: 'main', path: '/tmp/synthetic.jsonl' }
const stamp = '2026-01-01T00:00:00Z'
const codex = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload, timestamp: stamp })

describe('request input through the real synthesizer and session', () => {
  it('Codex measures raw input once, excluding cache duplication, compaction and output-only usage', () => {
    const session = new ContextSession('codex')
    const push = (type: string, payload: Record<string, unknown>) => session.push(codex(type, payload), file)
    push('session_meta', { id: 'main', model_provider: 'openai' })
    push('turn_context', { model: 'small' })
    push('event_msg', { type: 'task_started', model_context_window: 200_000 })
    push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] })
    push('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 90, output_tokens: 5 } } })
    push('token_usage_record', { response_id: 'r1', usage: { input_tokens: 180_000, cached_input_tokens: 100_000, output_tokens: 10 } })
    push('turn_context', { model: 'large' })
    push('event_msg', { type: 'task_started', model_context_window: 1_000_000 })
    push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] })
    push('token_usage_record', { response_id: 'r2', usage: { input_tokens: 300_000, output_tokens: 10 } })
    push('token_usage_record', { response_id: 'compact', usage: { input_tokens: 999_000, output_tokens: 10 } })
    push('compacted', { compaction_response_id: 'compact', replacement_history: [] })
    push('turn_context', { model: 'unknown-window' })
    push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'c' }] })
    push('token_usage_record', { response_id: 'r3', usage: { output_tokens: 5 } })
    const result = session.timelineOf(file.id)
    expect(result?.contextWindow).toBeUndefined()
    expect(result?.requestInput).toMatchObject({ calls: 3, reported: 2, withWindow: 2, peak: { tokens: 300_000 }, highestRatio: { tokens: 180_000, window: { tokens: 200_000 } } })
  })

  it('Claude counts one request across continuations and rejects aggregate iteration usage', () => {
    const session = new ContextSession('claude')
    const push = (record: Record<string, unknown>) => session.push(JSON.stringify({ timestamp: stamp, ...record }), file)
    const assistant = (id: string, usage: Record<string, unknown>) => push({ type: 'assistant', uuid: id, requestId: id, message: {
      id, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'answer' }], usage,
    } })
    const human = () => push({ type: 'user', uuid: 'user', message: { role: 'user', content: 'hello' } })
    human()
    assistant('r1', { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 })
    human()
    assistant('r1', { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 })
    human()
    assistant('r2', { input_tokens: 999, iterations: [{ input_tokens: 400 }, { input_tokens: 599 }] })
    human()
    expect(session.timelineOf(file.id)?.requestInput).toMatchObject({ calls: 2, reported: 1, peak: { tokens: 60 }, withWindow: 0 })
  })

  it('binds a Codex task-start window to its following model, including a mid-session switch', () => {
    const session = new ContextSession('codex')
    const push = (type: string, payload: Record<string, unknown>) => session.push(codex(type, payload), file)
    for (const [model, window, tokens] of [['small', 200_000, 180_000], ['large', 1_000_000, 300_000]] as const) {
      push('event_msg', { type: 'task_started', model_context_window: window })
      push('turn_context', { model })
      push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] })
      push('token_usage_record', { response_id: model, usage: { input_tokens: tokens } })
      push('event_msg', { type: 'task_complete' })
    }
    expect(session.timelineOf(file.id)?.requestInput).toMatchObject({ withWindow: 2, peak: { tokens: 300_000, window: { tokens: 1_000_000 } }, highestRatio: { tokens: 180_000 } })
    expect(session.timelineOf(file.id)?.contextWindow).toBe(1_000_000)
  })

  it('does not promote malformed, output-only or partial input buckets into a measurement', () => {
    for (const usage of [{ outputTokens: 3 }, { inputTokens: -1 }, { inputTokens: Number.NaN }, { inputTokens: 3, cacheReadTokens: -1 }]) {
      expect(disjointInput(usage).source).toBe('unknown')
    }
    expect(disjointInput({ inputTokens: 0, outputTokens: 5 })).toMatchObject({ source: 'reported', tokens: 0 })
  })
})
