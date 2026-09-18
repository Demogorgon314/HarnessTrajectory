/**
 * Codex synthesizer — synthetic fixtures only.
 *
 * Every record below is hand-written with the REAL Codex rollout field names
 * and fake payloads ("hello", `/tmp/a.ts`). No transcript content is copied
 * here.
 */

import type { SessionFileRef } from '@harness-trajectory/core'
import { describe, expect, it } from 'vitest'
import type { ContentBlock, TimelineEvent } from '../../src/fold/event.ts'
import { createCodexSynthesizer } from '../../src/synth/codex.ts'

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

const T0 = Date.UTC(2025, 0, 1, 12, 0, 0)
/** ISO timestamp `s` seconds into the fixture session. */
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
/** Epoch SECONDS `s` seconds into the fixture session (`task_started.started_at`). */
const secs = (s: number): number => Math.round((T0 + s * 1000) / 1000)
/** Epoch MILLISECONDS `s` seconds in (`item_completed.*_ms`). */
const ms = (s: number): number => T0 + s * 1000

const MAIN: SessionFileRef = { id: 'rollout-1', role: 'main', path: '/tmp/rollout-1.jsonl' }

interface Rec { [key: string]: unknown }

function line(s: number, type: string, payload: Rec): string {
  return JSON.stringify({ timestamp: at(s), ordinal: s, type, payload })
}

const sessionMeta = (s: number, extra: Rec = {}): string => line(s, 'session_meta', {
  session_id: 'thread-1',
  id: 'thread-1',
  timestamp: at(s),
  cwd: '/tmp/work',
  originator: 'codex_cli_rs',
  cli_version: '0.99.0',
  model_provider: 'openai',
  base_instructions: { text: 'SYSTEM PROMPT hello hello hello' },
  history_mode: 'persisted',
  context_window: { window_id: 'win-1' },
  ...extra,
})

const turnContext = (s: number, model: string, extra: Rec = {}): string => line(s, 'turn_context', {
  turn_id: 'turn-1', cwd: '/tmp/work', model, effort: 'medium', summary: 'auto',
  ...extra,
})

const taskStarted = (s: number, extra: Rec = {}): string => line(s, 'event_msg', {
  type: 'task_started', turn_id: 'turn-1', started_at: secs(s), model_context_window: 258400,
  collaboration_mode_kind: 'default', ...extra,
})

const taskComplete = (s: number, extra: Rec = {}): string => line(s, 'event_msg', {
  type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done',
  started_at: secs(s - 10), completed_at: secs(s), duration_ms: 10_000, time_to_first_token_ms: 900,
  ...extra,
})

const userMessage = (s: number, text: string): string => line(s, 'response_item', {
  type: 'message', id: `msg-${s}`, role: 'user',
  content: [{ type: 'input_text', text }],
  internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
})

const developerMessage = (s: number, text: string): string => line(s, 'response_item', {
  type: 'message', id: `msg-${s}`, role: 'developer',
  content: [{ type: 'input_text', text }],
})

const assistantMessage = (s: number, text: string): string => line(s, 'response_item', {
  type: 'message', id: `msg-${s}`, role: 'assistant',
  content: [{ type: 'output_text', text }],
})

const reasoning = (s: number, summary: string): string => line(s, 'response_item', {
  type: 'reasoning', id: `rs-${s}`,
  summary: summary === '' ? [] : [{ type: 'summary_text', text: summary }],
  encrypted_content: 'gAAAA',
})

const customToolCall = (s: number, callId: string, input: string): string => line(s, 'response_item', {
  type: 'custom_tool_call', id: `ctc-${s}`, status: 'completed', call_id: callId, name: 'exec', input,
})

const functionCall = (s: number, callId: string, name: string, args: string): string => line(s, 'response_item', {
  type: 'function_call', id: `fc-${s}`, name, arguments: args, call_id: callId,
})

const toolOutput = (s: number, callId: string, text: string): string => line(s, 'response_item', {
  type: 'custom_tool_call_output', id: `cto-${s}`, call_id: callId,
  output: [{ type: 'input_text', text }],
})

const tokenUsage = (s: number, usage: Rec, thread?: Rec): string => line(s, 'token_usage_record', {
  thread_id: 'thread-1', turn_id: 'turn-1', session_id: 'thread-1', root_turn_id: 'turn-1',
  response_id: `resp_${s}`,
  usage,
  turn_token_usage: usage,
  thread_token_usage: thread ?? usage,
})

const itemCompleted = (s: number, item: Rec, startedAt = s): string => line(s, 'event_msg', {
  type: 'item_completed', thread_id: 'thread-1', turn_id: 'turn-1',
  item, started_at_ms: ms(startedAt), completed_at_ms: ms(s),
})

const commandExecution = (s: number, parsed: Rec[], status = 'completed'): string => itemCompleted(s, {
  type: 'CommandExecution', id: `0199-item-${s}`, process_id: '1',
  command: ['bash', '-lc', 'x'], cwd: '/tmp/work', parsed_cmd: parsed, source: 'model',
  status, stdout: '', stderr: '', aggregated_output: '', exit_code: status === 'failed' ? 1 : 0,
  duration: { secs: 0, nanos: 1 }, formatted_output: '',
})

const fileChange = (s: number, changes: Rec): string => itemCompleted(s, {
  type: 'FileChange', id: `0199-file-${s}`, changes, status: 'completed', stdout: '', stderr: '',
})

/** Feed every line and collect the events, in order. */
function run(lines: readonly string[], file: SessionFileRef = MAIN): {
  events: TimelineEvent[]
  synth: ReturnType<typeof createCodexSynthesizer>
} {
  const synth = createCodexSynthesizer(file)
  const events: TimelineEvent[] = []
  for (const l of lines) events.push(...synth.push(l))
  return { events, synth }
}

const typesOf = (events: readonly TimelineEvent[]): string[] => events.map(e => e.type)
const firstOf = (events: readonly TimelineEvent[], type: string): TimelineEvent | undefined =>
  events.find(e => e.type === type)
const allOf = (events: readonly TimelineEvent[], type: string): TimelineEvent[] =>
  events.filter(e => e.type === type)
const dataOf = (event: TimelineEvent | undefined): Rec => (event?.data ?? {}) as Rec
const blocksOf = (event: TimelineEvent | undefined): ContentBlock[] => {
  const data = dataOf(event)
  const message = data['message'] as { content?: ContentBlock[] } | undefined
  return message?.content ?? (data['content'] as ContentBlock[] | undefined) ?? []
}
const sourceOf = (event: TimelineEvent | undefined): Record<string, unknown> =>
  (dataOf(event)['source'] ?? {}) as Record<string, unknown>

/** One complete, ordinary turn: prompt → reasoning + tool call → result → answer. */
const TYPICAL_TURN: string[] = [
  sessionMeta(0),
  taskStarted(1),
  turnContext(1, 'gpt-5.2-codex'),
  userMessage(2, 'hello there'),
  reasoning(3, 'thinking about hello'),
  customToolCall(4, 'call_a', '{"command":["ls"]}'),
  commandExecution(4, [{ type: 'list_files', cmd: 'ls', path: '/tmp/work' }], 'completed'),
  tokenUsage(5, {
    input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 50,
    output_tokens: 120, reasoning_output_tokens: 40, total_tokens: 1120,
  }),
  toolOutput(6, 'call_a', 'a.ts\nb.ts'),
  reasoning(7, 'wrapping up'),
  assistantMessage(8, 'all done'),
  tokenUsage(9, {
    input_tokens: 1500, cached_input_tokens: 900, cache_write_input_tokens: 0,
    output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 1540,
  }),
  taskComplete(10),
]

// -----------------------------------------------------------------------------

