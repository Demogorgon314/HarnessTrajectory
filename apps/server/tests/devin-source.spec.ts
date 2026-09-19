/**
 * DevinSource — real temporary `sessions.db` fixtures.
 *
 * The schema is created by `DevinDb.createSchema` (the same DDL the real store
 * uses); rows are hand-written with the real column names and the real
 * `chat_message`/`subagent/*` field names the CLI writes.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionLiveEvent } from '@harness-trajectory/core'
import { DevinDb } from '../src/devin/db.ts'
import { DevinSource } from '../src/devin/source.ts'
import { SearchIndexer } from '../src/search/indexer.ts'
import { search } from '../src/search/query.ts'
import { SearchStore } from '../src/search/store.ts'
import { extractSearchDocs } from '../src/search/extract.ts'
import { ListingCache } from '../src/listing-cache.ts'

let dir: string
let dbPath: string
let source: DevinSource | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ht-devin-'))
  dbPath = join(dir, 'sessions.db')
  source = null
})

afterEach(() => {
  source?.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** A writable fixture handle; `start` re-opens the same file read-only. */
function fixture(): DevinDb {
  const db = new DevinDb(dbPath, { readOnly: false })
  return db
}

function createStore(db: DevinDb): void {
  db.createSchema()
}

function insertSession(
  db: DevinDb,
  id: string,
  overrides: {
    created_at?: number
    last_activity_at?: number
    title?: string
    main_chain_id?: number | null
    hidden?: number
    metadata?: string | null
  } = {},
): void {
  db.db.prepare(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode,
      created_at, last_activity_at, title, main_chain_id, hidden, metadata)
     VALUES (?, '/work/project', 'cli', 'swe-1.5', 'standard', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.created_at ?? 1_700_000_000,
    overrides.last_activity_at ?? 1_700_000_000,
    overrides.title ?? `Session ${id}`,
    overrides.main_chain_id ?? null,
    overrides.hidden ?? 0,
    overrides.metadata ?? null,
  )
}

