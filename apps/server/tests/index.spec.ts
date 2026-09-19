import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, utimes, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GROK_SIDECAR_METHOD, type SessionLiveEvent } from '@harness-trajectory/core'
import { SessionIndex, classifyPath, lineTime, lineTimes, mergeChronologically, scopeToFile } from '../src/index.ts'
import { zstdSupported } from '../src/tail.ts'
import { createMetaScanner, emptyMeta, listingScannerFor, mergeChildAgent, serializeMeta, hydrateMeta } from '../src/meta.ts'
import { defaultRoots } from '../src/roots.ts'
import { ListingCache } from '../src/listing-cache.ts'
import { SearchIndexer } from '../src/search/indexer.ts'
import { SearchStore, unpackText } from '../src/search/store.ts'
import { extractSearchDocs } from '../src/search/extract.ts'

function jsonl(records: readonly unknown[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

it('resumes Grok in the middle of a multi-block prompt and counts reused indices after rewind', () => {
  const first = createMetaScanner('grok')
  first.push(JSON.stringify(grokPrompt('first block', 0, 0)))
  const saved = serializeMeta(first)
  expect(saved).not.toBeNull()
  const resumed = createMetaScanner('grok')
  expect(hydrateMeta(resumed, saved ?? '')).toBe(true)
  resumed.push(JSON.stringify(grok({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'image', data: 'fake', mimeType: 'image/png' },
    _meta: { promptIndex: 0 },
  }, 1)))
  expect(resumed.state.promptCount).toBe(1)
  resumed.push(JSON.stringify(grok({ sessionUpdate: 'rewind_marker', target_prompt_index: 0 }, 2)))
  resumed.push(JSON.stringify(grokPrompt('replacement', 0, 3)))
  expect(resumed.state.promptCount).toBe(2)
})

function claudeUser(text: string, sessionId: string, offset: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'user', uuid: `u-${offset}`, parentUuid: null, isSidechain: false, sessionId,
    cwd: '/work/project', timestamp: iso(offset), message: { role: 'user', content: text },
    origin: { kind: 'human' }, ...extra,
  }
}

function claudeAssistant(text: string, sessionId: string, offset: number) {
  return {
    type: 'assistant', uuid: `a-${offset}`, sessionId, timestamp: iso(offset), requestId: `req-${offset}`,
    message: { id: `msg-${offset}`, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  }
}

function codexMeta(id: string, offset: number, parent?: string, extra: Record<string, unknown> = {}) {
  return {
    timestamp: iso(offset), type: 'session_meta',
    payload: { id, cwd: '/work/codex', model_provider: 'openai', thread_source: parent === undefined ? 'user' : 'subagent', ...(parent === undefined ? {} : { parent_thread_id: parent }), ...extra },
  }
}

function codexUser(text: string, offset: number) {
  return { timestamp: iso(offset), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
}

/** Kimi wire records: `{ type, time (epoch ms), agentId, ...payload }`. */
function kimi(type: string, offset: number, payload: Record<string, unknown> = {}, agentId = 'main') {
  return { type, time: T0 + offset, agentId, ...payload }
}

function kimiUser(text: string, offset: number, origin: unknown = { kind: 'user' }) {
  return kimi('context.append_message', offset, {
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin },
  })
}

function kimiMain(prompt: string): string {
  return jsonl([
    { type: 'metadata', created_at: T0, protocol_version: '1.5' },
    kimi('runtime.set_binding', 1, { runtimeId: 'rt-1', workspaceId: 'wd_project_abc123def456' }),
    kimi('profile.bind', 2, {
      profileName: 'agent', modelAlias: 'kimi-code/k3', thinkingEffort: 'medium',
      systemPrompt: 'You are Kimi.', activeToolNames: ['Read'], agentsMdPaths: [],
      environmentDisclosure: { cwd: '/work/kimi' }, subagents: [],
    }),
    kimiUser(prompt, 10),
    kimi('context.append_loop_event', 11, { event: { type: 'step.begin', turnId: '0', step: 1, uuid: 's-1' } }),
    kimi('llm.request', 12, {
      kind: 'loop', model: 'k3', modelAlias: 'kimi-code/k3', provider: 'openai',
      maxTokens: 1048576, messageCount: 2, turnStep: '0.1',
    }),
    kimiUser('Todo list reminder', 20, { kind: 'injection', variant: 'todo_list_reminder' }),
    kimi('turn.ended', 30, { durationMs: 30, reason: 'completed', turnId: 0 }),
  ])
}

const GROK_MAIN = '01a09b39-a469-7073-b766-83847750b352'
const GROK_CHILD = '01a09b3a-1111-7073-b766-838477500001'
const GROK_ORPHAN = '01a09b3b-2222-7073-b766-838477500002'

/**
 * Grok update envelopes (GROK-FORMAT §C.1): the envelope `timestamp` is epoch
 * SECONDS, the millisecond stamp lives in `params._meta.agentTimestampMs`.
 */
function grok(update: Record<string, unknown>, offset: number, sessionId = GROK_MAIN, meta: Record<string, unknown> = {}) {
  return {
    timestamp: Math.floor((T0 + offset) / 1000),
    method: 'session/update',
    params: {
      sessionId,
      update,
      _meta: { eventId: `${sessionId}-${offset}`, agentTimestampMs: T0 + offset, ...meta },
    },
  }
}

/** A genuine human chunk: `update._meta.promptIndex` is the flag that makes it one (§F.4). */
function grokPrompt(text: string, promptIndex: number, offset: number, sessionId = GROK_MAIN) {
  return grok({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text },
    _meta: { modelId: 'grok-4.6', promptIndex },
  }, offset, sessionId, { promptId: `prompt-${promptIndex}` })
}

const DSH_MAIN = 'session-main-0001'
const DSH_CHILD = 'session-child-0002'

/** One independently decodable, checksummed Zstandard frame — what the writer appends per flush. */
function dshFrame(body: string): Buffer {
  return zlib.zstdCompressSync(Buffer.from(body, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  })
}

function dshFrames(...bodies: string[]): Buffer {
  return Buffer.concat(bodies.map(dshFrame))
}

/** The `type:"session"` header line; `time` fields are epoch MILLISECONDS. */
function dshHeader(id: string, extra: Record<string, unknown> = {}) {
  return { type: 'session', version: 3, id, createdAt: T0, cwd: '/work/dsh', isSeeded: false, ...extra }
}

function dshEvent(type: string, seq: number, offset: number, data: Record<string, unknown> = {}) {
  return { type, seq, time: T0 + offset, data }
}

