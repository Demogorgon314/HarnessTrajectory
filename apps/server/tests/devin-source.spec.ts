/**
 * DevinSource — real temporary `sessions.db` fixtures.
 *
 * The schema is created by `DevinDb.createSchema` (the same DDL the real store
 * uses); rows are hand-written with the real column names and the real
 * `chat_message`/`subagent/*` field names the CLI writes.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionLiveEvent } from '@harness-trajectory/core'
import { DevinDb } from '../src/devin/db.ts'
import { DevinSource } from '../src/devin/source.ts'

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
): void {
  db.db.prepare(
    `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, nodeId, parent, JSON.stringify(msg), createdAt, null)
}

const userMsg = (mid: string, text: string, human = true): Record<string, unknown> => ({
  message_id: mid,
  role: 'user',
  content: [{ type: 'text', text }],
  metadata: {
    created_at: '2023-11-14T22:13:20.000Z',
    ...(human ? { is_user_input: true } : {}),
  },
})

const assistantMsg = (mid: string, text: string, calls: { id: string; name: string }[] = []): Record<string, unknown> => ({
  message_id: mid,
  role: 'assistant',
  content: [{ type: 'text', text }],
  tool_calls: calls.map(call => ({ id: call.id, name: call.name, arguments: '{}' })),
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
  source = new DevinSource({ dbPath, dataDir: dir, watch: false })
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
    insertNode(db, 'alpha', 2, 1, userMsg('u2', 'system_guidance: keep going', false))
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
    insertNode(db, 'alpha', 2, 1, assistantMsg('a1', 'spawning', [{ id: 'spawn-1', name: 'run_subagent' }]))
    // Subagent chain: its own root (disjoint tree).
    insertNode(db, 'alpha', 10, null, { message_id: 'c-sys', role: 'system', content: 'You are a subagent of Devin', metadata: {} })
    insertNode(db, 'alpha', 11, 10, userMsg('c-task', 'survey the repo', false))
    insertNode(db, 'alpha', 12, 11, assistantMsg('c-a1', 'on it', [{ id: 'child-1', name: 'ls' }]))
    // The spawn result lands last and names the chain.
    insertNode(db, 'alpha', 3, 2, toolMsg('r1', 'spawn-1', 'done', {
      'subagent/agent_id': 'd4bf017',
      'subagent/chain_node_id': 10,
      'subagent/profile_name': 'explore',
    }))
    db.close()
    const src = await start()
    const detail = src.get('devin', 'alpha')
    const children = detail?.files.filter(file => file.role === 'child') ?? []
    expect(children).toHaveLength(1)
    const child = children[0]
    // fileId is `agent-<smallest row_id in the chain group>` — merge-stable.
    expect(child?.id).toBe('agent-3')
    expect(child?.agent?.agentId).toBe('d4bf017')
    expect(src.hasChild('devin', 'alpha', 'agent-3')).toBe(true)
    // Standalone child replay serves only the child's lines.
    const childLines = linesOf(await replay(src, 'alpha', 'agent-3'))
      .flatMap(chunk => chunk.lines)
    expect(childLines.filter(line => line.includes('subagent of Devin'))).toHaveLength(1)
    expect(childLines.filter(line => line.includes('survey the repo'))).toHaveLength(1)
    // Main replay includes main lines AND child lines merged chronologically.
    const all = linesOf(await replay(src, 'alpha')).flatMap(chunk => chunk.lines)
    expect(all.filter(line => line.includes('devin.msg'))).toHaveLength(6)
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

  it('rejects a file without the Devin schema', async () => {
    const db = fixture()
    db.db.exec(`CREATE TABLE other (id TEXT)`)
    db.close()
    source = new DevinSource({ dbPath, dataDir: dir, watch: false })
    await expect(source.start()).rejects.toThrow('not a Devin session store')
  })
})
