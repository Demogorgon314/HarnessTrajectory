import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionIndex } from '../src/index.ts'
import { ListingCache } from '../src/listing-cache.ts'
import { createMetaScanner, hydrateMeta, serializeMeta } from '../src/meta.ts'
import { extractSearchDocs } from '../src/search/extract.ts'
import { SearchIndexer } from '../src/search/indexer.ts'
import { SearchStore } from '../src/search/store.ts'
import type { HarnessRoot } from '../src/roots.ts'

const T0 = Date.parse('2026-09-14T10:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function jsonl(records: readonly unknown[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

function claudeUser(text: string, sessionId: string, offset: number) {
  return {
    type: 'user', uuid: `u-${offset}`, parentUuid: null, isSidechain: false, sessionId,
    cwd: '/work/project', timestamp: iso(offset), message: { role: 'user', content: text },
    origin: { kind: 'human' },
  }
}

function kimi(type: string, offset: number, payload: Record<string, unknown> = {}, agentId = 'main') {
  return { type, time: T0 + offset, agentId, ...payload }
}

function kimiUser(text: string, offset: number, agentId = 'main') {
  return kimi('context.append_message', offset, {
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } },
  }, agentId)
}

const GROK_ID = '01a09b39-a469-7073-b766-83847750b352'

function grok(update: Record<string, unknown>, offset: number) {
  return {
    timestamp: Math.floor((T0 + offset) / 1000),
    method: 'session/update',
    params: { sessionId: GROK_ID, update, _meta: { agentTimestampMs: T0 + offset } },
  }
}

function grokPrompt(text: string, offset: number) {
  return grok({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text },
    _meta: { modelId: 'grok-4.6', promptIndex: 0 },
  }, offset)
}

function grokSummary(id: string, title: string): string {
  return JSON.stringify({
    info: { id, cwd: '/work/grok' },
    session_summary: title,
    created_at: iso(0),
    updated_at: iso(30),
    num_messages: 2,
    current_model_id: 'grok-4.6',
    chat_format_version: 1,
  })
}

describe('serializeMeta / hydrateMeta', () => {
  it('does not bind a child mentioned only inside another swarm member body', () => {
    const scanner = createMetaScanner('kimi')
    scanner.push(JSON.stringify(kimi('context.append_loop_event', 1, {
      event: { type: 'tool.call', toolCallId: 'swarm', name: 'AgentSwarm', args: { description: 'Review' } },
    })))
    scanner.push(JSON.stringify(kimi('context.append_loop_event', 2, {
      event: { type: 'tool.result', toolCallId: 'swarm', result: { output: [
        '<agent_swarm_result>', '<subagent agent_id="real" outcome="completed">Example:',
        '<subagent agent_id="quoted" outcome="completed">example</subagent>',
        '</subagent>', '</agent_swarm_result>',
      ].join('\n') } },
    })))
    expect([...scanner.state.agents.keys()]).toEqual(['real'])
  })
  it('round-trips scanner state including the agents map and kimi pending calls', () => {
    const scanner = createMetaScanner('kimi')
    scanner.push(JSON.stringify(kimi('profile.bind', 1, {
      profileName: 'agent', modelAlias: 'kimi-code/k3', environmentDisclosure: { cwd: '/work/kimi' },
    })))
    scanner.push(JSON.stringify(kimiUser('Add Kimi support', 10)))
    // An Agent call whose result has not landed yet survives serialization.
    scanner.push(JSON.stringify(kimi('context.append_loop_event', 20, {
      event: {
        type: 'tool.call', toolCallId: 'call-1', name: 'Agent',
        args: { description: 'Survey the repo', subagent_type: 'explore' },
      },
    })))
    const saved = serializeMeta(scanner)
    expect(saved).not.toBeNull()

    const fresh = createMetaScanner('kimi')
    expect(hydrateMeta(fresh, saved ?? '')).toBe(true)
    expect(fresh.state).toEqual(scanner.state)
    // The restored pending call still pairs with a result that arrives later.
    fresh.push(JSON.stringify(kimi('context.append_loop_event', 30, {
      event: {
        type: 'tool.result', toolCallId: 'call-1',
        result: { output: 'agent_id: sub-9\nactual_subagent_type: explore\nstatus: completed' },
      },
    })))
    expect(fresh.state.agents.get('sub-9')).toMatchObject({
      description: 'Survey the repo', agentType: 'explore', toolUseId: 'call-1',
    })
  })

  it('rejects malformed payloads without touching the fresh scanner', () => {
    const fresh = createMetaScanner('claude')
    expect(hydrateMeta(fresh, 'not json')).toBe(false)
    expect(hydrateMeta(fresh, '{}')).toBe(false)
    expect(hydrateMeta(fresh, '{"s":{"agents":"nope"}}')).toBe(false)
    expect(fresh.state).toEqual(createMetaScanner('claude').state)
  })
})