describe('codex synthesizer', () => {
  it('maps one ordinary turn to the documented event sequence', () => {
    const { events } = run(TYPICAL_TURN)
    expect(typesOf(events)).toEqual([
      'step/start',        // task_started (started_at is epoch SECONDS)
      'request/context',   // model_context_window
      'request/header',    // deferred from session_meta until the model is known
      'user/message',      // the human prompt
      'assistant/message', // reasoning + tool-call, settled by token_usage_record
      'tool/call',
      'tool/result',
      'step/end',          // the step's only call settled
      'step/start',        // step 2 opens on the next model block
      'assistant/message', // reasoning + text, settled by the second usage record
      'step/end',          // no tool call: the step ends with the message
      // `task_complete` finds nothing open and emits nothing.
    ])
  })

  it('never throws on malformed input and emits nothing for it', () => {
    const { events, synth } = run(['', 'not json', '{"no":"type"}', '[]', 'null', '{"type":"unknown"}'])
    expect(events).toEqual([])
    expect(synth.meta().running).toBe(false)
    expect(synth.kind).toBe('codex')
  })

  it('emits strictly increasing seqs', () => {
    const { events } = run(TYPICAL_TURN)
    const seqs = events.map(e => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  describe('request header', () => {
    it('carries the base instructions as the system prompt and names the provider', () => {
      const { events } = run([sessionMeta(0), taskStarted(1), turnContext(1, 'gpt-5.2-codex')])
      const header = firstOf(events, 'request/header')
      const data = dataOf(header)
      expect(data['reason']).toBe('initial')
      // `config` rides inside `header` — that is where the fold reads it.
      expect(data['header']).toEqual({
        system: 'SYSTEM PROMPT hello hello hello', tools: [],
        config: { model: 'gpt-5.2-codex', provider: 'openai' },
      })
    })

    it('flattens dynamic_tools namespaces into the header tool list', () => {
      const { events } = run([
        sessionMeta(0, {
          dynamic_tools: [
            { type: 'namespace', name: 'g1', description: 'd', tools: [{ type: 'function', name: 'alpha', description: 'a', inputSchema: {} }] },
            { type: 'namespace', name: 'g2', description: 'd', tools: [{ type: 'function', name: 'beta', inputSchema: {} }] },
          ],
        }),
        turnContext(1, 'gpt-5.2-codex'),
      ])
      const tools = (dataOf(firstOf(events, 'request/header'))['header'] as { tools: { name: string; namespace?: string }[] }).tools
      expect(tools.map(t => t.name)).toEqual(['alpha', 'beta'])
      expect(tools.map(t => t.namespace)).toEqual(['g1', 'g2'])
    })

    it('emits exactly one initial header even though session_meta precedes the model', () => {
      const { events } = run(TYPICAL_TURN)
      expect(allOf(events, 'request/header')).toHaveLength(1)
    })

    it('flushes the header before the first model response when no turn_context arrives', () => {
      const { events } = run([sessionMeta(0), taskStarted(1), userMessage(2, 'hi'), assistantMessage(3, 'yo'), tokenUsage(4, { input_tokens: 1, output_tokens: 1 })])
      const header = firstOf(events, 'request/header')
      expect(header).toBeDefined()
      const assistant = firstOf(events, 'assistant/message')
      expect(header!.seq).toBeLessThan(assistant!.seq)
      expect((dataOf(header)['header'] as Rec)['config']).toEqual({ provider: 'openai' })
    })

    it('logs a model change as a change header that REPEATS the system prompt', () => {
      const { events, synth } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'gpt-5.2-codex'),
        taskStarted(20), turnContext(20, 'gpt-5.2-codex-mini'),
      ])
      const headers = allOf(events, 'request/header')
      expect(headers).toHaveLength(2)
      expect(dataOf(headers[1])['reason']).toBe('change')
      // The fold clears a header-sourced system prompt when a later header
      // omits it, so the change header must restate it.
      expect(dataOf(headers[1])['header']).toEqual({
        system: 'SYSTEM PROMPT hello hello hello', tools: [],
        config: { model: 'gpt-5.2-codex-mini', provider: 'openai' },
      })
      expect(synth.meta().model).toBe('gpt-5.2-codex-mini')
    })

    it('does not re-emit a header when the model is unchanged', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'gpt-5.2-codex'),
        taskStarted(20), turnContext(20, 'gpt-5.2-codex'),
      ])
      expect(allOf(events, 'request/header')).toHaveLength(1)
    })
  })

  describe('context window', () => {
    it('emits request/context from task_started and again only when it changes', () => {
      const { events, synth } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'gpt-5.2-codex'),
        line(2, 'event_msg', { type: 'token_count', info: { model_context_window: 258400, last_token_usage: {} }, rate_limits: {} }),
        line(3, 'event_msg', { type: 'token_count', info: { model_context_window: 400000, last_token_usage: {} }, rate_limits: {} }),
      ])
      const contexts = allOf(events, 'request/context')
      expect(contexts.map(e => dataOf(e)['contextWindow'])).toEqual([258400, 400000])
      expect(synth.meta().contextWindow).toBe(400000)
    })
  })

  describe('turn and step numbering', () => {
    it('numbers turns from task_started and steps from each settled response', () => {
      const { events } = run([
        ...TYPICAL_TURN,
        taskStarted(20),
        userMessage(21, 'again'),
        assistantMessage(22, 'sure'),
        tokenUsage(23, { input_tokens: 10, output_tokens: 2 }),
        taskComplete(24),
      ])
      const assistants = allOf(events, 'assistant/message')
      expect(assistants.map(e => [dataOf(e)['turn'], dataOf(e)['step']])).toEqual([[1, 1], [1, 2], [2, 1]])
    })

    it('opens a turn defensively when the file starts mid-turn', () => {
      const { events } = run([userMessage(1, 'orphan prompt'), assistantMessage(2, 'ok'), tokenUsage(3, { input_tokens: 5, output_tokens: 1 })])
      expect(dataOf(firstOf(events, 'assistant/message'))['turn']).toBe(1)
      expect(typesOf(events)).toContain('step/start')
    })

    it('closes an open step at turn_aborted', () => {
      const { events, synth } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'gpt-5.2-codex'), userMessage(2, 'hi'),
        reasoning(3, 'hm'),
        line(4, 'event_msg', { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted', started_at: secs(1), completed_at: secs(4), duration_ms: 3000 }),
      ])
      // The open response settles without usage, then the step closes.
      const assistant = firstOf(events, 'assistant/message')
      expect(assistant).toBeDefined()
      expect(dataOf(assistant)['usage']).toBeUndefined()
      expect(typesOf(events).filter(t => t === 'step/end')).toHaveLength(1)
      expect(synth.meta().running).toBe(false)
    })
  })

  describe('response grouping', () => {
    it('groups reasoning, text and tool-call items into one assistant message', () => {
      const { events } = run(TYPICAL_TURN)
      const first = allOf(events, 'assistant/message')[0]
      expect(blocksOf(first).map(b => b.type)).toEqual(['reasoning', 'tool-call'])
      const call = blocksOf(first)[1]
      expect(call).toMatchObject({ type: 'tool-call', name: 'exec', callId: 'call_a', arguments: '{"command":["ls"]}' })
      const second = allOf(events, 'assistant/message')[1]
      expect(blocksOf(second).map(b => b.type)).toEqual(['reasoning', 'text'])
    })

    it('keeps an encrypted-only reasoning item as an empty reasoning block', () => {
      const { events } = run([sessionMeta(0), taskStarted(1), turnContext(1, 'm'), reasoning(2, ''), tokenUsage(3, { input_tokens: 1, output_tokens: 1 })])
      expect(blocksOf(firstOf(events, 'assistant/message'))).toEqual([{ type: 'reasoning', text: '' }])
    })

    it('reads function_call arguments and custom_tool_call input alike', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        functionCall(2, 'call_f', 'sleep', '{"seconds":1}'),
        tokenUsage(3, { input_tokens: 1, output_tokens: 1 }),
      ])
      expect(blocksOf(firstOf(events, 'assistant/message'))[0])
        .toMatchObject({ type: 'tool-call', name: 'sleep', arguments: '{"seconds":1}', callId: 'call_f' })
      expect(dataOf(firstOf(events, 'tool/call'))).toEqual({ callId: 'call_f', name: 'sleep', arguments: '{"seconds":1}' })
    })

    it('emits tool/call events AFTER the assistant message that carried them', () => {
      const { events } = run(TYPICAL_TURN)
      const assistant = allOf(events, 'assistant/message')[0]
      const call = firstOf(events, 'tool/call')
      expect(call!.seq).toBe(assistant!.seq + 1)
    })

    it('settles an open response without usage when an input arrives first', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        customToolCall(2, 'call_x', '{}'),
        toolOutput(3, 'call_x', 'out'),
      ])
      const assistant = firstOf(events, 'assistant/message')
      expect(dataOf(assistant)['usage']).toBeUndefined()
      expect(assistant!.seq).toBeLessThan(firstOf(events, 'tool/result')!.seq)
    })
  })

  describe('usage mapping', () => {
    it('subtracts the cached and cache-written shares from input_tokens', () => {
      const { events } = run(TYPICAL_TURN)
      // input_tokens is the WHOLE prompt, so the three disjoint buckets must
      // add back up to it (1000) — never past it.
      expect(dataOf(allOf(events, 'assistant/message')[0])['usage']).toEqual({
        inputTokens: 550, cacheReadTokens: 400, cacheWriteTokens: 50, outputTokens: 120,
      })
    })

    it('keeps the cache-written share whole when the prompt is too small to contain it', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'), assistantMessage(2, 'x'),
        tokenUsage(3, { input_tokens: 100, cached_input_tokens: 90, cache_write_input_tokens: 40, output_tokens: 5 }),
      ])
      // 90 + 40 > 100: the write cannot be a share of this prompt, so it is
      // billed as its own bucket rather than driving uncached negative.
      expect(dataOf(firstOf(events, 'assistant/message'))['usage']).toEqual({
        inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 40, outputTokens: 5,
      })
    })

    it('tolerates a usage object with only output tokens', () => {
      const { events } = run([sessionMeta(0), taskStarted(1), turnContext(1, 'm'), assistantMessage(2, 'x'), tokenUsage(3, { output_tokens: 7 })])
      expect(dataOf(firstOf(events, 'assistant/message'))['usage']).toEqual({ inputTokens: 0, outputTokens: 7 })
    })

    it('ignores a usage record with no readable buckets', () => {
      const { events } = run([sessionMeta(0), taskStarted(1), turnContext(1, 'm'), assistantMessage(2, 'x'), tokenUsage(3, {})])
      expect(dataOf(firstOf(events, 'assistant/message'))['usage']).toBeUndefined()
    })
  })

  describe('user and developer messages', () => {
    it('classifies a plain prompt as the human input and uses it as the label', () => {
      const { events, synth } = run(TYPICAL_TURN)
      const user = firstOf(events, 'user/message')
      expect(sourceOf(user)).toEqual({ kind: 'user' })
      expect(synth.meta().label).toBe('hello there')
    })

    it('classifies marked fragments as injections, named by their marker', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        userMessage(2, '<environment_context>\ncwd=/tmp/work\n</environment_context>'),
        userMessage(3, '<turn_aborted>\nstop that\n</turn_aborted>'),
        userMessage(4, 'real prompt'),
      ])
      const users = allOf(events, 'user/message')
      expect(users.map(sourceOf)).toEqual([
        { kind: 'environment-context', form: 'context' },
        { kind: 'turn-aborted', form: 'context' },
        { kind: 'user' },
      ])
    })

    it('classifies the Markdown and relay preambles as injections, named as core names them', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        userMessage(2, '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nproject rules\n</INSTRUCTIONS>'),
        userMessage(3, 'The following is the Codex agent history for the previous window.'),
        // Neither a bare list intro nor a prompt about the file is an
        // injection — the fallback is exact markers, never loose preambles.
        userMessage(4, 'Here is a list of the available skills.'),
        userMessage(5, 'please update # AGENTS.md with the new rule'),
      ])
      expect(allOf(events, 'user/message').map(sourceOf)).toEqual([
        { kind: 'agents-md', form: 'context' },
        { kind: 'guardian-history', form: 'context' },
        { kind: 'user' },
        { kind: 'user' },
      ])
    })

    it('maps developer-role messages to a developer injection', () => {
      const { events } = run([sessionMeta(0), taskStarted(1), turnContext(1, 'm'), developerMessage(2, '<skills_instructions>x</skills_instructions>')])
      expect(sourceOf(firstOf(events, 'user/message'))).toEqual({ kind: 'developer', form: 'context' })
    })

    it('emits an image block for input_image content and keeps the message human', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        line(2, 'response_item', {
          type: 'message', id: 'msg-2', role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }, { type: 'input_text', text: 'look' }],
        }),
      ])
      const user = firstOf(events, 'user/message')
      expect(blocksOf(user).map(b => b.type)).toEqual(['image', 'text'])
      expect(sourceOf(user)).toEqual({ kind: 'user' })
    })

    it('injects collaboration-mode developer instructions once per change', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1),
        turnContext(1, 'm', { collaboration_mode: { mode: 'default', settings: { model: 'm', developer_instructions: 'stay terse' } } }),
        taskStarted(10),
        turnContext(10, 'm', { collaboration_mode: { mode: 'default', settings: { model: 'm', developer_instructions: 'stay terse' } } }),
        taskStarted(20),
        turnContext(20, 'm', { collaboration_mode: { mode: 'default', settings: { model: 'm', developer_instructions: 'be verbose' } } }),
      ])
      const injects = allOf(events, 'user/message').filter(e => sourceOf(e)['kind'] === 'developer-instructions')
      expect(injects).toHaveLength(2)
      expect(blocksOf(injects[0])).toEqual([{ type: 'text', text: 'stay terse' }])
    })
  })

  describe('tool results', () => {
    it('pairs an output with its call id and joins the output blocks', () => {
      const { events } = run(TYPICAL_TURN)
      const result = firstOf(events, 'tool/result')
      const data = dataOf(result)
      expect((data['message'] as { source: unknown }).source).toEqual({ callId: 'call_a' })
      expect(blocksOf(result)).toEqual([
        { type: 'tool-result', toolCallId: 'call_a', isError: false, content: [{ type: 'text', text: 'a.ts\nb.ts' }] },
      ])
      expect(data['error']).toBeUndefined()
    })

    it('reads a plain-string output', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        customToolCall(2, 'call_s', '{}'),
        tokenUsage(3, { input_tokens: 1, output_tokens: 1 }),
        line(4, 'response_item', { type: 'custom_tool_call_output', id: 'o', call_id: 'call_s', output: 'plain' }),
      ])
      expect(blocksOf(firstOf(events, 'tool/result'))[0]?.content).toEqual([{ type: 'text', text: 'plain' }])
    })

    it('marks the result as an error when its item_completed reported failure', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        customToolCall(2, 'call_e', '{}'),
        commandExecution(3, [], 'failed'),
        tokenUsage(4, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(5, 'call_e', 'boom'),
      ])
      const result = firstOf(events, 'tool/result')
      expect(dataOf(result)['error']).toBe(true)
      expect(blocksOf(result)[0]?.isError).toBe(true)
    })
  })

  describe('file ops', () => {
    it('maps parsed_cmd read/search/list_files rows', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        customToolCall(2, 'call_o', '{}'),
        commandExecution(3, [
          { type: 'read', cmd: 'cat a.ts', name: 'a.ts', path: '/tmp/a.ts' },
          { type: 'search', cmd: 'rg hello src', query: 'hello', path: '/tmp/src' },
          { type: 'search', cmd: 'rg hello', query: 'hello' },
          { type: 'list_files', cmd: 'ls', path: '/tmp/work' },
          { type: 'list_files', cmd: 'ls' },
          { type: 'unknown', cmd: 'echo hi' },
        ]),
        tokenUsage(4, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(5, 'call_o', 'ok'),
      ])
      // Reads and searches state no line delta: the fold defaults them to 0.
      expect(dataOf(firstOf(events, 'tool/result'))['fileOps']).toEqual([
        { kind: 'read', path: '/tmp/a.ts' },
        { kind: 'search', path: '/tmp/src', detail: 'hello' },
        { kind: 'search', path: 'hello', pattern: true, detail: 'hello' },
        { kind: 'search', path: '/tmp/work' },
        // A bare `ls` lists the command's own working directory.
        { kind: 'search', path: '/tmp/work' },
      ])
    })

    it('keeps parallel calls\' items on their own call by command match', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        // Two exec calls in flight at once (parallel calls in one response).
        customToolCall(2, 'call_a', 'cat /tmp/a.ts'),
        customToolCall(2, 'call_b', 'rm -rf /tmp/b'),
        // A's item completes first: its read op must NOT land on B's result.
        itemCompleted(3, {
          type: 'CommandExecution', id: 'exec-a', process_id: '1',
          command: ['bash', '-lc', 'cat /tmp/a.ts'], cwd: '/tmp',
          parsed_cmd: [{ type: 'read', cmd: 'cat /tmp/a.ts', name: 'a.ts', path: '/tmp/a.ts' }],
          status: 'failed',
        }),
        tokenUsage(4, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(5, 'call_a', 'a-contents'),
        toolOutput(6, 'call_b', 'done'),
      ])
      const results = allOf(events, 'tool/result')
      const a = results.find(e => ((dataOf(e)['message'] as Rec).source as Rec)?.['callId'] === 'call_a')!
      const b = results.find(e => ((dataOf(e)['message'] as Rec).source as Rec)?.['callId'] === 'call_b')!
      expect(dataOf(a)['fileOps']).toEqual([{ kind: 'read', path: '/tmp/a.ts' }])
      expect(dataOf(a)['error']).toBe(true)
      expect(dataOf(b)['fileOps']).toBeUndefined()
      expect(dataOf(b)['error']).toBeUndefined()
    })

    it('keeps an unpairable item as its own result when several calls are open', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        customToolCall(2, 'call_a', 'cat /tmp/a.ts'),
        customToolCall(2, 'call_b', 'cat /tmp/b.ts'),
        // The item ran a command NEITHER pending call carries — no verifiable link.
        itemCompleted(3, {
          type: 'CommandExecution', id: 'exec-orphan', process_id: '1',
          command: ['bash', '-lc', 'cat /tmp/orphan.ts'], cwd: '/tmp',
          parsed_cmd: [{ type: 'read', cmd: 'cat /tmp/orphan.ts', name: 'o.ts', path: '/tmp/orphan.ts' }],
          status: 'failed',
        }),
        tokenUsage(4, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(5, 'call_a', 'a'),
        toolOutput(6, 'call_b', 'b'),
      ])
      const results = allOf(events, 'tool/result')
      expect(results).toHaveLength(3)
      const orphan = results.find(e => (dataOf(e)['message'] as Rec).source === undefined)!
      expect(dataOf(orphan)['fileOps']).toEqual([{ kind: 'read', path: '/tmp/orphan.ts' }])
      expect(dataOf(orphan)['error']).toBe(true)
      expect(blocksOf(orphan)).toEqual([{ type: 'text', text: 'cat /tmp/orphan.ts' }])
      for (const e of results) {
        const src = (dataOf(e)['message'] as Rec).source as Rec | undefined
        if (src === undefined) continue
        expect(dataOf(e)['error']).toBeUndefined()
      }
    })

    it('counts unified-diff lines for FileChange rows and merges them with command rows', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        customToolCall(2, 'call_p', '{}'),
        fileChange(3, {
          '/tmp/a.ts': { type: 'update', unified_diff: '--- a\n+++ b\n@@\n+one\n+two\n-old\n context\n', move_path: null },
          '/tmp/b.ts': { type: 'add', content: 'x\ny\n' },
        }),
        commandExecution(4, [{ type: 'read', cmd: 'cat', name: 'a.ts', path: '/tmp/a.ts' }]),
        tokenUsage(5, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(6, 'call_p', 'ok'),
      ])
      expect(dataOf(firstOf(events, 'tool/result'))['fileOps']).toEqual([
        { kind: 'write', path: '/tmp/a.ts', added: 2, removed: 1, detail: 'update' },
        { kind: 'write', path: '/tmp/b.ts', added: 2, removed: 0, detail: 'add' },
        { kind: 'read', path: '/tmp/a.ts' },
      ])
    })

  })

  describe('late file ops (tool/ops)', () => {
    /** The dominant real ordering of a late item: `output, token_count, item_completed`. */
    const LATE: string[] = [
      sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
      customToolCall(2, 'call_l', '{}'),
      tokenUsage(3, { input_tokens: 1, output_tokens: 1 }),
      toolOutput(4, 'call_l', 'ok'),
      line(5, 'event_msg', { type: 'token_count', info: { model_context_window: 258400 }, rate_limits: {} }),
      commandExecution(6, [{ type: 'read', cmd: 'cat', name: 'a.ts', path: '/tmp/a.ts' }]),
    ]

    it('books ops that arrive after the output onto the settled result', () => {
      const { events } = run(LATE)
      const result = firstOf(events, 'tool/result')!
      expect(dataOf(result)['fileOps']).toBeUndefined()
      const late = firstOf(events, 'tool/ops')
      expect(late).toBeDefined()
      expect(dataOf(late)).toEqual({
        resultSeq: result.seq,
        tool: 'exec',
        fileOps: [{ kind: 'read', path: '/tmp/a.ts' }],
      })
      // The booking names the result's seq; its own seq only orders the stream.
      expect(late!.seq).toBeGreaterThan(result.seq)
      // `completed_at_ms` is epoch MILLISECONDS, not seconds.
      expect(late!.time).toBe(ms(6))
    })

    it('raises the error flag when the late item reported a failure', () => {
      const { events } = run([
        ...LATE.slice(0, -1),
        commandExecution(6, [{ type: 'read', cmd: 'cat', name: 'a.ts', path: '/tmp/a.ts' }], 'failed'),
      ])
      expect(dataOf(firstOf(events, 'tool/ops'))['err']).toBe(true)
    })

    it('books several late items onto the same settled result', () => {
      const { events } = run([
        ...LATE,
        fileChange(7, { '/tmp/b.ts': { type: 'add', content: 'x\n' } }),
      ])
      const result = firstOf(events, 'tool/result')!
      const late = allOf(events, 'tool/ops')
      expect(late).toHaveLength(2)
      expect(late.every(e => dataOf(e)['resultSeq'] === result.seq)).toBe(true)
    })

    it('keeps booking late items against the newest settled call', () => {
      const { events } = run([
        ...LATE,
        customToolCall(7, 'call_m', '{}'),
        tokenUsage(8, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(9, 'call_m', 'ok'),
        commandExecution(10, [{ type: 'read', cmd: 'cat', name: 'b.ts', path: '/tmp/b.ts' }]),
      ])
      const results = allOf(events, 'tool/result')
      const late = allOf(events, 'tool/ops')
      expect(late).toHaveLength(2)
      expect(dataOf(late[0])['resultSeq']).toBe(results[0]!.seq)
      expect(dataOf(late[1])['resultSeq']).toBe(results[1]!.seq)
    })

    it('drops a late item when two calls settled since the last one opened', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        // Two calls in flight at once: the late item cannot name its own.
        customToolCall(2, 'call_x', '{}'),
        customToolCall(3, 'call_y', '{}'),
        tokenUsage(4, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(5, 'call_x', 'ok'),
        toolOutput(6, 'call_y', 'ok'),
        commandExecution(7, [{ type: 'read', cmd: 'cat', name: 'a.ts', path: '/tmp/a.ts' }]),
      ])
      expect(allOf(events, 'tool/ops')).toEqual([])
    })

    it('pairs exactly when the item id IS the call id', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        customToolCall(2, 'call_x', '{}'),
        customToolCall(3, 'call_y', '{}'),
        tokenUsage(4, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(5, 'call_x', 'ok'),
        toolOutput(6, 'call_y', 'ok'),
        // An id-bearing item (the shape McpToolCall already uses) resolves the
        // ambiguity outright.
        itemCompleted(7, {
          type: 'CommandExecution', id: 'call_x', process_id: '1', command: ['ls'], cwd: '/tmp',
          parsed_cmd: [{ type: 'read', cmd: 'cat', name: 'a.ts', path: '/tmp/a.ts' }],
          source: 'model', status: 'completed', stdout: '', stderr: '', aggregated_output: '',
          exit_code: 0, duration: { secs: 0, nanos: 1 }, formatted_output: '',
        }),
      ])
      const late = firstOf(events, 'tool/ops')
      expect(dataOf(late)['resultSeq']).toBe(allOf(events, 'tool/result')[0]!.seq)
    })

    it('emits nothing for a late item that derives no file op', () => {
      const { events } = run([
        ...LATE.slice(0, -1),
        commandExecution(6, [{ type: 'unknown', cmd: 'echo hi' }]),
      ])
      expect(allOf(events, 'tool/ops')).toEqual([])
    })

    it('files a late item under its SETTLED call by exact id, not the lone pending one', () => {
      // A and B run in parallel; A's output settles first, then A's
      // `item_completed` arrives. B being the only PENDING call proves nothing
      // — the exact id names the already-settled A.
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        customToolCall(2, 'call_a', 'cat /tmp/a.ts'),
        customToolCall(3, 'call_b', 'cat /tmp/b.ts'),
        tokenUsage(4, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(5, 'call_a', 'a'),
        itemCompleted(6, {
          type: 'CommandExecution', id: 'call_a', process_id: '1',
          command: ['bash', '-lc', 'cat /tmp/a.ts'], cwd: '/tmp',
          parsed_cmd: [{ type: 'read', cmd: 'cat /tmp/a.ts', name: 'a.ts', path: '/tmp/a.ts' }],
          source: 'model', status: 'failed', stdout: '', stderr: '', aggregated_output: '',
          exit_code: 1, duration: { secs: 0, nanos: 1 }, formatted_output: '',
        }),
        toolOutput(7, 'call_b', 'b'),
      ])
      const results = allOf(events, 'tool/result')
      const late = firstOf(events, 'tool/ops')
      expect(dataOf(late)).toEqual({
        resultSeq: results[0]!.seq,
        tool: 'exec',
        err: true,
        fileOps: [{ kind: 'read', path: '/tmp/a.ts' }],
      })
      // B's own result is untouched: nothing was misfiled under the open call.
      expect(dataOf(results[1])['fileOps']).toBeUndefined()
      expect(dataOf(results[1])['error']).toBeUndefined()
    })

    it('files a late item under its settled call by command when the id is foreign', () => {
      // Same ordering, but the item id is not a call id: the command string
      // inside the SETTLED call's arguments still proves the link.
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'),
        customToolCall(2, 'call_a', 'cat /tmp/a.ts'),
        customToolCall(3, 'call_b', 'cat /tmp/b.ts'),
        tokenUsage(4, { input_tokens: 1, output_tokens: 1 }),
        toolOutput(5, 'call_a', 'a'),
        itemCompleted(6, {
          type: 'CommandExecution', id: '0199-item-6', process_id: '1',
          command: ['bash', '-lc', 'cat /tmp/a.ts'], cwd: '/tmp',
          parsed_cmd: [{ type: 'read', cmd: 'cat /tmp/a.ts', name: 'a.ts', path: '/tmp/a.ts' }],
          source: 'model', status: 'completed', stdout: '', stderr: '', aggregated_output: '',
          exit_code: 0, duration: { secs: 0, nanos: 1 }, formatted_output: '',
        }),
        toolOutput(7, 'call_b', 'b'),
      ])
      const results = allOf(events, 'tool/result')
      const late = firstOf(events, 'tool/ops')
      expect(dataOf(late)).toEqual({
        resultSeq: results[0]!.seq,
        tool: 'exec',
        fileOps: [{ kind: 'read', path: '/tmp/a.ts' }],
      })
      expect(dataOf(results[1])['fileOps']).toBeUndefined()
    })
  })

  describe('time to first token', () => {
    it('stamps a token chunk per step, before that step\'s block starts', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'gpt-5.2-codex'), userMessage(2, 'hi'),
        reasoning(3, 'think'),
        itemCompleted(3, { type: 'Reasoning', id: 'rs-3', summary_text: [], raw_content: [] }, 2.5),
        customToolCall(4, 'call_t', '{}'),
        tokenUsage(5, { input_tokens: 10, output_tokens: 2 }),
        toolOutput(6, 'call_t', 'ok'),
        assistantMessage(7, 'done'),
        itemCompleted(7, { type: 'AgentMessage', id: 'msg-7', content: [], phase: 'final' }, 6.5),
        tokenUsage(8, { input_tokens: 10, output_tokens: 2 }),
      ])
      const [first, second] = allOf(events, 'assistant/message')
      const firstStream = dataOf(first)['stream'] as { time: number; chunk: { type: string; blockType?: string } }[]
      expect(firstStream[0]).toEqual({ type: 'chunk', time: ms(2.5), chunk: { type: 'text-delta', text: ' ' } })
      expect(firstStream.slice(1).map(c => c.chunk.blockType)).toEqual(['reasoning', 'tool-call'])
      // Block i starts when block i-1 completed; block 0 at the first token.
      expect(firstStream[1]?.time).toBe(ms(2.5))
      expect(firstStream[2]?.time).toBe(ms(3))
      // Step 2 of the same turn is stamped from its OWN first item, against
      // its own step start (the tool result at t=6s).
      const secondStream = dataOf(second)['stream'] as { time: number; chunk: { type: string } }[]
      expect(secondStream[0]).toEqual({ type: 'chunk', time: ms(6.5), chunk: { type: 'text-delta', text: ' ' } })
    })

    it('omits the token chunk when the derived instant falls outside the step window', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(5), turnContext(5, 'm'),
        reasoning(6, 'think'),
        // `started_at_ms` predates the step start: an out-of-window stand-in is
        // dropped rather than fabricating a negative wait.
        itemCompleted(6, { type: 'Reasoning', id: 'rs-6', summary_text: [], raw_content: [] }, 1),
        tokenUsage(7, { input_tokens: 1, output_tokens: 1 }),
      ])
      const stream = dataOf(firstOf(events, 'assistant/message'))['stream'] as { chunk: { type: string } }[]
      expect(stream.every(c => c.chunk.type === 'block-start')).toBe(true)
    })

    it('omits the token chunk when no Reasoning/AgentMessage item was recorded', () => {
      const { events } = run(TYPICAL_TURN)
      const stream = dataOf(allOf(events, 'assistant/message')[0])['stream'] as { chunk: { type: string } }[]
      expect(stream.every(c => c.chunk.type === 'block-start')).toBe(true)
    })
  })

  describe('compaction', () => {
    const compacted = (s: number, extra: Rec = {}): string => line(s, 'compacted', {
      message: '',
      replacement_history: [
        { type: 'message', id: 'r1', role: 'user', content: [{ type: 'input_text', text: 'kept prompt' }] },
        { type: 'message', id: 'r2', role: 'developer', content: [{ type: 'input_text', text: 'kept rules' }] },
        { type: 'compaction', id: 'r3', encrypted_content: 'gAAA' },
      ],
      window_number: 1,
      first_window_id: 'win-1',
      previous_window_id: 'win-1',
      window_id: 'win-2',
      latest_token_usage_record: { usage: { input_tokens: 12345 } },
      ...extra,
    })

    it('shadows every live surface seq and replaces it with the retained history', () => {
      const { events } = run([...TYPICAL_TURN, compacted(11)])
      const summary = firstOf(events, 'compaction/summary')!
      const liveBefore = events
        .filter(e => ['user/message', 'tool/result', 'assistant/message'].includes(e.type) && e.seq < summary.seq)
        .map(e => e.seq)
      expect(dataOf(summary)['shadowedSeqs']).toEqual(liveBefore)
      expect(dataOf(summary)['shadowedTokenCount']).toBe(12345)

      const replacements = events.filter(e => e.type === 'user/message' && e.seq > summary.seq)
      expect(replacements).toHaveLength(3)
      expect(replacements[0]!.surfaceOp).toEqual({
        op: 'replace', startSeq: Math.min(...liveBefore), endSeq: Math.max(...liveBefore),
      })
      expect(replacements.slice(1).every(e => e.surfaceOp === undefined)).toBe(true)
      expect(replacements.map(sourceOf)).toEqual([
        { kind: 'compaction-retained', form: 'compaction' },
        { kind: 'compaction-retained', form: 'compaction', name: 'developer' },
        { kind: 'plugin', form: 'compaction', plugin: 'compaction', compactionId: 'win-2' },
      ])
      // The encrypted summary item carries no readable content.
      expect(blocksOf(replacements[2])).toEqual([])
      expect(blocksOf(replacements[0])).toEqual([{ type: 'text', text: 'kept prompt' }])
    })

    it('falls back to the last response context size when the record omits one', () => {
      const { events } = run([...TYPICAL_TURN, line(11, 'compacted', { message: '', replacement_history: [], window_id: 'win-2' })])
      // The last token_usage_record of TYPICAL_TURN reported input_tokens 1500 —
      // the context occupancy at compaction, not the cumulative thread total.
      expect(dataOf(firstOf(events, 'compaction/summary'))['shadowedTokenCount']).toBe(1500)
    })

    it('still claims the replaced range when the replacement history is empty', () => {
      const { events } = run([...TYPICAL_TURN, line(11, 'compacted', { message: '', replacement_history: [], window_id: 'win-2' })])
      const summary = firstOf(events, 'compaction/summary')!
      const replacements = events.filter(e => e.type === 'user/message' && e.seq > summary.seq)
      expect(replacements).toHaveLength(1)
      expect(replacements[0]!.surfaceOp).toMatchObject({ op: 'replace' })
    })

    it('shadows only the seqs that are live after a previous compaction', () => {
      const { events } = run([...TYPICAL_TURN, compacted(11), compacted(12)])
      const summaries = allOf(events, 'compaction/summary')
      const second = dataOf(summaries[1])['shadowedSeqs'] as number[]
      expect(second).toHaveLength(3)
      expect(Math.min(...second)).toBeGreaterThan(summaries[0]!.seq)
    })

    it('claims a buffered usage-only response through compaction_response_id', () => {
      const { events } = run([
        ...TYPICAL_TURN,
        // The remote compaction's own response is a usage-only
        // `token_usage_record` settling no open response; the `compacted`
        // record names it through `compaction_response_id`.
        line(11, 'token_usage_record', {
          thread_id: 'thread-1', turn_id: 'turn-1', response_id: 'resp-compact',
          usage: { input_tokens: 500, output_tokens: 80, total_tokens: 580 },
        }),
        compacted(12, { compaction_response_id: 'resp-compact' }),
      ])
      const usageOnly = allOf(events, 'assistant/message').find(e =>
        dataOf(e)['usage'] !== undefined && blocksOf(e).length === 0)
      expect(usageOnly).toBeDefined()
      expect(dataOf(usageOnly)['usage']).toEqual({ inputTokens: 500, outputTokens: 80 })
      // Its zero-token node folds inside the window the compaction shadows.
      const summary = firstOf(events, 'compaction/summary')!
      expect(usageOnly!.seq).toBeLessThan(summary.seq)
      expect(dataOf(summary)['shadowedSeqs']).toContain(usageOnly!.seq)
    })

    it('keeps retained agent messages and holds retained user messages as host evidence', () => {
      const { events } = run([
        ...TYPICAL_TURN,
        compacted(11, {
          replacement_history: [
            { type: 'message', id: 'r1', role: 'user', content: [{ type: 'input_text', text: 'kept prompt' }] },
            { type: 'agent_message', id: 'r2', author: 'parent', recipient: 'child',
              content: [{ type: 'input_text', text: 'keep coordinating' }] },
            { type: 'compaction', id: 'r3', encrypted_content: 'gAAA' },
          ],
          retained_context: {
            user_messages: [{ turn_id: 'turn-1', message_id: 'm1', text: 'host-only instruction', complete: true }],
          },
        }),
      ])
      const summary = firstOf(events, 'compaction/summary')!
      const replacements = events.filter(e => e.type === 'user/message' && e.seq > summary.seq)
      // `replacement_history` is authoritative: the retained agent_message
      // survives under its relay identity alongside the kept messages.
      expect(replacements.map(sourceOf)).toEqual([
        { kind: 'compaction-retained', form: 'compaction' },
        { kind: 'agent-message', form: 'relay', name: 'parent → child' },
        { kind: 'plugin', form: 'compaction', plugin: 'compaction', compactionId: 'win-2' },
      ])
      expect(blocksOf(replacements[1])).toEqual([{ type: 'text', text: 'keep coordinating' }])
      // `retained_context.user_messages` is host-review evidence: it annotates
      // the summary event but never joins the model-visible surface.
      expect(dataOf(summary)['retained']).toEqual(['host-only instruction'])
      const surfaceTexts = allOf(events, 'user/message')
        .flatMap(e => blocksOf(e))
        .map(block => block.text)
      expect(surfaceTexts).not.toContain('host-only instruction')
    })
  })

  describe('durable items', () => {
    it('settles a web_search_call on arrival: call event first, then the result', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'), userMessage(2, 'search it'),
        line(3, 'response_item', {
          type: 'web_search_call', id: 'ws-1', status: 'completed',
          action: { type: 'search', query: 'codex rollout format' },
        }),
        tokenUsage(4, { input_tokens: 10, output_tokens: 2 }),
        assistantMessage(5, 'found'),
        tokenUsage(6, { input_tokens: 12, output_tokens: 3 }),
        taskComplete(7),
      ])
      const call = allOf(events, 'tool/call').find(e => dataOf(e)['callId'] === 'ws-1')
      expect(call).toBeDefined()
      expect(dataOf(call)['name']).toBe('web_search')
      const result = allOf(events, 'tool/result').find(e =>
        (((dataOf(e)['message'] as Rec).source ?? {}) as Rec)['callId'] === 'ws-1')
      expect(result).toBeDefined()
      // The fold pairs a result only with a call it has already seen.
      expect(call!.seq).toBeLessThan(result!.seq)
      // The self-contained call must not leave the step open awaiting an output.
      expect(typesOf(events).lastIndexOf('step/end')).toBeGreaterThan(typesOf(events).lastIndexOf('tool/call'))
    })

    it('completes image_generation_call with an image block', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'), userMessage(2, 'draw'),
        line(3, 'response_item', {
          type: 'image_generation_call', id: 'ig-1', status: 'completed',
          revised_prompt: 'a gray tabby', result: 'aW1hZ2U=',
        }),
        tokenUsage(4, { input_tokens: 10, output_tokens: 2 }),
        taskComplete(7),
      ])
      const result = allOf(events, 'tool/result').find(e =>
        (((dataOf(e)['message'] as Rec).source ?? {}) as Rec)['callId'] === 'ig-1')
      expect(result).toBeDefined()
      const inner = ((blocksOf(result)[0] ?? {}) as Rec)
      const innerContent = (inner['content'] ?? []) as ContentBlock[]
      expect(innerContent[0]?.type).toBe('image')
    })

    it('pairs tool_search_call with tool_search_output', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'), userMessage(2, 'find tools'),
        line(3, 'response_item', {
          type: 'tool_search_call', id: 'ts-1', call_id: 'call-ts', execution: 'client',
          arguments: { query: 'file tools' },
        }),
        line(4, 'response_item', {
          type: 'tool_search_output', call_id: 'call-ts', status: 'completed', execution: 'client',
          tools: [{ type: 'function', name: 'read_file' }],
        }),
        tokenUsage(5, { input_tokens: 10, output_tokens: 2 }),
        taskComplete(7),
      ])
      const call = allOf(events, 'tool/call').find(e => dataOf(e)['callId'] === 'call-ts')
      expect(dataOf(call)['name']).toBe('tool_search')
      const result = allOf(events, 'tool/result').find(e =>
        (((dataOf(e)['message'] as Rec).source ?? {}) as Rec)['callId'] === 'call-ts')
      expect(result).toBeDefined()
      const inner = (blocksOf(result)[0] ?? {}) as Rec
      expect(((inner['content'] ?? []) as ContentBlock[])[0]?.text).toBe('[{"type":"function","name":"read_file"}]')
    })

    it('marks a failed tool_search_output as an error result', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'), userMessage(2, 'go'),
        line(3, 'response_item', {
          type: 'tool_search_call', call_id: 'call-ts', execution: 'client', arguments: {},
        }),
        line(4, 'response_item', {
          type: 'tool_search_output', call_id: 'call-ts', status: 'failed', execution: 'client', tools: [],
        }),
        taskComplete(7),
      ])
      const result = allOf(events, 'tool/result').find(e =>
        (((dataOf(e)['message'] as Rec).source ?? {}) as Rec)['callId'] === 'call-ts')
      expect(dataOf(result)['error']).toBe(true)
    })

    it('qualifies a namespaced function_call name', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'), userMessage(2, 'open'),
        line(3, 'response_item', {
          type: 'function_call', id: 'fc-ns', call_id: 'call-ns',
          namespace: 'codex_app', name: 'open_in_codex', arguments: '{}',
        }),
        tokenUsage(4, { input_tokens: 10, output_tokens: 2 }),
        taskComplete(7),
      ])
      const call = allOf(events, 'tool/call').find(e => dataOf(e)['callId'] === 'call-ns')
      expect(dataOf(call)['name']).toBe('codex_app.open_in_codex')
    })

    it('renders agent_message and inter_agent_communication as relay injects, never prompts', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'), userMessage(2, 'delegate'),
        line(3, 'response_item', {
          type: 'agent_message', id: 'am-1', author: '/child/explorer', recipient: '/root',
          content: [{ type: 'input_text', text: 'found it in src/x.ts' }],
        }),
        line(4, 'inter_agent_communication', {
          author: '/root', recipient: '/child/explorer', content: 'now check tests', trigger_turn: false,
        }),
        tokenUsage(5, { input_tokens: 10, output_tokens: 2 }),
        taskComplete(7),
      ])
      const relays = allOf(events, 'user/message').filter(e => sourceOf(e)['kind'] === 'agent-message')
      expect(relays).toHaveLength(2)
      expect(sourceOf(relays[0])['name']).toBe('/child/explorer → /root')
      expect(sourceOf(relays[1])['name']).toBe('/root → /child/explorer')
      // Neither is a human prompt.
      expect(allOf(events, 'user/message').filter(e => sourceOf(e)['kind'] === 'user')).toHaveLength(1)
    })

    it('shows a retained_context verified_answer as a notice without model content', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'), userMessage(2, 'go'),
        line(3, 'retained_context', {
          type: 'verified_answer', turn_id: 'turn-1', call_id: 'call-q',
          questions: [{ question: 'which db?', answer: 'sqlite' }],
        }),
        taskComplete(7),
      ])
      const relay = allOf(events, 'user/message').find(e => sourceOf(e)['kind'] === 'verified-answer')
      expect(relay).toBeDefined()
      expect(blocksOf(relay)).toEqual([])
      expect(sourceOf(relay)['summary']).toContain('sqlite')
    })

    it('emits a configuration_update marker and a thread_goal inject', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'm'), userMessage(2, 'go'),
        line(3, 'response_item', { type: 'configuration_update', reasoning: { effort: 'high' } }),
        line(4, 'event_msg', {
          type: 'thread_goal_updated', threadId: 'thread-1',
          goal: { threadId: 'thread-1', objective: 'build it in one hour', status: 'active' },
        }),
        taskComplete(7),
      ])
      const kinds = allOf(events, 'user/message').map(e => sourceOf(e)['kind'])
      expect(kinds).toEqual(expect.arrayContaining(['configuration-update', 'thread-goal']))
    })

    it('applies a thread_settings_applied model switch as a change header', () => {
      const { events, synth } = run([
        sessionMeta(0), taskStarted(1), turnContext(1, 'gpt-old'), userMessage(2, 'go'),
        line(3, 'event_msg', {
          type: 'thread_settings_applied', thread_id: 'thread-1',
          thread_settings: { model: 'gpt-new', model_provider_id: 'openai' },
        }),
        taskComplete(7),
      ])
      const headers = allOf(events, 'request/header')
      const change = headers.find(e => dataOf(e)['reason'] === 'change')
      expect(change).toBeDefined()
      expect(((dataOf(change)['header'] as Rec)['config'] as Rec)['model']).toBe('gpt-new')
      expect(synth.meta().model).toBe('gpt-new')
    })
  })

  describe('thread_rolled_back', () => {
    it('prunes the last N turns\' surface nodes and leaves a marker', () => {
      const { events } = run([
        sessionMeta(0),
        taskStarted(1), turnContext(1, 'm'), userMessage(2, 'first prompt'),
        reasoning(3, 'thinking'), assistantMessage(4, 'answer one'),
        tokenUsage(5, { input_tokens: 10, output_tokens: 2 }),
        taskComplete(6),
        line(7, 'event_msg', { type: 'task_started', turn_id: 'turn-2', started_at: secs(7) }),
        userMessage(8, 'second prompt'),
        assistantMessage(9, 'answer two'),
        tokenUsage(10, { input_tokens: 12, output_tokens: 3 }),
        taskComplete(11),
        line(12, 'event_msg', { type: 'thread_rolled_back', num_turns: 1 }),
      ])
      const prune = firstOf(events, 'compaction/prune')
      expect(prune).toBeDefined()
      const shadowed = dataOf(prune)['shadowedSeqs'] as number[]
      // Turn 2's user message and assistant answer are shadowed; turn 1's stay.
      const turn2User = allOf(events, 'user/message').find(e => blocksOf(e)[0]?.text === 'second prompt')!
      const turn1User = allOf(events, 'user/message').find(e => blocksOf(e)[0]?.text === 'first prompt')!
      expect(shadowed).toContain(turn2User.seq)
      expect(shadowed).not.toContain(turn1User.seq)
      const marker = allOf(events, 'user/message').find(e => sourceOf(e)['kind'] === 'rollback')
      expect(marker).toBeDefined()
      expect(marker!.surfaceOp).toMatchObject({ op: 'replace' })
    })

    it('keeps turn-0 injections out of the rollback', () => {
      const { events } = run([
        sessionMeta(0),
        developerMessage(1, 'injected instructions'),
        taskStarted(2), turnContext(2, 'm'), userMessage(3, 'only prompt'),
        assistantMessage(4, 'answer'),
        taskComplete(5),
        line(6, 'event_msg', { type: 'thread_rolled_back', num_turns: 5 }),
      ])
      const prune = firstOf(events, 'compaction/prune')!
      const shadowed = dataOf(prune)['shadowedSeqs'] as number[]
      const inject = allOf(events, 'user/message').find(e => sourceOf(e)['kind'] === 'developer')!
      expect(shadowed).not.toContain(inject.seq)
    })
  })

  describe('dynamic_tools normalization', () => {
    const headerTools = (events: readonly TimelineEvent[]): unknown[] =>
      ((dataOf(firstOf(events, 'request/header'))['header'] as Rec | undefined)?.['tools'] ?? []) as unknown[]

    it('keeps canonical function entries and expands namespaces', () => {
      const { events } = run([
        sessionMeta(0, {
          dynamic_tools: [
            { type: 'function', name: 'ping', description: 'p', inputSchema: {} },
            { type: 'namespace', name: 'codex_app', description: 'app tools',
              tools: [{ type: 'function', name: 'open_in_codex', description: 'd', inputSchema: {} }] },
          ],
        }),
        taskStarted(1), turnContext(1, 'm'), userMessage(2, 'hi'),
      ])
      const tools = headerTools(events) as Rec[]
      expect(tools.map(tool => tool['name'])).toEqual(['ping', 'open_in_codex'])
      expect(tools[1]?.['namespace']).toBe('codex_app')
    })

    it('normalizes the legacy flat shape, preserving namespace and deferLoading', () => {
      const { events } = run([
        sessionMeta(0, {
          dynamic_tools: [
            { name: 'lookup', description: 'd', inputSchema: {}, namespace: 'search', exposeToContext: false },
            { name: 'plain', description: 'd', inputSchema: {} },
          ],
        }),
        taskStarted(1), turnContext(1, 'm'), userMessage(2, 'hi'),
      ])
      const tools = headerTools(events) as Rec[]
      expect(tools[0]?.['type']).toBe('function')
      expect(tools[0]?.['namespace']).toBe('search')
      expect(tools[0]?.['deferLoading']).toBe(true)
      expect(tools[0]?.['exposeToContext']).toBeUndefined()
      expect(tools[1]?.['namespace']).toBeUndefined()
    })
  })

  describe('world_state fallback', () => {
    const worldState = (s: number, state: Rec): string => line(s, 'world_state', { full: true, state })

    it('sizes agents_md and host_skills once when no developer message was seen', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1),
        worldState(2, { agents_md: { text: 'project rules', directory: '/tmp/work' }, host_skills: { body: 'skill list', includeInstructions: true } }),
        worldState(3, { agents_md: { text: 'project rules' }, host_skills: { body: 'skill list' } }),
      ])
      const injects = allOf(events, 'user/message')
      expect(injects.map(sourceOf)).toEqual([
        { kind: 'agents-md', form: 'context' },
        { kind: 'host-skills', form: 'context' },
      ])
    })

    it('stays silent once a developer message has carried the instructions', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1), developerMessage(2, 'instructions'),
        line(3, 'world_state', { full: true, state: { agents_md: { text: 'project rules' } } }),
      ])
      expect(allOf(events, 'user/message').map(sourceOf)).toEqual([{ kind: 'developer', form: 'context' }])
    })

    it('re-sizes when the world state text actually changes', () => {
      const { events } = run([
        sessionMeta(0), taskStarted(1),
        line(2, 'world_state', { full: true, state: { agents_md: { text: 'v1' } } }),
        line(3, 'world_state', { full: true, state: { agents_md: { text: 'v2' } } }),
      ])
      expect(allOf(events, 'user/message')).toHaveLength(2)
    })
  })

  describe('meta', () => {
    it('reports model, provider, window, label, version and the running flag', () => {
      const synth = createCodexSynthesizer(MAIN)
      for (const l of TYPICAL_TURN.slice(0, 4)) synth.push(l)
      expect(synth.meta()).toEqual({
        model: 'gpt-5.2-codex',
        provider: 'openai',
        contextWindow: 258400,
        label: 'hello there',
        running: true,
        children: new Map(),
        version: '0.99.0',
      })
      for (const l of TYPICAL_TURN.slice(4)) synth.push(l)
      expect(synth.meta().running).toBe(false)
    })

    it('keeps children empty (Codex records no child references in the parent)', () => {
      const { synth } = run(TYPICAL_TURN)
      expect(synth.meta().children.size).toBe(0)
    })

    it('honours a non-openai model_provider', () => {
      const { synth } = run([sessionMeta(0, { model_provider: 'azure' })])
      expect(synth.meta().provider).toBe('azure')
    })

    it('labels a subagent thread from session_meta.source when it has no prompt', () => {
      const { synth } = run([
        sessionMeta(0, {
          parent_thread_id: 'thread-parent',
          thread_source: 'subagent',
          source: { subagent: { other: 'review the diff' } },
        }),
        taskStarted(1),
        developerMessage(2, 'you are a reviewer'),
      ])
      expect(synth.meta().label).toBe('review the diff')
    })

    it('falls back to thread_source when the subagent carries no name', () => {
      const { synth } = run([sessionMeta(0, { parent_thread_id: 'thread-parent', thread_source: 'guardian_review', source: {} })])
      expect(synth.meta().label).toBe('guardian_review')
    })

    it('prefers a real human prompt over the subagent fallback', () => {
      const { synth } = run([
        sessionMeta(0, { parent_thread_id: 'p', thread_source: 'subagent', source: { subagent: { other: 'fallback' } } }),
        taskStarted(1), userMessage(2, 'actual prompt'),
      ])
      expect(synth.meta().label).toBe('actual prompt')
    })

    it('leaves a main session without a prompt unlabelled', () => {
      const { synth } = run([sessionMeta(0), taskStarted(1)])
      expect(synth.meta().label).toBeUndefined()
    })

    it('trims a long label to 80 characters', () => {
      const long = 'x'.repeat(200)
      const { synth } = run([sessionMeta(0), taskStarted(1), userMessage(2, long)])
      expect(synth.meta().label).toHaveLength(80)
      expect(synth.meta().label?.endsWith('…')).toBe(true)
    })
  })
})

describe('codex synthesizer — readable reasoning text', () => {
  it('renders reasoning_text content alongside the summary', () => {
    const { events } = run([
      sessionMeta(0),
      taskStarted(1),
      userMessage(2, 'hi'),
      line(3, 'response_item', {
        type: 'reasoning', id: 'rs-3', summary: [],
        content: [{ type: 'reasoning_text', text: 'Visible reasoning' }, { type: 'text', text: 'Final thought' }],
        encrypted_content: 'gAAAA',
      }),
      assistantMessage(4, 'done'),
      tokenUsage(5, { input_tokens: 10, output_tokens: 5, total_tokens: 15 }),
    ])
    const assistant = firstOf(events, 'assistant/message')
    expect(blocksOf(assistant)).toContainEqual({ type: 'reasoning', text: 'Visible reasoning\n\nFinal thought' })
  })
})