function dshUser(text: string, seq: number, offset: number) {
  return dshEvent('user/message', seq, offset, {
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

/** The nine always-present `summary.json` keys (GROK-FORMAT §B.1), plus whatever a case needs. */
function grokSummary(id: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    info: { id, cwd },
    session_summary: 'Grok status line',
    created_at: iso(0),
    updated_at: iso(30),
    num_messages: 3,
    num_chat_messages: 2,
    current_model_id: 'grok-4.6',
    next_trace_turn: 1,
    chat_format_version: 1,
    ...extra,
  })
}

describe('classifyPath', () => {
  it('recognizes Claude main transcripts, agent files, and subagent directories', () => {
    const root = '/r'
    expect(classifyPath('claude', root, '/r/-slug/abc.jsonl')).toEqual({ id: 'abc', role: 'main' })
    expect(classifyPath('claude', root, '/r/-slug/agent-x.jsonl')).toEqual({ id: 'agent-x', role: 'child' })
    expect(classifyPath('claude', root, '/r/-slug/abc/subagents/agent-y.jsonl'))
      .toEqual({ id: 'abc/agent-y', role: 'child', parentId: 'abc' })
    expect(classifyPath('claude', root, '/r/-slug/memory/notes.md')).toBeNull()
  })

  it('recognizes Codex rollouts by name and extracts the rollout id', () => {
    const path = '/r/2026/09/14/rollout-2026-09-14T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl'
    expect(classifyPath('codex', '/r', path)).toEqual({
      id: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      role: 'main',
      rolloutId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      threadUuid: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
    })
    // A reverted thread's file carries `<threadId>_<rolloutId>`; the rollout
    // id (what `history_base` references) is the last UUID.
    const reverted = '/r/2026/09/16/rollout-2026-09-16T02-25-36-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee_01a0a989-33bd-78e3-a255-8a5791f4b10a.jsonl'
    expect(classifyPath('codex', '/r', reverted)).toEqual({
      id: '01a0a989-33bd-78e3-a255-8a5791f4b10a',
      role: 'main',
      rolloutId: '01a0a989-33bd-78e3-a255-8a5791f4b10a',
      threadUuid: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
    })
    // Cold rollouts are `.jsonl.zst`; the same ids parse through the suffix.
    expect(classifyPath('codex', '/r', `${path}.zst`)).toEqual({
      id: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      role: 'main',
      rolloutId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      threadUuid: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
    })
    expect(classifyPath('codex', '/r', '/r/2026/09/14/notes.jsonl')).toBeNull()
    expect(classifyPath('codex', '/r', '/r/2026/09/14/notes.jsonl.zst')).toBeNull()
  })

  it('recognizes Kimi wire transcripts and binds children to their session directory', () => {
    const root = '/r'
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/agents/main/wire.jsonl'))
      .toEqual({ id: 'session_k1', role: 'main' })
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/agents/sub-1/wire.jsonl'))
      .toEqual({ id: 'sub-1', role: 'child', parentId: 'session_k1' })
    // Side stores and anything that is not `wire.jsonl` at exactly that depth are not transcripts.
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/agents/main/tasks/t1.jsonl')).toBeNull()
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/agents/main/notes.jsonl')).toBeNull()
    expect(classifyPath('kimi', root, '/r/wd_project_ab12/session_k1/wire.jsonl')).toBeNull()
    expect(classifyPath('kimi', root, '/r/session_index.jsonl')).toBeNull()
  })

  it('recognizes Grok update streams only, and never the side stores beside them', () => {
    const root = '/r'
    const dir = `/r/%2Fwork%2Fgrok/${GROK_MAIN}`
    // A child session directory looks exactly like a main one here: only
    // `summary.json` tells them apart, so the role stays provisional.
    expect(classifyPath('grok', root, `${dir}/updates.jsonl`)).toEqual({ id: GROK_MAIN, role: 'main' })
    expect(classifyPath('grok', root, `/r/%2Fwork%2Fgrok-wt/${GROK_CHILD}/updates.jsonl`))
      .toEqual({ id: GROK_CHILD, role: 'main' })
    // `chat_history.jsonl` is a derived cache, `events.jsonl` telemetry, the rest side stores.
    expect(classifyPath('grok', root, `${dir}/chat_history.jsonl`)).toBeNull()
    expect(classifyPath('grok', root, `${dir}/events.jsonl`)).toBeNull()
    expect(classifyPath('grok', root, `${dir}/rewind_points.jsonl`)).toBeNull()
    expect(classifyPath('grok', root, `${dir}/feedback.jsonl`)).toBeNull()
    // Wrong depth: the cwd-level prompt log above, a per-tool store below.
    expect(classifyPath('grok', root, '/r/%2Fwork%2Fgrok/prompt_history.jsonl')).toBeNull()
    expect(classifyPath('grok', root, `${dir}/terminal/updates.jsonl`)).toBeNull()
  })

  it('recognizes dsh generation logs only inside a session directory', () => {
    const root = '/r'
    expect(classifyPath('dsh', root, '/r/--work--/session-a1/session.jsonl.zstd'))
      .toEqual({ id: 'session-a1', role: 'main' })
    expect(classifyPath('dsh', root, '/r/--work--/session-a1/session.v3.jsonl.zstd'))
      .toEqual({ id: 'session-a1', role: 'main' })
    expect(classifyPath('dsh', root, '/r/--work--/session-a1/session.jsonl'))
      .toEqual({ id: 'session-a1', role: 'main' })
    // The session lease and side stores are not transcripts; neither is a log
    // at the wrong depth or under another harness's suffix rules.
    expect(classifyPath('dsh', root, '/r/--work--/session-a1/session.lock')).toBeNull()
    expect(classifyPath('dsh', root, '/r/--work--/session-a1/notes.jsonl')).toBeNull()
    expect(classifyPath('dsh', root, '/r/--work--/session.jsonl.zstd')).toBeNull()
    expect(classifyPath('dsh', root, '/r/a/b/session-a1/session.jsonl.zstd')).toBeNull()
    expect(classifyPath('dsh', root, '/r/--work--/session-a1/session.jsonl.zst')).toBeNull()
    expect(classifyPath('claude', root, '/r/-slug/session-a1/session.jsonl.zstd')).toBeNull()
  })

  it('recognizes pi sessions by the encoded-cwd directory and a first-underscore id split', () => {
    const root = '/r'
    expect(classifyPath('pi', root, '/r/--work-project--/2026-09-14T10-00-00-000Z_abc123.jsonl'))
      .toEqual({ id: 'abc123', role: 'main' })
    // A custom session id may itself contain underscores: everything after the FIRST one stays.
    expect(classifyPath('pi', root, '/r/--work-project--/2026-09-14T10-00-00-000Z_my_custom_id.jsonl'))
      .toEqual({ id: 'my_custom_id', role: 'main' })
    // A fork is a file of its own, not a child.
    expect(classifyPath('pi', root, '/r/--work-project--/2026-09-14T11-00-00-000Z_fork-of-abc.jsonl'))
      .toEqual({ id: 'fork-of-abc', role: 'main' })
    // Wrong depth or a non-JSONL/unrelated name is not a transcript.
    expect(classifyPath('pi', root, '/r/--work-project--/nested/2026-09-14T10-00-00-000Z_x.jsonl')).toBeNull()
    expect(classifyPath('pi', root, '/r/2026-09-14T10-00-00-000Z_x.jsonl')).toBeNull()
    expect(classifyPath('pi', root, '/r/--work-project--/notes.md')).toBeNull()
    expect(classifyPath('pi', root, '/r/--work-project--/state.json')).toBeNull()
  })
})

describe('defaultRoots', () => {
  it('resolves every harness root from harness homes and explicit overrides', () => {
    expect(defaultRoots({
      CLAUDE_CONFIG_DIR: join('/h', '.claude'),
      CODEX_HOME: join('/h', '.codex'),
      KIMI_CODE_HOME: join('/h', '.kimi-code'),
      GROK_HOME: join('/h', '.grok'),
      PI_CODING_AGENT_DIR: join('/h', '.pi', 'agent'),
      DSH_HOME: join('/h', '.dsh'),
    })).toEqual([
      { kind: 'claude', dir: join('/h', '.claude', 'projects') },
      { kind: 'codex', dir: join('/h', '.codex', 'sessions') },
      { kind: 'codex', dir: join('/h', '.codex', 'archived_sessions') },
      { kind: 'kimi', dir: join('/h', '.kimi-code', 'sessions') },
      { kind: 'grok', dir: join('/h', '.grok', 'sessions') },
      { kind: 'pi', dir: join('/h', '.pi', 'agent', 'sessions') },
      { kind: 'dsh', dir: join('/h', '.dsh', 'sessions') },
    ])
    expect(defaultRoots({
      HARNESS_TRAJECTORY_CLAUDE_ROOT: join('/roots', 'c'),
      HARNESS_TRAJECTORY_CODEX_ROOT: join('/roots', 'x'),
      HARNESS_TRAJECTORY_CODEX_ARCHIVED_ROOT: join('/roots', 'xa'),
      HARNESS_TRAJECTORY_KIMI_ROOT: join('/roots', 'k'),
      HARNESS_TRAJECTORY_GROK_ROOT: join('/roots', 'g'),
      HARNESS_TRAJECTORY_PI_ROOT: join('/roots', 'p'),
      HARNESS_TRAJECTORY_DSH_ROOT: join('/roots', 'd'),
    }).map(root => root.dir))
      .toEqual([join('/roots', 'c'), join('/roots', 'x'), join('/roots', 'xa'), join('/roots', 'k'), join('/roots', 'g'), join('/roots', 'p'), join('/roots', 'd')])
    // An empty `GROK_HOME` is not an override: grok itself falls back to the home default.
    expect(defaultRoots({ GROK_HOME: '' }).find(root => root.kind === 'grok')?.dir.endsWith(join('.grok', 'sessions'))).toBe(true)
  })
})

describe('chronological merge', () => {
  it('inherits timestamps for housekeeping lines and back-fills leading ones', () => {
    const lines = [
      JSON.stringify({ type: 'mode' }),
      JSON.stringify({ type: 'user', timestamp: iso(1000) }),
      JSON.stringify({ type: 'last-prompt' }),
      JSON.stringify({ type: 'assistant', timestamp: iso(3000) }),
    ]
    expect(lineTimes(lines)).toEqual([T0 + 1000, T0 + 1000, T0 + 1000, T0 + 3000])
  })

  it('interleaves child lines by time and keeps the main file first on ties', () => {
    const main = { id: 'm', role: 'main' as const, path: '/m' }
    const child = { id: 'c', role: 'child' as const, path: '/c', parentId: 'm' }
    const mainLines = [iso(0), iso(2000), iso(4000)].map(timestamp => JSON.stringify({ timestamp, f: 'm' }))
    const childLines = [iso(2000), iso(3000)].map(timestamp => JSON.stringify({ timestamp, f: 'c' }))
    const chunks = [...mergeChronologically([
      { ref: main, lines: mainLines, times: lineTimes(mainLines) },
      { ref: child, lines: childLines, times: lineTimes(childLines) },
    ])]
    expect(chunks.map(chunk => `${chunk.ref.id}:${chunk.lines.length}`)).toEqual(['m:2', 'c:2', 'm:1'])
    // Each file keeps its own numbering across the interleaving.
    expect(chunks.map(chunk => `${chunk.ref.id}@${chunk.startLine}`)).toEqual(['m@0', 'c@0', 'm@2'])
  })

  it('numbers chunks per file and keeps a synthetic line out of the count', () => {
    const main = { id: 'm', role: 'main' as const, path: '/m' }
    const lines = Array.from({ length: 900 }, (_, index) => JSON.stringify({ timestamp: iso(index), n: index }))
    // Grok's sidecar rides in front of the file's own lines (`synthetic: 1`).
    const all = [JSON.stringify({ timestamp: iso(0), sidecar: true }), ...lines]
    const chunks = [...mergeChronologically([
      { ref: main, lines: all, times: lineTimes(all), synthetic: 1 },
    ])]
    // The sidecar never shares a chunk with real lines, and line 0 of the file
    // is the first real one.
    expect(chunks.map(chunk => [chunk.startLine, chunk.lines.length])).toEqual([[-1, 1], [0, 400], [400, 400], [800, 100]])
    expect(JSON.parse(chunks[1]?.lines[0] ?? '{}')).toMatchObject({ n: 0 })
    expect(JSON.parse(chunks[2]?.lines[0] ?? '{}')).toMatchObject({ n: 400 })
  })

  it('reads Kimi epoch-millisecond "time" fields and still prefers "timestamp"', () => {
    expect(lineTime(JSON.stringify(kimi('turn.ended', 4000)))).toBe(T0 + 4000)
    expect(lineTime(JSON.stringify({ type: 'metadata', created_at: T0 }))).toBeNull()
    // Seconds stay seconds; a record with both keeps the `timestamp`.
    expect(lineTime('{"type":"x","time":1789372800}')).toBe(1789372800_000)
    expect(lineTime(JSON.stringify({ timestamp: iso(1000), time: T0 + 9000 }))).toBe(T0 + 1000)
    expect(lineTime('{"type":"x"}')).toBeNull()
  })

  it('reads a Grok envelope timestamp as seconds and never mistakes agentTimestampMs for it', () => {
    const line = JSON.stringify(grokPrompt('Hello there', 0, 1500))
    // The envelope key is the first on the line and the millisecond stamp is
    // spelled `agentTimestampMs`, which matches neither pattern.
    expect(line.indexOf('"timestamp"')).toBeLessThan(line.indexOf('agentTimestampMs'))
    expect(lineTime(line)).toBe(Math.floor((T0 + 1500) / 1000) * 1000)
    // The sidecar the server prepends carries the same second-granular envelope.
    expect(lineTime(JSON.stringify({ timestamp: 0, method: GROK_SIDECAR_METHOD, params: { sessionId: GROK_MAIN } }))).toBe(0)
  })

  it('reads a pi entry-level ISO timestamp and never the nested message milliseconds', () => {
    const line = JSON.stringify({
      type: 'message', id: 'e1', parentId: null, timestamp: iso(2000),
      message: { role: 'user', content: 'hi', timestamp: T0 + 9000 },
    })
    // The entry stamp precedes `message` in pi's key order, so the first
    // `"timestamp"` match is the ISO one.
    expect(lineTime(line)).toBe(T0 + 2000)
  })
})

describe('meta scanners', () => {
  it('summarizes a Claude transcript: title, cwd, model, prompts, and ai-title precedence', () => {
    const scanner = createMetaScanner('claude')
    const lines = [
      claudeUser('Fix the flaky test please', 's1', 0),
      claudeAssistant('On it', 's1', 500),
      claudeUser('<command-name>/model</command-name>', 's1', 800),
      claudeUser('notification', 's1', 900, { origin: { kind: 'task-notification' } }),
      { type: 'ai-title', aiTitle: 'Flaky test fix', sessionId: 's1' },
    ]
    for (const line of jsonl(lines).split('\n')) scanner.push(line)
    expect(scanner.state).toMatchObject({
      title: 'Fix the flaky test please', aiTitle: 'Flaky test fix', cwd: '/work/project',
      model: 'claude-test', promptCount: 1, startedAt: T0,
    })
  })

  it('summarizes a Codex rollout and ignores injected context messages', () => {
    const scanner = createMetaScanner('codex')
    const lines = [
      codexMeta('t1', 0),
      { timestamp: iso(10), type: 'turn_context', payload: { model: 'gpt-test', cwd: '/work/codex' } },
      codexUser('<environment_context>cwd</environment_context>', 20),
      codexUser('Refactor the parser', 30),
    ]
    for (const line of jsonl(lines).split('\n')) scanner.push(line)
    expect(scanner.state).toMatchObject({ title: 'Refactor the parser', cwd: '/work/codex', model: 'gpt-test', promptCount: 1 })
  })

  it('summarizes a Kimi wire transcript and counts only origin-user messages', () => {
    const scanner = createMetaScanner('kimi')
    const lines = [
      { type: 'metadata', created_at: T0, protocol_version: '1.5' },
      kimi('profile.bind', 2, { modelAlias: 'kimi-code/k3', environmentDisclosure: { cwd: '/work/kimi' } }),
      kimiUser('Port the viewer to Kimi', 10),
      kimi('llm.request', 12, { model: 'k3', provider: 'openai', maxTokens: 1048576 }),
      kimiUser('todo reminder', 20, { kind: 'injection', variant: 'todo_list_reminder' }),
      kimiUser('agent finished', 21, { kind: 'task', taskId: 't1', status: 'completed' }),
      kimiUser('skill text', 22, { kind: 'skill_activation', skillName: 'design' }),
      kimiUser('/plugin', 23, { kind: 'plugin_command' }),
      kimiUser('previous summary', 24, { kind: 'compaction_summary' }),
      kimiUser('And now the second prompt', 30),
      kimi('turn.ended', 40, { durationMs: 40, reason: 'completed', turnId: 0 }),
    ]
    for (const line of jsonl(lines).split('\n')) scanner.push(line)
    expect(scanner.state).toMatchObject({
      title: 'Port the viewer to Kimi', cwd: '/work/kimi', model: 'k3',
      promptCount: 2, startedAt: T0, lastTime: T0 + 40,
    })
  })

  it('summarizes a pi transcript: header cwd, first model, session_info title, human prompts', () => {
    const scanner = createMetaScanner('pi')
    const piEntry = (offset: number, id: string, type: string, rest: Record<string, unknown> = {}) =>
      ({ type, id, parentId: null, timestamp: iso(offset), ...rest })
    const lines = [
      { type: 'session', version: 3, id: 'pi-1', timestamp: iso(0), cwd: '/work/pi' },
      piEntry(10, 'e1', 'model_change', { provider: 'openai', modelId: 'pi-k3' }),
      piEntry(20, 'e2', 'message', { message: { role: 'user', content: 'Build the pi adapter', timestamp: T0 + 20 } }),
      piEntry(30, 'e3', 'message', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'pi-other', timestamp: T0 + 30 },
      }),
      piEntry(40, 'e4', 'custom', { customType: 'shadow-mind-event', data: {} }),
      piEntry(50, 'e5', 'message', {
        message: { role: 'bashExecution', command: 'ls', output: 'x', timestamp: T0 + 50 },
      }),
      piEntry(60, 'e6', 'session_info', { name: 'Pi session name' }),
      piEntry(70, 'e7', 'message', { message: { role: 'user', content: 'second prompt', timestamp: T0 + 70 } }),
    ]
    for (const line of jsonl(lines).split('\n')) scanner.push(line)
    expect(scanner.state).toMatchObject({
      title: 'Build the pi adapter', aiTitle: 'Pi session name', cwd: '/work/pi',
      model: 'pi-k3', promptCount: 2, startedAt: T0, lastTime: T0 + 70,
    })
  })

  it('tolerates malformed and unknown Kimi lines', () => {
    const scanner = createMetaScanner('kimi')
    for (const line of ['', '{ not json', 'null', '[]', JSON.stringify(kimi('mcp.tools_discovered', 1))]) {
      expect(() => { scanner.push(line) }).not.toThrow()
    }
    expect(scanner.state).toMatchObject({ title: null, promptCount: 0 })
  })

  it('discovers Kimi subagent listing facts from task.started and from an Agent result', () => {
    const started = createMetaScanner('kimi')
    started.push(JSON.stringify(kimi('task.started', 40, {
      info: {
        kind: 'agent', agentId: 'agent-0', parentToolCallId: 'call-bg',
        description: 'Fix the bug', subagentType: 'coder', model: 'kimi-code/k3',
      },
    })))
    expect(started.state.agents.get('agent-0')).toEqual({
      agentId: 'agent-0', description: 'Fix the bug', agentType: 'coder', model: 'k3', toolUseId: 'call-bg',
    })

    const foreground = createMetaScanner('kimi')
    for (const line of jsonl([
      kimi('context.append_loop_event', 50, {
        event: {
          type: 'tool.call', toolCallId: 'call-fg', name: 'Agent',
          args: { description: 'Survey the repo', subagent_type: 'explore', prompt: 'look around' },
        },
      }),
      kimi('context.append_loop_event', 80, {
        event: {
          type: 'tool.result', toolCallId: 'call-fg',
          result: { output: 'agent_id: agent-1\nactual_subagent_type: explore\nstatus: completed\n\nDone.' },
        },
      }),
    ]).split('\n').filter(line => line !== '')) {
      foreground.push(line)
    }
    expect(foreground.state.agents.get('agent-1')).toEqual({
      agentId: 'agent-1', description: 'Survey the repo', agentType: 'explore', toolUseId: 'call-fg',
    })
  })

  it('ignores an agent_id header quoted by a result that is not an Agent call', () => {
    // TaskOutput's task dump carries a bare `agent_id:` line; it must not stamp
    // the child with the polling call's id.
    const scanner = createMetaScanner('kimi')
    for (const line of jsonl([
      kimi('context.append_loop_event', 50, {
        event: {
          type: 'tool.call', toolCallId: 'call-poll', name: 'TaskOutput',
          args: { task_id: 'agent-2prrfelx' },
        },
      }),
      kimi('context.append_loop_event', 60, {
        event: {
          type: 'tool.result', toolCallId: 'call-poll',
          result: {
            output: 'retrieval_status: not_ready\ntask_id: agent-2prrfelx\nstatus: running\nagent_id: agent-7\nsubagent_type: explore',
          },
        },
      }),
    ]).split('\n').filter(line => line !== '')) {
      scanner.push(line)
    }
    expect(scanner.state.agents.size).toBe(0)
  })

  it('scans a child transcript only when registration attached no sidecar', () => {
    expect(listingScannerFor('kimi', 'child', undefined)).not.toBeNull()
    expect(listingScannerFor('codex', 'child', undefined)).not.toBeNull()
    expect(listingScannerFor('claude', 'child', { agentId: 'agent-0' })).toBeNull()
    expect(listingScannerFor('grok', 'child', { agentId: 'child', description: 'helper' })).toBeNull()
    expect(listingScannerFor('claude', 'main', { agentId: 'agent-0' })).not.toBeNull()
  })

  it('merges parent spawn facts over the child listing title, filling type from the child', () => {
    const own = emptyMeta()
    own.title = 'look around thoroughly'
    own.agentType = 'explore'
    own.model = 'k3'
    expect(mergeChildAgent(
      'sub-1',
      { agentId: 'sub-1', description: 'Survey the repo', toolUseId: 'call-fg' },
      own,
      undefined,
    )).toEqual({
      agentId: 'sub-1',
      description: 'Survey the repo',
      agentType: 'explore',
      model: 'k3',
      toolUseId: 'call-fg',
    })
    expect(mergeChildAgent('sub-1', undefined, own, undefined)).toEqual({
      agentId: 'sub-1', description: 'look around thoroughly', agentType: 'explore', model: 'k3',
    })
    expect(mergeChildAgent('sub-1', undefined, undefined, { agentId: 'sub-1', description: 'sidecar' }))
      .toEqual({ agentId: 'sub-1', description: 'sidecar' })
    const sidecar = { agentId: 'a1', description: 'Find things', agentType: 'Explore', model: 'sonnet' }
    expect(mergeChildAgent('main-1/agent-a1', undefined, emptyMeta(), sidecar)).toBe(sidecar)
  })

  it('counts only genuine human Grok chunks, never hostTurn relays or the session preamble', () => {
    // No path, so no `summary.json`: the scanner falls back to what the stream carries.
    const scanner = createMetaScanner('grok')
    const lines = [
      // The preamble that opens every session: no `promptIndex`, so not a prompt.
      grok({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<environment>cwd</environment>' } }, 0),
      grokPrompt('Port the viewer to Grok', 0, 10),
      // A host-injected turn: flagged on the content, prompt index or not.
      grok({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'relayed', _meta: { hostTurn: true } },
        _meta: { promptIndex: 1 },
      }, 20),
      grok({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working on it' } }, 30),
      grokPrompt('And a second one', 1, 40),
    ]
    for (const line of jsonl(lines).split('\n')) scanner.push(line)
    expect(scanner.state).toMatchObject({
      title: 'Port the viewer to Grok', aiTitle: null, cwd: null, model: 'grok-4.6',
      promptCount: 2, startedAt: T0, lastTime: T0 + 40,
    })
  })

  it('counts an image-only Grok prompt and keeps the next one as the title', () => {
    const scanner = createMetaScanner('grok')
    const lines = [
      // A prompt whose only content is an image carries no text at all; it is
      // still a turn, and the adapter and the synthesizer both count it.
      grok({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        _meta: { modelId: 'grok-4.6', promptIndex: 0 },
      }, 0),
      grokPrompt('What is in it?', 1, 10),
    ]
    for (const line of jsonl(lines).split('\n')) scanner.push(line)
    expect(scanner.state).toMatchObject({ title: 'What is in it?', promptCount: 2 })
  })

  it('takes the Grok title, cwd, model, and start from the summary the caller read', () => {
    const scanner = createMetaScanner('grok', JSON.parse(grokSummary(GROK_MAIN, '/work/grok')) as Record<string, unknown>)
    scanner.push(JSON.stringify(grokPrompt('Add Grok Build support', 0, 10)))
    // `session_summary` lands on `aiTitle` verbatim, the way the live sync sets it.
    expect(scanner.state).toMatchObject({
      title: 'Add Grok Build support', aiTitle: 'Grok status line', cwd: '/work/grok',
      model: 'grok-4.6', startedAt: T0, promptCount: 1,
    })
  })

  it('tolerates malformed, legacy, and unknown Grok lines', () => {
    const scanner = createMetaScanner('grok')
    const lines = [
      '', '{ not json', 'null', '[]',
      JSON.stringify(grok({ sessionUpdate: 'hook_execution', hook_name: 'pre' }, 1)),
      // A legacy line has no envelope at all: a bare ACP notification.
      JSON.stringify({ sessionId: GROK_MAIN, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } }),
    ]
    for (const line of lines) expect(() => { scanner.push(line) }).not.toThrow()
    expect(scanner.state).toMatchObject({ title: null, promptCount: 0 })
  })

  it('summarizes a dsh transcript: cwd, millisecond times, model, titles, prompts, and spawn facts', () => {
    const scanner = createMetaScanner('dsh')
    const lines = jsonl([
      dshHeader(DSH_MAIN),
      dshEvent('request/header', 1, 10, { header: { config: { model: 'deepseek-v4' } } }),
      dshUser('Add dsh support', 2, 20),
      dshEvent('session/title', 3, 30, { title: 'dsh session' }),
      // `arguments` is a JSON STRING on the wire; `description` is the spawn caption.
      dshEvent('tool/call', 4, 40, { callId: 'call-1', name: 'subagent', arguments: '{"description":"Scout the repo"}' }),
      dshEvent('tool/result', 5, 50, {
        message: {
          source: { callId: 'call-1' },
          content: [{
            type: 'tool-result', toolCallId: 'call-1',
            content: [{ type: 'text', text: `started subagent ${DSH_CHILD}` }],
          }],
        },
      }),
      // A non-`user` source kind is injected context, and a replace surfaceOp
      // is a compaction summary — neither is a human prompt.
      dshEvent('user/message', 6, 60, { source: { kind: 'context' }, content: [{ type: 'text', text: 'injected' }] }),
      {
        ...dshUser('previous summary', 7, 70),
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 6 },
      },
    ])
    for (const line of lines.split('\n').filter(line => line !== '')) scanner.push(line)
    expect(scanner.state).toMatchObject({
      title: 'Add dsh support', aiTitle: 'dsh session', cwd: '/work/dsh', model: 'deepseek-v4',
      promptCount: 1, startedAt: T0, lastTime: T0 + 70,
    })
    expect(scanner.state.agents.get(DSH_CHILD)).toEqual({
      agentId: DSH_CHILD, toolUseId: 'call-1', description: 'Scout the repo',
    })
  })

  it('keeps a pending dsh tool call description across a listing-cache resume', () => {
    const first = createMetaScanner('dsh')
    first.push(JSON.stringify(
      dshEvent('tool/call', 1, 10, { callId: 'call-1', name: 'subagent', arguments: '{"description":"Scout the repo"}' }),
    ))
    const saved = serializeMeta(first)
    const resumed = createMetaScanner('dsh')
    expect(hydrateMeta(resumed, saved ?? '')).toBe(true)
    resumed.push(JSON.stringify(dshEvent('tool/result', 2, 20, {
      message: {
        source: { callId: 'call-1' },
        content: [{
          type: 'tool-result', toolCallId: 'call-1',
          content: [{ type: 'text', text: `started subagent ${DSH_CHILD}` }],
        }],
      },
    })))
    expect(resumed.state.agents.get(DSH_CHILD)).toMatchObject({ description: 'Scout the repo' })
  })
})

