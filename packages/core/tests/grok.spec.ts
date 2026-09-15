import { describe, expect, it } from 'vitest'
import {
  createGrokParser, grokContextWindow, grokMessageClass, isGrokTaskTool, parseGrokLine,
  GROK_CONTEXT_WINDOWS, GROK_DEFAULT_CONTEXT_WINDOW, GROK_SIDECAR_METHOD,
} from '../src/adapters/grok.ts'
import type { SessionFileRef } from '../src/session.ts'
import type {
  AssistantMessageNode, ContextMessageNode, ToolResultNode,
} from '../src/contract.ts'

const SESSION_ID = '01a09b39-a469-7073-b766-83847750b352'
const CHILD_ID = '01a09b3a-1111-7000-8000-222233334444'
const PROMPT_ID = '2215e64f-d3a3-4e66-aff6-6ba9448d26d8'
const NEXT_PROMPT_ID = 'ad5fe32a-47b5-49a5-9c1c-2f62e544d19b'

const MAIN: SessionFileRef = {
  id: SESSION_ID,
  role: 'main',
  path: `/tmp/.grok/sessions/%2Fwork%2Fproject/${SESSION_ID}/updates.jsonl`,
}
const CHILD: SessionFileRef = {
  id: CHILD_ID,
  role: 'child',
  path: `/tmp/.grok/sessions/%2Fwork%2Fproject/${CHILD_ID}/updates.jsonl`,
  parentId: SESSION_ID,
}

/** The envelope stamp is epoch SECONDS; `_meta.agentTimestampMs` is milliseconds. */
const T0 = Date.parse('2026-09-13T00:00:00.000Z')

function at(offsetMs: number): number {
  return T0 + offsetMs
}

function envelope(
  method: string,
  update: Record<string, unknown>,
  offset: number,
  meta: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    timestamp: Math.floor(at(offset) / 1000),
    method,
    params: {
      sessionId: SESSION_ID,
      update,
      _meta: { eventId: `${SESSION_ID}-${offset}`, agentTimestampMs: at(offset), ...meta },
    },
  })
}

/** ACP rail (`session/update`). */
const acp = (update: Record<string, unknown>, offset: number, meta: Record<string, unknown> = {}) =>
  envelope('session/update', update, offset, meta)

/** xAI extension rail (`_x.ai/session/update`). */
const xai = (update: Record<string, unknown>, offset: number, meta: Record<string, unknown> = {}) =>
  envelope('_x.ai/session/update', update, offset, meta)

const sidecar = (offset: number, summary: Record<string, unknown> = {}) => JSON.stringify({
  timestamp: Math.floor(at(offset) / 1000),
  method: GROK_SIDECAR_METHOD,
  params: {
    sessionId: SESSION_ID,
    summary: {
      info: { cwd: '/work/project' },
      session_summary: 'Reading a.ts',
      created_at: '2026-09-13T00:00:00.000Z',
      current_model_id: 'grok-4.6',
      num_messages: 4,
      ...summary,
    },
    systemPrompt: 'You are Grok Build.',
    toolDefinitions: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from disk.',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ],
  },
})

const userChunk = (
  offset: number,
  text: string,
  update: Record<string, unknown> = {},
  contentMeta?: Record<string, unknown>,
) => acp({
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text, ...(contentMeta === undefined ? {} : { _meta: contentMeta }) },
  ...update,
}, offset)

const prompt = (offset: number, text: string, promptIndex: number) => userChunk(
  offset, text, { _meta: { modelId: 'grok-4.6', promptIndex } },
)

const thought = (offset: number, text: string, meta: Record<string, unknown> = {}) => acp(
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
  offset,
  { promptId: PROMPT_ID, ...meta },
)

const message = (offset: number, text: string, meta: Record<string, unknown> = {}) => acp(
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  offset,
  { promptId: PROMPT_ID, ...meta },
)

const toolCall = (
  offset: number,
  toolCallId: string,
  update: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) => acp({
  sessionUpdate: 'tool_call',
  toolCallId,
  title: 'Read `/work/project/a.ts`',
  kind: 'other',
  status: 'in_progress',
  rawInput: { variant: 'ReadFile', target_file: '/work/project/a.ts' },
  ...update,
}, offset, { promptId: PROMPT_ID, ...meta })

const toolCallUpdate = (
  offset: number,
  toolCallId: string,
  update: Record<string, unknown>,
  meta: Record<string, unknown> = {},
) => acp({ sessionUpdate: 'tool_call_update', toolCallId, ...update }, offset, { promptId: PROMPT_ID, ...meta })

/** The canonical identity envelope, which lands on the first `tool_call_update`. */
const READ_FILE_IDENTITY = {
  _meta: {
    'x.ai/tool': {
      version: 1,
      name: 'read_file',
      kind: 'read',
      namespace: 'grok_build',
      label: 'Read',
      read_only: true,
      input: { path: '/work/project/a.ts' },
    },
  },
}

