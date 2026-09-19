import { describe, expect, it } from 'vitest'
import { GROK_SIDECAR_METHOD } from '@harness-trajectory/core'
import { MAX_DOC_CHARS, extractSearchDocs, type SearchDocDraft } from '../src/search/extract.ts'

const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function docs(kind: 'claude' | 'codex' | 'kimi' | 'grok' | 'devin' | 'pi' | 'opencode' | 'dsh', record: unknown): SearchDocDraft[] {
  return extractSearchDocs(kind, JSON.stringify(record))
}

/** `role: text` pairs, so a spec reads as what ends up searchable. */
function pairs(drafts: readonly SearchDocDraft[]): string[] {
  return drafts.map(draft => `${draft.role}: ${draft.text}`)
}

it('indexes both durable Codex reasoning content types without repeating the summary', () => {
  expect(pairs(docs('codex', { type: 'response_item', payload: {
    type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }],
    content: [
      { type: 'reasoning_text', text: 'summary' },
      { type: 'text', text: 'final thought' },
    ],
  } }))).toEqual(['other: summary\n\nfinal thought'])
})

it('indexes durable Codex speech without indexing promoted item mirrors or standalone tool outputs', () => {
  for (const role of ['user', 'assistant']) {
    expect(docs('codex', {
      type: 'realtime_item', timestamp: iso(0),
      payload: { id: role, realtime_session_id: 'voice', type: 'transcript_segment', role, text: 'spoken text' },
    })).toEqual([{ role: role === 'user' ? 'human' : 'assistant', text: 'spoken text', timeMs: T0 }])
  }
  expect(docs('codex', {
    type: 'realtime_item', payload: { type: 'bem_item_promoted', item_id: 'existing', presentation: { type: 'whole_item' } },
  })).toEqual([])
  expect(docs('codex', {
    type: 'response_item', payload: { type: 'function_call_output', id: 'external', name: 'external', output: 'tool output' },
  })).toEqual([])
})

describe('extractSearchDocs — Claude Code', () => {
  it('indexes a human prompt, assistant text, thinking, and a tool call', () => {
    expect(docs('claude', {
      type: 'user', uuid: 'u-1', parentUuid: null, isSidechain: false, sessionId: 's1',
      cwd: '/work', timestamp: iso(0), userType: 'external',
      message: { role: 'user', content: 'Port the trajectory viewer' },
    })).toEqual([{ role: 'human', text: 'Port the trajectory viewer', timeMs: T0 }])

    expect(pairs(docs('claude', {
      type: 'assistant', uuid: 'a-1', sessionId: 's1', timestamp: iso(1000),
      message: {
        id: 'msg-1', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'The adapter already splits lines.', signature: 'sig' },
          { type: 'text', text: 'I will start with the server.' },
          {
            type: 'tool_use', id: 'toolu_1', name: 'Bash',
            input: { command: 'pnpm vitest run --project server', description: 'Run server tests', timeout: 120000 },
          },
        ],
      },
    }))).toEqual([
      'other: The adapter already splits lines.',
      'assistant: I will start with the server.',
      'tool: Bash\ncommand: pnpm vitest run --project server\ndescription: Run server tests',
    ])
  })

  it('skips tool results entirely: outputs are not indexed', () => {
    expect(docs('claude', {
      type: 'user', uuid: 'u-2', sessionId: 's1', timestamp: iso(2000),
      sourceToolAssistantUUID: 'a-1',
      message: {
        role: 'user',
        content: [{
          tool_use_id: 'toolu_1', type: 'tool_result', is_error: false,
          content: [{ type: 'text', text: 'Test Files  2 passed (2)' }],
        }],
      },
      toolUseResult: { stdout: 'Test Files  2 passed (2)', stderr: '', interrupted: false },
    })).toEqual([])

    // The string form of a tool_result is just as common — and just as skipped.
    expect(docs('claude', {
      type: 'user', uuid: 'u-3', sessionId: 's1', timestamp: iso(2100),
      message: { role: 'user', content: [{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'total 0\ndrwxr-xr-x' }] },
    })).toEqual([])
  })

  it('skips injected, meta, compaction, and non-conversation records', () => {
    const skipped: unknown[] = [
      { type: 'user', timestamp: iso(0), isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' } },
      { type: 'user', timestamp: iso(0), message: { role: 'user', content: '<system-reminder>Today is …</system-reminder>' } },
      { type: 'user', timestamp: iso(0), origin: { kind: 'task-notification' }, message: { role: 'user', content: 'agent finished' } },
      { type: 'user', timestamp: iso(0), isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation…' } },
      { type: 'ai-title', aiTitle: 'Trajectory feature port', sessionId: 's1' },
      { type: 'last-prompt', lastPrompt: 'Port the trajectory viewer', leafUuid: 'u-1', sessionId: 's1' },
      { type: 'system', subtype: 'compact_boundary', timestamp: iso(0), compactMetadata: { trigger: 'manual', preTokens: 9 } },
      { type: 'attachment', timestamp: iso(0), attachment: { type: 'environment', text: 'cwd: /work' }, rendered: 'cwd: /work' },
      // An image-only assistant block carries no text at all.
      { type: 'assistant', timestamp: iso(0), message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'x'.repeat(4000) } }] } },
    ]
    for (const record of skipped) expect(docs('claude', record)).toEqual([])
  })

  it('files a subagent task prompt outside the human bucket the prompt count uses', () => {
    expect(pairs(docs('claude', {
      type: 'user', uuid: 'u-1', parentUuid: null, isSidechain: true, agentId: 'a54851cd',
      sessionId: 's1', timestamp: iso(0), message: { role: 'user', content: 'Find every call site' },
    }))).toEqual(['other: Find every call site'])
  })

  it('never throws on a malformed or unknown record', () => {
    for (const line of ['', '{ not json', 'null', '[]', '{"type":"user"}', '{"type":"user","message":3}']) {
      expect(extractSearchDocs('claude', line)).toEqual([])
    }
  })
})

