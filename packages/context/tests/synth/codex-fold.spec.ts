/**
 * Codex synthesizer → fold, end to end.
 *
 * Synthetic fixtures only (real field names, fake payloads). This spec proves
 * the synthesizer's events are a valid fold input: it feeds one session through
 * `applyTimeline` and reads the figures off `buildTimelineView`.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS } from '../../src/fold/config.ts'
import { applyTimeline, buildTimelineView, createTimelineState } from '../../src/fold/fold.ts'
import type { Snapshot } from '../../src/shared/types.ts'
import { createCodexSynthesizer } from '../../src/synth/codex.ts'

const T0 = Date.UTC(2025, 0, 1, 12, 0, 0)
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
const secs = (s: number): number => Math.round((T0 + s * 1000) / 1000)
const ms = (s: number): number => T0 + s * 1000

const MAIN: SessionFileRef = { id: 'rollout-1', role: 'main', path: '/tmp/rollout-1.jsonl' }

interface Rec { [key: string]: unknown }
const line = (s: number, type: string, payload: Rec): string =>
  JSON.stringify({ timestamp: at(s), ordinal: s, type, payload })

const SYSTEM_TEXT = 'You are Codex. '.repeat(40)

/** A two-turn session with an injection, a tool call with file ops, and a compaction. */
const SESSION: string[] = [
  line(0, 'session_meta', {
    session_id: 'thread-1', id: 'thread-1', timestamp: at(0), cwd: '/tmp/work',
    originator: 'codex_cli_rs', cli_version: '0.99.0', model_provider: 'openai',
    base_instructions: { text: SYSTEM_TEXT }, history_mode: 'persisted',
    context_window: { window_id: 'win-1' },
  }),
  line(1, 'event_msg', {
    type: 'task_started', turn_id: 'turn-1', started_at: secs(1),
    model_context_window: 258400, collaboration_mode_kind: 'default',
  }),
  line(1, 'turn_context', { turn_id: 'turn-1', cwd: '/tmp/work', model: 'gpt-5.2-codex', effort: 'medium' }),
  line(2, 'response_item', {
    type: 'message', id: 'msg-2', role: 'user',
    content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp/work</environment_context>' }],
  }),
  line(3, 'response_item', {
    type: 'message', id: 'msg-3', role: 'user',
    content: [{ type: 'input_text', text: 'please list the files' }],
  }),
  line(4, 'response_item', { type: 'reasoning', id: 'rs-4', summary: [{ type: 'summary_text', text: 'plan it' }], encrypted_content: 'g' }),
  line(4, 'event_msg', {
    type: 'item_completed', thread_id: 'thread-1', turn_id: 'turn-1',
    item: { type: 'Reasoning', id: 'rs-4', summary_text: [], raw_content: [] },
    started_at_ms: ms(3.5), completed_at_ms: ms(4),
  }),
  line(5, 'response_item', {
    type: 'custom_tool_call', id: 'ctc-5', status: 'completed', call_id: 'call_a', name: 'exec',
    input: '{"command":["ls","-la"]}',
  }),
  line(5, 'event_msg', {
    type: 'item_completed', thread_id: 'thread-1', turn_id: 'turn-1',
    item: {
      type: 'FileChange', id: '0199-file-5', status: 'completed', stdout: '', stderr: '',
      changes: { '/tmp/a.ts': { type: 'update', unified_diff: '--- a\n+++ b\n@@\n+new\n-old\n', move_path: null } },
    },
    started_at_ms: ms(5), completed_at_ms: ms(5),
  }),
  line(6, 'token_usage_record', {
    thread_id: 'thread-1', turn_id: 'turn-1', session_id: 'thread-1', root_turn_id: 'turn-1',
    response_id: 'resp_1',
    usage: { input_tokens: 4000, cached_input_tokens: 3000, cache_write_input_tokens: 100, output_tokens: 200, reasoning_output_tokens: 60, total_tokens: 4200 },
    turn_token_usage: { input_tokens: 4000, cached_input_tokens: 3000, cache_write_input_tokens: 100, output_tokens: 200, total_tokens: 4200 },
    thread_token_usage: { input_tokens: 4000, cached_input_tokens: 3000, cache_write_input_tokens: 100, output_tokens: 200, total_tokens: 4200 },
  }),
  line(7, 'response_item', {
    type: 'custom_tool_call_output', id: 'cto-7', call_id: 'call_a',
    output: [{ type: 'input_text', text: 'a.ts\nb.ts' }],
  }),
  line(8, 'response_item', { type: 'message', id: 'msg-8', role: 'assistant', content: [{ type: 'output_text', text: 'listed them' }] }),
  line(9, 'token_usage_record', {
    thread_id: 'thread-1', turn_id: 'turn-1', session_id: 'thread-1', root_turn_id: 'turn-1',
    response_id: 'resp_2',
    usage: { input_tokens: 5000, cached_input_tokens: 4000, cache_write_input_tokens: 0, output_tokens: 80, total_tokens: 5080 },
    turn_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 80, total_tokens: 5080 },
    thread_token_usage: { input_tokens: 9000, cached_input_tokens: 7000, output_tokens: 280, total_tokens: 9280 },
  }),
  line(10, 'event_msg', {
    type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'listed them',
    started_at: secs(1), completed_at: secs(10), duration_ms: 9000, time_to_first_token_ms: 2500,
  }),
  line(11, 'compacted', {
    message: '',
    replacement_history: [
      { type: 'message', id: 'r1', role: 'user', content: [{ type: 'input_text', text: 'please list the files' }] },
      { type: 'compaction', id: 'r2', encrypted_content: 'g' },
    ],
    window_number: 1, first_window_id: 'win-1', previous_window_id: 'win-1', window_id: 'win-2',
    latest_token_usage_record: { thread_token_usage: { total_tokens: 9280 } },
  }),
]