/** Real `turn_completed.usage`: `cachedReadTokens` is part of `inputTokens`, not beside it. */
const TURN_USAGE = {
  inputTokens: 55_529,
  outputTokens: 717,
  totalTokens: 56_246,
  cachedReadTokens: 47_232,
  cacheCreationTokens: 0,
  reasoningTokens: 363,
  modelCalls: 3,
  apiDurationMs: 14_169,
  costUsdTicks: 151_340_800,
  modelUsage: {
    'grok-4.6-build': {
      inputTokens: 55_529, outputTokens: 717, totalTokens: 56_246, cachedReadTokens: 47_232,
      cacheCreationTokens: 0, reasoningTokens: 363, modelCalls: 3, costUsdTicks: 151_340_800,
    },
  },
  numTurns: 3,
}

const turnCompleted = (
  offset: number,
  promptId: string,
  update: Record<string, unknown> = {},
) => xai({
  sessionUpdate: 'turn_completed',
  prompt_id: promptId,
  stop_reason: 'end_turn',
  usage: TURN_USAGE,
  elapsed_ms: 19_584,
  ...update,
}, offset)

function feed(lines: readonly string[], file: SessionFileRef = MAIN) {
  const parser = createGrokParser()
  for (const item of lines) parser.push(item, file)
  return parser
}

type Parser = ReturnType<typeof createGrokParser>

function assistants(parser: Parser): AssistantMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is AssistantMessageNode => node.kind === 'assistant')
}

function toolResults(parser: Parser): ToolResultNode[] {
  return parser.snapshot().eventNodes.filter((node): node is ToolResultNode => node.kind === 'tool-result')
}

function contexts(parser: Parser): ContextMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is ContextMessageNode => node.kind === 'context')
}

/** One turn, two model calls: a `read_file` loop and then the answer. */
function twoStepFixture(): string[] {
  return [
    sidecar(0),
    prompt(100, 'read a.ts', 0),
    thought(200, 'Open the file first.', { streamStartMs: at(150) }),
    thought(250, ' Then answer.'),
    toolCall(300, 'call-1'),
    toolCallUpdate(320, 'call-1', {
      kind: 'read',
      title: 'Read `/work/project/a.ts`',
      locations: [{ path: '/work/project/a.ts' }],
      rawInput: { variant: 'ReadFile', target_file: '/work/project/a.ts' },
      ...READ_FILE_IDENTITY,
    }),
    toolCallUpdate(400, 'call-1', {
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'export const a = 1' } }],
      rawOutput: { type: 'ReadFile', Ok: 'export const a = 1' },
    }),
    message(500, 'It exports ', { streamStartMs: at(450) }),
    message(520, 'a.'),
    turnCompleted(600, PROMPT_ID),
  ]
}

