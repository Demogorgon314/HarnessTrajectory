/**
 * Cursor Agent adapter — synthetic `cursor.message` / `cursor.session` lines.
 * Field names match the server wire; payloads are fake.
 */

import { describe, expect, it } from 'vitest'
import {
  createCursorParser, cursorHumanText, cursorModelOf, cursorUserClass, parseCursorLine,
} from '../src/adapters/cursor.ts'
import type { SessionFileRef } from '../src/session.ts'

const FILE: SessionFileRef = {
  id: 'agent-1',
  role: 'main',
  path: 'cursor://sessions/agent-1',
}

const T0 = 1_700_000_000_000

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record)
}

function session(extra: Record<string, unknown> = {}): string {
  return line({
    type: 'cursor.session',
    time: T0,
    agentId: 'agent-1',
    title: 'API Extraction Script',
    cwd: '/work/project',
    model: 'grok-4.7-high',
    createdAt: T0,
    updatedAt: T0 + 5_000,
    usage: {
      used: 22_201,
      window: 256_000,
      buckets: [
        { key: 'system_prompt', label: 'System prompt', tokens: 505, chars: 1_954 },
        { key: 'conversation', label: 'Conversation', tokens: 5_950, chars: 14_877 },
      ],
    },
    ...extra,
  })
}

function human(text: string, requestId = 'req-1'): string {
  return line({
    type: 'cursor.message',
    index: 2,
    blobId: 'b' + 'a'.repeat(63),
    time: T0 + 1_000,
    message: {
      role: 'user',
      content: [{ type: 'text', text: `<timestamp>Saturday</timestamp>\n<user_query>\n${text}\n</user_query>` }],
      providerOptions: { cursor: { requestId } },
    },
  })
}

describe('cursorUserClass', () => {
  it('treats an array user message with requestId as human', () => {
    expect(cursorUserClass({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      providerOptions: { cursor: { requestId: 'req-1' } },
    })).toBe('human')
  })

  it('treats string user content and a missing requestId as injection', () => {
    expect(cursorUserClass({
      role: 'user',
      content: '<user_info>os</user_info>',
      providerOptions: { cursor: { requestContextCompleteness: {} } },
    })).toBe('injection')
    expect(cursorUserClass({
      role: 'user',
      content: 'interrupted',
      providerOptions: null,
    })).toBe('injection')
    expect(cursorUserClass({
      role: 'user',
      content: [{ type: 'text', text: 'no id' }],
    })).toBe('injection')
  })

  it('treats system as system and rejects malformed values', () => {
    expect(cursorUserClass({ role: 'system', content: 'You are a coding assistant.' })).toBe('system')
    expect(cursorUserClass({ role: 'assistant', content: [] })).toBeNull()
    expect(cursorUserClass(null)).toBeNull()
    expect(cursorUserClass('user')).toBeNull()
  })
})

describe('cursorHumanText / cursorModelOf', () => {
  it('strips the timestamp and user_query wrapper for display only', () => {
    expect(cursorHumanText({
      role: 'user',
      content: [{ type: 'text', text: '<timestamp>t</timestamp>\n<user_query>\nFix the parser\n</user_query>' }],
    })).toBe('Fix the parser')
  })

  it('reads the model from reasoning even when the text is empty', () => {
    expect(cursorModelOf({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: '',
        signature: 'sig',
        providerOptions: { cursor: { modelName: 'grok-4.7-high' } },
      }],
    })).toBe('grok-4.7-high')
    expect(cursorModelOf({ role: 'user', content: 'nope' })).toBeUndefined()
  })
})

describe('parseCursorLine', () => {
  it('returns null for blank and malformed lines', () => {
    expect(parseCursorLine('')).toBeNull()
    expect(parseCursorLine('{')).toBeNull()
    expect(parseCursorLine('null')).toBeNull()
    expect(parseCursorLine('{"type":"cursor.message"}')).toBeNull()
  })
})