function fold(lines: readonly string[]): Snapshot {
  const synth = createCodexSynthesizer(MAIN)
  let state = createTimelineState()
  for (const l of lines) {
    for (const event of synth.push(l)) state = applyTimeline(state, event, DEFAULT_BOUNDS)
  }
  return buildTimelineView(state, DEFAULT_BOUNDS)
}

describe('codex synthesizer → fold', () => {
  it('books one request per settled model response, with turn/step and usage', () => {
    const view = fold(SESSION)
    expect(view.requests).toHaveLength(2)
    const [first, second] = view.requests
    expect([first?.turn, first?.step]).toEqual([1, 1])
    expect([second?.turn, second?.step]).toEqual([1, 2])
    // prompt = uncached input + cacheRead + cacheWrite (the disjoint buckets).
    expect(first?.prompt).toBe(1000 + 3000 + 100)
    expect(first?.cacheRead).toBe(3000)
    expect(first?.output).toBe(200)
    expect(second?.prompt).toBe(1000 + 4000)
    expect(second?.output).toBe(80)
  })

  it('prices the base instructions as a real (not derived) system prompt', () => {
    const view = fold(SESSION)
    expect(view.current.system).toBeGreaterThan(0)
    expect(view.requests[0]?.system).toBeGreaterThan(0)
    expect(view.systemDerived).toBeUndefined()
  })

  it('carries the model, provider and context window through', () => {
    const view = fold(SESSION)
    expect(view.model).toBe('gpt-5.2-codex')
    expect(view.provider).toBe('openai')
    expect(view.contextWindow).toBe(258400)
    // Codex records no tool schemas in an ordinary session.
    expect(view.toolsKnown).toBeUndefined()
    expect(view.current.tools).toBe(0)
  })

  it('counts the human prompt once and the wrapper as an injection', () => {
    // Read before the compaction: it replaces both nodes with retained history.
    const view = fold(SESSION.slice(0, -1))
    expect(view.humanInputs).toBe(1)
    const injects = view.events.filter(e => e.kind === 'inject')
    expect(injects.map(e => e.name)).toContain('environment_context')
    expect(view.current.inject).toBeGreaterThan(0)
    expect(view.current.user).toBeGreaterThan(0)
  })

  it('derives file ops from item_completed and attributes them to the exec call', () => {
    const view = fold(SESSION)
    expect(view.fileOps).toHaveLength(1)
    expect(view.fileOps?.[0]).toMatchObject({
      kind: 'write', path: '/tmp/a.ts', added: 1, removed: 1, tool: 'exec', err: false,
    })
  })

  it('records the tool call and its result on the surface', () => {
    const view = fold(SESSION.slice(0, -1))
    expect(view.toolCalls).toBe(1)
    expect(view.current.tool).toBeGreaterThan(0)
    expect(view.current.assistant).toBeGreaterThan(0)
  })

  it('attributes the turn first step time-to-first-token', () => {
    const view = fold(SESSION)
    expect(view.timing?.calls).toBe(2)
    // The first step opened at task_started (t=1s) and its first item started
    // at t=3.5s; the second step carries no token chunk.
    expect(view.timing?.ttftMs).toBe(2500)
    expect(view.timing?.genMs).toBeGreaterThan(0)
    expect(view.timing?.toolCalls).toBe(1)
  })

  it('logs the compaction and replaces the shadowed surface', () => {
    const before = fold(SESSION.slice(0, -1))
    const after = fold(SESSION)
    const compaction = after.events.find(e => e.kind === 'compaction')
    expect(compaction).toBeDefined()
    expect(after.current.total).toBeLessThan(before.current.total)
    // The retained prompt is no longer a human input, and the assistant/tool
    // nodes the compaction shadowed have left the live surface.
    expect(after.humanInputs).toBe(1)
    expect(after.current.assistant).toBe(0)
    expect(after.current.tool).toBe(0)
    expect(after.current.system).toBe(before.current.system)
  })

  it('books a LATE file op at its result\'s seq, in log order', () => {
    // The dominant real ordering: output, token_count, item_completed. The
    // result has already folded, so the ops ride a `tool/ops` follow-up.
    const view = fold([
      ...SESSION.slice(0, -1),
      line(12, 'event_msg', {
        type: 'task_started', turn_id: 'turn-2', started_at: secs(12), model_context_window: 258400,
      }),
      line(13, 'response_item', {
        type: 'custom_tool_call', id: 'ctc-13', status: 'completed', call_id: 'call_b', name: 'exec',
        input: '{"command":["cat","a.ts"]}',
      }),
      line(14, 'token_usage_record', {
        thread_id: 'thread-1', turn_id: 'turn-2', session_id: 'thread-1', root_turn_id: 'turn-2',
        response_id: 'resp_3',
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 },
        turn_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        thread_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      }),
      line(15, 'response_item', {
        type: 'custom_tool_call_output', id: 'cto-15', call_id: 'call_b',
        output: [{ type: 'input_text', text: 'contents' }],
      }),
      line(16, 'event_msg', { type: 'token_count', info: { model_context_window: 258400 }, rate_limits: {} }),
      line(17, 'event_msg', {
        type: 'item_completed', thread_id: 'thread-1', turn_id: 'turn-2',
        item: {
          type: 'CommandExecution', id: '0199-item-17', process_id: '1', command: ['cat', 'a.ts'],
          cwd: '/tmp/work', parsed_cmd: [{ type: 'read', cmd: 'cat a.ts', name: 'a.ts', path: '/tmp/a.ts' }],
          source: 'model', status: 'completed', stdout: '', stderr: '', aggregated_output: '',
          exit_code: 0, duration: { secs: 0, nanos: 1 }, formatted_output: '',
        },
        started_at_ms: ms(15), completed_at_ms: ms(17),
      }),
    ])
    const late = view.fileOps?.find(op => op.kind === 'read')
    expect(late).toBeDefined()
    expect(late).toMatchObject({ kind: 'read', path: '/tmp/a.ts', tool: 'exec', err: false, added: 0, removed: 0 })
    // Filed under the RESULT's seq, with the item's own completion time.
    expect(late?.time).toBe(ms(17))
    // The earlier write is still first: the log stays seq-ordered.
    expect(view.fileOps?.map(op => op.kind)).toEqual(['write', 'read'])
    const seqs = view.fileOps?.map(op => op.seq) ?? []
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('logs a model switch as a fold event', () => {
    const view = fold([
      ...SESSION,
      line(12, 'event_msg', { type: 'task_started', turn_id: 'turn-2', started_at: secs(12), model_context_window: 258400 }),
      line(12, 'turn_context', { turn_id: 'turn-2', cwd: '/tmp/work', model: 'gpt-5.2-codex-mini', effort: 'medium' }),
    ])
    const models = view.events.filter(e => e.kind === 'model')
    expect(models).toHaveLength(1)
    expect([models[0]?.from, models[0]?.to]).toEqual(['gpt-5.2-codex', 'gpt-5.2-codex-mini'])
    // The change header restates the system prompt, so it must not drop to 0.
    expect(view.current.system).toBeGreaterThan(0)
  })
})