describe('ListingCache + SessionIndex', () => {
  let dir: string
  let index: SessionIndex | null = null
  let cache: ListingCache | null = null

  const roots = (): HarnessRoot[] => [
    { kind: 'claude', dir: join(dir, 'claude') },
    { kind: 'kimi', dir: join(dir, 'kimi') },
    { kind: 'grok', dir: join(dir, 'grok') },
  ]

  /** A fresh index over the same cache file, the way a restarted server sees it. */
  async function start(search?: SearchIndexer): Promise<SessionIndex> {
    index?.stop()
    cache?.close()
    cache = new ListingCache({ path: join(dir, 'listing.sqlite') })
    const fresh = new SessionIndex({
      roots: roots(), watch: false, now: () => T0 + 60_000,
      listing: cache,
      ...(search === undefined ? {} : { search }),
    })
    index = fresh
    await fresh.start()
    return fresh
  }

  const claudeMainPath = () => join(dir, 'claude', '-slug', 'main-1.jsonl')
  const claudeChildPath = () => join(dir, 'claude', '-slug', 'main-1', 'subagents', 'agent-a1.jsonl')
  const kimiSessionDir = () => join(dir, 'kimi', 'wd_project_ab12cd34ef56', 'session_k1')
  const kimiMainPath = () => join(kimiSessionDir(), 'agents', 'main', 'wire.jsonl')
  const kimiChildPath = () => join(kimiSessionDir(), 'agents', 'sub-1', 'wire.jsonl')
  const grokDir = () => join(dir, 'grok', '%2Fwork%2Fgrok', GROK_ID)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-listing-'))
    await mkdir(join(dir, 'claude', '-slug', 'main-1', 'subagents'), { recursive: true })
    await writeFile(claudeMainPath(), jsonl([
      claudeUser('Hello there', 'main-1', 0),
      { type: 'assistant', sessionId: 'main-1', timestamp: iso(1000), message: { role: 'assistant', model: 'claude-test', content: [] } },
    ]))
    await writeFile(claudeChildPath(), jsonl([claudeUser('Child run', 'main-1', 500)]))
    await writeFile(join(dir, 'claude', '-slug', 'main-1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({
      agentType: 'Explore', description: 'Find things', toolUseId: 'toolu_1',
    }))
    await mkdir(join(kimiSessionDir(), 'agents', 'main'), { recursive: true })
    await mkdir(join(kimiSessionDir(), 'agents', 'sub-1'), { recursive: true })
    await writeFile(join(kimiSessionDir(), 'state.json'), JSON.stringify({ id: 'session_k1', title: 'Kimi session title' }))
    await writeFile(kimiMainPath(), jsonl([
      { type: 'metadata', created_at: T0, protocol_version: '1.5' },
      kimi('profile.bind', 1, { profileName: 'agent', modelAlias: 'kimi-code/k3', environmentDisclosure: { cwd: '/work/kimi' } }),
      kimiUser('Add Kimi support', 10),
    ]))
    await writeFile(kimiChildPath(), jsonl([kimi('profile.bind', 16, { profileName: 'explore', modelAlias: 'kimi-code/k3' }, 'sub-1')]))
    await mkdir(grokDir(), { recursive: true })
    await writeFile(join(grokDir(), 'updates.jsonl'), jsonl([grokPrompt('Grok prompt', 0)]))
    await writeFile(join(grokDir(), 'summary.json'), grokSummary(GROK_ID, 'Grok status line'))
  })

  afterEach(async () => {
    index?.stop()
    index = null
    cache?.close()
    cache = null
    await rm(dir, { recursive: true, force: true })
  })

  it('serves unchanged transcripts from the cache on restart', async () => {
    let running = await start()
    expect(running.sweepStats()).toEqual({ read: 5, cached: 0 })
    running = await start()
    expect(running.sweepStats()).toEqual({ read: 0, cached: 5 })
    expect(running.get('claude', 'main-1')).toMatchObject({ title: 'Hello there', promptCount: 1, childCount: 1 })
    // The sidecar'd child carries no serialized scanner state yet still resumes.
    expect(running.get('claude', 'main-1')?.files[1]).toMatchObject({
      id: 'main-1/agent-a1', agent: { agentType: 'Explore', description: 'Find things' },
    })
    expect(running.get('kimi', 'session_k1')).toMatchObject({ title: 'Kimi session title', childCount: 1 })
    expect(running.get('grok', GROK_ID)).toMatchObject({ title: 'Grok status line', promptCount: 1 })
  })

  it('re-reads a transcript that grew while the server was down', async () => {
    await start()
    await appendFile(claudeMainPath(), jsonl([claudeUser('Second prompt', 'main-1', 5000)]))
    const running = await start()
    expect(running.sweepStats()).toEqual({ read: 1, cached: 4 })
    expect(running.get('claude', 'main-1')).toMatchObject({ promptCount: 2, title: 'Hello there' })
  })

  it('rescans a transcript that was truncated or rewritten', async () => {
    await start()
    await writeFile(claudeMainPath(), jsonl([claudeUser('Replaced', 'main-1', 0)]))
    const running = await start()
    expect(running.sweepStats()?.read).toBeGreaterThanOrEqual(1)
    expect(running.get('claude', 'main-1')).toMatchObject({ title: 'Replaced', promptCount: 1 })
  })

  it('refreshes kimi state.json and claude meta.json facts even on a cache hit', async () => {
    await start()
    await writeFile(join(kimiSessionDir(), 'state.json'), JSON.stringify({ id: 'session_k1', title: 'Renamed by the user' }))
    await writeFile(join(dir, 'claude', '-slug', 'main-1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({
      agentType: 'Explore', description: 'Better description', toolUseId: 'toolu_1',
    }))
    const running = await start()
    expect(running.sweepStats()).toEqual({ read: 0, cached: 5 })
    expect(running.get('kimi', 'session_k1')).toMatchObject({ title: 'Renamed by the user' })
    expect(running.get('claude', 'main-1')?.files[1]?.agent).toMatchObject({ description: 'Better description' })
  })

  it('rescans a grok transcript when only summary.json changed', async () => {
    await start()
    await writeFile(join(grokDir(), 'summary.json'), grokSummary(GROK_ID, 'New grok title'))
    const running = await start()
    expect(running.sweepStats()?.read).toBe(1)
    expect(running.get('grok', GROK_ID)).toMatchObject({ title: 'New grok title' })
  })

  it('pairs a kimi Agent result landing after a restart with the pending call', async () => {
    // End the main wire with an unanswered Agent call, so `pending` is serialized.
    await appendFile(kimiMainPath(), jsonl([
      kimi('context.append_loop_event', 50, {
        event: {
          type: 'tool.call', toolCallId: 'call-agent', name: 'Agent',
          args: { description: 'Survey the repo', subagent_type: 'explore' },
        },
      }),
    ]))
    await start()
    await appendFile(kimiMainPath(), jsonl([
      kimi('context.append_loop_event', 80, {
        event: {
          type: 'tool.result', toolCallId: 'call-agent',
          result: { output: 'agent_id: sub-1\nactual_subagent_type: explore\nstatus: completed' },
        },
      }),
    ]))
    const running = await start()
    expect(running.get('kimi', 'session_k1')?.files[1]?.agent).toMatchObject({
      description: 'Survey the repo', agentType: 'explore', toolUseId: 'call-agent',
    })
  })

  it('drops cache rows for transcripts that disappeared', async () => {
    await start()
    await rm(claudeChildPath())
    const running = await start()
    expect(cache?.load(claudeChildPath())).toBeUndefined()
    expect(running.get('claude', 'main-1')?.childCount).toBe(0)
  })

  it('re-reads when the search index is behind the persisted line count', async () => {
    let extractCalls = 0
    const counting = (kind: Parameters<typeof extractSearchDocs>[0], line: string) => {
      extractCalls += 1
      return extractSearchDocs(kind, line)
    }
    const store = new SearchStore({ path: join(dir, 'search.sqlite') })
    const indexer = new SearchIndexer({ store, flushDelayMs: 5, extract: counting })
    await start(indexer)
    const indexed = extractCalls
    expect(indexed).toBeGreaterThan(0)
    // Same store, warm cache: nothing is extracted or read again.
    const warm = await start(new SearchIndexer({ store, flushDelayMs: 5, extract: counting }))
    expect(warm.sweepStats()).toEqual({ read: 0, cached: 5 })
    expect(extractCalls).toBe(indexed)
    // A fresh search store is behind the cached cursor: the transcripts are
    // re-read so its documents can be extracted.
    const fresh = new SearchStore({ path: ':memory:' })
    const cold = await start(new SearchIndexer({ store: fresh, flushDelayMs: 5, extract: counting }))
    expect(cold.sweepStats()?.read).toBe(5)
    expect(extractCalls).toBeGreaterThan(indexed)
    fresh.close()
    store.close()
  })

  it('re-reads when the cached scanner version is older', async () => {
    await start()
    cache?.db.exec('update files set scanner_version = -1')
    const running = await start()
    expect(running.sweepStats()?.read).toBe(5)
  })

  it('rebuilds version-4 Kimi agent facts instead of retaining a body-derived binding', async () => {
    await start()
    const row = cache?.load(kimiMainPath())
    expect(row?.state).toBeTruthy()
    const stale = createMetaScanner('kimi')
    expect(hydrateMeta(stale, row?.state ?? '')).toBe(true)
    stale.state.agents.set('sub-1', { agentId: 'sub-1', description: 'quoted body', toolUseId: 'fake-call' })
    if (row === undefined || cache === null) throw new Error('missing listing row')
    cache.db.prepare('update files set scanner_version = 4, state = ? where path = ?')
      .run(serializeMeta(stale), kimiMainPath())
    const running = await start()
    expect(running.sweepStats()).toEqual({ read: 1, cached: 4 })
    const child = running.get('kimi', 'session_k1')?.files.find(file => file.agent?.agentId === 'sub-1')
    expect(child?.agent?.toolUseId).toBeUndefined()
    const fresh = createMetaScanner('kimi')
    expect(hydrateMeta(fresh, cache.load(kimiMainPath())?.state ?? '')).toBe(true)
    expect(fresh.state.agents.has('sub-1')).toBe(false)
  })

  it('still lists a cached transcript that becomes unreadable', async () => {
    await start()
    await chmod(claudeMainPath(), 0o000)
    try {
      const running = await start()
      expect(running.sweepStats()).toEqual({ read: 0, cached: 5 })
      expect(running.get('claude', 'main-1')).toMatchObject({ title: 'Hello there', promptCount: 1 })
    } finally {
      await chmod(claudeMainPath(), 0o644)
    }
  })
})