describe('createCursorParser', () => {
  it('folds a human prompt, empty reasoning, a tool call, and its result', () => {
    const parser = createCursorParser()
    const callId = 'call-1\nfc_1'
    parser.push(session(), FILE, -1)
    parser.push(line({
      type: 'cursor.message', index: 0, blobId: 'sys', time: T0,
      message: { role: 'system', content: 'You are a coding assistant.' },
    }), FILE, 0)
    parser.push(line({
      type: 'cursor.message', index: 1, blobId: 'env', time: T0,
      message: { role: 'user', content: '<user_info>os</user_info>', providerOptions: { cursor: {} } },
    }), FILE, 1)
    parser.push(human('Fix the parser'), FILE, 2)
    parser.push(line({
      type: 'cursor.message', index: 3, blobId: 'asst', time: T0 + 2_000,
      message: {
        role: 'assistant',
        id: 'msg_1',
        content: [
          { type: 'reasoning', text: '', signature: 'sig', providerOptions: { cursor: { modelName: 'claude-fable-5-1' } } },
          { type: 'text', text: 'Looking now.' },
          { type: 'tool-call', toolCallId: callId, toolName: 'Read', args: { path: 'a.ts' } },
        ],
      },
    }), FILE, 3)
    parser.push(line({
      type: 'cursor.message', index: 4, blobId: 'tool', time: T0 + 3_000,
      message: {
        role: 'tool',
        id: callId,
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          toolName: 'Read',
          result: { path: 'a.ts' },
          experimental_content: [{ type: 'text', text: 'export const answer = 1\n' }],
        }],
        providerOptions: { cursor: { highLevelToolCallResult: { isError: false } } },
      },
    }), FILE, 4)

    const snapshot = parser.snapshot()
    expect(parser.meta()).toMatchObject({
      title: 'API Extraction Script',
      cwd: '/work/project',
      model: 'claude-fable-5-1',
      promptCount: 1,
    })
    expect(snapshot.systemPrompts?.map(node => node.text)).toEqual(['You are a coding assistant.'])
    const user = snapshot.eventNodes.find(node => node.kind === 'user')
    expect(user && user.kind === 'user' ? user.content : []).toEqual([{ type: 'text', text: 'Fix the parser' }])
    const injected = snapshot.eventNodes.find(node => node.kind === 'context')
    expect(injected?.kind).toBe('context')
    const assistant = snapshot.eventNodes.find(node => node.kind === 'assistant')
    expect(assistant && assistant.kind === 'assistant' ? assistant.blocks.map(block => block.kind) : []).toEqual([
      'reasoning', 'text', 'tool-call',
    ])
    const reasoning = assistant && assistant.kind === 'assistant' ? assistant.blocks[0] : undefined
    expect(reasoning && reasoning.kind === 'reasoning' ? reasoning.text : undefined).toBe('')
    const call = assistant && assistant.kind === 'assistant' ? assistant.blocks[2] : undefined
    expect(call && call.kind === 'tool-call' ? call.callId : undefined).toBe(callId)
    const result = snapshot.eventNodes.find(node => node.kind === 'tool-result')
    expect(result && result.kind === 'tool-result' ? result.callId : undefined).toBe(callId)
    expect(result && result.kind === 'tool-result' ? result.isError : undefined).toBe(false)
    expect(result && result.kind === 'tool-result' ? result.content : []).toEqual([
      { type: 'text', text: 'export const answer = 1\n' },
    ])
    const request = snapshot.requests[0]
    expect(request?.requestConfig?.maxTokens).toBe(256_000)
    expect(request?.requestConfig?.model).toBe('claude-fable-5-1')
  })

  it('marks an errored tool result', () => {
    const parser = createCursorParser()
    const callId = 'call-err'
    parser.push(human('go'), FILE, 0)
    parser.push(line({
      type: 'cursor.message', index: 1, blobId: 'a', time: T0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: callId, toolName: 'Shell', args: { command: 'false' } }],
      },
    }), FILE, 1)
    parser.push(line({
      type: 'cursor.message', index: 2, blobId: 't', time: T0 + 1,
      message: {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: callId, toolName: 'Shell', result: 'Error: Aborted' }],
        providerOptions: { cursor: { highLevelToolCallResult: { output: { error: { errorMessage: 'Aborted' } }, isError: true } } },
      },
    }), FILE, 2)
    const result = parser.snapshot().eventNodes.find(node => node.kind === 'tool-result')
    expect(result && result.kind === 'tool-result' ? result.isError : undefined).toBe(true)
    expect(result && result.kind === 'tool-result' ? result.content : []).toEqual([{ type: 'text', text: 'Error: Aborted' }])
  })

  it('keeps snapshot identity when nothing changed', () => {
    const parser = createCursorParser()
    const before = parser.snapshot()
    parser.push('', FILE, 0)
    parser.push('{', FILE, 1)
    parser.push('{"type":"cursor.unknown"}', FILE, 2)
    expect(parser.snapshot()).toBe(before)
    parser.push(session(), FILE, -1)
    const after = parser.snapshot()
    parser.push(session(), FILE, -1)
    expect(parser.snapshot()).toBe(after)
  })

  it('records the turn-chain step window and each tool call duration', () => {
    const parser = createCursorParser()
    const callId = 'call-1\nfc_1'
    parser.push(human('go'), FILE, 0)
    parser.push(line({
      type: 'cursor.message', index: 1, blobId: 'a', time: T0 + 2_000,
      span: {
        start: T0 + 2_000,
        end: T0 + 4_000,
        calls: [{ id: callId, start: T0 + 2_500, end: T0 + 3_800 }],
        blocks: [{ kind: 'reasoning', start: T0 + 2_000, end: T0 + 2_400 }],
      },
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', providerOptions: { cursor: { modelName: 'grok-4.7-high' } } },
          { type: 'tool-call', toolCallId: callId, toolName: 'Shell', args: { command: 'true' } },
        ],
      },
    }), FILE, 1)
    parser.push(line({
      type: 'cursor.message', index: 2, blobId: 't', time: T0 + 3_800,
      message: {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: callId, toolName: 'Shell', result: 'ok' }],
      },
    }), FILE, 2)
    const snapshot = parser.snapshot()
    const assistant = snapshot.eventNodes.find(node => node.kind === 'assistant')
    expect(assistant && assistant.kind === 'assistant' ? assistant.timing : undefined).toMatchObject({
      stepStartTime: T0 + 2_000,
      completedTime: T0 + 4_000,
    })
    expect(assistant && assistant.kind === 'assistant' ? assistant.time : undefined).toBe(T0 + 4_000)
    const result = snapshot.eventNodes.find(node => node.kind === 'tool-result')
    expect(result && result.kind === 'tool-result' ? result.callTime : undefined).toBe(T0 + 2_500)
    expect(result && result.kind === 'tool-result' ? result.time : undefined).toBe(T0 + 3_800)
    expect(result && result.kind === 'tool-result' ? result.meta : undefined).toEqual({ durationMs: 1_300 })
  })

  it('does not throw on a malformed message body', () => {
    const parser = createCursorParser()
    expect(() => parser.push('{"type":"cursor.message","message":null}', FILE, 0)).not.toThrow()
    expect(() => parser.push('{"type":"cursor.message","message":{"role":"assistant","content":"nope"}}', FILE, 1)).not.toThrow()
    expect(parser.snapshot().eventNodes).toEqual([])
  })
})