describe('grok adapter', () => {
  it('reads the system prompt, tools, and session facts from the sidecar', () => {
    const parser = feed(twoStepFixture())
    expect(parser.kind).toBe('grok')
    expect(parser.snapshot().systemPrompts).toEqual([
      { seq: 1, time: T0, turn: 0, step: 0, text: 'You are Grok Build.', update: false },
    ])
    expect(parser.meta()).toEqual({
      title: 'Reading a.ts',
      cwd: '/work/project',
      model: 'grok-4.6',
      startedAt: T0,
      promptCount: 1,
    })
    // The catalog is attached per call id once the canonical wire name is known.
    expect(parser.snapshot().callSchemas.get('call-1')).toEqual({
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    })
  })

  it('lets a later sidecar replace the title without creating nodes', () => {
    const parser = feed(twoStepFixture())
    const before = parser.snapshot().eventNodes.length
    parser.push(sidecar(700, { session_summary: 'Explaining a.ts' }), MAIN)
    expect(parser.meta().title).toBe('Explaining a.ts')
    expect(parser.snapshot().eventNodes).toHaveLength(before)
    expect(parser.snapshot().systemPrompts).toHaveLength(1)
  })

  it('keeps the memoized snapshot when an identical sidecar is re-sent', () => {
    const parser = feed(twoStepFixture())
    const before = parser.snapshot()
    // The server re-sends the sidecar whenever `summary.json` changes, which is
    // every appended line; an unchanged system prompt and tool catalog must not
    // invalidate the snapshot the view is already rendering.
    parser.push(sidecar(0), MAIN)
    expect(parser.snapshot()).toBe(before)
    expect(before.callSchemas.get('call-1')?.name).toBe('read_file')
    // A real change to a schema still does.
    parser.push(JSON.stringify({
      timestamp: 0,
      method: GROK_SIDECAR_METHOD,
      params: {
        sessionId: SESSION_ID,
        summary: null,
        systemPrompt: null,
        toolDefinitions: [{ type: 'function', function: { name: 'read_file', description: 'Read it.', parameters: {} } }],
      },
    }), MAIN)
    expect(parser.snapshot()).not.toBe(before)
  })

  it('folds without a sidecar, falling back to the first prompt for the title', () => {
    const parser = feed(twoStepFixture().slice(1))
    expect(parser.meta()).toEqual({
      title: 'read a.ts',
      cwd: null,
      model: 'grok-4.6',
      startedAt: at(100),
      promptCount: 1,
    })
    expect(parser.snapshot().systemPrompts).toBeUndefined()
  })

  it('reads the millisecond stamp, never the second-granularity envelope', () => {
    const parser = feed(twoStepFixture())
    const [first] = assistants(parser)
    // `agentTimestampMs` wins; `streamStartMs` marks when the model call opened.
    expect(first?.timing).toEqual({
      stepStartTime: at(150), firstTokenTime: at(200), completedTime: at(300),
    })
    expect(toolResults(parser)[0]?.time).toBe(at(400))
  })

  it('concatenates debounced thought and message chunks into one block each', () => {
    const parser = feed(twoStepFixture())
    const [first, second] = assistants(parser)
    expect(first?.blocks).toEqual([
      { kind: 'reasoning', text: 'Open the file first. Then answer.' },
      {
        kind: 'tool-call',
        callId: 'call-1',
        name: 'read_file',
        argsRaw: JSON.stringify({ path: '/work/project/a.ts' }),
      },
    ])
    expect(second?.blocks).toEqual([{ kind: 'text', text: 'It exports a.' }])
    expect(assistants(parser).map(node => [node.turn, node.step])).toEqual([[1, 1], [1, 2]])
  })

  it('merges the canonical x.ai/tool identity into a call announced under its title', () => {
    // The `tool_call` only knows the display title and the internal `rawInput`.
    const parser = feed(twoStepFixture().slice(0, 5))
    expect(parser.snapshot().runningCalls).toEqual([{
      callId: 'call-1',
      name: 'Read `/work/project/a.ts`',
      argsRaw: JSON.stringify({ variant: 'ReadFile', target_file: '/work/project/a.ts' }),
      turn: 1,
      step: 1,
      time: at(300),
      subCalls: [],
    }])
    parser.push(twoStepFixture()[5] ?? '', MAIN)
    expect(parser.snapshot().runningCalls[0]).toMatchObject({
      name: 'read_file',
      argsRaw: JSON.stringify({ path: '/work/project/a.ts' }),
    })
  })

  it('pairs a completed result with its call and stamps the update-delta duration', () => {
    const parser = feed(twoStepFixture())
    const [result] = toolResults(parser)
    expect(result?.callId).toBe('call-1')
    expect(result?.call).toEqual({
      name: 'read_file', argsRaw: JSON.stringify({ path: '/work/project/a.ts' }),
    })
    expect(result?.content).toEqual([{ type: 'text', text: 'export const a = 1' }])
    expect(result?.isError).toBe(false)
    // `events.jsonl` holds the measured duration; this is the update-stamp delta.
    expect(result?.meta).toEqual({ durationMs: 100 })
  })

  it('treats status "failed" as the error flag and renders diff content', () => {
    const parser = feed([
      sidecar(0),
      prompt(100, 'patch a.ts', 0),
      toolCall(200, 'call-9', { title: 'Edit `/work/project/a.ts`' }),
      toolCallUpdate(250, 'call-9', {
        status: 'completed',
        content: [{
          type: 'diff',
          path: '/work/project/a.ts',
          oldText: 'const a = 1',
          newText: 'const a = 2',
          _meta: { old_line: 1, new_line: 1 },
        }],
      }),
      toolCall(300, 'call-10', { title: 'Read `/work/project/missing`' }),
      toolCallUpdate(350, 'call-10', {
        status: 'failed',
        content: [{
          type: 'content',
          content: { type: 'text', text: 'Error: /work/project/missing is a directory, not a file.' },
        }],
        rawOutput: { type: 'ReadFile', IsADirectory: 'Error: …' },
      }),
    ])
    const [diffResult, failure] = toolResults(parser)
    expect(diffResult?.content).toEqual([
      { type: 'text', text: '--- /work/project/a.ts\nconst a = 1 → const a = 2' },
    ])
    expect(diffResult?.isError).toBe(false)
    expect(failure?.isError).toBe(true)
    expect(failure?.content).toEqual([
      { type: 'text', text: 'Error: /work/project/missing is a directory, not a file.' },
    ])
  })

  it('starts a call whose announcing tool_call never arrived', () => {
    const parser = feed([
      sidecar(0),
      prompt(100, 'read a.ts', 0),
      toolCallUpdate(200, 'call-lost', { ...READ_FILE_IDENTITY, kind: 'read' }),
      toolCallUpdate(250, 'call-lost', {
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      }),
    ])
    expect(toolResults(parser).map(result => [result.callId, result.call?.name]))
      .toEqual([['call-lost', 'read_file']])
  })

  it('closes the turn with turn_completed usage where cached reads are a subset of input', () => {
    const parser = feed(twoStepFixture())
    const last = assistants(parser)[1]
    expect(last?.usage).toEqual({
      // 55529 total input − 47232 cached read − 0 cache creation.
      inputTokens: 8_297,
      outputTokens: 717,
      totalTokens: 56_246,
      cacheReadTokens: 47_232,
      cacheWriteTokens: 0,
      // Reasoning is a subset of output, never added to it.
      reasoningTokens: 363,
    })
    const request = parser.snapshot().requests.find(item => item.startSeq === last?.seq)
    expect(request?.usage).toEqual(last?.usage)
    expect(request?.provenance).toEqual({ provider: 'xai', model: 'grok-4.6' })
    expect(request?.requestConfig).toEqual({ provider: 'xai', model: 'grok-4.6' })
    const locations = [...parser.snapshot().eventLocations.values()]
    expect(locations).toHaveLength(4)
    expect(locations.every(item => item.kind === 'turn' && item.turn.status === 'closed')).toBe(true)
  })

  it('puts turn usage on the last model call when the turn ends after a tool result', () => {
    const parser = feed(twoStepFixture().slice(0, 7).concat(turnCompleted(600, PROMPT_ID)))
    const [only] = assistants(parser)
    expect(only?.usage?.inputTokens).toBe(8_297)
    expect(parser.snapshot().requests.find(item => item.startSeq === only?.seq)?.usage?.cacheReadTokens)
      .toBe(47_232)
  })

  it('marks the step errored when turn_completed reports an error kind', () => {
    const parser = feed([
      sidecar(0),
      prompt(100, 'write a long file', 0),
      message(200, 'Starting…'),
      turnCompleted(300, PROMPT_ID, { error_kind: 'max_tokens_truncation', stop_reason: 'max_tokens' }),
    ])
    const [only] = assistants(parser)
    expect(only?.interrupted).toBe(true)
    const request = parser.snapshot().requests.find(item => item.startSeq === only?.seq)
    expect(request?.status).toBe('error')
    expect(request?.errorCode).toBe('max_tokens_truncation')
  })

  it('numbers turns by arrival and counts an interjection as a prompt without opening one', () => {
    const parser = feed([
      ...twoStepFixture(),
      prompt(700, 'now explain it', 1),
      thought(800, 'Explaining.', { promptId: NEXT_PROMPT_ID }),
      // A mid-turn Ctrl+Enter steer: human, but not a turn boundary.
      userChunk(850, '<user_query>also mention exports</user_query>', {}, {
        interjection: true, displayText: 'also mention exports',
      }),
      message(900, 'It exports a constant.', { promptId: NEXT_PROMPT_ID }),
      xai({ sessionUpdate: 'turn_completed', prompt_id: NEXT_PROMPT_ID, stop_reason: 'end_turn' }, 950),
    ])
    const users = parser.snapshot().eventNodes.filter(node => node.kind === 'user')
    expect(users).toHaveLength(3)
    expect(users[2]?.content).toEqual([{ type: 'text', text: 'also mention exports' }])
    expect(parser.meta().promptCount).toBe(3)
    expect(assistants(parser).map(node => [node.turn, node.step])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]])
  })

  it('classifies slash commands, host turns, and the environment preamble', () => {
    const parser = feed([
      // The env preamble: no promptIndex, no content._meta.
      userChunk(50, '<user_info>OS Version: macos</user_info>'),
      userChunk(100, '/statusline', { _meta: { modelId: 'grok-4.6', promptIndex: 0 } }, {
        displayText: '/statusline', displayAsSkill: true,
      }),
      userChunk(150, 'host asked for a summary', { _meta: { modelId: 'grok-4.6', promptIndex: 1 } }, {
        hostTurn: true,
      }),
    ])
    expect(contexts(parser).map(node => [node.provenance.label, node.form])).toEqual([
      ['preamble', 'notice'],
      ['hostTurn', 'relay'],
    ])
    const users = parser.snapshot().eventNodes.filter(node => node.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]?.source).toEqual({ kind: 'user', slash: true })
    // Only the typed slash command is a prompt; the preamble and host turn are not.
    expect(parser.meta().promptCount).toBe(1)
    expect(parser.meta().title).toBe('/statusline')
  })

  it('reads a legacy line that has no method envelope', () => {
    const parser = feed([
      sidecar(0),
      // Old grok wrote the bare ACP notification with no `method`/`params` wrapper.
      JSON.stringify({
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'legacy prompt' },
          _meta: { modelId: 'grok-4.5', promptIndex: 0 },
        },
      }),
      message(200, 'Answering.'),
    ])
    const users = parser.snapshot().eventNodes.filter(node => node.kind === 'user')
    expect(users).toHaveLength(1)
    // No stamp of its own: the line inherits the last time seen.
    expect(users[0]?.time).toBe(T0)
    expect(parser.meta().promptCount).toBe(1)
    expect(parser.meta().model).toBe('grok-4.5')
  })

  it('records a plan snapshot once per distinct todo list', () => {
    const entries = [
      { content: 'Confirm the routing', priority: 'medium', status: 'in_progress' },
      { content: 'Check the protobuf tags', priority: 'medium', status: 'pending' },
    ]
    const parser = feed([
      sidecar(0),
      prompt(100, 'plan it', 0),
      acp({ sessionUpdate: 'plan', entries }, 200),
      acp({ sessionUpdate: 'plan', entries }, 250),
      acp({
        sessionUpdate: 'plan',
        entries: [{ content: 'Confirm the routing', priority: 'medium', status: 'completed' }],
      }, 300),
    ])
    expect(contexts(parser).map(node => [node.form, node.content])).toEqual([
      ['snapshot', [{ type: 'text', text: '[in_progress] Confirm the routing\n[pending] Check the protobuf tags' }]],
      ['snapshot', [{ type: 'text', text: '[completed] Confirm the routing' }]],
    ])
  })

  it('records a compaction pair and remembers the context window it reports', () => {
    const parser = feed([
      sidecar(0),
      prompt(100, 'keep going', 0),
      message(150, 'Working.'),
      xai({
        sessionUpdate: 'auto_compact_started',
        tokens_used: 425_228,
        context_window: 500_000,
        percentage: 85,
        reason: 'Context window 85% full',
      }, 200),
      xai({
        sessionUpdate: 'auto_compact_completed',
        tokens_before: 425_228,
        tokens_after: 7_762,
        elapsed_ms: 150_802,
        summary_preview: 'Earlier context summarized.',
      }, 300),
      message(400, 'Resuming.'),
      turnCompleted(500, PROMPT_ID),
    ])
    expect(parser.snapshot().eventNodes.find(node => node.kind === 'compaction')).toMatchObject({
      kind: 'compaction',
      time: at(200),
      summary: 'Earlier context summarized.',
      shadowedTokenCount: 425_228,
    })
    expect(parser.snapshot().requests.find(item => item.purpose === 'compaction')).toMatchObject({
      purpose: 'compaction', status: 'complete', turn: 1,
      summary: [{ type: 'text', text: 'Earlier context summarized.' }],
    })
    // `auto_compact_started.context_window` is the only in-band window size.
    expect(assistants(parser)[1]?.requestConfig).toEqual({
      provider: 'xai', model: 'grok-4.6', maxTokens: 500_000,
    })
  })

  it('reports a standalone compaction checkpoint and a failed compaction', () => {
    const parser = feed([
      sidecar(0),
      prompt(100, 'go', 0),
      xai({
        sessionUpdate: 'compaction_checkpoint',
        checkpoint_id: '71f70582-90c1-4e5f-8834-9b526a45f0e5',
        prompt_index_at_compaction: 10,
        checkpoint_file: 'compaction_checkpoints/71f70582.json',
        schema_version: 1,
        created_at: '2026-08-21T07:14:14.737034+00:00',
      }, 200),
      xai({ sessionUpdate: 'auto_compact_started', tokens_used: 10, context_window: 500_000, percentage: 85, reason: 'x' }, 300),
      xai({ sessionUpdate: 'auto_compact_failed', error: 'summarizer unavailable' }, 400),
    ])
    expect(parser.snapshot().eventNodes.filter(node => node.kind === 'compaction')).toHaveLength(2)
    const requests = parser.snapshot().requests.filter(item => item.purpose === 'compaction')
    expect(requests.map(item => item.status)).toEqual(['complete', 'error'])
    expect(requests[1]?.error).toBe('summarizer unavailable')
  })

  it('surfaces retry_state as a notice and fails the open step', () => {
    const parser = feed([
      sidecar(0),
      prompt(100, 'go', 0),
      message(200, 'Working…'),
      xai({
        sessionUpdate: 'retry_state',
        type: 'failed',
        error_type: 'context_length',
        message: 'prompt is too long',
      }, 300),
    ])
    expect(contexts(parser).map(node => [node.provenance.label, node.content])).toEqual([
      ['retry', [{ type: 'text', text: 'failed: context_length: prompt is too long' }]],
    ])
    const [only] = assistants(parser)
    expect(only?.interrupted).toBe(true)
    expect(parser.snapshot().requests[0]?.errorCode).toBe('context_length')
  })

  it('marks a rewind without deleting the abandoned branch', () => {
    const parser = feed([
      ...twoStepFixture(),
      xai({
        sessionUpdate: 'rewind_marker',
        target_prompt_index: 0,
        created_at: '2026-09-13T00:00:01+00:00',
      }, 700),
      // The rewound branch replays promptIndex 0, but turns keep counting up.
      prompt(800, 'read a.ts again', 0),
    ])
    expect(contexts(parser).map(node => node.content)).toEqual([
      [{ type: 'text', text: 'Rewound to prompt 0' }],
    ])
    const users = parser.snapshot().eventNodes.filter(node => node.kind === 'user')
    expect(users).toHaveLength(2)
    expect(parser.snapshot().eventLocations.get(users[1]?.seq ?? 0)).toEqual({
      kind: 'turn', turn: { turn: 2, status: 'open' },
    })
  })

  it('notices model switches and background task records', () => {
    const parser = feed([
      sidecar(0),
      prompt(100, 'go', 0),
      xai({
        sessionUpdate: 'model_auto_switched',
        previous_model_id: 'grok-4.6',
        new_model_id: 'grok-4.5',
        reason: 'rate limited',
      }, 200),
      xai({ sessionUpdate: 'model_changed', model_id: 'grok-4.6', reasoning_effort: 'high' }, 250),
      xai({
        sessionUpdate: 'task_backgrounded',
        tool_call_id: 'call-bg',
        task_id: 'task-1',
        command: 'pnpm build',
        cwd: '/work/project',
        output_file: '/tmp/out.log',
        description: 'Build the workspace',
      }, 300),
      xai({ sessionUpdate: 'session_summary_generated', session_summary: 'Building the workspace' }, 400),
      message(500, 'Done.'),
      turnCompleted(600, PROMPT_ID),
    ])
    expect(contexts(parser).map(node => [node.provenance.label, node.content[0]])).toEqual([
      ['model', { type: 'text', text: 'Model switched from grok-4.6 to grok-4.5: rate limited' }],
      ['task_backgrounded', { type: 'text', text: 'Task backgrounded: Build the workspace' }],
    ])
    expect(parser.meta().title).toBe('Building the workspace')
    expect(parser.meta().model).toBe('grok-4.6')
    expect(assistants(parser)[0]?.requestConfig).toEqual({
      provider: 'xai', model: 'grok-4.6', reasoningEffort: 'high',
    })
  })

  it('ignores hook_execution and unknown session updates', () => {
    const base = feed(twoStepFixture())
    const before = base.snapshot()
    base.push(xai({
      sessionUpdate: 'hook_execution',
      event_name: 'user_prompt_submit',
      prompt_id: PROMPT_ID,
      runs: [{ name: 'global/orca-status', status: { status: 'failed', error: 'no env', elapsed_ms: 0 } }],
    }, 700), MAIN)
    base.push(xai({ sessionUpdate: 'session_recap', summary: 'so far…', auto: true }, 710), MAIN)
    base.push(xai({ sessionUpdate: 'a_variant_from_the_future', whatever: 1 }, 720), MAIN)
    base.push(acp({ sessionUpdate: 'available_commands_update', availableCommands: [] }, 730), MAIN)
    expect(base.snapshot()).toBe(before)
  })

  it('ignores blank, malformed, and truncated lines', () => {
    const parser = feed(twoStepFixture())
    const before = parser.snapshot()
    parser.push('', MAIN)
    parser.push('   ', MAIN)
    parser.push('{"timestamp":1789310671,"method":"session/update","params":{"upda', MAIN)
    parser.push('not json at all', MAIN)
    parser.push(JSON.stringify({ timestamp: 1_789_310_671 }), MAIN)
    parser.push(JSON.stringify({ timestamp: 1, method: 'session/update', params: { update: 'oops' } }), MAIN)
    expect(parser.snapshot()).toBe(before)
    parser.push(prompt(800, 'again', 1), MAIN)
    expect(parser.snapshot()).not.toBe(before)
  })

  it('binds a subagent to its spawn_subagent call and nests the child transcript', () => {
    const parser = createGrokParser()
    for (const item of [
      sidecar(0),
      prompt(100, 'fix the bug', 0),
      toolCall(200, 'call-t', { title: 'Task: Fix the bug' }),
      // The canonical identity, and the tool's arguments, land on the update.
      toolCallUpdate(210, 'call-t', {
        kind: 'other',
        title: 'Task: Fix the bug',
        _meta: {
          'x.ai/tool': {
            version: 1,
            name: 'spawn_subagent',
            kind: 'other',
            namespace: 'grok_build',
            label: 'Task',
            read_only: false,
            input: {
              prompt: 'fix the bug in a.ts',
              description: 'Fix the bug',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
        },
      }),
      xai({
        sessionUpdate: 'subagent_spawned',
        subagent_id: CHILD_ID,
        parent_session_id: SESSION_ID,
        child_session_id: CHILD_ID,
        subagent_type: 'general-purpose',
        description: 'Fix the bug',
        // Optional on the wire, and the run's own model rather than the parent's (§D.4).
        model: 'grok-4.6-fast',
      }, 300, { promptId: PROMPT_ID }),
    ]) parser.push(item, MAIN)
    for (const item of [
      acp({
        sessionUpdate: 'tool_call',
        toolCallId: 'child-call-1',
        title: 'Read `/work/project/a.ts`',
        rawInput: { variant: 'ReadFile', target_file: '/work/project/a.ts' },
        ...READ_FILE_IDENTITY,
      }, 400),
      acp({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'child-call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'export const a = 1' } }],
      }, 450),
    ]) parser.push(item, CHILD)
    for (const item of [
      xai({
        sessionUpdate: 'subagent_progress',
        subagent_id: CHILD_ID,
        tool_call_count: 1,
        turn_count: 1,
        tokens_used: 1_200,
        context_window_tokens: 500_000,
        context_usage_pct: 1,
        tools_used: ['read_file'],
        error_count: 0,
      }, 500),
      xai({
        sessionUpdate: 'subagent_finished',
        subagent_id: CHILD_ID,
        status: 'completed',
        tool_calls: 1,
        turns: 1,
        duration_ms: 600,
        tokens_used: 1_200,
        output: 'Fixed it.',
        will_wake: true,
      }, 900),
    ]) parser.push(item, MAIN)

    expect(parser.subagents()).toEqual([{
      agentId: CHILD_ID,
      fileId: CHILD_ID,
      // Bound by promptId + order, never by tool_call_id.
      callId: 'call-t',
      description: 'Fix the bug',
      agentType: 'general-purpose',
      model: 'grok-4.6-fast',
      status: 'completed',
      startedAt: at(300),
      endedAt: at(900),
      lastTime: at(500),
      toolCalls: 1,
    }])
    const [taskResult] = toolResults(parser)
    expect(taskResult?.callId).toBe('call-t')
    expect(taskResult?.call?.name).toBe('spawn_subagent')
    expect(taskResult?.content).toEqual([{ type: 'text', text: 'Fixed it.' }])
    expect(taskResult?.subCalls.map(call => call.callId)).toEqual(['child-call-1'])
    expect(toolResults(parser)).toHaveLength(1)
  })

  it('disambiguates two spawns in one turn by description', () => {
    const taskCall = (offset: number, callId: string, description: string) => toolCall(offset, callId, {
      title: `Task: ${description}`,
      _meta: {
        'x.ai/tool': {
          version: 1,
          name: 'task',
          kind: 'other',
          namespace: 'grok_build',
          label: 'Task',
          read_only: false,
          input: { prompt: `do ${description}`, description, subagent_type: 'explore' },
        },
      },
    })
    const parser = feed([
      sidecar(0),
      prompt(100, 'split the work', 0),
      taskCall(200, 'call-a', 'Alpha'),
      taskCall(250, 'call-b', 'Beta'),
      xai({
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'agent-beta',
        parent_session_id: SESSION_ID,
        child_session_id: 'agent-beta',
        subagent_type: 'explore',
        description: 'Beta',
      }, 300, { promptId: PROMPT_ID }),
      xai({
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'agent-alpha',
        parent_session_id: SESSION_ID,
        child_session_id: 'agent-alpha',
        subagent_type: 'explore',
        description: 'Alpha',
      }, 350, { promptId: PROMPT_ID }),
    ])
    expect(parser.subagents().map(run => [run.agentId, run.callId])).toEqual([
      ['agent-beta', 'call-b'],
      ['agent-alpha', 'call-a'],
    ])
  })

  it('folds an unbound child transcript into counters only', () => {
    const parser = createGrokParser()
    for (const item of twoStepFixture()) parser.push(item, MAIN)
    for (const item of [
      acp({
        sessionUpdate: 'tool_call',
        toolCallId: 'child-call-1',
        title: 'Read `/work/project/a.ts`',
        ...READ_FILE_IDENTITY,
      }, 800),
      acp({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'child-call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'export const a = 1' } }],
      }, 850),
      prompt(900, 'child prompt', 0),
    ]) parser.push(item, CHILD)
    expect(parser.subagents()).toEqual([{
      agentId: CHILD_ID,
      fileId: CHILD_ID,
      callId: null,
      description: null,
      agentType: null,
      model: null,
      status: 'running',
      startedAt: at(800),
      endedAt: null,
      lastTime: at(900),
      toolCalls: 1,
    }])
    // Unbound child records never reach the parent ledger.
    expect(toolResults(parser).map(result => result.callId)).toEqual(['call-1'])
    expect(parser.meta().promptCount).toBe(1)
  })

  it('exposes the open step as partial output until a tool call ends it', () => {
    const lines = twoStepFixture()
    const parser = feed(lines.slice(0, 4))
    const snapshot = parser.snapshot()
    expect(snapshot.partial).toEqual({
      turn: 1,
      step: 1,
      blocks: [{ kind: 'reasoning', text: 'Open the file first. Then answer.' }],
    })
    // The snapshot object is stable until another line arrives.
    expect(parser.snapshot()).toBe(snapshot)
    expect(assistants(parser)).toHaveLength(0)
    parser.push(lines[4] ?? '', MAIN)
    expect(parser.snapshot()).not.toBe(snapshot)
    // A tool call ends the model's step; the call stays running.
    expect(parser.snapshot().partial).toBeNull()
    expect(assistants(parser)).toHaveLength(1)
    expect(parser.snapshot().runningCalls.map(call => call.callId)).toEqual(['call-1'])
  })
})