function insertNode(
  db: DevinDb,
  sessionId: string,
  nodeId: number,
  parent: number | null,
  msg: Record<string, unknown>,
  createdAt = 1_700_000_000,
  /** Row `metadata` column JSON — carries `extensions."compact/prior_node_ids"`. */
  meta: string | null = null,
): void {
  db.db.prepare(
    `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, nodeId, parent, JSON.stringify(msg), createdAt, meta)
}

/** A `message_nodes.metadata` column carrying a `compact/prior_node_ids` edge. */
function priorMeta(...nodeIds: number[]): string {
  return JSON.stringify({ extensions: { 'compact/prior_node_ids': nodeIds } })
}

const userMsg = (mid: string, text: string, opts: { human?: boolean } = {}): Record<string, unknown> => ({
  message_id: mid,
  role: 'user',
  content: [{ type: 'text', text }],
  metadata: {
    created_at: '2023-11-14T22:13:20.000Z',
    ...(opts.human === false ? {} : { is_user_input: true }),
  },
})

const assistantMsg = (mid: string, text: string, calls: { id: string; name: string; args?: Record<string, unknown> }[] = []): Record<string, unknown> => ({
  message_id: mid,
  role: 'assistant',
  content: [{ type: 'text', text }],
  tool_calls: calls.map(call => ({ id: call.id, name: call.name, arguments: call.args ?? {} })),
  metadata: { created_at: '2023-11-14T22:13:21.000Z', metrics: { input_tokens: 10, output_tokens: 5 } },
})

const toolMsg = (mid: string, callId: string, text: string, ext: Record<string, unknown> = {}): Record<string, unknown> => ({
  message_id: mid,
  role: 'tool',
  tool_call_id: callId,
  content: [{ type: 'text', text }],
  metadata: { created_at: '2023-11-14T22:13:22.000Z', extensions: ext },
})

async function start(): Promise<DevinSource> {
  source = new DevinSource({ dbPath, watch: false })
  await source.start()
  return source
}

/** Collect a replay of one session as `(event)` tuples. */
async function replay(
  source: DevinSource,
  id: string,
  fileId?: string,
): Promise<SessionLiveEvent[]> {
  const events: SessionLiveEvent[] = []
  await source.readAll('devin', id, event => events.push(event), fileId)
  return events
}

function linesOf(events: SessionLiveEvent[]): { lines: string[]; startLine: number }[] {
  return events.flatMap(event =>
    event.type === 'lines' ? [{ lines: [...event.lines], startLine: event.startLine }] : [])
}

describe('DevinSource', () => {
  it('discovers visible sessions and skips hidden ones', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { title: 'Alpha work' })
    insertSession(db, 'ghost', { hidden: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'hello'))
    insertNode(db, 'alpha', 2, 1, userMsg('u2', 'system_guidance: keep going', { human: false }))
    insertNode(db, 'alpha', 3, 2, userMsg('u3', 'again'))
    db.close()
    const src = await start()
    const list = src.list()
    expect(list.map(session => session.id)).toEqual(['alpha'])
    expect(list[0]?.kind).toBe('devin')
    expect(list[0]?.title).toBe('Alpha work')
    // Only is_user_input rows count as prompts.
    expect(list[0]?.promptCount).toBe(2)
    expect(src.get('devin', 'ghost')).toBeUndefined()
  })

  it('dedupes message_id copies — first row wins, replay stays stable', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'hello'))
    // A context render copies the chain: same message_id on a new node.
    insertNode(db, 'alpha', 10, null, userMsg('u1', 'hello'), 1_700_000_100)
    insertNode(db, 'alpha', 11, 10, assistantMsg('a1', 'hi there'), 1_700_000_100)
    db.close()
    const src = await start()
    const chunks = linesOf(await replay(src, 'alpha'))
    const msgs = chunks.flatMap(chunk => chunk.lines).filter(line => line.includes('devin.msg'))
    expect(msgs).toHaveLength(2)
    // Line numbers: real lines start at 0; the duplicate consumes none.
    const numbered = chunks.flatMap(chunk =>
      chunk.startLine >= 0 ? chunk.lines.map(line => line.includes('devin.msg')) : [])
    expect(numbered).toEqual([true, true])
    const again = linesOf(await replay(src, 'alpha')).flatMap(c => c.lines).filter(l => l.includes('devin.msg'))
    expect(again).toEqual(msgs)
  })

  it('re-emits render copies past a summary boundary — ancestors and descendants', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    // Live chain.
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first task'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'working'))
    insertNode(db, 'alpha', 3, 2, {
      message_id: 'sys1', role: 'system',
      content: [{ type: 'text', text: 'You are Devin.' }],
      metadata: { created_at: '2023-11-14T22:13:20.000Z' },
    })
    // Compaction render: a new chain re-copying the kept context — the system
    // prefix lands as an ANCESTOR of the summary, the kept user message as a
    // DESCENDANT (both share the originals' message_ids).
    insertNode(db, 'alpha', 10, null, {
      message_id: 'sys1', role: 'system',
      content: [{ type: 'text', text: 'You are Devin.' }],
      metadata: { created_at: '2023-11-14T22:13:23.000Z' },
    }, 1_700_000_100)
    insertNode(db, 'alpha', 11, 10, {
      message_id: 's1', role: 'system',
      content: [{ type: 'text', text: 'continuing work summary' }],
      metadata: {
        created_at: '2023-11-14T22:13:24.000Z',
        extensions: { 'devin-rs/summary': { source: 'async_file_compactor' } },
      },
    }, 1_700_000_100)
    insertNode(db, 'alpha', 12, 11, userMsg('u1', 'first task'), 1_700_000_100)
    insertNode(db, 'alpha', 13, 12, assistantMsg('a2', 'after'), 1_700_000_200)
    db.close()
    const src = await start()
    const lines = linesOf(await replay(src, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
      .map(line => JSON.parse(line) as { msg: { message_id: string }; kept?: number })
    const msgs = lines.map(line => line.msg.message_id)
    // u1's copy re-emits past the boundary; sys1's copy flushes with the
    // summary's render ancestors. a2 is a fresh post-summary node.
    expect(msgs).toEqual(['u1', 'a1', 'sys1', 'sys1', 's1', 'u1', 'a2'])
    // Only the ancestor flush (the second sys1) is tagged `kept` — the claim's
    // exemption set. The post-summary descendant copy stays untagged so the
    // NEXT render's summary can claim it.
    expect(lines.map(line => line.kept ?? 0)).toEqual([0, 0, 0, 1, 0, 0, 0])
  })

  it('emits a synthetic sidecar (startLine -1) plus tool state', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'hi'))
    db.db.prepare(
      `INSERT INTO tool_call_state (session_id, tool_call_id, tool_call_json, tool_call_update_json)
       VALUES ('alpha', 'c1', ?, ?)`,
    ).run(JSON.stringify({ title: 'shell', kind: 'execute' }), JSON.stringify({ status: 'completed' }))
    db.close()
    const src = await start()
    const chunks = linesOf(await replay(src, 'alpha'))
    const synthetic = chunks.filter(chunk => chunk.startLine === -1).flatMap(chunk => chunk.lines)
    expect(synthetic.some(line => line.includes('devin.session'))).toBe(true)
    expect(synthetic.some(line => line.includes('devin.tool'))).toBe(true)
    const real = chunks.filter(chunk => chunk.startLine >= 0)
    expect(real[0]?.startLine).toBe(0)
  })

  it('materializes a subagent chain as a child file named by subagent/* metadata', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 3 })
    // Main chain.
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'spawning', [{
      id: 'spawn-1', name: 'run_subagent', args: { title: 'Survey the repo', task: 'survey the repo' },
    }]))
    // Subagent chain: its own root (disjoint tree).
    insertNode(db, 'alpha', 10, null, { message_id: 'c-sys', role: 'system', content: 'You are a subagent of Devin', metadata: {} })
    insertNode(db, 'alpha', 11, 10, userMsg('c-task', 'survey the repo', { human: false }))
    insertNode(db, 'alpha', 12, 11, assistantMsg('c-a1', 'on it', [{ id: 'child-1', name: 'ls' }]))
    // The spawn result lands last and names the chain.
    insertNode(db, 'alpha', 3, 2, toolMsg('r1', 'spawn-1', 'done', {
      'subagent/agent_id': 'd4bf017',
      'subagent/chain_node_id': 10,
      'subagent/profile_name': 'explore',
      'subagent/model': 'SWE-2 Max',
    }))
    db.close()
    const src = await start()
    const detail = src.get('devin', 'alpha')
    const children = detail?.files.filter(file => file.role === 'child') ?? []
    expect(children).toHaveLength(1)
    const child = children[0]
    // fileId is `agent-<agentId>` — identical for a fresh scan, a live poll,
    // and a restart (a row-derived group key is not).
    expect(child?.id).toBe('agent-d4bf017')
    expect(child?.agent?.agentId).toBe('d4bf017')
    // The spawn call's title/task reaches the file's agent meta — a view
    // folding only this child's stream still gets a human title.
    expect(child?.agent?.description).toBe('Survey the repo')
    expect(child?.agent?.toolUseId).toBe('spawn-1')
    expect(child?.agent?.agentType).toBe('explore')
    expect(child?.agent?.model).toBe('SWE-2 Max')
    expect(src.hasChild('devin', 'alpha', 'agent-d4bf017')).toBe(true)
    // Standalone child replay serves only the child's lines.
    const childLines = linesOf(await replay(src, 'alpha', 'agent-d4bf017'))
      .flatMap(chunk => chunk.lines)
    expect(childLines.filter(line => line.includes('subagent of Devin'))).toHaveLength(1)
    expect(childLines.filter(line => line.includes('survey the repo'))).toHaveLength(1)
    // Main replay includes main lines AND child lines merged chronologically.
    const all = linesOf(await replay(src, 'alpha')).flatMap(chunk => chunk.lines)
    expect(all.filter(line => line.includes('devin.msg'))).toHaveLength(6)
  })

  it('keeps unclaimed chains (compactor renders) out of the child list', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'hi'))
    // A summarizer context chain: disjoint tree, nothing claims it.
    insertNode(db, 'alpha', 10, null, {
      message_id: 's-sys', role: 'system',
      content: 'You are a Summarizer that summarizes conversation history',
      metadata: {},
    })
    insertNode(db, 'alpha', 11, 10, userMsg('s-ctx', 'summarize this', { human: false }))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'reply'))
    db.close()
    const src = await start()
    const detail = src.get('devin', 'alpha')
    expect(detail?.files.filter(file => file.role === 'child')).toHaveLength(0)
    const all = linesOf(await replay(src, 'alpha')).flatMap(chunk => chunk.lines)
    expect(all.filter(line => line.includes('devin.msg'))).toHaveLength(2)
    expect(all.some(line => line.includes('Summarizer'))).toBe(false)
  })

  it('materializes a chain late-claimed by a spawn result with its backlog', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'spawning', [{
      id: 'spawn-1', name: 'run_subagent', args: { title: 'Late survey', task: 'survey' },
    }]))
    // The chain starts before its claim lands (a live run in flight).
    insertNode(db, 'alpha', 10, null, { message_id: 'c-sys', role: 'system', content: 'subagent prompt', metadata: {} })
    insertNode(db, 'alpha', 11, 10, userMsg('c-task', 'survey', { human: false }))
    db.close()
    const src = await start()
    // Unclaimed so far: invisible.
    expect(src.get('devin', 'alpha')?.files.filter(file => file.role === 'child')).toHaveLength(0)
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'alpha', 3, 2, toolMsg('r1', 'spawn-1', 'done', {
      'subagent/agent_id': 'late007',
      'subagent/chain_node_id': 10,
    }))
    write.db.prepare(`UPDATE sessions SET last_activity_at = 1700000500 WHERE id = 'alpha'`).run()
    write.close()
    await src.refresh()
    const detail = src.get('devin', 'alpha')
    const child = detail?.files.find(file => file.role === 'child')
    expect(child?.agent?.agentId).toBe('late007')
    // Spawn args learned in the first scan still reach a file created by a
    // claim that lands in a later batch.
    expect(child?.agent?.description).toBe('Late survey')
    expect(child?.agent?.toolUseId).toBe('spawn-1')
    const childLines = linesOf(await replay(src, 'alpha', child?.id)).flatMap(chunk => chunk.lines)
    // The buffered backlog landed in order.
    expect(childLines.filter(line => line.includes('devin.msg'))).toHaveLength(2)
    expect(childLines[0]).toContain('subagent prompt')
  })

  it('picks up appended rows and new sessions on refresh', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first'))
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('devin', 'alpha', event => seen.push(event))
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'alpha', 2, 1, assistantMsg('a1', 'second'), 1_700_000_500)
    write.db.prepare(`UPDATE sessions SET last_activity_at = 1700000500 WHERE id = 'alpha'`).run()
    insertSession(write, 'beta', { created_at: 1_700_000_600, last_activity_at: 1_700_000_600 })
    insertNode(write, 'beta', 1, null, userMsg('b1', 'beta prompt'))
    write.close()
    await src.refresh()
    const appended = linesOf(seen).flatMap(chunk => chunk.lines)
    expect(appended.some(line => line.includes('second'))).toBe(true)
    expect(src.list().map(session => session.id).sort()).toEqual(['alpha', 'beta'])
  })

  it('drops a session that turns hidden', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'hi'))
    db.close()
    const src = await start()
    expect(src.list()).toHaveLength(1)
    const write = new DevinDb(dbPath, { readOnly: false })
    write.db.prepare(`UPDATE sessions SET hidden = 1 WHERE id = 'alpha'`).run()
    write.close()
    await src.refresh()
    expect(src.list()).toHaveLength(0)
    expect(src.get('devin', 'alpha')).toBeUndefined()
  })

  it('ignores store rewrites — re-inserted rows under new row_ids are copies', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'working'))
    db.close()
    const src = await start()
    const write = new DevinDb(dbPath, { readOnly: false })
    // The CLI periodically rewrites the whole forest in one commit: every node
    // re-inserted in node order under fresh AUTOINCREMENT row_ids (the row
    // watermark advances, so the batch looks like a giant append), plus any
    // genuinely new tail rows.
    write.db.prepare(`DELETE FROM message_nodes WHERE session_id = 'alpha'`).run()
    insertNode(write, 'alpha', 1, null, userMsg('u1', 'first'))
    insertNode(write, 'alpha', 2, 1, assistantMsg('a1', 'working'))
    insertNode(write, 'alpha', 3, 2, userMsg('u2', 'more work'))
    write.db.prepare(`UPDATE sessions SET last_activity_at = 1700000500 WHERE id = 'alpha'`).run()
    write.close()
    await src.refresh()
    const msgs = linesOf(await replay(src, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
      .map(line => JSON.parse(line).node as number)
    expect(msgs).toEqual([1, 2, 3])
  })

  it('re-materializes when the row watermark regresses (store rebuilt)', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'old content'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'old reply'))
    db.close()
    const src = await start()
    src.subscribe('devin', 'alpha', () => {})
    const write = new DevinDb(dbPath, { readOnly: false })
    // Rebuild: fewer rows than the consumed watermark.
    write.db.prepare(`DELETE FROM message_nodes`).run()
    write.db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'message_nodes'`).run()
    insertNode(write, 'alpha', 7, null, userMsg('u2', 'new content'))
    write.db.prepare(`UPDATE sessions SET last_activity_at = 1700000900 WHERE id = 'alpha'`).run()
    write.close()
    await src.refresh()
    const lines = linesOf(await replay(src, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('new content')
  })

  it('degrades on a file without the Devin schema — error event, empty list, no throw', async () => {
    const db = fixture()
    db.db.exec(`CREATE TABLE other (id TEXT)`)
    db.close()
    source = new DevinSource({ dbPath, watch: false })
    const errors: unknown[] = []
    source.on('error', error => errors.push(error))
    // A foreign database must not take the composite down: the source runs
    // degraded (no sessions) and reports through 'error'.
    await expect(source.start()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('not a Devin session store')
    expect(source.list()).toEqual([])
    // Degraded source answers reads with nothing rather than throwing.
    await expect(replay(source, 'alpha')).resolves.toEqual([])
  })

  it('degrades on a corrupt file that is not SQLite at all', async () => {
    const db = fixture()
    db.close()
    writeFileSync(dbPath, 'this is not a sqlite database')
    source = new DevinSource({ dbPath, watch: false })
    const errors: unknown[] = []
    source.on('error', error => errors.push(error))
    await expect(source.start()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(source.list()).toEqual([])
    // Retries keep failing quietly — the failure was already reported once.
    await source.refresh()
    await source.refresh()
    expect(errors).toHaveLength(1)
  })

  it('attaches a store that appears after start — no restart needed', async () => {
    // No file at all: Devin CLI "not installed yet" is not an error.
    source = new DevinSource({ dbPath, watch: false })
    const errors: unknown[] = []
    source.on('error', error => errors.push(error))
    await source.start()
    expect(source.list()).toEqual([])
    expect(errors).toEqual([])

    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'late arrival'))
    db.close()
    await source.refresh()
    expect(source.list().map(session => session.id)).toEqual(['alpha'])
    expect(
      linesOf(await replay(source, 'alpha')).flatMap(chunk => chunk.lines)
        .some(line => line.includes('late arrival')),
    ).toBe(true)
  })

  it('drops the search watermark with the session so a re-appearing one re-indexes', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'findable line'))
    db.close()
    source = new DevinSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    const path = 'devin://sessions/alpha'
    expect(store.fileState(path)?.indexedLines).toBe(1)
    // The session hides → drop → the whole index entry (docs + watermark) goes.
    const write = new DevinDb(dbPath, { readOnly: false })
    write.db.prepare(`UPDATE sessions SET hidden = 1 WHERE id = 'alpha'`).run()
    write.close()
    await source.refresh()
    indexer.flush()
    expect(store.fileState(path)).toBeUndefined()
    // Un-hide → re-register → beginFile sees no watermark → re-index from 0.
    const write2 = new DevinDb(dbPath, { readOnly: false })
    write2.db.prepare(`UPDATE sessions SET hidden = 0, last_activity_at = 1700000900 WHERE id = 'alpha'`).run()
    write2.close()
    await source.refresh()
    indexer.flush()
    expect(store.fileState(path)?.indexedLines).toBe(1)
  })

  it('resumes search on restart for main and child streams without re-queuing history', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 2 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 10, null, userMsg('child-u', 'child task'))
    insertNode(db, 'alpha', 11, 10, assistantMsg('child-a', 'child answer'))
    insertNode(db, 'alpha', 2, 1, toolMsg('receipt', 'spawn', 'started', {
      'subagent/agent_id': 'worker', 'subagent/chain_node_id': 10,
    }))
    const maxRow = db.maxRowId('alpha')
    db.close()
    source = new DevinSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    const paths = [...source.livePaths()]
    expect(paths).toHaveLength(2)
    for (const path of paths) expect(store.fileState(path)?.size).toBe(maxRow)
    const before = paths.map(path => store.fileState(path))
    source.stop()
    const queue = vi.spyOn(indexer, 'queue')
    const reset = vi.spyOn(indexer, 'reset')
    source = new DevinSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    expect(reset).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
    expect(paths.map(path => store.fileState(path))).toEqual(before)
    indexer.stop()
    store.close()
  })

  it.each([false, true])('restores a warm catalog and builds chains only on access (search=%s)', async (withSearch) => {
    const listing = new ListingCache({ path: join(dir, 'listing.sqlite') })
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, maxAgeDays: 0 })
    const options = { dbPath, watch: false, listing, ...(withSearch ? { search: indexer } : {}) }
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 2 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 10, null, userMsg('child-u', 'child task'))
    insertNode(db, 'alpha', 11, 10, assistantMsg('child-a', 'child answer'))
    insertNode(db, 'alpha', 2, 1, toolMsg('receipt', 'spawn', 'started', {
      'subagent/agent_id': 'worker', 'subagent/chain_node_id': 10,
    }))
    db.close()
    source = new DevinSource(options)
    await source.start()
    indexer.flush()
    const before = source.get('devin', 'alpha')
    const history = await replay(source, 'alpha')
    source.stop()
    const nodes = vi.spyOn(DevinDb.prototype, 'nodes')
    const after = vi.spyOn(DevinDb.prototype, 'nodesAfter')
    const queue = vi.spyOn(indexer, 'queue')
    source = new DevinSource(options)
    await source.start()
    await source.refresh()
    expect(source.get('devin', 'alpha')).toEqual(before)
    expect(nodes).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
    expect(await replay(source, 'alpha')).toEqual(history)
    expect(nodes).toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
    nodes.mockRestore()
    after.mockRestore()
    indexer.stop()
    store.close()
    listing.close()
  })

  it.each(['poll', 'replay'] as const)('invalidates a deferred catalog on a late child claim before %s', async mode => {
    const listing = new ListingCache({ path: join(dir, 'listing.sqlite') })
    const options = { dbPath, watch: false, listing }
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'main prompt'))
    insertNode(db, 'alpha', 10, null, userMsg('c1', 'unclaimed child'))
    db.close()
    source = new DevinSource(options)
    await source.start()
    source.stop()
    source = new DevinSource(options)
    await source.start()
    expect(source.get('devin', 'alpha')?.files).toHaveLength(1)
    const write = fixture()
    write.db.prepare(`insert into subagent_heads (session_id, agent_id, chain_node_id, updated_at) values ('alpha', 'worker', 10, 1700000000)`).run()
    write.close()
    if (mode === 'poll') await source.refresh()
    else await replay(source, 'alpha')
    expect(source.hasChild('devin', 'alpha', 'agent-worker')).toBe(true)
    const append = fixture()
    insertNode(append, 'alpha', 2, 1, assistantMsg('a1', 'new answer'))
    append.close()
    await source.refresh()
    const history = linesOf(await replay(source, 'alpha')).flatMap(chunk => chunk.lines)
    expect(history.filter(line => line.includes('new answer'))).toHaveLength(1)
    expect(history.filter(line => line.includes('unclaimed child'))).toHaveLength(1)
    listing.close()
  })

  it.each(['startup', 'toggle'] as const)('reconstructs a warm catalog when search is missing (%s)', async mode => {
    const listing = new ListingCache({ path: join(dir, 'listing.sqlite') })
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'findable line'))
    db.close()
    source = new DevinSource({ dbPath, watch: false, listing })
    await source.start()
    source.stop()
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, maxAgeDays: 0 })
    const queue = vi.spyOn(indexer, 'queue')
    source = new DevinSource({ dbPath, watch: false, listing, ...(mode === 'startup' ? { search: indexer } : {}) })
    await source.start()
    if (mode === 'toggle') source.enableSearch(indexer)
    indexer.flush()
    expect(queue).toHaveBeenCalledTimes(1)
    expect(search(store, { q: 'findable line' }).totalHits).toBe(1)
    indexer.stop()
    store.close()
    listing.close()
  })

  it.each(['replacement', 'corrupt snapshot'] as const)('discards an unusable catalog: %s', async mode => {
    const listing = new ListingCache({ path: join(dir, 'listing.sqlite') })
    const options = { dbPath, watch: false, listing }
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'original prompt'))
    db.close()
    source = new DevinSource(options)
    await source.start()
    source.stop()
    if (mode === 'replacement') {
      const replacement = join(dir, 'replacement.db')
      const write = new DevinDb(replacement, { readOnly: false })
      createStore(write)
      insertSession(write, 'alpha')
      insertNode(write, 'alpha', 1, null, userMsg('u1', 'replacement prompt'))
      write.close()
      renameSync(replacement, dbPath)
    } else {
      listing.db.prepare('update catalogs set state = ?').run('{}')
    }
    source = new DevinSource(options)
    await source.start()
    const text = mode === 'replacement' ? 'replacement prompt' : 'original prompt'
    expect(source.list()[0]?.promptCount).toBe(1)
    expect(linesOf(await replay(source, 'alpha')).flatMap(chunk => chunk.lines).some(line => line.includes(text))).toBe(true)
    listing.close()
  })

  it('indexes existing sessions when search is enabled mid-run, without doubling appends', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'findable line'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'working on it'))
    db.close()
    source = new DevinSource({ dbPath, watch: false })
    await source.start()
    indexer.flush()
    expect(store.docCount()).toBe(0)

    source.enableSearch(indexer)
    indexer.finishBackfill(source.livePaths())
    const path = 'devin://sessions/alpha'
    expect(store.fileState(path)?.indexedLines).toBe(2)
    expect(search(store, { q: 'findable line' }).totalHits).toBe(1)

    // Rows appended after enabling index exactly once.
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'alpha', 3, 2, assistantMsg('a2', 'later thought'))
    write.db.prepare(`UPDATE sessions SET last_activity_at = 1700000500 WHERE id = 'alpha'`).run()
    write.close()
    await source.refresh()
    indexer.flush()
    expect(store.fileState(path)?.indexedLines).toBe(3)
    expect(search(store, { q: 'later thought' }).totalHits).toBe(1)

    // Toggling off stops indexing; toggling back on resumes at the watermark.
    source.disableSearch()
    const docs = store.docCount()
    source.enableSearch(indexer)
    indexer.flush()
    expect(store.docCount()).toBe(docs)
  })

  it('replays the exact stream live emitted — derived from the store, not retained', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 3 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'spawning', [{ id: 'spawn-1', name: 'run_subagent' }]))
    insertNode(db, 'alpha', 10, null, { message_id: 'c-sys', role: 'system', content: 'subagent prompt', metadata: {} })
    insertNode(db, 'alpha', 3, 2, toolMsg('r1', 'spawn-1', 'done', {
      'subagent/agent_id': 'eq1',
      'subagent/chain_node_id': 10,
    }))
    db.close()
    // Subscribe before start() so the first materialize's lines land too.
    source = new DevinSource({ dbPath, watch: false })
    const live: SessionLiveEvent[] = []
    source.subscribe('devin', 'alpha', event => live.push(event))
    await source.start()
    // A second tick appends to both streams incrementally.
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'alpha', 11, 10, assistantMsg('c-a1', 'on it'))
    insertNode(write, 'alpha', 4, 3, assistantMsg('a2', 'wrapped'))
    write.db.prepare(`UPDATE sessions SET last_activity_at = 1700000500 WHERE id = 'alpha'`).run()
    write.close()
    await source.refresh()
    // Synthetic lines (the sidecar's startLine -1 chunks) are derived, not
    // stream content — compare real stream lines only.
    const liveLines = (fileId: string): string[] => live.flatMap(event =>
      event.type === 'lines' && event.file.id === fileId && event.startLine >= 0 ? event.lines : [])
    const events = await replay(source, 'alpha')
    const replayedLines = (fileId: string): string[] => events.flatMap(event =>
      event.type === 'lines' && event.file.id === fileId && event.startLine >= 0 ? event.lines : [])
    // Every stream's replayed sequence equals what live emitted — the scratch
    // rebuild is deterministic.
    expect(replayedLines('alpha')).toEqual(liveLines('alpha'))
    expect(replayedLines('agent-eq1')).toEqual(liveLines('agent-eq1'))
    expect(replayedLines('alpha').length).toBeGreaterThan(0)
  })

  it('replay mutates nothing shared — no live events, no search movement', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'hello'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'hi'))
    db.close()
    source = new DevinSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    const before = store.fileState('devin://sessions/alpha')?.indexedLines
    const live: SessionLiveEvent[] = []
    const changes: string[] = []
    source.subscribe('devin', 'alpha', event => live.push(event))
    source.on('change', (_kind, id) => changes.push(id))
    const events = await replay(source, 'alpha')
    expect(events.some(event => event.type === 'lines')).toBe(true)
    // The scratch state's book has no subscribers and emits no `change`.
    expect(live).toEqual([])
    expect(changes).toEqual([])
    indexer.flush()
    expect(store.fileState('devin://sessions/alpha')?.indexedLines).toBe(before)
  })

  it('replays across a whole-forest rewrite that landed between ticks', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'working'))
    db.close()
    const src = await start()
    // The rewrite commits before live polls again: every row_id is now above
    // the stale watermark. Replay must still serve the consumed stream — and
    // NOT the row live hasn't seen (node 3), or its next emit doubles.
    const write = new DevinDb(dbPath, { readOnly: false })
    write.db.prepare(`DELETE FROM message_nodes WHERE session_id = 'alpha'`).run()
    insertNode(write, 'alpha', 1, null, userMsg('u1', 'first'))
    insertNode(write, 'alpha', 2, 1, assistantMsg('a1', 'working'))
    insertNode(write, 'alpha', 3, 2, userMsg('u2', 'not yet consumed'))
    write.close()
    const msgs = linesOf(await replay(src, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
      .map(line => JSON.parse(line).node as number)
    expect(msgs).toEqual([1, 2])
  })

  it('follows row-metadata compact/prior_node_ids to merge a re-render', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'working'))
    // A re-render commits a NEW tree; the boundary node's ROW `metadata`
    // carries the `compact/prior_node_ids` link to the node it replaces. Its
    // message_ids are fresh here, so the prior edge is the only thing that
    // joins the tree to the chain — without it the tree sits pending forever.
    insertNode(db, 'alpha', 10, null, {
      message_id: 'r-sys', role: 'system',
      content: [{ type: 'text', text: 'rendered prefix' }],
      metadata: { created_at: '2023-11-14T22:13:23.000Z' },
    }, 1_700_000_100, priorMeta(1))
    insertNode(db, 'alpha', 11, 10, assistantMsg('a2', 'still going'), 1_700_000_100)
    db.close()
    const src = await start()
    const msgs = linesOf(await replay(src, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
    expect(msgs).toHaveLength(4)
    expect(msgs[2]).toContain('rendered prefix')
  })

  it('keeps agent chains that share a boilerplate system message_id separate', async () => {
    // Regression: every subagent's context opens with the same system-prompt
    // OBJECT — one message_id shared across every agent chain. A shared-mid
    // union merged all agent chains into one group, the last claim won the
    // merged file (a child file named agent-A with agent.agentId of B), and
    // every agent's lines landed in it. Prior edges carry lineage now; the
    // mid glues only prior-free components.
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'spawning', [{
      id: 'spawn-1', name: 'run_subagent', args: { title: 'Review alpha work', task: 'survey alpha' },
    }]))
    insertNode(db, 'alpha', 3, 2, assistantMsg('a2', 'spawning too', [{
      id: 'spawn-2', name: 'run_subagent', args: { task: 'survey beta', profile: 'review' },
    }]))
    // Background spawn results carry only `subagent/agent_id`.
    insertNode(db, 'alpha', 4, 3, toolMsg('r1', 'spawn-1', 'Background subagent started with agent_id=aaaa01.', {
      'subagent/agent_id': 'aaaa01',
    }))
    insertNode(db, 'alpha', 5, 4, toolMsg('r2', 'spawn-2', 'Background subagent started with agent_id=bbbb02.', {
      'subagent/agent_id': 'bbbb02',
    }))
    // Agent A's chain — opens with the SHARED boilerplate object.
    insertNode(db, 'alpha', 10, null, {
      message_id: 'BOILER', role: 'system', content: 'You are a subagent of Devin.', metadata: {},
    })
    insertNode(db, 'alpha', 11, 10, userMsg('task-A', 'survey alpha', { human: false }))
    insertNode(db, 'alpha', 12, 11, assistantMsg('aA1', 'on it'))
    // Agent B's chain — the SAME boilerplate message_id.
    insertNode(db, 'alpha', 20, null, {
      message_id: 'BOILER', role: 'system', content: 'You are a subagent of Devin.', metadata: {},
    })
    insertNode(db, 'alpha', 21, 20, userMsg('task-B', 'survey beta', { human: false }))
    insertNode(db, 'alpha', 22, 21, assistantMsg('aB1', 'on it'))
    // Each agent's next render copies its tree; the copies' row metadata
    // carries the prior links that keep each chain distinct.
    insertNode(db, 'alpha', 40, null, {
      message_id: 'BOILER', role: 'system', content: 'You are a subagent of Devin.', metadata: {},
    }, 1_700_000_100)
    insertNode(db, 'alpha', 41, 40, userMsg('task-A', 'survey alpha', { human: false }), 1_700_000_100, priorMeta(11))
    insertNode(db, 'alpha', 50, null, {
      message_id: 'BOILER', role: 'system', content: 'You are a subagent of Devin.', metadata: {},
    }, 1_700_000_100)
    insertNode(db, 'alpha', 51, 50, userMsg('task-B', 'survey beta', { human: false }), 1_700_000_100, priorMeta(21))
    // Completion notifications on the main chain bind each chain.
    insertNode(db, 'alpha', 30, 5, {
      message_id: 'note-A', role: 'system',
      content: '<subagent_completion_notification agent_id="aaaa01">',
      metadata: { extensions: { 'subagent/agent_id': 'aaaa01', 'subagent/chain_node_id': 12 } },
    })
    insertNode(db, 'alpha', 31, 30, {
      message_id: 'note-B', role: 'system',
      content: '<subagent_completion_notification agent_id="bbbb02">',
      metadata: { extensions: { 'subagent/agent_id': 'bbbb02', 'subagent/chain_node_id': 22 } },
    })
    db.close()
    const src = await start()
    const children = src.get('devin', 'alpha')?.files.filter(file => file.role === 'child') ?? []
    expect(children.map(child => child.id).sort()).toEqual(['agent-aaaa01', 'agent-bbbb02'])
    // Each file claims the agent it is named for — no merged-group overwrite.
    const fileA = children.find(child => child.id === 'agent-aaaa01')
    const fileB = children.find(child => child.id === 'agent-bbbb02')
    expect(fileA?.agent?.agentId).toBe('aaaa01')
    expect(fileB?.agent?.agentId).toBe('bbbb02')
    // The spawn call's title/task reaches the file's agent meta — the
    // catalog's fallback title for a view that never saw the run.
    expect(fileA?.agent?.description).toBe('Review alpha work')
    expect(fileA?.agent?.toolUseId).toBe('spawn-1')
    // No title arg → the task text stands in; the call's profile fills
    // agentType when `subagent/profile_name` was absent.
    expect(fileB?.agent?.description).toBe('survey beta')
    expect(fileB?.agent?.agentType).toBe('review')
    const aLines = linesOf(await replay(src, 'alpha', 'agent-aaaa01')).flatMap(chunk => chunk.lines)
    const bLines = linesOf(await replay(src, 'alpha', 'agent-bbbb02')).flatMap(chunk => chunk.lines)
    expect(aLines.filter(line => line.includes('devin.msg'))).toHaveLength(3)
    expect(bLines.filter(line => line.includes('devin.msg'))).toHaveLength(3)
    expect(aLines.some(line => line.includes('survey alpha'))).toBe(true)
    expect(aLines.some(line => line.includes('survey beta'))).toBe(false)
    expect(bLines.some(line => line.includes('survey beta'))).toBe(true)
    expect(bLines.some(line => line.includes('survey alpha'))).toBe(false)
  })

  it('keeps prior-less agent chains that share the boilerplate opener separate', async () => {
    // Regression: two short tasks that never re-rendered have no prior edges;
    // their only link is the shared system-prompt message_id. Gluing on it
    // merged both chains so only agent-aaaa01 materialized.
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    // Agent A's chain — opens with the shared boilerplate object.
    insertNode(db, 'alpha', 10, null, {
      message_id: 'BOILER', role: 'system', content: 'You are a subagent of Devin.', metadata: {},
    })
    insertNode(db, 'alpha', 11, 10, userMsg('task-A', 'survey alpha', { human: false }))
    insertNode(db, 'alpha', 12, 11, assistantMsg('aA1', 'alpha done'))
    // Agent B's chain — the SAME boilerplate message_id, no priors anywhere.
    insertNode(db, 'alpha', 20, null, {
      message_id: 'BOILER', role: 'system', content: 'You are a subagent of Devin.', metadata: {},
    })
    insertNode(db, 'alpha', 21, 20, userMsg('task-B', 'survey beta', { human: false }))
    insertNode(db, 'alpha', 22, 21, assistantMsg('aB1', 'beta done'))
    // Completion notifications claim each chain's tip.
    insertNode(db, 'alpha', 30, 1, {
      message_id: 'note-A', role: 'system',
      content: '<subagent_completion_notification agent_id="aaaa01">',
      metadata: { extensions: { 'subagent/agent_id': 'aaaa01', 'subagent/chain_node_id': 12 } },
    })
    insertNode(db, 'alpha', 31, 30, {
      message_id: 'note-B', role: 'system',
      content: '<subagent_completion_notification agent_id="bbbb02">',
      metadata: { extensions: { 'subagent/agent_id': 'bbbb02', 'subagent/chain_node_id': 22 } },
    })
    db.close()
    const src = await start()
    const children = src.get('devin', 'alpha')?.files.filter(file => file.role === 'child') ?? []
    expect(children.map(child => child.id).sort()).toEqual(['agent-aaaa01', 'agent-bbbb02'])
    const aLines = linesOf(await replay(src, 'alpha', 'agent-aaaa01')).flatMap(chunk => chunk.lines)
    const bLines = linesOf(await replay(src, 'alpha', 'agent-bbbb02')).flatMap(chunk => chunk.lines)
    expect(aLines.filter(line => line.includes('devin.msg'))).toHaveLength(3)
    expect(bLines.filter(line => line.includes('devin.msg'))).toHaveLength(3)
    expect(aLines.some(line => line.includes('alpha done'))).toBe(true)
    expect(bLines.some(line => line.includes('beta done'))).toBe(true)
  })

  it('keeps each pending chain its own copy of a shared opener', async () => {
    // Regression: pending rows were deduped session-wide by message_id, so a
    // second unclaimed chain's copy of the shared boilerplate was dropped
    // while it waited — its stream lacked the opener after binding.
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 10, null, {
      message_id: 'BOILER', role: 'system', content: 'You are a subagent of Devin.', metadata: {},
    })
    insertNode(db, 'alpha', 11, 10, userMsg('task-A', 'survey alpha', { human: false }))
    insertNode(db, 'alpha', 20, null, {
      message_id: 'BOILER', role: 'system', content: 'You are a subagent of Devin.', metadata: {},
    })
    insertNode(db, 'alpha', 21, 20, userMsg('task-B', 'survey beta', { human: false }))
    // Only A is claimed at scan time; B buffers unclaimed.
    insertNode(db, 'alpha', 30, 1, {
      message_id: 'note-A', role: 'system',
      content: '<subagent_completion_notification agent_id="aaaa01">',
      metadata: { extensions: { 'subagent/agent_id': 'aaaa01', 'subagent/chain_node_id': 11 } },
    })
    db.close()
    const src = await start()
    expect(src.get('devin', 'alpha')?.files.filter(file => file.role === 'child')
      .map(child => child.id)).toEqual(['agent-aaaa01'])
    // B's claim lands later — its buffered copy of the opener must drain.
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'alpha', 31, 30, {
      message_id: 'note-B', role: 'system',
      content: '<subagent_completion_notification agent_id="bbbb02">',
      metadata: { extensions: { 'subagent/agent_id': 'bbbb02', 'subagent/chain_node_id': 21 } },
    })
    write.db.prepare(`UPDATE sessions SET last_activity_at = 1700000500 WHERE id = 'alpha'`).run()
    write.close()
    await src.refresh()
    expect(src.get('devin', 'alpha')?.files.filter(file => file.role === 'child')
      .map(child => child.id).sort()).toEqual(['agent-aaaa01', 'agent-bbbb02'])
    const bMsgs = linesOf(await replay(src, 'alpha', 'agent-bbbb02')).flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
    expect(bMsgs).toHaveLength(2)
    expect(bMsgs[0]).toContain('You are a subagent of Devin.')
    expect(bMsgs[1]).toContain('survey beta')
  })

  it.each(['receipt', 'child'] as const)('opens a running child when the %s arrives late, preserving replay at completion', async late => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', '', [{
      id: 'spawn-1', name: 'run_subagent', args: { title: 'Live survey', task: 'survey', is_background: true },
    }]))
    const receipt = (db: DevinDb): void => insertNode(db, 'alpha', 3, 2, toolMsg('r1', 'spawn-1', 'started', {
      'subagent/agent_id': 'cc0003',
    }))
    const child = (db: DevinDb): void => {
      insertNode(db, 'alpha', 10, null, userMsg('task', 'survey'))
      insertNode(db, 'alpha', 11, null, { message_id: 'sys', role: 'system', content: 'prompt' })
      insertNode(db, 'alpha', 12, 11, userMsg('task', 'survey'), undefined, priorMeta(10))
      insertNode(db, 'alpha', 13, 12, assistantMsg('working', 'investigating'))
    }
    if (late === 'receipt') child(db)
    else receipt(db)
    db.close()
    const src = await start()
    expect(src.hasChild('devin', 'alpha', 'agent-cc0003')).toBe(false)
    const events: SessionLiveEvent[] = []
    const unsubscribe = src.subscribe('devin', 'alpha', event => events.push(event))
    const write = new DevinDb(dbPath, { readOnly: false })
    if (late === 'receipt') receipt(write)
    else child(write)
    await src.refresh()
    expect(src.hasChild('devin', 'alpha', 'agent-cc0003')).toBe(true)
    expect(src.get('devin', 'alpha')?.files.find(file => file.role === 'child')?.agent).toMatchObject({
      agentId: 'cc0003', toolUseId: 'spawn-1', description: 'Live survey',
    })
    expect(events.some(event => event.type === 'file' && event.file.id === 'agent-cc0003')).toBe(true)
    const before = linesOf(await replay(src, 'alpha', 'agent-cc0003')).flatMap(chunk => chunk.lines)
    expect(before.filter(line => line.includes('devin.msg'))).toHaveLength(3)
    expect(before.some(line => line.includes('investigating'))).toBe(true)
    insertNode(write, 'alpha', 14, 13, assistantMsg('more', 'still working'))
    await src.refresh()
    insertNode(write, 'alpha', 4, 3, {
      message_id: 'done', role: 'system', content: 'completion',
      metadata: { extensions: { 'subagent/agent_id': 'cc0003', 'subagent/chain_node_id': 14 } },
    })
    write.close()
    await src.refresh()
    const after = linesOf(await replay(src, 'alpha', 'agent-cc0003')).flatMap(chunk => chunk.lines)
    expect(after).toHaveLength(before.length + 1)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(src.get('devin', 'alpha')?.files.filter(file => file.role === 'child')).toHaveLength(1)
    unsubscribe()
  })

  it.each(['spawns', 'chains', 'later message', 'main'] as const)('does not infer ownership from ambiguous %s', async ambiguity => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', ambiguity === 'main' ? 'survey' : 'delegate'))
    const calls = [{ id: 'spawn-1', name: 'run_subagent', args: { task: 'survey' } }]
    if (ambiguity === 'spawns') calls.push({ id: 'spawn-2', name: 'run_subagent', args: { task: 'survey' } })
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', '', calls))
    insertNode(db, 'alpha', 3, 2, toolMsg('r1', 'spawn-1', 'started', { 'subagent/agent_id': 'cc0003' }))
    if (ambiguity !== 'main') {
      insertNode(db, 'alpha', 10, null, userMsg('task', ambiguity === 'later message' ? 'other task' : 'survey'))
      if (ambiguity === 'later message') insertNode(db, 'alpha', 11, 10, userMsg('later', 'survey'))
      if (ambiguity === 'chains') insertNode(db, 'alpha', 20, null, userMsg('other', 'survey'))
    }
    db.close()
    const src = await start()
    expect(src.get('devin', 'alpha')?.files.filter(file => file.role === 'child')).toHaveLength(0)
  })

  it('replaces an inferred chain when a later explicit claim identifies a different chain', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', '', [{
      id: 'spawn-1', name: 'run_subagent', args: { task: 'survey' },
    }]))
    insertNode(db, 'alpha', 3, 2, toolMsg('r1', 'spawn-1', 'started', { 'subagent/agent_id': 'cc0003' }))
    insertNode(db, 'alpha', 10, null, userMsg('task', 'survey'))
    db.close()
    const src = await start()
    expect(src.hasChild('devin', 'alpha', 'agent-cc0003')).toBe(true)
    const events: SessionLiveEvent[] = []
    const unsubscribe = src.subscribe('devin', 'alpha', event => events.push(event))
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'alpha', 20, null, userMsg('actual-task', 'different task'))
    insertNode(write, 'alpha', 4, 3, {
      message_id: 'claim', role: 'system', content: 'completion',
      metadata: { extensions: { 'subagent/agent_id': 'cc0003', 'subagent/chain_node_id': 20 } },
    })
    write.close()
    await src.refresh()
    expect(events.some(event => event.type === 'file' && event.file.id === 'agent-cc0003' && event.reset)).toBe(true)
    const lines = linesOf(await replay(src, 'alpha', 'agent-cc0003')).flatMap(chunk => chunk.lines)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('actual-task')
    unsubscribe()
  })

  it('waits for an explicit completion claim when the child has no human task opener', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { main_chain_id: 1 })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'delegate'))
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'spawning', [{
      id: 'spawn-1', name: 'run_subagent', args: { title: 'Background survey', task: 'survey' },
    }]))
    // The spawn result names the agent but not its chain.
    insertNode(db, 'alpha', 3, 2, toolMsg('r1', 'spawn-1', 'Background subagent started with agent_id=cc0003.', {
      'subagent/agent_id': 'cc0003',
    }))
    // The chain runs while the claim is still absent.
    insertNode(db, 'alpha', 10, null, {
      message_id: 'c-sys', role: 'system', content: 'subagent prompt', metadata: {},
    })
    insertNode(db, 'alpha', 11, 10, userMsg('c-task', 'survey', { human: false }))
    db.close()
    const src = await start()
    // Running but unclaimed: no child file, the stream id 404s.
    expect(src.get('devin', 'alpha')?.files.filter(file => file.role === 'child')).toHaveLength(0)
    expect(src.hasChild('devin', 'alpha', 'agent-cc0003')).toBe(false)
    const write = new DevinDb(dbPath, { readOnly: false })
    // The completion notification lands on the main chain and names the tip.
    insertNode(write, 'alpha', 4, 3, {
      message_id: 'note-1', role: 'system',
      content: '<subagent_completion_notification agent_id="cc0003">',
      metadata: { extensions: { 'subagent/agent_id': 'cc0003', 'subagent/chain_node_id': 11 } },
    })
    write.db.prepare(`UPDATE sessions SET last_activity_at = 1700000500 WHERE id = 'alpha'`).run()
    write.close()
    await src.refresh()
    const child = src.get('devin', 'alpha')?.files.find(file => file.role === 'child')
    expect(child?.id).toBe('agent-cc0003')
    expect(child?.agent?.agentId).toBe('cc0003')
    // Completion-time claim still picks up the spawn call's title via the
    // result's tool_call_id join.
    expect(child?.agent?.description).toBe('Background survey')
    expect(child?.agent?.toolUseId).toBe('spawn-1')
    const childLines = linesOf(await replay(src, 'alpha', 'agent-cc0003')).flatMap(chunk => chunk.lines)
    expect(childLines.filter(line => line.includes('devin.msg'))).toHaveLength(2)
    expect(childLines[0]).toContain('subagent prompt')
  })

  it('keeps a session past the retention window browsable but unindexed', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 30, now: () => Date.parse('2026-01-01T00:00:00Z') })
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { last_activity_at: 1_700_000_000 }) // ~Nov 2023, way past the window
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'old but browsable'))
    db.close()
    source = new DevinSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    // Browsable…
    expect(source.list()).toHaveLength(1)
    expect(linesOf(await replay(source, 'alpha')).flatMap(c => c.lines).some(l => l.includes('old but browsable'))).toBe(true)
    // …but nothing was queued, no watermark was recorded, and the path is not
    // reported live (so finishBackfill purges any stale rows for it).
    expect(store.fileState('devin://sessions/alpha')).toBeUndefined()
    expect(source.livePaths()).toEqual([])
  })

  it('degrades on a schema-incompatible store — start resolves, one error, recovery retries', async () => {
    const db = fixture()
    // Tables exist but with foreign columns: hasSchema passes, sessions() throws.
    db.db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY)`)
    db.db.exec(`CREATE TABLE message_nodes (session_id TEXT)`)
    db.db.exec(`CREATE TABLE tool_call_state (session_id TEXT)`)
    db.close()
    source = new DevinSource({ dbPath, watch: false })
    const errors: unknown[] = []
    source.on('error', error => errors.push(error))
    // A whole-store query failure must not reject start() — the composite and
    // the other harnesses stay up with this source degraded to empty.
    await expect(source.start()).resolves.toBeUndefined()
    expect(source.list()).toEqual([])
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('session query failed')
    // The failure streak reports once, not per poll.
    await source.refresh()
    expect(errors).toHaveLength(1)
    // Repair the store in place: the retry must pick the session up — the
    // failed batch was never marked consumed.
    const write = new DevinDb(dbPath, { readOnly: false })
    write.db.exec(`DROP TABLE sessions`)
    write.db.exec(`DROP TABLE message_nodes`)
    write.db.exec(`DROP TABLE tool_call_state`)
    write.createSchema()
    insertSession(write, 'alpha')
    insertNode(write, 'alpha', 1, null, userMsg('u1', 'recovered'))
    write.close()
    await source.refresh()
    expect(source.list().map(session => session.id)).toEqual(['alpha'])
    expect(
      linesOf(await replay(source, 'alpha')).flatMap(chunk => chunk.lines)
        .some(line => line.includes('recovered')),
    ).toBe(true)
  })

  it('a failed session does not block the others and retries without skipping rows', async () => {
    const db = fixture()
    createStore(db)
    // `bad` sorts first (earlier created_at) — its failure lands before `good`
    // is processed, proving the loop is not aborted by one session's error.
    insertSession(db, 'bad', { created_at: 1_699_999_000 })
    insertSession(db, 'good')
    insertNode(db, 'bad', 1, null, userMsg('b1', 'bad one'))
    insertNode(db, 'good', 1, null, userMsg('g1', 'good one'))
    db.close()
    // Break `bad` BEFORE start: the initial sweep must isolate it too.
    const orig = DevinDb.prototype.nodesAfter
    const spy = vi.spyOn(DevinDb.prototype, 'nodesAfter').mockImplementation(function (
      this: DevinDb, sessionId: string, rowId: number,
    ) {
      if (sessionId === 'bad') throw new Error('boom')
      return orig.call(this, sessionId, rowId)
    })
    source = new DevinSource({ dbPath, watch: false })
    const errors: unknown[] = []
    source.on('error', error => errors.push(error))
    await source.start()
    const src = source
    // The healthy session materialized at start; `bad` registered but failed.
    expect(
      linesOf(await replay(src, 'good')).flatMap(chunk => chunk.lines)
        .some(line => line.includes('good one')),
    ).toBe(true)
    expect(errors.some(error => String(error).includes('bad'))).toBe(true)
    expect(src.list().map(session => session.id).sort()).toEqual(['bad', 'good'])
    // Still failing at tick time: new rows land for `good`, `bad` keeps
    // reporting — and its watermark stays put, so nothing is skipped.
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'bad', 2, 1, userMsg('b2', 'bad two'))
    insertNode(write, 'good', 2, 1, userMsg('g2', 'good two'))
    write.close()
    await src.refresh()
    expect(
      linesOf(await replay(src, 'good')).flatMap(chunk => chunk.lines)
        .some(line => line.includes('good two')),
    ).toBe(true)
    // Recovery: the failed batches are refetched — the watermark never
    // advanced past them.
    spy.mockRestore()
    await src.refresh()
    const msgs = linesOf(await replay(src, 'bad'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
    expect(msgs.some(line => line.includes('bad one'))).toBe(true)
    expect(msgs.some(line => line.includes('bad two'))).toBe(true)
  })

  it('reopens when the store file is replaced atomically', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { title: 'old alpha' })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'old line'))
    db.close()
    const src = await start()
    expect(src.list().map(session => session.id)).toEqual(['alpha'])
    // rename(2) over the path — a new inode, the identity change we key on.
    const swapPath = join(dir, 'sessions-new.db')
    const swap = new DevinDb(swapPath, { readOnly: false })
    swap.createSchema()
    insertSession(swap, 'beta', { title: 'new beta' })
    insertNode(swap, 'beta', 1, null, userMsg('u1', 'new line'))
    swap.close()
    renameSync(swapPath, dbPath)
    await src.refresh()
    expect(src.list().map(session => session.id)).toEqual(['beta'])
    expect(src.get('devin', 'alpha')).toBeUndefined()
    expect(
      linesOf(await replay(src, 'beta')).flatMap(chunk => chunk.lines)
        .some(line => line.includes('new line')),
    ).toBe(true)
  })

  it('a replacement reusing a session id rebuilds that stream — old rows do not leak', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { title: 'old alpha' })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'old content'))
    insertNode(db, 'alpha', 2, 1, userMsg('u2', 'old second'))
    db.close()
    const src = await start()
    expect(src.list()[0]?.promptCount).toBe(2)
    const seen: SessionLiveEvent[] = []
    src.subscribe('devin', 'alpha', event => seen.push(event))
    const swapPath = join(dir, 'sessions-swap.db')
    const swap = new DevinDb(swapPath, { readOnly: false })
    swap.createSchema()
    insertSession(swap, 'alpha', { title: 'new alpha' })
    insertNode(swap, 'alpha', 5, null, userMsg('u9', 'new content'))
    swap.close()
    renameSync(swapPath, dbPath)
    await src.refresh()
    // Subscribers were reset and now fold the replacement's rows.
    expect(seen.some(event => event.type === 'file' && event.reset === true)).toBe(true)
    const msgs = linesOf(await replay(src, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('new content')
    expect(src.list()[0]?.title).toBe('new alpha')
    // The meta scanner was rebuilt with the stream — the old store's
    // promptCount/seenMids do not survive the swap.
    expect(src.list()[0]?.promptCount).toBe(1)
  })

  it('a mid-batch failure forces a full rebuild — no rows skipped on retry', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first'))
    insertNode(db, 'alpha', 2, 1, userMsg('u2', 'second'))
    db.close()
    // The first search-queue call fails: the row fetch succeeded, emission
    // aborted mid-batch — node 1 already counted, node 2 never reached.
    const spy = vi.spyOn(indexer, 'queue').mockImplementationOnce(() => {
      throw new Error('transient index failure')
    })
    source = new DevinSource({ dbPath, watch: false, search: indexer })
    const errors: unknown[] = []
    source.on('error', error => errors.push(error))
    await source.start()
    expect(errors.length).toBeGreaterThan(0)
    expect(source.list()[0]?.promptCount).toBe(1)
    spy.mockRestore()
    // The retry must rebuild, not resume — the stored nodes of the aborted
    // batch would otherwise satisfy `fresh` and never emit.
    await source.refresh()
    indexer.flush()
    expect(source.list()[0]?.promptCount).toBe(2)
    const msgs = linesOf(await replay(source, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
    expect(msgs).toHaveLength(2)
    expect(store.fileState('devin://sessions/alpha')?.indexedLines).toBe(2)
  })

  it('recovers through delete + recreate at the same path', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'v1'))
    db.close()
    const src = await start()
    rmSync(dbPath)
    // Gone: the open handle still serves its snapshot — a refresh is a no-op.
    await src.refresh()
    expect(src.list().map(session => session.id)).toEqual(['alpha'])
    const db2 = fixture()
    createStore(db2)
    insertSession(db2, 'gamma', { title: 'recreated' })
    insertNode(db2, 'gamma', 1, null, userMsg('u1', 'v2'))
    db2.close()
    await src.refresh()
    expect(src.list().map(session => session.id)).toEqual(['gamma'])
    expect(src.get('devin', 'alpha')).toBeUndefined()
  })

  it('ordinary commits move mtime but must not reopen the store or reset streams', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first'))
    db.close()
    const src = await start()
    const seen: SessionLiveEvent[] = []
    src.subscribe('devin', 'alpha', event => seen.push(event))
    seen.length = 0
    const handle = (src as unknown as { db: unknown }).db
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'alpha', 2, 1, userMsg('u2', 'second'))
    write.db.prepare(`UPDATE sessions SET last_activity_at = 1700000500 WHERE id = 'alpha'`).run()
    write.close()
    await src.refresh()
    // Same handle (no reopen), no reset — just the appended line.
    expect((src as unknown as { db: unknown }).db).toBe(handle)
    expect(seen.some(event => event.type === 'file' && event.reset === true)).toBe(false)
    const msgs = seen.flatMap(event =>
      event.type === 'lines' ? event.lines.filter(line => line.includes('devin.msg')) : [])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('second')
  })

  it('appended rows materialize on watermark growth alone — no subscribers, sessions row unchanged', async () => {
    const store = new SearchStore({ path: ':memory:' })
    const indexer = new SearchIndexer({ store, flushDelayMs: 1, extract: extractSearchDocs, maxAgeDays: 0 })
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first prompt'))
    db.close()
    source = new DevinSource({ dbPath, watch: false, search: indexer })
    await source.start()
    indexer.flush()
    expect(source.list()[0]?.promptCount).toBe(1)
    expect(store.fileState('devin://sessions/alpha')?.indexedLines).toBe(1)
    // Append a message row WITHOUT touching the sessions row and with nobody
    // subscribed — only the row watermark moves.
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'alpha', 2, 1, userMsg('u2', 'second prompt'))
    write.close()
    await source.refresh()
    indexer.flush()
    // List counter, replay and the search index all moved.
    expect(source.list()[0]?.promptCount).toBe(2)
    const msgs = linesOf(await replay(source, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
    expect(msgs).toHaveLength(2)
    expect(store.fileState('devin://sessions/alpha')?.indexedLines).toBe(2)
  })

  it('a late title reaches list/facts/meta events without resetting the scanner', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha', { title: 'old title' })
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first prompt'))
    // Same mid re-rendered: the scanner's dedup set must survive the update.
    insertNode(db, 'alpha', 2, 1, userMsg('u1', 'first prompt'), 1_700_000_100)
    db.close()
    const src = await start()
    expect(src.list()[0]?.title).toBe('old title')
    expect(src.list()[0]?.promptCount).toBe(1)
    const events: SessionLiveEvent[] = []
    src.subscribe('devin', 'alpha', event => events.push(event))
    const write = new DevinDb(dbPath, { readOnly: false })
    // Title only — no new rows, no activity bump.
    write.db.prepare(`UPDATE sessions SET title = 'new title' WHERE id = 'alpha'`).run()
    write.close()
    await src.refresh()
    expect(src.list()[0]?.title).toBe('new title')
    expect(src.facts('devin', 'alpha')?.title).toBe('new title')
    // Scanner state survived: prompt count and mid dedup intact.
    expect(src.list()[0]?.promptCount).toBe(1)
    // The sidecar moved → subscribers got a fresh meta summary (subscribe
    // itself pushes nothing; this event came from the refresh).
    const metas = events.filter(event => event.type === 'meta')
    expect(metas.length).toBe(1)
    expect(metas[0]?.summary.title).toBe('new title')
  })

  it('stop is idempotent, clears resources, and the instance restarts cleanly', async () => {
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first'))
    db.close()
    const src = await start()
    expect(src.list()).toHaveLength(1)
    src.stop()
    // The second close must not throw `database is not open`.
    expect(() => src.stop()).not.toThrow()
    const peek = src as unknown as { db: unknown; poll: unknown; pollTimer: unknown }
    expect(peek.db).toBeNull()
    expect(peek.poll).toBeNull()
    expect(peek.pollTimer).toBeNull()
    // Same instance starts again: polling state and derived state come back.
    await src.start()
    const write = new DevinDb(dbPath, { readOnly: false })
    insertNode(write, 'alpha', 2, 1, userMsg('u2', 'after restart'))
    write.close()
    await src.refresh()
    const msgs = linesOf(await replay(src, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
    expect(msgs).toHaveLength(2)
  })

  it('watches the store file and its WAL — attaching lazily once the WAL exists', async () => {
    // fs.watch delivery is unreliable under the vitest worker runtime, so this
    // asserts the watch surface: both paths watched once the WAL exists, no
    // failure while it does not, and a late-appearing WAL picked up on tick.
    const watched = (): string[] =>
      [...(source as unknown as { watchedPaths: Set<string> }).watchedPaths].sort()
    const db = fixture()
    createStore(db)
    insertSession(db, 'alpha')
    insertNode(db, 'alpha', 1, null, userMsg('u1', 'first'))
    db.close()
    // No WAL yet (rollback journal) — only the db file itself is watchable.
    source = new DevinSource({ dbPath, watch: true })
    await source.start()
    expect(watched()).toEqual([dbPath])
    // The writer switches to WAL and commits — the -wal file appears now.
    // Keep it open: last-connection close checkpoints and removes the WAL.
    const write = new DevinDb(dbPath, { readOnly: false })
    write.db.exec(`PRAGMA journal_mode=WAL`)
    insertNode(write, 'alpha', 2, 1, userMsg('u2', 'second'))
    await source.refresh()
    expect(watched()).toEqual([dbPath, `${dbPath}-wal`])
    // ...and the appended row still landed through the normal tick.
    const msgs = linesOf(await replay(source, 'alpha'))
      .flatMap(chunk => chunk.lines)
      .filter(line => line.includes('devin.msg'))
    expect(msgs).toHaveLength(2)
    write.close()
  })
})