describe('SessionIndex', () => {
  let dir: string
  let index: SessionIndex

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-'))
    await mkdir(join(dir, 'claude', '-slug', 'main-1', 'subagents'), { recursive: true })
    await mkdir(join(dir, 'codex', '2026', '09', '14'), { recursive: true })
    await writeFile(join(dir, 'claude', '-slug', 'main-1.jsonl'), jsonl([
      claudeUser('Hello there', 'main-1', 0),
      claudeAssistant('Hi', 'main-1', 1000),
    ]))
    await writeFile(join(dir, 'claude', '-slug', 'main-1', 'subagents', 'agent-a.jsonl'), jsonl([
      claudeUser('child prompt', 'main-1', 500, { isSidechain: true }),
    ]))
    await writeFile(join(dir, 'codex', '2026', '09', '14', 'rollout-2026-09-14T10-00-00-parent.jsonl'), jsonl([
      codexMeta('parent-thread', 0),
      codexUser('Parent prompt', 100),
    ]))
    await writeFile(join(dir, 'codex', '2026', '09', '14', 'rollout-2026-09-14T10-00-01-child.jsonl'), jsonl([
      codexMeta('child-thread', 50, 'parent-thread'),
    ]))
    const kimiSession = join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1')
    await mkdir(join(kimiSession, 'agents', 'main', 'tasks'), { recursive: true })
    await mkdir(join(kimiSession, 'agents', 'sub-1'), { recursive: true })
    await writeFile(join(kimiSession, 'state.json'), JSON.stringify({
      id: 'session_k1', version: 2, cwd: '/work/kimi', createdAt: T0, updatedAt: T0 + 30,
      title: 'Kimi session title', titleKind: 'generated', lastTurnReason: 'completed',
      agents: { main: { type: 'main' }, 'sub-1': { type: 'sub', parentAgentId: 'main' } },
    }))
    await writeFile(join(kimiSession, 'agents', 'main', 'wire.jsonl'), kimiMain('Add Kimi support'))
    await writeFile(join(kimiSession, 'agents', 'main', 'tasks', 't1.jsonl'), jsonl([{ ignored: true }]))
    await writeFile(join(kimiSession, 'agents', 'sub-1', 'wire.jsonl'), jsonl([
      kimi('runtime.set_binding', 15, { runtimeId: 'rt-2' }, 'sub-1'),
      kimi('profile.bind', 16, { profileName: 'explore', modelAlias: 'kimi-code/k3' }, 'sub-1'),
    ]))
    const piSession = join(dir, 'pi', '--work-pi--')
    await mkdir(piSession, { recursive: true })
    await writeFile(join(piSession, '2026-09-14T10-00-00-000Z_pi-session-1.jsonl'), jsonl([
      { type: 'session', version: 3, id: 'pi-session-1', timestamp: iso(0), cwd: '/work/pi' },
      { type: 'model_change', id: 'e1', parentId: null, timestamp: iso(10), provider: 'openai', modelId: 'pi-k3' },
      {
        type: 'message', id: 'e2', parentId: 'e1', timestamp: iso(20),
        message: { role: 'user', content: 'Add pi support', timestamp: T0 + 20 },
      },
      {
        type: 'message', id: 'e3', parentId: 'e2', timestamp: iso(30),
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'done' }], provider: 'openai', model: 'pi-k3',
          usage: { input: 1, output: 1 }, stopReason: 'stop', timestamp: T0 + 30,
        },
      },
    ]))
    index = new SessionIndex({
      roots: [
        { kind: 'claude', dir: join(dir, 'claude') },
        { kind: 'codex', dir: join(dir, 'codex') },
        { kind: 'kimi', dir: join(dir, 'kimi') },
        { kind: 'pi', dir: join(dir, 'pi') },
      ],
      watch: false,
      now: () => T0 + 60_000,
    })
    await index.start()
  })

  afterEach(async () => {
    index.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('lists main sessions with metadata and attaches children by parent id', () => {
    const sessions = index.list()
    expect(sessions.map(session => `${session.kind}:${session.id}`).sort())
      .toEqual(['claude:main-1', 'codex:parent-thread', 'kimi:session_k1', 'pi:pi-session-1'])
    const claude = index.get('claude', 'main-1')
    expect(claude).toMatchObject({ title: 'Hello there', cwd: '/work/project', childCount: 1, promptCount: 1 })
    expect(claude?.files.map(file => file.role)).toEqual(['main', 'child'])
    const codex = index.get('codex', 'parent-thread')
    expect(codex).toMatchObject({ title: 'Parent prompt', childCount: 1 })
    expect(codex?.files[1]).toMatchObject({ id: 'child-thread', role: 'child', parentId: 'parent-thread' })
    expect(index.get('codex', 'child-thread')).toBeUndefined()
  })

  it('indexes a Kimi session by directory name, titles it from state.json, and attaches its agents', async () => {
    const session = index.get('kimi', 'session_k1')
    expect(session).toMatchObject({
      id: 'session_k1', kind: 'kimi', title: 'Kimi session title', cwd: '/work/kimi',
      model: 'k3', startedAt: T0, childCount: 1, promptCount: 1,
    })
    expect(session?.files.map(file => `${file.role}:${file.id}`)).toEqual(['main:session_k1', 'child:sub-1'])
    expect(session?.files[1]).toMatchObject({
      parentId: 'session_k1',
      agent: { agentId: 'sub-1', agentType: 'explore', model: 'k3' },
    })
    // The subagent transcript is not a session of its own, and side stores are skipped.
    expect(index.get('kimi', 'sub-1')).toBeUndefined()
    expect(index.hasChild('kimi', 'session_k1', 'sub-1')).toBe(true)

    // state.json is rewritten as the session runs; a refresh picks the new title up.
    const statePath = join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1', 'state.json')
    const mainPath = join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1', 'agents', 'main', 'wire.jsonl')
    await writeFile(statePath, JSON.stringify({ id: 'session_k1', title: 'Renamed by the user', titleKind: 'custom' }))
    await appendFile(mainPath, jsonl([kimiUser('One more thing', 5000)]))
    await index.refreshPath(mainPath)
    expect(index.get('kimi', 'session_k1')).toMatchObject({ title: 'Renamed by the user', promptCount: 2 })
  })

  it('indexes a pi session by first-underscore id with header cwd, first model, and prompt count', () => {
    const session = index.get('pi', 'pi-session-1')
    expect(session).toMatchObject({
      id: 'pi-session-1', kind: 'pi', title: 'Add pi support', cwd: '/work/pi',
      model: 'pi-k3', startedAt: T0, promptCount: 1, childCount: 0,
    })
    expect(session?.files.map(file => file.role)).toEqual(['main'])
  })

  it('stamps a Kimi child with the parent Agent description so the subagent view has a title', async () => {
    const sessionDir = join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1')
    const mainPath = join(sessionDir, 'agents', 'main', 'wire.jsonl')
    const childPath = join(sessionDir, 'agents', 'sub-1', 'wire.jsonl')
    await appendFile(mainPath, jsonl([
      kimi('context.append_loop_event', 50, {
        event: {
          type: 'tool.call', toolCallId: 'call-agent', name: 'Agent',
          args: { description: 'Survey the repo', subagent_type: 'explore', prompt: 'look around' },
        },
      }),
      kimi('context.append_loop_event', 80, {
        event: {
          type: 'tool.result', toolCallId: 'call-agent',
          result: { output: 'agent_id: sub-1\nactual_subagent_type: explore\nstatus: completed\n\nDone.' },
        },
      }),
    ]))
    await appendFile(childPath, jsonl([
      kimi('context.append_message', 60, {
        message: {
          role: 'user',
          content: [{
            type: 'text',
            text: '<git-context>\nWorking directory: /work\n</git-context>\n\nlook around thoroughly',
          }],
          toolCalls: [],
          origin: { kind: 'system_trigger', name: 'subagent' },
        },
      }, 'sub-1'),
    ]))
    await index.refreshPath(mainPath)
    await index.refreshPath(childPath)
    expect(index.get('kimi', 'session_k1')?.files[1]).toMatchObject({
      id: 'sub-1',
      agent: {
        agentId: 'sub-1',
        description: 'Survey the repo',
        agentType: 'explore',
        toolUseId: 'call-agent',
      },
    })
  })

  it('falls back to the first human prompt when state.json has no usable title', async () => {
    await rm(join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1', 'state.json'))
    const fresh = new SessionIndex({
      roots: [{ kind: 'kimi', dir: join(dir, 'kimi') }],
      watch: false,
      now: () => T0 + 60_000,
    })
    await fresh.start()
    expect(fresh.get('kimi', 'session_k1')).toMatchObject({ title: 'Add Kimi support', childCount: 1 })
    fresh.stop()
  })

  it('announces a Kimi subagent transcript created while the session is watched', async () => {
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('kimi', 'session_k1', event => events.push(event))
    const childDir = join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1', 'agents', 'sub-2')
    await mkdir(childDir, { recursive: true })
    const path = join(childDir, 'wire.jsonl')
    await writeFile(path, jsonl([kimi('runtime.set_binding', 2000, { runtimeId: 'rt-3' }, 'sub-2')]))
    await index.refreshPath(path)
    expect(events.map(event => event.type)).toEqual(['file', 'lines', 'meta'])
    const [file] = events
    expect(file?.type === 'file' && file.file).toMatchObject({ id: 'sub-2', role: 'child', parentId: 'session_k1' })
    expect(index.get('kimi', 'session_k1')?.childCount).toBe(2)
    unsubscribe()
  })

  it('replays files in timestamp order and then reports live appends', async () => {
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('claude', 'main-1', event => events.push(event))
    const replay: SessionLiveEvent[] = []
    await index.readAll('claude', 'main-1', event => replay.push(event))
    const order = replay.flatMap(event => (event.type === 'lines'
      ? event.lines.map(line => `${event.file.role}:${(JSON.parse(line) as { type: string }).type}`)
      : []))
    expect(order).toEqual(['main:user', 'child:user', 'main:assistant'])
    expect(replay.at(-1)?.type).toBe('meta')

    const path = join(dir, 'claude', '-slug', 'main-1.jsonl')
    await appendFile(path, jsonl([claudeUser('Second prompt', 'main-1', 5000)]))
    await index.refreshPath(path)
    const appended = events.filter(event => event.type === 'lines')
    expect(appended).toHaveLength(1)
    expect(appended[0]?.type === 'lines' && appended[0].lines).toHaveLength(1)
    // The replay ended at line 1 of the main file, so the append is line 2.
    expect(appended[0]?.type === 'lines' && appended[0].startLine).toBe(2)
    expect(index.get('claude', 'main-1')?.promptCount).toBe(2)
    unsubscribe()
  })

  it('discovers a transcript created after startup', async () => {
    const path = join(dir, 'claude', '-slug', 'main-2.jsonl')
    await writeFile(path, jsonl([claudeUser('Late arrival', 'main-2', 0)]))
    await index.refreshPath(path)
    expect(index.get('claude', 'main-2')).toMatchObject({ title: 'Late arrival' })
  })

  it('skips a harness root that does not exist instead of reporting a watcher error', async () => {
    // A machine without the harness installed has no session root; the sweep
    // finds nothing and the watcher stays quiet.
    const missing = new SessionIndex({
      roots: [{ kind: 'pi', dir: join(dir, 'absent') }],
      now: () => T0 + 60_000,
    })
    const errors: unknown[] = []
    missing.on('error', error => errors.push(error))
    await missing.start()
    // A watcher error on a missing path arrives on a later tick.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(errors).toEqual([])
    expect(missing.list()).toEqual([])
    missing.stop()
  })
})

describe('SessionIndex live children', () => {
  let dir: string
  let index: SessionIndex

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-live-'))
    await mkdir(join(dir, 'claude', '-slug'), { recursive: true })
    await writeFile(join(dir, 'claude', '-slug', 'main-1.jsonl'), jsonl([
      claudeUser('Hello there', 'main-1', 0),
      claudeAssistant('Hi', 'main-1', 1000),
    ]))
    index = new SessionIndex({
      roots: [{ kind: 'claude', dir: join(dir, 'claude') }],
      watch: false,
      now: () => T0 + 60_000,
    })
    await index.start()
  })

  afterEach(async () => {
    index.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('announces a subagent transcript created while watching and forwards its existing lines', async () => {
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('claude', 'main-1', event => events.push(event))
    const childDir = join(dir, 'claude', '-slug', 'main-1', 'subagents')
    await mkdir(childDir, { recursive: true })
    const path = join(childDir, 'agent-a1.jsonl')
    await writeFile(`${childDir}/agent-a1.meta.json`, JSON.stringify({
      agentType: 'Explore', description: 'Find things', toolUseId: 'toolu_1', isFork: false, model: 'sonnet',
    }))
    await writeFile(path, jsonl([
      claudeUser('child prompt', 'main-1', 500, { isSidechain: true, agentId: 'a1' }),
      claudeAssistant('child reply', 'main-1', 800),
    ]))
    await index.refreshPath(path)
    expect(events.map(event => event.type)).toEqual(['file', 'lines', 'meta'])
    const [file, lines, meta] = events
    expect(file?.type === 'file' && file.file).toMatchObject({
      id: 'main-1/agent-a1', role: 'child', parentId: 'main-1',
      agent: { agentId: 'a1', toolUseId: 'toolu_1', description: 'Find things', agentType: 'Explore', model: 'sonnet' },
    })
    expect(file?.type === 'file' && file.reset).toBeUndefined()
    expect(lines?.type === 'lines' && lines.lines).toHaveLength(2)
    expect(meta?.type === 'meta' && meta.children.map(child => child.file.id)).toEqual(['main-1/agent-a1'])
    expect(index.get('claude', 'main-1')?.children[0]).toMatchObject({ file: { id: 'main-1/agent-a1' }, bytes: expect.any(Number) })

    // Later appends keep flowing; a truncation is flagged as a reset.
    await appendFile(path, jsonl([claudeAssistant('more', 'main-1', 900)]))
    await index.refreshPath(path)
    expect(events.filter(event => event.type === 'lines')).toHaveLength(2)
    await writeFile(path, jsonl([claudeUser('rewritten', 'main-1', 100, { isSidechain: true })]))
    await index.refreshPath(path)
    expect(events.some(event => event.type === 'file' && event.reset === true)).toBe(true)
    unsubscribe()
  })

  it('serves one child transcript as a session of its own', async () => {
    const childDir = join(dir, 'claude', '-slug', 'main-1', 'subagents')
    await mkdir(childDir, { recursive: true })
    const path = join(childDir, 'agent-a1.jsonl')
    await writeFile(path, jsonl([claudeUser('child prompt', 'main-1', 500, { isSidechain: true, agentId: 'a1' })]))
    await index.refreshPath(path)
    expect(index.hasChild('claude', 'main-1', 'main-1/agent-a1')).toBe(true)
    expect(index.hasChild('claude', 'main-1', 'main-1/agent-zz')).toBe(false)
    const replay: SessionLiveEvent[] = []
    await index.readAll('claude', 'main-1', event => replay.push(event), 'main-1/agent-a1')
    expect(replay.map(event => event.type)).toEqual(['file', 'lines', 'meta'])
    const [file, lines] = replay
    expect(file?.type === 'file' && file.file).toEqual({
      id: 'main-1/agent-a1', role: 'main', path, agent: { agentId: 'a1' },
    })
    expect(lines?.type === 'lines' && lines.file.role).toBe('main')
    expect(lines?.type === 'lines' && lines.lines).toHaveLength(1)

    const main: SessionLiveEvent = {
      type: 'lines', file: { id: 'main-1', role: 'main', path: '/m' }, lines: ['{}'], startLine: 0,
    }
    const child: SessionLiveEvent = {
      type: 'lines',
      file: { id: 'main-1/agent-a1', role: 'child', path, parentId: 'main-1' },
      lines: ['{}'],
      startLine: 7,
    }
    expect(scopeToFile(main, 'main-1/agent-a1')).toBeNull()
    // Narrowing a child to its own view keeps the line numbering of the file.
    expect(scopeToFile(child, 'main-1/agent-a1'))
      .toMatchObject({ file: { id: 'main-1/agent-a1', role: 'main' }, startLine: 7 })
    expect(scopeToFile({ type: 'ready' }, 'main-1/agent-a1')).toEqual({ type: 'ready' })
  })
})

describe('SessionIndex — Grok Build', () => {
  let dir: string
  let root: string
  let mainDir: string
  let index: SessionIndex

  const systemPrompt = 'You are Grok released by xAI.'
  const toolDefinitions = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: {} } }]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-grok-'))
    root = join(dir, 'grok')
    // The parent's group and the child's are different encoded cwds: a subagent
    // gets its own top-level session directory under its own cwd (§D.2).
    mainDir = join(root, '%2Fwork%2Fgrok', GROK_MAIN)
    const childDir = join(root, '%2Fwork%2Fgrok-wt', GROK_CHILD)
    const orphanDir = join(root, '%2Fwork%2Fgrok', GROK_ORPHAN)
    await mkdir(join(mainDir, 'subagents', GROK_CHILD), { recursive: true })
    await mkdir(childDir, { recursive: true })
    await mkdir(orphanDir, { recursive: true })
    await writeFile(join(mainDir, 'summary.json'), grokSummary(GROK_MAIN, '/work/grok'))
    await writeFile(join(mainDir, 'system_prompt.txt'), systemPrompt)
    await writeFile(join(mainDir, 'tool_definitions.json'), JSON.stringify(toolDefinitions))
    await writeFile(join(mainDir, 'updates.jsonl'), jsonl([
      grokPrompt('Add Grok Build support', 0, 0),
      grok({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'On it' } }, 1000),
    ]))
    // Derived caches and side stores sit right beside the transcript.
    await writeFile(join(mainDir, 'chat_history.jsonl'), jsonl([{ type: 'system', content: systemPrompt }]))
    await writeFile(join(mainDir, 'events.jsonl'), jsonl([{ event: 'turn_started' }]))
    await writeFile(join(root, '%2Fwork%2Fgrok', 'prompt_history.jsonl'), jsonl([
      { timestamp: iso(0), session_id: GROK_MAIN, prompt: 'Add Grok Build support', is_bash: false },
    ]))
    await writeFile(join(mainDir, 'subagents', GROK_CHILD, 'meta.json'), JSON.stringify({
      subagent_id: GROK_CHILD, parent_session_id: GROK_MAIN, child_session_id: GROK_CHILD,
      subagent_type: 'general-purpose', description: 'Find the parser', prompt: 'find it',
      status: 'completed', started_at: iso(200), child_cwd: '/work/grok-wt',
      effective_model_id: 'grok-4.6-fast',
    }))
    await writeFile(join(childDir, 'summary.json'), grokSummary(GROK_CHILD, '/work/grok-wt', {
      created_at: iso(500), session_kind: 'subagent', session_summary: 'Find the parser',
    }))
    await writeFile(join(childDir, 'updates.jsonl'), jsonl([grokPrompt('Find the parser', 0, 500, GROK_CHILD)]))
    // A child whose parent never wrote a binding: better an orphan than invisible.
    await writeFile(join(orphanDir, 'summary.json'), grokSummary(GROK_ORPHAN, '/work/grok', {
      created_at: iso(2000), session_kind: 'subagent', session_summary: 'Unbound helper',
    }))
    await writeFile(join(orphanDir, 'updates.jsonl'), jsonl([grokPrompt('Orphaned work', 0, 2000, GROK_ORPHAN)]))
    index = new SessionIndex({ roots: [{ kind: 'grok', dir: root }], watch: false, now: () => T0 + 60_000 })
    await index.start()
  })

  afterEach(async () => {
    index.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('titles a session from summary.json and binds a subagent under another encoded cwd', () => {
    const session = index.get('grok', GROK_MAIN)
    expect(session).toMatchObject({
      id: GROK_MAIN, kind: 'grok', title: 'Grok status line', cwd: '/work/grok',
      model: 'grok-4.6', startedAt: T0, childCount: 1, promptCount: 1,
    })
    expect(session?.files.map(file => `${file.role}:${file.id}`)).toEqual([`main:${GROK_MAIN}`, `child:${GROK_CHILD}`])
    // grok records no spawning tool-call id, so `toolUseId` stays unset (§D.4).
    expect(session?.files[1]).toMatchObject({
      parentId: GROK_MAIN,
      agent: { agentId: GROK_CHILD, description: 'Find the parser', agentType: 'general-purpose', model: 'grok-4.6-fast' },
    })
    expect(session?.files[1]?.agent?.toolUseId).toBeUndefined()
    expect(index.hasChild('grok', GROK_MAIN, GROK_CHILD)).toBe(true)
    expect(index.get('grok', GROK_CHILD)).toBeUndefined()
  })

  it('registers an unbindable subagent as a session of its own', () => {
    expect(index.list().map(session => session.id).sort())
      .toEqual([GROK_MAIN, GROK_ORPHAN].sort())
    expect(index.get('grok', GROK_ORPHAN)).toMatchObject({
      title: 'Unbound helper', cwd: '/work/grok', childCount: 0, promptCount: 1,
    })
  })

  it('re-homes a child that registered before its parent wrote the binding', async () => {
    const orphanPath = join(root, '%2Fwork%2Fgrok', GROK_ORPHAN, 'updates.jsonl')
    // Grok creates the child's directory and appends to `updates.jsonl` before
    // it writes `subagents/<id>/meta.json`, so the first probe finds no parent.
    expect(index.list().map(session => session.id)).toContain(GROK_ORPHAN)
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('grok', GROK_MAIN, event => events.push(event))
    await mkdir(join(mainDir, 'subagents', GROK_ORPHAN), { recursive: true })
    await writeFile(join(mainDir, 'subagents', GROK_ORPHAN, 'meta.json'), JSON.stringify({
      subagent_id: GROK_ORPHAN, parent_session_id: GROK_MAIN, child_session_id: GROK_ORPHAN,
      subagent_type: 'explore', description: 'Unbound helper', status: 'running', started_at: iso(2000),
    }))
    await index.refreshPath(orphanPath)
    expect(index.list().map(session => session.id)).toEqual([GROK_MAIN])
    expect(index.get('grok', GROK_ORPHAN)).toBeUndefined()
    expect(index.hasChild('grok', GROK_MAIN, GROK_ORPHAN)).toBe(true)
    const session = index.get('grok', GROK_MAIN)
    expect(session?.childCount).toBe(2)
    expect(session?.files.find(file => file.id === GROK_ORPHAN)).toMatchObject({
      role: 'child',
      parentId: GROK_MAIN,
      agent: { agentId: GROK_ORPHAN, description: 'Unbound helper', agentType: 'explore' },
    })
    // The parent's watchers learn about the new child file, as for one that
    // appeared while they were watching.
    const announced = events.find(event => event.type === 'file')
    expect(announced?.type === 'file' && announced.file.id).toBe(GROK_ORPHAN)
    unsubscribe()
  })

  it('re-homes a child whose summary.json did not exist yet either', async () => {
    const lateId = '01a09b3c-3333-7073-b766-838477500003'
    const lateDir = join(root, '%2Fwork%2Fgrok', lateId)
    await mkdir(lateDir, { recursive: true })
    await writeFile(join(lateDir, 'updates.jsonl'), jsonl([grokPrompt('Late helper', 0, 3000, lateId)]))
    // Registered with no `summary.json` at all: nothing says it is a subagent.
    await index.refreshPath(join(lateDir, 'updates.jsonl'))
    expect(index.list().map(session => session.id)).toContain(lateId)
    await writeFile(join(lateDir, 'summary.json'), grokSummary(lateId, '/work/grok', {
      created_at: iso(3000), session_kind: 'subagent', session_summary: 'Late helper', hidden: true,
    }))
    await mkdir(join(mainDir, 'subagents', lateId), { recursive: true })
    await writeFile(join(mainDir, 'subagents', lateId, 'meta.json'), JSON.stringify({
      subagent_id: lateId, parent_session_id: GROK_MAIN, child_session_id: lateId,
      subagent_type: 'general-purpose', description: 'Late helper', status: 'running', started_at: iso(3000),
    }))
    await index.refreshPath(join(lateDir, 'updates.jsonl'))
    expect(index.get('grok', lateId)).toBeUndefined()
    expect(index.hasChild('grok', GROK_MAIN, lateId)).toBe(true)
  })

  it('replays the sidecar first, carrying the system prompt, the tool schemas, and the summary', async () => {
    const replay: SessionLiveEvent[] = []
    await index.readAll('grok', GROK_MAIN, event => replay.push(event))
    const first = replay.find(event => event.type === 'lines')
    expect(first?.type === 'lines' && first.file.id).toBe(GROK_MAIN)
    // The sidecar is in no file: it rides its own event with a negative
    // `startLine`, so `updates.jsonl` still starts at line 0.
    const mainChunks = replay.filter(event => event.type === 'lines' && event.file.id === GROK_MAIN)
    // The child's own line falls between the parent's two by time, so the main
    // file arrives in two chunks — still numbered 0 and 1.
    expect(mainChunks.map(event => (event.type === 'lines' ? [event.startLine, event.lines.length] : [])))
      .toEqual([[-1, 1], [0, 1], [1, 1]])
    const line: unknown = JSON.parse((first?.type === 'lines' && first.lines[0]) || '{}')
    expect(line).toMatchObject({
      timestamp: Math.floor(T0 / 1000),
      method: GROK_SIDECAR_METHOD,
      params: {
        sessionId: GROK_MAIN,
        systemPrompt,
        toolDefinitions,
        summary: { info: { cwd: '/work/grok' }, session_summary: 'Grok status line', current_model_id: 'grok-4.6' },
      },
    })
  })

  it('re-sends the sidecar and the title when summary.json is rewritten', async () => {
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('grok', GROK_MAIN, event => events.push(event))
    const summaryPath = join(mainDir, 'summary.json')
    await writeFile(summaryPath, grokSummary(GROK_MAIN, '/work/grok', {
      session_summary: 'Renamed mid-session', updated_at: iso(9000),
    }))
    // Force a distinct mtime so the change is unambiguous on every filesystem.
    await utimes(summaryPath, new Date(T0 + 3_600_000), new Date(T0 + 3_600_000))
    await index.refreshPath(join(mainDir, 'updates.jsonl'))
    expect(events.map(event => event.type)).toEqual(['lines', 'meta'])
    const [lines] = events
    expect(lines?.type === 'lines' && lines.lines).toHaveLength(1)
    expect(lines?.type === 'lines' && lines.startLine).toBe(-1)
    const sidecar: unknown = JSON.parse((lines?.type === 'lines' && lines.lines[0]) || '{}')
    expect(sidecar).toMatchObject({ method: GROK_SIDECAR_METHOD, params: { summary: { session_summary: 'Renamed mid-session' } } })
    expect(index.get('grok', GROK_MAIN)?.title).toBe('Renamed mid-session')
    // grok patches `num_messages`/`updated_at` into summary.json on essentially
    // every appended line, so a fresh mtime is the steady state: the ~60 KB
    // sidecar is only re-sent when its content actually differs.
    events.length = 0
    await writeFile(summaryPath, grokSummary(GROK_MAIN, '/work/grok', {
      session_summary: 'Renamed mid-session', updated_at: iso(9000), num_messages: 9,
    }))
    await utimes(summaryPath, new Date(T0 + 7_200_000), new Date(T0 + 7_200_000))
    await index.refreshPath(join(mainDir, 'updates.jsonl'))
    expect(events).toEqual([])
    unsubscribe()
  })
})