describe('extractSearchDocs — Codex', () => {
  const item = (payload: Record<string, unknown>, offset = 0) =>
    ({ timestamp: iso(offset), ordinal: 1, type: 'response_item', payload })

  it('indexes a human prompt but not the injected context that shares the user role', () => {
    expect(docs('codex', item({
      type: 'message', id: 'msg-1', role: 'user',
      content: [{ type: 'input_text', text: 'Refactor the parser' }],
    }))).toEqual([{ role: 'human', text: 'Refactor the parser', timeMs: T0 }])

    for (const text of [
      '<environment_context>cwd</environment_context>',
      '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>',
      '>>> TRANSCRIPT START',
      // Annotated injected fragment — `content_item_kinds` decides, not text.
    ]) {
      expect(docs('codex', item({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }))).toEqual([])
    }
    // Text that only resembles an injection stays searchable human input.
    for (const text of ['Here is a list of skills', '<question>what now?</question>']) {
      expect(docs('codex', item({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })))
        .toEqual([{ role: 'human', text, timeMs: T0 }])
    }
    // A `content_item_kinds` annotation classifies even unmarked text.
    expect(docs('codex', item({
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'unmarked injected context' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['guardian.followup_review_reminder'] },
    }))).toEqual([])
    // `developer` is always instruction injection.
    expect(docs('codex', item({
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Always run the tests.' }],
    }))).toEqual([])
  })

  it('indexes assistant output and reasoning summaries but not the encrypted blob', () => {
    expect(pairs(docs('codex', item({
      type: 'message', id: 'msg-2', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'I will compare the two crates first.' }],
    })))).toEqual(['assistant: I will compare the two crates first.'])

    expect(pairs(docs('codex', item({
      type: 'reasoning', id: 'rs-1',
      summary: [{ type: 'summary_text', text: 'Checking the MASQUE config model' }],
      encrypted_content: 'gAAAAAB'.repeat(200),
    })))).toEqual(['other: Checking the MASQUE config model'])
    expect(docs('codex', item({ type: 'reasoning', summary: [], encrypted_content: 'gAAAAAB'.repeat(200) }))).toEqual([])
  })

  it('indexes both tool-call spellings and skips both output spellings', () => {
    // `custom_tool_call.input` is raw JavaScript, not JSON.
    expect(pairs(docs('codex', item({
      type: 'custom_tool_call', id: 'ctc-1', status: 'completed', call_id: 'call_1', name: 'exec',
      input: 'const r = await tools.exec_command({cmd:"pnpm typecheck"});',
    })))).toEqual(['tool: exec\nconst r = await tools.exec_command({cmd:"pnpm typecheck"});'])

    // `function_call.arguments` is a JSON-encoded string.
    expect(pairs(docs('codex', item({
      type: 'function_call', id: 'fc-1', name: 'js', call_id: 'call_2',
      arguments: JSON.stringify({ cmd: 'rg --files packages/core', cell_id: '53' }),
    })))).toEqual(['tool: js\ncmd: rg --files packages/core'])

    expect(docs('codex', item({
      type: 'custom_tool_call_output', id: 'ctco-1', call_id: 'call_1',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds' },
        { type: 'input_text', text: '/Users/me/project' },
      ],
    }))).toEqual([])

    expect(docs('codex', item({
      type: 'function_call_output', call_id: 'call_2',
      output: JSON.stringify({ output: 'exit 0', metadata: { exit_code: 0 } }),
    }))).toEqual([])
  })

  it('indexes the durable web/image/tool-search calls as tools', () => {
    expect(pairs(docs('codex', item({
      type: 'web_search_call', id: 'ws-1', status: 'completed',
      action: { type: 'search', query: 'codex rollout format' },
    })))).toEqual(['tool: web_search\nquery: codex rollout format'])

    expect(pairs(docs('codex', item({
      type: 'image_generation_call', id: 'ig-1', revised_prompt: 'a gray tabby', result: 'aW1hZ2U=',
    })))).toEqual(['tool: image_generation\nprompt: a gray tabby'])

    expect(pairs(docs('codex', item({
      type: 'tool_search_call', call_id: 'call-ts', execution: 'client',
      arguments: { query: 'file tools' },
    })))).toEqual(['tool: tool_search\nquery: file tools'])

    // Discovery results follow the same exclusion policy as other tool outputs.
    expect(pairs(docs('codex', item({
      type: 'tool_search_output', call_id: 'call-ts', status: 'completed', execution: 'client',
      tools: [{ type: 'function', name: 'read_file' }, { type: 'function', name: 'write_file' }],
    })))).toEqual([])
  })

  it('indexes agent traffic, retained answers, and the thread goal as other', () => {
    expect(pairs(docs('codex', item({
      type: 'agent_message', id: 'am-1', author: '/child/explorer', recipient: '/root',
      content: [{ type: 'input_text', text: 'found it in src/x.ts' }],
    })))).toEqual(['other: /child/explorer → /root\nfound it in src/x.ts'])

    expect(pairs(docs('codex', {
      timestamp: iso(0), type: 'inter_agent_communication',
      payload: { author: '/root', recipient: '/child/explorer', content: 'now check tests', trigger_turn: false },
    }))).toEqual(['other: /root → /child/explorer\nnow check tests'])

    expect(pairs(docs('codex', {
      timestamp: iso(0), type: 'retained_context',
      payload: {
        type: 'verified_answer', turn_id: 'turn-1', call_id: 'call-q',
        questions: [{ question: 'which db?', answer: 'sqlite' }],
      },
    }))).toEqual(['other: which db?\nsqlite'])

    expect(pairs(docs('codex', {
      timestamp: iso(0), type: 'event_msg',
      payload: {
        type: 'thread_goal_updated', threadId: 'thread-1',
        goal: { threadId: 'thread-1', objective: 'build it in one hour', status: 'active' },
      },
    }))).toEqual(['other: build it in one hour'])
    // Other event_msg records mirror response items — never indexed twice.
    expect(docs('codex', {
      timestamp: iso(0), type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt' } },
    })).toEqual([])
    // Encrypted compaction replays carry no readable text.
    expect(docs('codex', item({ type: 'compaction', encrypted_content: 'gAAAA' }))).toEqual([])
    expect(docs('codex', item({ type: 'context_compaction', encrypted_content: 'gAAAA' }))).toEqual([])
  })

  it('skips the mirrored event stream, session metadata, and data-URL images', () => {
    expect(docs('codex', { timestamp: iso(0), type: 'event_msg', payload: { type: 'agent_message', message: 'mirror' } })).toEqual([])
    expect(docs('codex', { timestamp: iso(0), type: 'session_meta', payload: { id: 't1', cwd: '/w', base_instructions: { text: 'You are Codex.' } } })).toEqual([])
    expect(docs('codex', { timestamp: iso(0), type: 'token_usage_record', payload: { total: 1 } })).toEqual([])
    expect(docs('codex', item({
      type: 'message', role: 'user',
      content: [{ type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${'A'.repeat(4000)}` }],
    }))).toEqual([])
    expect(extractSearchDocs('codex', '{ not json')).toEqual([])
  })
})

describe('extractSearchDocs — Kimi Code', () => {
  const wire = (type: string, offset: number, payload: Record<string, unknown> = {}) =>
    ({ type, time: T0 + offset, agentId: 'main', ...payload })

  it('counts only origin-user messages as human, exactly as the meta scanner does', () => {
    expect(docs('kimi', wire('context.append_message', 10, {
      message: { role: 'user', content: [{ type: 'text', text: 'Add search to the server' }], origin: { kind: 'user' } },
    }))).toEqual([{ role: 'human', text: 'Add search to the server', timeMs: T0 + 10 }])

    const injected = [
      { kind: 'injection', variant: 'todo_list_reminder' },
      { kind: 'injection', variant: 'date_change', disclosure: { kind: 'date' } },
      { kind: 'task', taskId: 't1', status: 'completed' },
      { kind: 'skill_activation', skillName: 'design' },
      { kind: 'plugin_command' },
      { kind: 'compaction_summary' },
    ]
    for (const origin of injected) {
      expect(docs('kimi', wire('context.append_message', 20, {
        message: { role: 'user', content: [{ type: 'text', text: 'injected text' }], toolCalls: [], origin },
      }))).toEqual([])
    }
  })

  it('indexes loop events: text, thinking, and a tool call — but not its result', () => {
    const loop = (event: Record<string, unknown>, offset: number) =>
      wire('context.append_loop_event', offset, { event })

    expect(pairs(docs('kimi', loop({
      type: 'content.part', uuid: 'c-1', turnId: '0', step: 2, part: { type: 'text', text: 'Reading the adapter next.' },
    }, 30)))).toEqual(['assistant: Reading the adapter next.'])

    expect(pairs(docs('kimi', loop({
      type: 'content.part', uuid: 'c-2', turnId: '0', step: 2, part: { type: 'think', think: 'The wire format inlines the payload.' },
    }, 31)))).toEqual(['other: The wire format inlines the payload.'])

    // Kimi spells the path argument `path`, not `file_path`.
    expect(pairs(docs('kimi', loop({
      type: 'tool.call', uuid: 't-1', turnId: '0', step: 1, toolCallId: 'tool_k1', name: 'Grep',
      args: { pattern: 'createMetaScanner', path: 'apps/server/src', output_mode: 'content' },
    }, 32)))).toEqual(['tool: Grep\npattern: createMetaScanner\npath: apps/server/src\noutput_mode: content'])

    expect(docs('kimi', loop({
      type: 'tool.result', parentUuid: 't-1', toolCallId: 'tool_k1',
      result: { output: 'apps/server/src/meta.ts:45', note: 'truncated to 1 match' },
    }, 33))).toEqual([])
  })

  it('indexes a delegated subagent prompt as a human document, stripped of its git prelude', () => {
    const delegated = '<git-context>\nWorking directory: /work/project\n</git-context>\n\nReview the diff carefully.'
    expect(docs('kimi', wire('context.append_message', 10, {
      message: {
        role: 'user', content: [{ type: 'text', text: delegated }], toolCalls: [],
        origin: { kind: 'system_trigger', name: 'subagent' },
      },
    }))).toEqual([{ role: 'human', text: 'Review the diff carefully.', timeMs: T0 + 10 }])
    // Every other system trigger stays harness chatter.
    expect(docs('kimi', wire('context.append_message', 20, {
      message: {
        role: 'user', content: [{ type: 'text', text: 'hook text' }], toolCalls: [],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      },
    }))).toEqual([])
  })

  it('skips a media tool result along with every other output', () => {
    expect(docs('kimi', wire('context.append_loop_event', 30, {
      event: {
        type: 'tool.result', parentUuid: 't-1', toolCallId: 'tool_k1',
        result: {
          output: [
            { type: 'text', text: '<image path="/tmp/shot.png">' },
            { type: 'image_url', imageUrl: { url: `blobref:image/png;${'a'.repeat(64)}` } },
          ],
        },
      },
    }))).toEqual([])
  })

  it('skips bookkeeping records and the prompt mirror that would double-count', () => {
    expect(docs('kimi', wire('llm.request', 1, { model: 'k3', provider: 'openai', maxTokens: 1048576 }))).toEqual([])
    expect(docs('kimi', wire('usage.record', 2, { tokens: 10, kind: 'input' }))).toEqual([])
    // `turn.prompt` repeats the human prompt `context.append_message` already carried.
    expect(docs('kimi', wire('turn.prompt', 3, { input: [{ type: 'text', text: 'Add search to the server' }] }))).toEqual([])
    expect(docs('kimi', { type: 'metadata', created_at: T0, protocol_version: '1.5' })).toEqual([])
    expect(extractSearchDocs('kimi', 'null')).toEqual([])
  })
})

describe('extractSearchDocs — Grok Build', () => {
  const SESSION = '01a09b39-a469-7073-b766-83847750b352'
  /** Envelope `timestamp` is epoch SECONDS; `_meta.agentTimestampMs` is milliseconds. */
  const envelope = (update: Record<string, unknown>, offset: number, meta: Record<string, unknown> = {}, method = 'session/update') => ({
    timestamp: Math.floor((T0 + offset) / 1000),
    method,
    params: { sessionId: SESSION, update, _meta: { eventId: `${SESSION}-${offset}`, agentTimestampMs: T0 + offset, ...meta } },
  })

  it('indexes a human chunk but not the preamble or a host relay', () => {
    expect(docs('grok', envelope({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Add full-text search' },
      _meta: { modelId: 'grok-4.6', promptIndex: 1 },
    }, 10))).toEqual([{ role: 'human', text: 'Add full-text search', timeMs: T0 + 10 }])

    // A slash command records what was typed as `displayText`.
    expect(pairs(docs('grok', envelope({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Show the status line config', _meta: { displayText: '/statusline', displayAsSkill: true } },
      _meta: { promptIndex: 2 },
    }, 11)))).toEqual(['human: /statusline'])

    // No `promptIndex`: the environment preamble that opens every session.
    expect(docs('grok', envelope({
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<environment>cwd</environment>' },
    }, 0))).toEqual([])
    expect(docs('grok', envelope({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'relayed', _meta: { hostTurn: true } },
      _meta: { promptIndex: 3 },
    }, 12))).toEqual([])
  })

  it('indexes assistant chunks, thoughts, and a tool call — but not the result', () => {
    expect(pairs(docs('grok', envelope({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll check the config first." },
    }, 20, { promptId: 'p-1', totalTokens: 2601 })))).toEqual(["assistant: I'll check the config first."])

    expect(pairs(docs('grok', envelope({
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The summary sidecar holds the cwd.' },
    }, 21)))).toEqual(['other: The summary sidecar holds the cwd.'])

    // The canonical name rides `_meta['x.ai/tool']`; arguments ride `rawInput`.
    expect(pairs(docs('grok', envelope({
      sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read_file',
      rawInput: { target_file: '/Users/me/.grok/config.toml', limit: 200 },
      _meta: { 'x.ai/tool': { version: 1, name: 'read_file', kind: 'read', label: 'Read', read_only: true } },
    }, 22)))).toEqual(['tool: read_file\ntarget_file: /Users/me/.grok/config.toml'])

    // A completed `tool_call_update` is stdout: not indexed, whatever its shape.
    expect(docs('grok', envelope({
      sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'GROK_HOME=unset' } }],
      rawOutput: { type: 'Bash', output: [71, 82, 79, 75], exit_code: 0 },
    }, 23))).toEqual([])
    expect(docs('grok', envelope({
      sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'completed',
      content: [{ type: 'diff', path: '/work/README.md', oldText: 'old', newText: 'new line' }],
    }, 24))).toEqual([])
  })

  it('skips progress updates, telemetry, and the server’s own sidecar line', () => {
    // No terminal status: a progress merge, not a result.
    expect(docs('grok', envelope({
      sessionUpdate: 'tool_call_update', toolCallId: 'call-1', kind: 'read', title: 'read_file',
      content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
    }, 30))).toEqual([])
    expect(docs('grok', envelope({
      sessionUpdate: 'hook_execution', event_name: 'pre_tool', runs: [{ name: 'fmt', status: { status: 'ok' } }],
    }, 31, {}, '_x.ai/session/update'))).toEqual([])
    expect(docs('grok', envelope({
      sessionUpdate: 'turn_completed', prompt_id: 'p-1', usage: { inputTokens: 1, outputTokens: 2 },
    }, 32, {}, '_x.ai/session/update'))).toEqual([])
    expect(docs('grok', {
      timestamp: Math.floor(T0 / 1000),
      method: GROK_SIDECAR_METHOD,
      params: { sessionId: SESSION, summary: { session_summary: 'Grok status line' }, systemPrompt: 'You are Grok.', toolDefinitions: [] },
    })).toEqual([])
    for (const line of ['', '{ not json', 'null', '[]']) expect(extractSearchDocs('grok', line)).toEqual([])
  })
})

describe('extractSearchDocs — Devin CLI', () => {
  // Devin records are the server's virtual lines: `{t:'devin.msg', msg}` wraps
  // a raw chat_message; sidecars (`devin.session`, `devin.tool`) never index.
  const devinMsg = (msg: Record<string, unknown>): unknown =>
    ({ t: 'devin.msg', node: 1, parent: null, time: T0, msg })

  it('indexes human prompts, assistant text/thinking/calls, but not tool results', () => {
    expect(pairs(docs('devin', devinMsg({
      role: 'user', content: [{ type: 'text', text: 'Update the roadmap' }],
      metadata: { is_user_input: true },
    })))).toEqual(['human: Update the roadmap'])

    expect(pairs(docs('devin', devinMsg({
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading the file.' }],
      thinking: { thinking: 'Plan first.' },
      tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
    })))).toEqual([
      'assistant: Reading the file.',
      'other: Plan first.',
      'tool: read_file\npath: a.ts',
    ])

    expect(docs('devin', devinMsg({
      role: 'tool', tool_call_id: 'c1',
      content: [{ type: 'text', text: 'contents of a.ts' }],
    }))).toEqual([])
  })

  it('counts only is_user_input as human — injected user text indexes nowhere', () => {
    for (const msg of [
      { role: 'user', content: 'system_guidance: continue', metadata: {} },
      { role: 'user', content: '<system-reminder>x</system-reminder>', metadata: { is_user_input: false } },
    ]) {
      expect(docs('devin', devinMsg(msg)), JSON.stringify(msg)).toEqual([])
    }
  })

  it('skips synthetic sidecars, system segments, and malformed lines', () => {
    expect(docs('devin', { t: 'devin.session', title: 'work', agents: [] })).toEqual([])
    expect(docs('devin', { t: 'devin.tool', id: 'c1', call: { title: 'shell' } })).toEqual([])
    expect(docs('devin', devinMsg({ role: 'system', content: 'You are Devin.' }))).toEqual([])
    for (const line of ['', '{ nope', 'null', '{"t":"devin.msg"}']) {
      expect(extractSearchDocs('devin', line)).toEqual([])
    }
  })
})

describe('extractSearchDocs — pi', () => {
  const entry = (offset: number, id: string, type: string, rest: Record<string, unknown> = {}): unknown =>
    ({ type, id, parentId: null, timestamp: iso(offset), ...rest })

  const message = (offset: number, id: string, message: Record<string, unknown>): unknown =>
    entry(offset, id, 'message', { message: { timestamp: T0 + offset, ...message } })

  it('indexes a human prompt, assistant text/thinking, and a tool call', () => {
    expect(docs('pi', message(0, 'e1', {
      role: 'user', content: [{ type: 'text', text: 'Wire up the pi adapter' }],
    }))).toEqual([{ role: 'human', text: 'Wire up the pi adapter', timeMs: T0 }])

    expect(pairs(docs('pi', message(1000, 'e2', {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Plan the work first.' },
        { type: 'text', text: 'Starting with the parser.' },
        { type: 'toolCall', id: 'c1', name: 'edit', arguments: { path: 'a.ts', oldText: 'x', newText: 'y' } },
      ],
    })))).toEqual([
      'other: Plan the work first.',
      'assistant: Starting with the parser.',
      'tool: edit\npath: a.ts\noldText: x\nnewText: y',
    ])
  })

  it('indexes a bashExecution command but never its output', () => {
    expect(pairs(docs('pi', message(2000, 'e3', {
      role: 'bashExecution', command: 'pnpm test', output: 'very long output', exitCode: 0,
    })))).toEqual(['tool: bash\ncommand: pnpm test'])
  })

  it('indexes custom_message and custom-role content as other, skipping toolResult and bookkeeping', () => {
    expect(docs('pi', entry(3000, 'e4', 'custom_message', { customType: 'hook', content: 'injected note' })))
      .toEqual([{ role: 'other', text: 'injected note', timeMs: T0 + 3000 }])
    expect(docs('pi', message(3001, 'e5', { role: 'custom', customType: 'hook', content: 'hook text' })))
      .toEqual([{ role: 'other', text: 'hook text', timeMs: T0 + 3001 }])
    expect(docs('pi', message(4000, 'e6', {
      role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'result body' }],
    }))).toEqual([])
    for (const record of [
      entry(5000, 'e7', 'compaction', { summary: 'summary', firstKeptEntryId: 'e1' }),
      entry(5001, 'e8', 'branch_summary', { fromId: 'e1', summary: 'branch' }),
      entry(5002, 'e9', 'session_info', { name: 'title' }),
      entry(5003, 'ea', 'custom', { customType: 'shadow-mind-event', data: {} }),
      entry(5004, 'eb', 'label', { targetId: 'e1', label: 'note' }),
      entry(5005, 'ec', 'model_change', { provider: 'openai', modelId: 'm' }),
      message(5006, 'ed', { role: 'system', content: 'system prompt' }),
      { type: 'session', version: 3, id: 's', timestamp: iso(5007), cwd: '/work' },
    ]) {
      expect(docs('pi', record), JSON.stringify(record)).toEqual([])
    }
  })
})

describe('extractSearchDocs — OpenCode', () => {
  const userHeader = (offset: number, parts: Record<string, unknown>[], msg: Record<string, unknown> = {}): unknown => ({
    t: 'opencode.message', time: T0 + offset, id: 'msg_u',
    msg: { role: 'user', time: { created: T0 + offset }, ...msg },
    parts: parts.map((part, index) => ({ id: `prt_${index}`, ...part })),
  })

  const partLine = (offset: number, part: Record<string, unknown>): unknown => ({
    t: 'opencode.part', time: T0 + offset, id: 'prt_1', messageID: 'msg_a', part,
  })

  it('indexes a human prompt — synthetic parts inside it stay out', () => {
    expect(pairs(docs('opencode', userHeader(0, [
      { type: 'text', text: 'Wire up the OpenCode adapter' },
      { type: 'text', text: 'appended reminder', synthetic: true },
    ])))).toEqual(['human: Wire up the OpenCode adapter'])
  })

  it('never indexes injected or compaction user messages', () => {
    expect(docs('opencode', userHeader(100, [
      { type: 'text', text: 'system reminder', synthetic: true },
    ], { metadata: { compaction_continue: true } }))).toEqual([])
    expect(docs('opencode', userHeader(200, [
      { type: 'compaction', auto: true, tail_start_id: 'msg_x' },
    ]))).toEqual([])
  })

  it('indexes assistant text, reasoning as other, and tool calls — never outputs', () => {
    expect(docs('opencode', partLine(300, {
      type: 'text', text: 'Starting with the parser.', time: { start: T0, end: T0 + 1 },
    }))).toEqual([{ role: 'assistant', text: 'Starting with the parser.', timeMs: T0 + 300 }])
    expect(docs('opencode', partLine(400, {
      type: 'reasoning', text: 'Plan the work first.', time: { start: T0, end: T0 + 1 },
    }))).toEqual([{ role: 'other', text: 'Plan the work first.', timeMs: T0 + 400 }])
    expect(pairs(docs('opencode', partLine(500, {
      type: 'tool', callID: 'c1', tool: 'edit',
      state: {
        status: 'completed',
        input: { filePath: 'a.ts', oldString: 'x', newString: 'y' },
        output: 'edited ok — this output must not index',
        time: { start: T0, end: T0 + 5 },
      },
    })))).toEqual(['tool: edit\nfilePath: a.ts\noldString: x\nnewString: y'])
  })

  it('never indexes sidecars, finishes, or bookkeeping parts', () => {
    for (const record of [
      { t: 'opencode.session', time: T0, session: { id: 's', title: 't', directory: '/w' }, children: [] },
      { t: 'opencode.finish', time: T0 + 600, id: 'msg_a', msg: { role: 'assistant', modelID: 'm' } },
      { t: 'opencode.prune', time: T0 + 700, id: 'prt_1', messageID: 'msg_a', callID: 'c1' },
      partLine(800, { type: 'step-finish', reason: 'stop' }),
      partLine(900, { type: 'file', mime: 'text/plain', url: 'file:///f' }),
      '{ not json',
      'null',
    ]) {
      expect(docs('opencode', record), JSON.stringify(record)).toEqual([])
    }
  })
})

describe('extractSearchDocs — shared rules', () => {
  it('caps a document at 16 KB', () => {
    const long = 'the quick brown fox jumps over the lazy dog. '.repeat(2_000)
    expect(long.length).toBeGreaterThan(MAX_DOC_CHARS * 2)
    const [doc] = docs('claude', {
      type: 'user', timestamp: iso(0), message: { role: 'user', content: long },
    })
    expect(doc?.text).toHaveLength(MAX_DOC_CHARS)
    expect(doc?.text).toBe(long.slice(0, MAX_DOC_CHARS))
  })

  it('caps a tool call at 16 KB', () => {
    // Spaced prose: a solid base64-alphabet run would be scrubbed as a payload.
    const long = 'chunk of output text. '.repeat(4_000)
    // A Write's whole `content` argument is the call: it keeps the prose cap.
    const [call] = docs('claude', {
      type: 'assistant', timestamp: iso(1),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/f.ts', content: long } }],
      },
    })
    expect(call?.text).toHaveLength(MAX_DOC_CHARS)
  })

  it('strips embedded base64 payloads and keeps the surrounding prose', () => {
    const base64 = `${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph'.repeat(20)}==`
    // A Write call whose content is only a payload keeps no trace of it.
    const [payloadOnly] = docs('claude', {
      type: 'assistant', timestamp: iso(0),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/f.png.ts', content: base64 } }],
      },
    })
    expect(payloadOnly?.text).not.toContain('QUJDREVGR0hJ')
    const [mixed] = docs('claude', {
      type: 'assistant', timestamp: iso(1),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: '/f.ts', content: `tests passed\n${base64}\nexit 0` } }],
      },
    })
    expect(mixed?.text).toContain('tests passed')
    expect(mixed?.text).toContain('exit 0')
    expect(mixed?.text).not.toContain('QUJDREVGR0hJ')
    // A data URL in prose is eaten by the prefix rule and the payload run.
    const [prose] = docs('claude', {
      type: 'user', timestamp: iso(2),
      message: { role: 'user', content: `look at this image\ndata:image/png;base64,${base64}\nwhat is it?` },
    })
    expect(prose?.text).toContain('what is it?')
    expect(prose?.text).not.toContain('QUJDREVGR0hJ')
  })

  it('never lets a control character reach the index, so the snippet markers stay unambiguous', () => {
    const [doc] = docs('claude', {
      type: 'user', timestamp: iso(0),
      message: { role: 'user', content: `before${'\u0002'}marked${'\u0003'}after${'\u001f'}end` },
    })
    expect(doc?.text).toBe('before marked after end')
  })
})

