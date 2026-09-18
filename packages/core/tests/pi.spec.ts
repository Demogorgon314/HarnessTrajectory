/**
 * pi adapter — synthetic fixtures only.
 *
 * Every record below is hand-written with the REAL pi wire field names
 * (`parentId`, `stopReason`, `cacheRead`, `firstKeptEntryId`, …) and fake
 * payloads ("hello", `/tmp/a.ts`). No transcript content is copied here.
 * Entry `timestamp` is an ISO string; the nested `message.timestamp` is epoch
 * MILLISECONDS and must never be used as the record time.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  createPiParser, isPiHumanPrompt, parsePiLine, piContentText, PiPromptState, PiSessionTree,
} from '../src/adapters/pi.ts'
import type { SessionFileRef, SessionParser } from '../src/session.ts'
import type {
  AssistantMessageNode, CompactionSummaryNode, ContextMessageNode, ToolResultNode,
} from '../src/contract.ts'

const MAIN: SessionFileRef = {
  id: 'session-1',
  role: 'main',
  path: '/tmp/sessions/--work-project--/2026-01-01T00-00-00-000Z_session-1.jsonl',
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString()
}

interface Extra { [key: string]: unknown }

let entrySeq = 0
let lastId: string | null = null
function entryId(): string {
  entrySeq += 1
  return entrySeq.toString(16).padStart(8, '0')
}

/**
 * Real transcripts chain parentId linearly; omitting it here chains onto the
 * previously generated id so `parentId: null` keeps meaning "new root".
 */
function entry(type: string, offsetMs: number, body: Extra = {}, parentId?: string | null): Extra {
  const id = entryId()
  const record = { type, id, parentId: parentId === undefined ? lastId : parentId, timestamp: at(offsetMs), ...body }
  lastId = id
  return record
}

const header = () => ({
  type: 'session', version: 3, id: 'session-1', timestamp: at(0), cwd: '/work/project',
})

function systemMessage(offsetMs: number, body: Extra = {}, parentId?: string | null): Extra {
  return entry('message', offsetMs, {
    message: { role: 'system', timestamp: T0 + offsetMs, ...body },
  }, parentId)
}

function userMessage(offsetMs: number, content: unknown, parentId?: string | null): Extra {
  return entry('message', offsetMs, {
    message: { role: 'user', content, timestamp: T0 + offsetMs },
  }, parentId)
}

function assistantMessage(
  offsetMs: number,
  content: readonly Extra[],
  options: { stop?: string; usage?: Extra; extra?: Extra; parentId?: string | null } = {},
): Extra {
  return entry('message', offsetMs, {
    message: {
      role: 'assistant',
      content,
      api: 'openai-completions',
      provider: 'openai',
      model: 'pi-test-1',
      usage: options.usage ?? { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.01 } },
      stopReason: options.stop ?? 'stop',
      timestamp: T0 + offsetMs,
      ...options.extra,
    },
  }, options.parentId)
}

function toolResultMessage(
  offsetMs: number,
  callId: string,
  content: unknown,
  options: { isError?: boolean; parentId?: string | null } = {},
): Extra {
  return entry('message', offsetMs, {
    message: {
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'read',
      content,
      isError: options.isError ?? false,
      timestamp: T0 + offsetMs,
    },
  }, options.parentId)
}

function feed(parser: SessionParser, records: readonly unknown[]): void {
  records.forEach((record, index) => {
    parser.push(typeof record === 'string' ? record : JSON.stringify(record), MAIN, index)
  })
}

function assistants(parser: SessionParser): AssistantMessageNode[] {
  return parser.snapshot().eventNodes.filter((node): node is AssistantMessageNode => node.kind === 'assistant')
}