describe('SessionIndex Codex lineage and compression', () => {
  let dir: string
  let index: SessionIndex

  const THREAD = '0199aaaa-0000-7000-8000-00000000000a'
  const HEAD = '0199aaaa-0000-7000-8000-00000000000c'
  const FORK_THREAD = '0199aaaa-0000-7000-8000-00000000000d'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-codex-'))
    await mkdir(join(dir, 'codex', '2026', '09', '14'), { recursive: true })
  })

  afterEach(async () => {
    index?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const codexDir = () => join(dir, 'codex', '2026', '09', '14')
  const rolloutPath = (name: string) => join(codexDir(), `${name}.jsonl`)

  async function startIndex(): Promise<SessionIndex> {
    index = new SessionIndex({ roots: [{ kind: 'codex', dir: join(dir, 'codex') }], watch: false })
    await index.start()
    return index
  }

  /** All `lines` payloads of a replay, flattened in order. */
  async function replayLines(idx: SessionIndex, id: string): Promise<unknown[]> {
    const records: unknown[] = []
    await idx.readAll('codex', id, event => {
      if (event.type === 'lines') for (const line of event.lines) records.push(JSON.parse(line))
    })
    return records
  }

  const textOf = (record: unknown) =>
    (record as { payload?: { content?: { text?: string }[] } }).payload?.content?.[0]?.text
  /** Message texts only — `session_meta` lines carry no content. */
  const texts = (records: readonly unknown[]) => records.map(textOf).filter(text => text !== undefined)

  it('lists a .jsonl.zst rollout and replays its decoded records', async () => {
    if (!zstdSupported()) return
    const body = jsonl([codexMeta(THREAD, 0), codexUser('Cold prompt', 10)])
    await writeFile(`${rolloutPath(`rollout-2026-09-14T10-00-00-${THREAD}`)}.zst`, zlib.zstdCompressSync(Buffer.from(body)))
    await startIndex()
    const session = index.get('codex', THREAD)
    expect(session).toMatchObject({ title: 'Cold prompt', promptCount: 1 })
    expect(texts(await replayLines(index, THREAD))).toEqual(['Cold prompt'])
  })

  it('prefers the plain file over a .zst twin — one session, not two', async () => {
    if (!zstdSupported()) return
    const name = `rollout-2026-09-14T10-00-00-${THREAD}`
    await writeFile(`${rolloutPath(name)}.zst`, zlib.zstdCompressSync(Buffer.from(jsonl([codexMeta(THREAD, 0), codexUser('Compressed', 10)]))))
    await writeFile(rolloutPath(name), jsonl([codexMeta(THREAD, 0), codexUser('Plain', 10)]))
    await startIndex()
    expect(index.list().filter(session => session.kind === 'codex')).toHaveLength(1)
    expect(texts(await replayLines(index, THREAD))).toEqual(['Plain'])
  })

  it('rebuilds a reverted thread from history_base and hides the superseded file', async () => {
    const baseName = `rollout-2026-09-14T09-00-00-${THREAD}`
    const headName = `rollout-2026-09-14T10-00-00-${THREAD}_${HEAD}`
    const baseLines = [JSON.stringify(codexMeta(THREAD, 0)), JSON.stringify(codexUser('Kept one', 10)), JSON.stringify(codexUser('Kept two', 20)), JSON.stringify(codexUser('Rolled back', 30))]
    const cut = Buffer.byteLength(`${baseLines.slice(0, 3).join('\n')}\n`)
    await writeFile(rolloutPath(baseName), `${baseLines.join('\n')}\n`)
    // `history_base.thread_id` references the base *rollout* id — the
    // single-UUID base file's rollout id is that UUID itself.
    await writeFile(rolloutPath(headName), jsonl([
      codexMeta(THREAD, 40, undefined, { history_base: { thread_id: THREAD, end_ordinal_exclusive: 3, end_byte_offset: cut } }),
      codexUser('After revert', 50),
    ]))
    await startIndex()
    // One session; the superseded rollout never lists on its own.
    expect(index.list().filter(session => session.kind === 'codex')).toHaveLength(1)
    expect(texts(await replayLines(index, THREAD))).toEqual(['Kept one', 'Kept two', 'After revert'])
  })

  it('lets a forked thread inherit another thread’s prefix without hiding the base session', async () => {
    const baseName = `rollout-2026-09-14T09-00-00-${THREAD}`
    const forkName = `rollout-2026-09-14T10-00-00-${FORK_THREAD}_${HEAD}`
    const baseLines = [JSON.stringify(codexMeta(THREAD, 0)), JSON.stringify(codexUser('Shared history', 10))]
    const cut = Buffer.byteLength(`${baseLines.join('\n')}\n`)
    await writeFile(rolloutPath(baseName), `${baseLines.join('\n')}\n`)
    await writeFile(rolloutPath(forkName), jsonl([
      codexMeta(FORK_THREAD, 40, undefined, { history_base: { thread_id: THREAD, end_ordinal_exclusive: 2, end_byte_offset: cut } }),
      codexUser('Fork prompt', 50),
    ]))
    await startIndex()
    expect(index.list().filter(session => session.kind === 'codex').map(session => session.id).sort())
      .toEqual([FORK_THREAD, THREAD].sort())
    expect(texts(await replayLines(index, FORK_THREAD))).toEqual(['Shared history', 'Fork prompt'])
  })

  it('re-resolves a base that appears after the head consumed', async () => {
    const baseName = `rollout-2026-09-14T09-00-00-${THREAD}`
    const headName = `rollout-2026-09-14T10-00-00-${THREAD}_${HEAD}`
    const baseLines = [JSON.stringify(codexMeta(THREAD, 0)), JSON.stringify(codexUser('Late base', 10))]
    const cut = Buffer.byteLength(`${baseLines.join('\n')}\n`)
    const headPath = rolloutPath(headName)
    await writeFile(headPath, jsonl([
      codexMeta(THREAD, 40, undefined, { history_base: { thread_id: THREAD, end_ordinal_exclusive: 2, end_byte_offset: cut } }),
      codexUser('After revert', 50),
    ]))
    await startIndex()
    expect(texts(await replayLines(index, THREAD))).toEqual(['After revert'])
    // The base lands later; registering it re-reads the head with the prefix.
    const basePath = rolloutPath(baseName)
    await writeFile(basePath, `${baseLines.join('\n')}\n`)
    await index.refreshPath(basePath)
    expect(texts(await replayLines(index, THREAD))).toEqual(['Late base', 'After revert'])
    expect(index.list().filter(session => session.kind === 'codex')).toHaveLength(1)
  })

  it('migrates an entry when Codex materializes a .zst back to .jsonl', async () => {
    if (!zstdSupported()) return
    const name = `rollout-2026-09-14T10-00-00-${THREAD}`
    const body = jsonl([codexMeta(THREAD, 0), codexUser('Cold prompt', 10)])
    const compressedPath = `${rolloutPath(name)}.zst`
    await writeFile(compressedPath, zlib.zstdCompressSync(Buffer.from(body)))
    await startIndex()
    expect(texts(await replayLines(index, THREAD))).toEqual(['Cold prompt'])
    // Codex deletes the archive and resumes appending on the plain file.
    await rm(compressedPath)
    const plainPath = rolloutPath(name)
    await writeFile(plainPath, `${body}${JSON.stringify(codexUser('Resumed', 20))}\n`)
    await index.refreshPath(plainPath)
    expect(texts(await replayLines(index, THREAD))).toEqual(['Cold prompt', 'Resumed'])
  })

  it('resets an open session when a live revert replaces the head', async () => {
    // Revert: a NEW rollout file branches off the still-on-disk old head, so
    // the demote lands while a viewer is already subscribed.
    const oldHead = `rollout-2026-09-14T10-00-00-${THREAD}_${HEAD}`
    const oldLines = [codexMeta(THREAD, 0), codexUser('v1', 10)]
    await writeFile(rolloutPath(oldHead), jsonl(oldLines))
    await startIndex()
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('codex', THREAD, event => events.push(event))
    const newHead = `rollout-2026-09-14T11-00-00-${THREAD}_0199aaaa-0000-7000-8000-00000000000e`
    await writeFile(rolloutPath(newHead), jsonl([
      codexMeta(THREAD, 40, undefined, {
        history_base: { thread_id: HEAD, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(jsonl(oldLines)) },
      }),
      codexUser('v2', 50),
    ]))
    await index.refreshPath(rolloutPath(newHead))
    unsubscribe()
    expect(events.some(event => event.type === 'file' && event.file.id === THREAD && event.reset === true))
      .toBe(true)
    expect(texts(await replayLines(index, THREAD))).toEqual(['v1', 'v2'])
    expect(index.list().filter(session => session.kind === 'codex')).toHaveLength(1)
  })

  it('resets the open child file event when a live revert replaces the child head', async () => {
    const CHILD = '0199aaaa-0000-7000-8000-00000000000f'
    const oldChild = `rollout-2026-09-14T10-30-00-${CHILD}_0199aaaa-0000-7000-8000-000000000010`
    const childLines = [codexMeta(CHILD, 30, THREAD), codexUser('child v1', 40)]
    await writeFile(rolloutPath(`rollout-2026-09-14T10-00-00-${THREAD}`), jsonl([
      codexMeta(THREAD, 0), codexUser('parent', 10),
    ]))
    await writeFile(rolloutPath(oldChild), jsonl(childLines))
    await startIndex()
    const events: SessionLiveEvent[] = []
    const unsubscribe = index.subscribe('codex', THREAD, event => events.push(event))
    const newChild = `rollout-2026-09-14T11-30-00-${CHILD}_0199aaaa-0000-7000-8000-000000000011`
    await writeFile(rolloutPath(newChild), jsonl([
      codexMeta(CHILD, 50, THREAD, {
        history_base: {
          thread_id: '0199aaaa-0000-7000-8000-000000000010',
          end_ordinal_exclusive: 2,
          end_byte_offset: Buffer.byteLength(jsonl(childLines)),
        },
      }),
      codexUser('child v2', 60),
    ]))
    await index.refreshPath(rolloutPath(newChild))
    unsubscribe()
    // A follow-up `file` event without `reset` can trail this one (the child
    // listing stamp), so assert the reset itself arrived rather than the tail.
    expect(events.some(event => event.type === 'file' && event.file.id === CHILD && event.reset === true))
      .toBe(true)
    // The reverted child still surfaces as the parent's child transcript.
    expect(index.hasChild('codex', THREAD, CHILD)).toBe(true)
  })

  it('indexes child-owned ordinals with a missing base and preserves physical search anchors', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const search = new SearchIndexer({ store, extract: extractSearchDocs, maxAgeDays: 0 })
    const childPath = rolloutPath(`rollout-2026-09-14T10-00-00-${FORK_THREAD}`)
    const ordinal = (record: object, value: number) => ({ ...record, ordinal: value })
    try {
      await writeFile(rolloutPath(`rollout-2026-09-14T09-00-00-${THREAD}`), jsonl([codexMeta(THREAD, 0)]))
      await writeFile(childPath, jsonl([
        ordinal(codexMeta(FORK_THREAD, 10, THREAD, {
          subagent_history_start_ordinal: 11,
          history_base: { thread_id: HEAD, end_byte_offset: 100, end_ordinal_exclusive: 10 },
        }), 10),
        ordinal(codexUser('own child prompt', 11), 11),
      ]))
      index = new SessionIndex({ roots: [{ kind: 'codex', dir: join(dir, 'codex') }], watch: false, search })
      await index.start()
      search.flush()
      expect(index.get('codex', THREAD)?.children[0]).toMatchObject({ file: { agent: { description: 'own child prompt' } } })
      const rows = store.db.prepare(
        'select docs.line, texts.text from docs join texts on texts.id = docs.text',
      ).all() as { line: number; text: Uint8Array }[]
      expect(rows.map(row => [row.line, unpackText(row.text)])).toEqual([[1, 'own child prompt']])
    } finally {
      index?.stop()
      search.stop()
      store.close()
    }
  })

  it('rebuilds listing and search when a missing base appears across a restart', async () => {
    const listingPath = join(dir, 'listing.sqlite')
    const searchPath = join(dir, 'search.sqlite')
    const baseName = `rollout-2026-09-14T09-00-00-${THREAD}`
    const headName = `rollout-2026-09-14T10-00-00-${THREAD}_${HEAD}`
    const baseLines = [JSON.stringify(codexMeta(THREAD, 0)), JSON.stringify(codexUser('inherited needle', 10))]
    const cut = Buffer.byteLength(`${baseLines.join('\n')}\n`)
    const headPath = rolloutPath(headName)
    await writeFile(headPath, jsonl([
      codexMeta(THREAD, 40, undefined, { history_base: { thread_id: THREAD, end_ordinal_exclusive: 2, end_byte_offset: cut } }),
      codexUser('head needle', 50),
    ]))
    const boot = async () => {
      const store = new SearchStore({ path: searchPath })
      const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs })
      index = new SessionIndex({
        roots: [{ kind: 'codex', dir: join(dir, 'codex') }],
        watch: false,
        listing: new ListingCache({ path: listingPath }),
        search: indexer,
      })
      await index.start()
      indexer.flush()
      return { store, indexer }
    }
    // First boot: the base is missing, so the head indexes alone.
    let { store, indexer } = await boot()
    expect(texts(await replayLines(index, THREAD))).toEqual(['head needle'])
    index.stop()
    indexer.stop()
    store.close()
    // The base lands while the server is down; the next boot re-reads the
    // whole logical stream — the stored `w` (waiting bases) footprint entry
    // invalidates both the listing row and the indexed lines.
    await writeFile(rolloutPath(baseName), `${baseLines.join('\n')}\n`)
    ;({ store, indexer } = await boot())
    expect(texts(await replayLines(index, THREAD))).toEqual(['inherited needle', 'head needle'])
    const rows = store.db.prepare(
      `select docs.line as line, texts.text as text
       from docs join files on docs.file = files.id join texts on texts.id = docs.text
       where files.path = ? order by docs.line`,
    ).all(headPath) as { line: number, text: Uint8Array }[]
    // Lines count the logical stream — the two `session_meta` records take
    // indexes 0 and 2, so the indexed docs land on 1 and 3.
    expect(rows.map(row => [row.line, unpackText(row.text)]))
      .toEqual([[1, 'inherited needle'], [3, 'head needle']])
    index.stop()
    indexer.stop()
    store.close()
  })
})