describe('grokMessageClass', () => {
  it('returns null for anything that is not a user_message_chunk', () => {
    expect(grokMessageClass(undefined)).toBeNull()
    expect(grokMessageClass({ sessionUpdate: 'agent_message_chunk' })).toBeNull()
    expect(grokMessageClass({ content: { type: 'text', text: 'hi' } })).toBeNull()
  })

  it('reads the structural flags, never the text', () => {
    const chunk = (content: Record<string, unknown>, meta?: Record<string, unknown>) => ({
      sessionUpdate: 'user_message_chunk',
      content,
      ...(meta === undefined ? {} : { _meta: meta }),
    })
    expect(grokMessageClass(chunk({ type: 'text', text: 'hello' }, { modelId: 'grok-4.6', promptIndex: 1 })))
      .toEqual({ kind: 'human', slash: false, interjection: false })
    expect(grokMessageClass(chunk(
      { type: 'text', text: '/statusline', _meta: { displayText: '/statusline', displayAsSkill: true } },
      { modelId: 'grok-4.6', promptIndex: 0 },
    ))).toEqual({ kind: 'human', slash: true, interjection: false })
    expect(grokMessageClass(chunk({ type: 'text', text: 'steer', _meta: { interjection: true } })))
      .toEqual({ kind: 'human', slash: false, interjection: true })
    expect(grokMessageClass(chunk(
      { type: 'text', text: 'host', _meta: { hostTurn: true } },
      { promptIndex: 2 },
    ))).toEqual({ kind: 'injection', name: 'hostTurn' })
    // The env preamble: no promptIndex and no flags.
    expect(grokMessageClass(chunk({ type: 'text', text: '<user_info>…</user_info>' })))
      .toEqual({ kind: 'injection', name: 'preamble' })
    // Anything but a literal `true` reads as false.
    expect(grokMessageClass(chunk({ type: 'text', text: 'x', _meta: { hostTurn: 'yes' } }, { promptIndex: 3 })))
      .toEqual({ kind: 'human', slash: false, interjection: false })
  })
})