describe('extractSearchDocs — DeepSeek Harness', () => {
  const event = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ type, seq: 1, time: T0, data, ...extra })

  it('indexes human prompts, committed assistant blocks, tool calls, and command runs', () => {
    expect(docs('dsh', event('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Port the viewer to dsh' }],
    }))).toEqual([{ role: 'human', text: 'Port the viewer to dsh', timeMs: T0 }])

    expect(pairs(docs('dsh', event('assistant/message', {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'planning' },
          { type: 'text', text: 'the answer' },
          { type: 'tool-call', id: 'call-1', name: 'Read', arguments: '{}' },
        ],
      },
    })))).toEqual(['other: planning', 'assistant: the answer'])

    expect(pairs(docs('dsh', event('tool/call', {
      callId: 'call-1', name: 'Write', arguments: '{"file_path":"/f.ts","content":"code"}',
    })))).toEqual(['tool: Write\nfile_path: /f.ts\ncontent: code'])

    expect(pairs(docs('dsh', event('command/run', { name: 'compact', args: ' --keep 3' }))))
      .toEqual(['tool: compact --keep 3'])
  })

  it('never indexes injected context, compaction summaries, tool outputs, or stream mirrors', () => {
    // A non-`user` source kind is injected context.
    expect(docs('dsh', event('user/message', {
      source: { kind: 'context' }, content: [{ type: 'text', text: 'injected' }],
    }))).toEqual([])
    // A replace surfaceOp makes the message a compaction summary.
    expect(docs('dsh', {
      ...event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'summary' }] }),
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 6 },
    })).toEqual([])
    // Tool RESULTS are outputs: stdout lives in the trajectory view, not the index.
    expect(docs('dsh', event('tool/result', {
      message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'stdout' }] }] },
    }))).toEqual([])
    // Packed v0 stream rows are delta mirrors of the committed messages.
    expect(docs('dsh', { type: 'text-chunks', seq0: 1, time0: T0, data: { texts: ['delta'] } })).toEqual([])
    expect(docs('dsh', event('session/title', { title: 'name' }))).toEqual([])
    expect(extractSearchDocs('dsh', '{ not json')).toEqual([])
  })
})