describe.skipIf(!zstdSupported())('SessionIndex — dsh', () => {
  let dir: string
  let index: SessionIndex | undefined

  /** `<root>/sessions/<encoded-cwd>/<session-id>/` — the sessions root mirrors `$DSH_HOME/sessions`. */
  const sessionDir = (id: string) => join(dir, 'dsh', 'sessions', '--work-dsh--', id)
  const dshRoot = () => join(dir, 'dsh', 'sessions')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-dsh-'))
  })

  afterEach(async () => {
    index?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  async function startIndex(): Promise<SessionIndex> {
    index = new SessionIndex({ roots: [{ kind: 'dsh', dir: dshRoot() }], watch: false })
    await index.start()
    return index
  }

  /** All `lines` payloads of a replay, flattened in order. */
  async function replayLines(idx: SessionIndex, id: string): Promise<unknown[]> {
    const records: unknown[] = []
    await idx.readAll('dsh', id, event => {
      if (event.type === 'lines') for (const line of event.lines) records.push(JSON.parse(line))
    })
    return records
  }

  it('registers one session for a directory holding several generations', async () => {
    const home = sessionDir(DSH_MAIN)
    await mkdir(home, { recursive: true })
    // The v0 log and the seeded v3 successor sit side by side; only the
    // current (highest-version) generation is the session's transcript.
    await writeFile(join(home, 'session.jsonl.zstd'), dshFrames(jsonl([
      dshHeader(DSH_MAIN, { version: 0 }), dshUser('Old generation', 1, 10),
    ])))
    await writeFile(join(home, 'session.v3.jsonl.zstd'), dshFrames(jsonl([
      dshHeader(DSH_MAIN, { isSeeded: true }), dshUser('Current generation', 1, 10),
    ])))
    await startIndex()
    expect(index?.list().filter(session => session.kind === 'dsh')).toHaveLength(1)
    const session = index?.get('dsh', DSH_MAIN)
    expect(session).toMatchObject({ title: 'Current generation', cwd: '/work/dsh', promptCount: 1 })
    const texts = (await replayLines(index!, DSH_MAIN))
      .map(record => (record as { type: string }).type)
    expect(texts).toEqual(['session', 'user/message'])
  })

  it('binds a subagent child through its header and stamps the spawn description', async () => {
    const main = sessionDir(DSH_MAIN)
    const child = sessionDir(DSH_CHILD)
    await mkdir(main, { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(join(main, 'session.v3.jsonl.zstd'), dshFrames(jsonl([
      dshHeader(DSH_MAIN),
      dshUser('Top-level work', 1, 10),
      dshEvent('tool/call', 2, 20, { callId: 'call-1', name: 'subagent', arguments: '{"description":"Scout the repo"}' }),
      dshEvent('tool/result', 3, 30, {
        message: {
          source: { callId: 'call-1' },
          content: [{
            type: 'tool-result', toolCallId: 'call-1',
            content: [{ type: 'text', text: `started subagent ${DSH_CHILD}` }],
          }],
        },
      }),
    ])))
    await writeFile(join(child, 'session.v3.jsonl.zstd'), dshFrames(jsonl([
      dshHeader(DSH_CHILD, { origin: 'subagent', parentSession: DSH_MAIN }),
      dshUser('child prompt', 1, 25),
    ])))
    await startIndex()
    const session = index?.get('dsh', DSH_MAIN)
    expect(session).toMatchObject({ childCount: 1 })
    expect(session?.files.map(file => file.role)).toEqual(['main', 'child'])
    expect(session?.files[1]).toMatchObject({
      id: DSH_CHILD, parentId: DSH_MAIN,
      agent: { agentId: DSH_CHILD, description: 'Scout the repo', toolUseId: 'call-1' },
    })
    // The child is not a session of its own.
    expect(index?.get('dsh', DSH_CHILD)).toBeUndefined()
    // A fork names `parentSession` WITHOUT the subagent origin — it stays a session.
    const fork = sessionDir('session-fork-0003')
    await mkdir(fork, { recursive: true })
    await writeFile(join(fork, 'session.v3.jsonl.zstd'), dshFrames(jsonl([
      dshHeader('session-fork-0003', { parentSession: DSH_MAIN }),
      dshUser('fork prompt', 1, 40),
    ])))
    await index?.refreshPath(join(fork, 'session.v3.jsonl.zstd'))
    expect(index?.get('dsh', 'session-fork-0003')).toMatchObject({ title: 'fork prompt' })
  })

  it('re-points the entry at a newly published generation with a file reset', async () => {
    const home = sessionDir(DSH_MAIN)
    await mkdir(home, { recursive: true })
    const v0 = join(home, 'session.jsonl.zstd')
    await writeFile(v0, dshFrames(jsonl([
      dshHeader(DSH_MAIN, { version: 0 }), dshUser('Before migration', 1, 10),
    ])))
    const idx = await startIndex()
    const events: SessionLiveEvent[] = []
    const unsubscribe = idx.subscribe('dsh', DSH_MAIN, event => events.push(event))
    expect(idx.get('dsh', DSH_MAIN)?.files[0]?.path).toBe(v0)
    // A resume publishes the seeded successor: a transformed prefix plus new records.
    const v3 = join(home, 'session.v3.jsonl.zstd')
    await writeFile(v3, dshFrames(jsonl([
      dshHeader(DSH_MAIN, { isSeeded: true }), dshUser('Inherited prompt', 1, 10),
      dshUser('After migration', 2, 20),
    ])))
    // The watch event names the NEW file; the entry migrates to it.
    await idx.refreshPath(v3)
    expect(idx.get('dsh', DSH_MAIN)?.files[0]?.path).toBe(v3)
    const resets = events.filter(event => event.type === 'file' && event.reset === true)
    expect(resets).toHaveLength(1)
    const lines = await replayLines(idx, DSH_MAIN)
    expect(lines.map(record => (record as { type: string }).type))
      .toEqual(['session', 'user/message', 'user/message'])
    unsubscribe()
  })

  it('migrates to a generation published while the entry was registered', async () => {
    const home = sessionDir(DSH_MAIN)
    await mkdir(home, { recursive: true })
    // Only v0 exists at registration; v3 lands later, named by a stale-path refresh.
    const v0 = join(home, 'session.jsonl.zstd')
    await writeFile(v0, dshFrames(jsonl([dshHeader(DSH_MAIN), dshUser('v0 prompt', 1, 10)])))
    const idx = await startIndex()
    const v3 = join(home, 'session.v3.jsonl.zstd')
    await writeFile(v3, dshFrames(jsonl([
      dshHeader(DSH_MAIN, { isSeeded: true }), dshUser('v3 prompt', 1, 10),
    ])))
    // The refresh names the OLD path (a watcher may fire on either file).
    await idx.refreshPath(v0)
    expect(idx.get('dsh', DSH_MAIN)?.files[0]?.path).toBe(v3)
    const lines = await replayLines(idx, DSH_MAIN)
    expect((lines[1] as { data?: { content?: { text?: string }[] } }).data?.content?.[0]?.text)
      .toBe('v3 prompt')
  })

  it('re-homes a file registered before its first frame completed', async () => {
    const main = sessionDir(DSH_MAIN)
    const child = sessionDir(DSH_CHILD)
    await mkdir(main, { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(join(main, 'session.v3.jsonl.zstd'), dshFrames(jsonl([
      dshHeader(DSH_MAIN), dshUser('parent prompt', 1, 10),
    ])))
    const childPath = join(child, 'session.v3.jsonl.zstd')
    // The watcher fires on file creation: the first frame is still torn.
    const frame = dshFrame(jsonl([
      dshHeader(DSH_CHILD, { origin: 'subagent', parentSession: DSH_MAIN }),
      dshUser('child prompt', 1, 20),
    ]))
    await writeFile(childPath, frame.subarray(0, 8))
    const idx = await startIndex()
    // Registered as a main session: the header was unreadable.
    expect(idx.get('dsh', DSH_CHILD)).toBeDefined()
    // The flush completes; the first consumed line settles the role.
    await writeFile(childPath, frame)
    await idx.refreshPath(childPath)
    expect(idx.get('dsh', DSH_CHILD)).toBeUndefined()
    const parent = idx.get('dsh', DSH_MAIN)
    expect(parent?.files.map(file => file.role)).toEqual(['main', 'child'])
    expect(parent?.files[1]).toMatchObject({ id: DSH_CHILD, parentId: DSH_MAIN })
  })

  it('resolves blobref hashes against the global attachment store', async () => {
    const home = sessionDir(DSH_MAIN)
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'session.v3.jsonl.zstd'), dshFrames(jsonl([
      dshHeader(DSH_MAIN), dshUser('look at this', 1, 10),
    ])))
    const idx = await startIndex()
    const hash = 'a'.repeat(64)
    // `<root>/sessions` → `<dshHome>/attachments/v1/objects/<2-hex>/<sha256>`.
    expect(idx.blobPath('dsh', DSH_MAIN, DSH_MAIN, hash))
      .toBe(join(dir, 'dsh', 'attachments', 'v1', 'objects', 'aa', hash))
    expect(idx.blobPath('dsh', DSH_MAIN, DSH_MAIN, 'not-a-hash')).toBeNull()
    expect(idx.blobPath('dsh', 'missing', 'missing', hash)).toBeNull()
  })

  it('backfills search across a zstd frame larger than the read window', async () => {
    const home = sessionDir(DSH_MAIN)
    await mkdir(home, { recursive: true })
    // One frame bigger than the 8 MiB read window: incompressible padding
    // keeps its compressed size above INITIAL_CHUNK_BYTES, so a bounded read
    // ending inside it yields zero progress without being a torn tail.
    const pad = randomBytes(9 * 1024 * 1024).toString('base64')
    const head = jsonl([dshHeader(DSH_MAIN), dshUser('early needle', 1, 10)])
    const tail = jsonl([
      dshEvent('turn/start', 2, 20, { pad }),
      dshUser('late needle', 3, 30),
    ])
    await writeFile(join(home, 'session.jsonl.zstd'), dshFrames(head, tail))
    const idx = await startIndex()
    const store = new SearchStore({ path: ':memory:' })
    const search = new SearchIndexer({ store, extract: extractSearchDocs, maxAgeDays: 0 })
    try {
      // Search attaches mid-run: historical lines are re-read from disk
      // through bounded windows instead of the consume path.
      await idx.enableSearch(search)
      search.flush()
      const rows = store.db.prepare(
        'select docs.line, texts.text from docs join texts on texts.id = docs.text order by docs.line',
      ).all() as { line: number; text: Uint8Array }[]
      expect(rows.map(row => [row.line, unpackText(row.text)]))
        .toEqual([[1, 'early needle'], [3, 'late needle']])
    } finally {
      search.stop()
      store.close()
    }
  }, 30000)
})

describe('SessionIndex start can be cancelled', () => {
  it('stop() during start() returns and does not hang', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-stop-'))
    try {
      await mkdir(join(dir, 'claude', '-slug'), { recursive: true })
      await writeFile(join(dir, 'claude', '-slug', 'main-1.jsonl'), jsonl([
        claudeUser('A prompt', 'main-1', 0),
      ]))
      const index = new SessionIndex({
        roots: [{ kind: 'claude', dir: join(dir, 'claude') }],
        watch: false,
      })
      const running = index.start()
      index.stop()
      await running
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