describe('parseGrokLine', () => {
  it('reads the current envelope with millisecond precision', () => {
    const record = parseGrokLine(thought(1_500, 'thinking', { streamStartMs: at(1_000) }))
    expect(record).toMatchObject({
      method: 'session/update',
      time: at(1_500),
      sessionId: SESSION_ID,
      sessionUpdate: 'agent_thought_chunk',
      promptId: PROMPT_ID,
      streamStartMs: at(1_000),
      sidecar: null,
    })
  })

  it('falls back to the second-granularity envelope stamp', () => {
    const line = JSON.stringify({
      timestamp: 1_789_310_671,
      method: '_x.ai/session/update',
      params: { sessionId: SESSION_ID, update: { sessionUpdate: 'turn_completed', prompt_id: PROMPT_ID } },
    })
    expect(parseGrokLine(line)?.time).toBe(1_789_310_671_000)
  })

  it('reads a legacy line with no method as an ACP notification', () => {
    const record = parseGrokLine(JSON.stringify({
      sessionId: 's',
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
    }))
    expect(record).toMatchObject({ method: 'session/update', sessionId: 's', time: null })
    expect(record?.sessionUpdate).toBe('user_message_chunk')
  })

  it('reads the sidecar payload', () => {
    const record = parseGrokLine(sidecar(0))
    expect(record?.method).toBe(GROK_SIDECAR_METHOD)
    expect(record?.sidecar?.systemPrompt).toBe('You are Grok Build.')
    expect(record?.sidecar?.toolDefinitions).toHaveLength(1)
    expect(record?.sidecar?.summary?.['current_model_id']).toBe('grok-4.6')
  })

  it('never throws on a malformed line', () => {
    expect(parseGrokLine('')).toBeNull()
    expect(parseGrokLine('{')).toBeNull()
    expect(parseGrokLine('[1,2,3]')).toBeNull()
    expect(parseGrokLine(JSON.stringify({ method: 'session/update' }))).toBeNull()
  })
})