describe('pi adapter', () => {
  beforeEach(() => {
    entrySeq = 0
    lastId = null
  })

  it('folds a header + system + user + tool loop into nodes, requests, and prompt state', () => {
    const parser = createPiParser()
    feed(parser, [
      header(),
      systemMessage(100, {
        content: 'You are a test agent.',
        sections: { env: 'cwd=/work/project' },
        toolsAdded: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      }),
      userMessage(1_000, 'Fix the build'),
      assistantMessage(2_000, [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a.ts' } }], { stop: 'toolUse' }),
      toolResultMessage(3_000, 'call-1', [{ type: 'text', text: 'file body' }]),
      assistantMessage(4_000, [{ type: 'text', text: 'Done.' }]),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual([
      'user', 'assistant', 'tool-result', 'assistant',
    ])
    const steps = assistants(parser)
    expect(steps.map(node => [node.turn, node.step])).toEqual([[1, 1], [1, 2]])
    expect(steps[0]?.provenance).toEqual({ provider: 'openai', model: 'pi-test-1' })
    expect(steps[0]?.requestConfig).toEqual({ provider: 'openai', model: 'pi-test-1' })
    expect(steps[0]?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20 })
    const result = snapshot.eventNodes.find((node): node is ToolResultNode => node.kind === 'tool-result')
    expect(result?.call).toEqual({ name: 'read', argsRaw: '{"path":"/tmp/a.ts"}' })
    expect(snapshot.callSchemas.get('call-1')).toEqual({
      name: 'read', description: 'read a file', parameters: { type: 'object' },
    })
    expect(snapshot.requests).toHaveLength(2)
    const request = snapshot.requests[0]
    expect(request?.purpose).toBe('assistant')
    if (request?.purpose !== 'assistant') return
    expect(request.prompt?.system).toBe('You are a test agent.\n\ncwd=/work/project')
    expect(request.prompt?.tools).toEqual([{ name: 'read', description: 'read a file', parameters: { type: 'object' } }])
    expect(request.promptChange?.kind).toBe('initial')
    expect(snapshot.systemPrompts?.map(node => node.text)).toEqual(['You are a test agent.\n\ncwd=/work/project'])
    expect(snapshot.eventLocations.get(steps[1]?.seq ?? 0)).toEqual({ kind: 'turn', turn: { turn: 1, status: 'closed' } })
    expect(parser.meta()).toEqual({
      title: 'Fix the build', cwd: '/work/project', model: 'pi-test-1', startedAt: T0, promptCount: 1,
    })
  })

  it('folds a session with NO system messages; model comes from model_change', () => {
    const parser = createPiParser()
    feed(parser, [
      header(),
      { type: 'model_change', id: 'mc1', parentId: null, timestamp: at(50), provider: 'openai', modelId: 'pi-test-2' },
      userMessage(1_000, 'hello'),
      assistantMessage(2_000, [{ type: 'text', text: 'hi' }], { extra: { model: 'pi-test-1' } }),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'assistant'])
    expect(snapshot.systemPrompts).toBeUndefined()
    expect(parser.meta().model).toBe('pi-test-2')
    expect(parser.meta().promptCount).toBe(1)
  })

  it('folds a compaction entry into a compaction request and node; systemMessage updates prompts', () => {
    const parser = createPiParser()
    feed(parser, [
      header(),
      systemMessage(100, { content: 'Base.' }),
      userMessage(1_000, 'do things'),
      assistantMessage(2_000, [{ type: 'text', text: 'done' }]),
      entry('compaction', 3_000, {
        summary: 'Earlier we did things.',
        firstKeptEntryId: '00000002',
        tokensBefore: 12_345,
        usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.02 } },
        systemMessage: { role: 'system', sections: { compacted: 'state after compact' } },
      }),
    ])
    const snapshot = parser.snapshot()
    const node = snapshot.eventNodes.find((item): item is CompactionSummaryNode => item.kind === 'compaction')
    expect(node).toMatchObject({ summary: 'Earlier we did things.', shadowedTokenCount: 12_345 })
    const request = snapshot.requests.find(item => item.purpose === 'compaction')
    expect(request).toMatchObject({ status: 'complete', turn: 1 })
    expect(request?.usage?.inputTokens).toBe(100)
    // The compaction checkpoint REPLACES the replayed prompt.
    expect(snapshot.systemPrompts?.map(item => item.text)).toEqual(['Base.', 'state after compact'])
  })

  it("maps stopReason 'error' to a turn-error node and 'aborted' to an interrupted step", () => {
    const parser = createPiParser()
    feed(parser, [
      header(),
      userMessage(1_000, 'try'),
      assistantMessage(2_000, [{ type: 'text', text: '' }], { stop: 'error', extra: { errorMessage: 'rate limited' } }),
      userMessage(3_000, 'again'),
      assistantMessage(4_000, [{ type: 'text', text: 'partial' }], { stop: 'aborted' }),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual([
      'user', 'assistant', 'turn-error', 'user', 'assistant',
    ])
    const error = snapshot.eventNodes.find(node => node.kind === 'turn-error')
    expect(error).toMatchObject({ message: 'rate limited', turn: 1 })
    expect(snapshot.requests[0]).toMatchObject({ status: 'error', error: 'rate limited' })
    const aborted = assistants(parser)[1]
    expect(aborted?.interrupted).toBe(true)
    expect(snapshot.requests[1]).toMatchObject({ status: 'error', error: 'aborted' })
  })

  it('honours session_info, skips custom/label, and surfaces bashExecution + custom_message', () => {
    const parser = createPiParser()
    feed(parser, [
      header(),
      { type: 'session_info', id: 'si1', parentId: null, timestamp: at(50), name: 'My Session' },
      userMessage(1_000, 'first'),
      entry('custom', 1_100, { customType: 'shadow-mind-event', data: { beat: 1 } }),
      entry('label', 1_200, { targetId: 'x', label: 'note' }),
      entry('message', 1_300, {
        message: {
          role: 'bashExecution', command: 'ls -la', output: 'a\nb', exitCode: 0,
          cancelled: false, truncated: false, timestamp: T0 + 1_300,
        },
      }),
      entry('custom_message', 1_400, { customType: 'hook-note', content: 'injected note', display: true }),
    ])
    const snapshot = parser.snapshot()
    expect(snapshot.eventNodes.map(node => node.kind)).toEqual(['user', 'context', 'context'])
    const contexts = snapshot.eventNodes.filter((node): node is ContextMessageNode => node.kind === 'context')
    expect(contexts[0]?.provenance.label).toBe('bash-execution')
    expect(contexts[0]?.content[0]).toMatchObject({ type: 'text', text: '$ ls -la\na\nb\n[exit 0]' })
    expect(contexts[1]?.provenance.label).toBe('hook-note')
    expect(parser.meta().title).toBe('My Session')
    expect(parser.meta().promptCount).toBe(1)
  })

  it('isPiHumanPrompt and piContentText classify records structurally', () => {
    const human = parsePiLine(JSON.stringify(userMessage(0, 'hi')))
    const assistant = parsePiLine(JSON.stringify(assistantMessage(0, [{ type: 'text', text: 'x' }])))
    const info = parsePiLine(JSON.stringify({ type: 'session_info', id: 'i', parentId: null, timestamp: at(0), name: 'n' }))
    expect(human !== null && isPiHumanPrompt(human)).toBe(true)
    expect(assistant !== null && isPiHumanPrompt(assistant)).toBe(false)
    expect(info !== null && isPiHumanPrompt(info)).toBe(false)
    expect(piContentText('plain')).toBe('plain')
    expect(piContentText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(parsePiLine('not json')).toBeNull()
    expect(parsePiLine('{"type":"message"}')?.time).toBeNull()
  })

  it('PiPromptState replays content, section patches, and tool mutations', () => {
    const state = new PiPromptState()
    expect(state.seen).toBe(false)
    const first = state.apply({
      content: [{ type: 'text', text: 'Base.' }],
      sections: { env: 'one', scratch: 'tmp' },
      toolsAdded: [
        { name: 'read', description: 'r', parameters: { type: 'object' } },
        { name: 'write' },
      ],
    })
    expect(first).toEqual({ systemChanged: true, toolsChanged: true })
    expect(state.text()).toBe('Base.\n\none\n\ntmp')
    const second = state.apply({
      sections: { env: 'two', scratch: null },
      toolsAdded: [{ name: 'read', description: 'r2', parameters: { type: 'object', properties: {} } }],
      toolsRemoved: [{ name: 'write' }],
    })
    expect(second.systemChanged).toBe(true)
    expect(second.toolsChanged).toBe(true)
    expect(state.text()).toBe('Base.\n\ntwo')
    expect(state.tools().map(tool => tool.name)).toEqual(['read'])
    expect(state.schemaOf('read')).toEqual({
      name: 'read', description: 'r2', parameters: { type: 'object', properties: {} },
    })
    expect(state.schemaOf('write')).toBeUndefined()
    expect(state.seen).toBe(true)
  })

  it('a same-name removal+addition in one system message redefines the tool', () => {
    // pi's getCurrentTools removes first, then adds: a redefinition arrives as
    // toolsRemoved + toolsAdded of the same name in ONE message.
    const state = new PiPromptState()
    state.apply({ toolsAdded: [{ name: 'read', description: 'v1', parameters: {} }] })
    state.apply({
      toolsRemoved: [{ name: 'read' }],
      toolsAdded: [{ name: 'read', description: 'v2', parameters: { type: 'object' } }],
    })
    expect(state.tools()).toEqual([
      { name: 'read', description: 'v2', parameters: { type: 'object' } },
    ])
  })

  it('a stored request prompt snapshot is not mutated by a later toolsAdded', () => {
    const parser = createPiParser()
    feed(parser, [
      header(),
      systemMessage(100, {
        content: 'Base.',
        toolsAdded: [{ name: 'read', description: 'r', parameters: {} }],
      }),
      userMessage(1_000, 'go'),
      assistantMessage(2_000, [{ type: 'text', text: 'one' }]),
      systemMessage(3_000, { toolsAdded: [{ name: 'write', description: 'w', parameters: {} }] }),
      userMessage(3_500, 'more'),
      assistantMessage(4_000, [{ type: 'text', text: 'two' }]),
    ])
    const first = parser.snapshot().requests[0]
    if (first?.purpose !== 'assistant') throw new Error('expected an assistant request')
    expect(first.prompt?.tools).toEqual([{ name: 'read', description: 'r', parameters: {} }])
  })

  it('a compaction systemMessage replaces the prompt checkpoint instead of appending', () => {
    const parser = createPiParser()
    feed(parser, [
      header(),
      systemMessage(100, {
        content: 'base',
        toolsAdded: [{ name: 'read', description: 'r', parameters: {} }],
      }),
      userMessage(1_000, 'go'),
      assistantMessage(2_000, [{ type: 'text', text: 'x' }]),
      entry('compaction', 3_000, {
        summary: 's', firstKeptEntryId: 'x', tokensBefore: 1,
        systemMessage: {
          role: 'system', content: 'base v2',
          toolsAdded: [{ name: 'write', description: 'w', parameters: {} }],
        },
      }),
      userMessage(4_000, 'again'),
      assistantMessage(5_000, [{ type: 'text', text: 'y' }]),
    ])
    const snapshot = parser.snapshot()
    // The checkpoint REPLACES the replayed prompt: 'base v2', never 'base\n\nbase v2'.
    expect(snapshot.systemPrompts?.map(node => node.text)).toEqual(['base', 'base v2'])
    const last = snapshot.requests.at(-1)
    if (last?.purpose !== 'assistant') throw new Error('expected an assistant request')
    expect(last.prompt?.system).toBe('base v2')
    expect(last.prompt?.tools).toEqual([{ name: 'write', description: 'w', parameters: {} }])
  })

  it('PiSessionTree.contextEntries replays paths and compaction kept ranges like pi', () => {
    const tree = new PiSessionTree()
    const add = (id: string, parentId: string | null, type = 'message', rest: Extra = {}): void => {
      tree.add({ type, id, parentId, time: null, record: { type, ...rest } })
    }
    add('a', null, 'message', { message: { role: 'user', content: 'a' } })
    add('b', 'a', 'message', { message: { role: 'assistant', content: [] } })
    add('c1', 'b', 'compaction', { summary: 's1', firstKeptEntryId: 'b' })
    add('d', 'c1', 'message', { message: { role: 'user', content: 'd' } })
    add('c2', 'd', 'compaction', { summary: 's2', firstKeptEntryId: 'b' })
    // Latest compaction wins: [c2, kept-from-b-up-to-c2, after-c2].
    expect(tree.contextEntries('c2').map(entry => entry.id)).toEqual(['c2', 'b', 'c1', 'd'])
    // A branch rewinds to the parent's path.
    add('e', 'a', 'message', { message: { role: 'user', content: 'e' } })
    expect(tree.contextEntries('e').map(entry => entry.id)).toEqual(['a', 'e'])
    // A firstKeptEntryId off the path keeps nothing from before the compaction.
    add('f', 'e', 'compaction', { summary: 's3', firstKeptEntryId: 'b' })
    add('g', 'f', 'message', { message: { role: 'user', content: 'g' } })
    expect(tree.contextEntries('g').map(entry => entry.id)).toEqual(['f', 'g'])
    expect(tree.contextEntries(null)).toEqual([])
    expect(tree.contextEntries('unknown')).toEqual([])
  })

  it('re-resolves the path prompt when an entry branches off an earlier parent', () => {
    const rec = (id: string, parentId: string | null, offsetMs: number, type: string, body: Extra = {}): Extra =>
      ({ type, id, parentId, timestamp: at(offsetMs), ...body })
    const sys = (id: string, parentId: string | null, offsetMs: number, body: Extra): Extra =>
      rec(id, parentId, offsetMs, 'message', { message: { role: 'system', timestamp: T0 + offsetMs, ...body } })
    const usr = (id: string, parentId: string | null, offsetMs: number, text: string): Extra =>
      rec(id, parentId, offsetMs, 'message', { message: { role: 'user', content: text, timestamp: T0 + offsetMs } })
    const asst = (id: string, parentId: string | null, offsetMs: number, text: string): Extra =>
      rec(id, parentId, offsetMs, 'message', {
        message: {
          role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions',
          provider: 'openai', model: 'pi-test-1',
          usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
          stopReason: 'stop', timestamp: T0 + offsetMs,
        },
      })
    const parser = createPiParser()
    feed(parser, [
      header(),
      sys('e1', null, 100, { content: 'Base.' }),
      usr('e2', 'e1', 1_000, 'first'),
      // The abandoned branch adds a prompt section and a tool.
      sys('e3', 'e2', 1_500, { sections: { branch: 'abandoned' }, toolsAdded: [{ name: 'x' }] }),
      asst('e4', 'e3', 2_000, 'on the branch'),
      // Rewind to e2: the section/tool must not reach the next request.
      usr('e5', 'e2', 3_000, 'second'),
      asst('e6', 'e5', 4_000, 'after the rewind'),
    ])
    const requests = parser.snapshot().requests
    const first = requests[0]
    if (first?.purpose !== 'assistant') throw new Error('expected an assistant request')
    expect(first.prompt?.system).toBe('Base.\n\nabandoned')
    const last = requests.at(-1)
    if (last?.purpose !== 'assistant') throw new Error('expected an assistant request')
    expect(last.prompt?.system).toBe('Base.')
    expect(last.prompt?.tools ?? []).toEqual([])
    expect(last.promptChange?.kind).toBe('system-and-tools')
  })

  it('re-resolves route/thinking from the FULL path when branching off a compaction', () => {
    const parser = createPiParser()
    feed(parser, [
      header(),
      { type: 'model_change', id: 'mc1', parentId: null, timestamp: at(50), provider: 'prov-a', modelId: 'model-a' },
      { type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', timestamp: at(60), thinkingLevel: 'high' },
      userMessage(1_000, 'kept', 'tl1'),                                     // 00000001
      entry('compaction', 3_000, { summary: 's', firstKeptEntryId: '00000001', tokensBefore: 1 }), // 00000002
      userMessage(4_000, 'continued'),                                       // 00000003
      // Branch back onto the compaction node: the route setters it shadowed
      // still live on the full parent path.
      userMessage(5_000, 'branch off the compact', '00000002'),              // 00000004
      assistantMessage(6_000, [{ type: 'text', text: 'y' }]),                // 00000005
    ])
    const last = parser.snapshot().requests.at(-1)
    if (last?.purpose !== 'assistant') throw new Error('expected an assistant request')
    expect(last.requestConfig?.thinking).toBe('high')
  })

  it('a plain compaction does not reset route/thinking on the next request', () => {
    const parser = createPiParser()
    feed(parser, [
      header(),
      { type: 'model_change', id: 'mc1', parentId: null, timestamp: at(50), provider: 'prov-a', modelId: 'model-a' },
      { type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', timestamp: at(60), thinkingLevel: 'high' },
      userMessage(1_000, 'kept', 'tl1'),                                     // 00000001
      entry('compaction', 3_000, { summary: 's', firstKeptEntryId: '00000001', tokensBefore: 1 }),
      userMessage(4_000, 'continued'),
      assistantMessage(5_000, [{ type: 'text', text: 'y' }]),
    ])
    const last = parser.snapshot().requests.at(-1)
    if (last?.purpose !== 'assistant') throw new Error('expected an assistant request')
    expect(last.requestConfig?.thinking).toBe('high')
  })
})
