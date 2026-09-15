// The session address grammar (apps/web/src/App.tsx): the four routes a
// session pane can wear, and which of them share a stream.

import { describe, expect, test } from 'vitest'
import { parseHash, routeHash, runtimeKey, type Route } from '../src/App.tsx'

const K = 'claude'
const ID = 'sess 1'
const FILE = 'sess 1/agent-a1b2'

describe('parseHash / routeHash', () => {
  test('every address round-trips', () => {
    const routes: Route[] = [
      { kind: K, id: ID },
      { kind: K, id: ID, file: FILE },
      { kind: K, id: ID, tab: 'context' },
      { kind: K, id: ID, tab: 'context', agent: FILE },
    ]
    for (const route of routes) expect(parseHash(routeHash(route))).toStrictEqual(route)
  })

  test('kimi addresses round-trip like every other harness kind', () => {
    const kimiId = 'session_kimi-1'
    const kimiFile = 'session_kimi-1/agents/agent-a1b2'
    const routes: Route[] = [
      { kind: 'kimi', id: kimiId },
      { kind: 'kimi', id: kimiId, file: kimiFile },
      { kind: 'kimi', id: kimiId, tab: 'context' },
      { kind: 'kimi', id: kimiId, tab: 'context', agent: kimiFile },
    ]
    for (const route of routes) expect(parseHash(routeHash(route))).toStrictEqual(route)
  })

  test('grok addresses round-trip like every other harness kind', () => {
    // Grok ids are bare UUIDv7s and a child is a session id of its own.
    const grokId = '01a09b39-a469-7073-b766-83847750b352'
    const grokFile = '01a09b3a-1111-7073-b766-838477500001'
    const routes: Route[] = [
      { kind: 'grok', id: grokId },
      { kind: 'grok', id: grokId, file: grokFile },
      { kind: 'grok', id: grokId, tab: 'context' },
      { kind: 'grok', id: grokId, tab: 'context', agent: grokFile },
    ]
    for (const route of routes) expect(parseHash(routeHash(route))).toStrictEqual(route)
  })

  test('ids and agent ids survive the slashes and spaces in them', () => {
    expect(routeHash({ kind: K, id: ID, tab: 'context', agent: FILE }))
      .toBe('#/claude/sess%201/context/sess%201%2Fagent-a1b2')
  })

  test('unknown and partial addresses degrade instead of throwing', () => {
    expect(parseHash('')).toBeNull()
    expect(parseHash('#/')).toBeNull()
    expect(parseHash('#/gemini/x')).toBeNull()
    expect(parseHash('#/claude/x/nonsense')).toBeNull()
    // `/agent` with no id is not an address of its own — it is the session.
    expect(parseHash('#/claude/x/agent')).toStrictEqual({ kind: K, id: 'x' })
    // `/context` with no agent is the main agent's dashboard.
    expect(parseHash('#/claude/x/context')).toStrictEqual({ kind: K, id: 'x', tab: 'context' })
  })
})

describe('runtimeKey', () => {
  test('both tabs of one session share a stream', () => {
    expect(runtimeKey({ kind: K, id: ID })).toBe(runtimeKey({ kind: K, id: ID, tab: 'context' }))
    // Picking a child inside the Context tab keeps the whole-session stream.
    expect(runtimeKey({ kind: K, id: ID, tab: 'context', agent: FILE }))
      .toBe(runtimeKey({ kind: K, id: ID, tab: 'context' }))
  })

  test('the trajectory subagent view is its own stream', () => {
    // It folds that one file, so crossing between it and the Context tab does
    // reopen the stream — an accepted cost of the two framings.
    expect(runtimeKey({ kind: K, id: ID, file: FILE }))
      .not.toBe(runtimeKey({ kind: K, id: ID, tab: 'context', agent: FILE }))
  })

  test('different sessions never share a stream', () => {
    expect(runtimeKey({ kind: K, id: 'a' })).not.toBe(runtimeKey({ kind: K, id: 'b' }))
    expect(runtimeKey({ kind: K, id: 'a' })).not.toBe(runtimeKey({ kind: 'codex', id: 'a' }))
  })
})