describe('grok helpers', () => {
  it('knows the task tool under all three spellings', () => {
    expect(['task', 'Task', 'spawn_subagent'].every(isGrokTaskTool)).toBe(true)
    expect(isGrokTaskTool('read_file')).toBe(false)
  })

  it('resolves the context window, stripping the billing -build suffix', () => {
    // Every catalog model answers with its own table entry, whatever it says.
    expect(Object.entries(GROK_CONTEXT_WINDOWS).map(([model]) => grokContextWindow(model)))
      .toEqual(Object.values(GROK_CONTEXT_WINDOWS))
    // The billing id is not in the table: only the `-build` strip can resolve it,
    // and it has to land on the display id's entry rather than on the default.
    expect(GROK_CONTEXT_WINDOWS['grok-4.6-build']).toBeUndefined()
    expect(grokContextWindow('grok-4.6-build')).toBe(GROK_CONTEXT_WINDOWS['grok-4.6'])
    // An unknown model and a missing one both fall back to the documented default.
    expect(grokContextWindow('grok-9')).toBe(GROK_DEFAULT_CONTEXT_WINDOW)
    expect(grokContextWindow('')).toBe(GROK_DEFAULT_CONTEXT_WINDOW)
    expect(grokContextWindow(undefined)).toBe(GROK_DEFAULT_CONTEXT_WINDOW)
  })
})
