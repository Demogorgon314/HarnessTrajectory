/**
 * The blob route serves the media kimi offloads into an agent's per-file
 * `blobs/` store, addressed by the `blobref:<mime>;<sha256>` refs the wire
 * log carries. The specs build a real session directory in a temp dir.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { SessionIndex } from '../src/index.ts'

const T0 = Date.parse('2026-09-15T10:00:00.000Z')
const SESSION = 'session_blobtest'
const MAIN_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const CHILD_HASH = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'
const MAIN_BYTES = Buffer.from('fake-png-bytes-main')
const CHILD_BYTES = Buffer.from('fake-png-bytes-child')

function wire(agentId: string): string {
  return JSON.stringify({ type: 'metadata', created_at: T0, protocol_version: '1.5', agentId }) + '\n'
}

describe('GET /api/sessions/:kind/:id/blob', () => {
  let dir: string
  let index: SessionIndex

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-trajectory-blob-'))
    const agents = join(dir, 'kimi', 'wd_project_0123456789ab', SESSION, 'agents')
    await mkdir(join(agents, 'main', 'blobs'), { recursive: true })
    await mkdir(join(agents, 'agent-1', 'blobs'), { recursive: true })
    await writeFile(join(agents, 'main', 'wire.jsonl'), wire('main'))
    await writeFile(join(agents, 'agent-1', 'wire.jsonl'), wire('agent-1'))
    await writeFile(join(agents, 'main', 'blobs', MAIN_HASH), MAIN_BYTES)
    await writeFile(join(agents, 'agent-1', 'blobs', CHILD_HASH), CHILD_BYTES)
    index = new SessionIndex({
      roots: [{ kind: 'kimi', dir: join(dir, 'kimi') }],
      watch: false,
      now: () => T0 + 60_000,
    })
    await index.start()
  })

  afterEach(async () => {
    index.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('serves a main transcript blob with its recorded mime type, immutably', async () => {
    const response = await createApp({ index }).request(
      `/api/sessions/kimi/${SESSION}/blob?file=${SESSION}&ref=blobref:image/png;${MAIN_HASH}`,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(MAIN_BYTES)
  })

  it('serves a child transcript blob from the child\'s own store', async () => {
    const response = await createApp({ index }).request(
      `/api/sessions/kimi/${SESSION}/blob?file=agent-1&ref=blobref:image/png;${CHILD_HASH}`,
    )
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CHILD_BYTES)
  })

  it('rejects a malformed ref, a traversal-shaped hash and an unknown blob', async () => {
    const app = createApp({ index })
    expect((await app.request(`/api/sessions/kimi/${SESSION}/blob?ref=not-a-blobref`)).status).toBe(400)
    expect((await app.request(`/api/sessions/kimi/${SESSION}/blob?ref=blobref:image/png;..%2Fwire`)).status).toBe(400)
    const unknown = '0'.repeat(64)
    expect((await app.request(`/api/sessions/kimi/${SESSION}/blob?ref=blobref:image/png;${unknown}`)).status).toBe(404)
    expect((await app.request(`/api/sessions/kimi/${SESSION}/blob?file=agent-9&ref=blobref:image/png;${MAIN_HASH}`)).status).toBe(404)
    expect((await app.request(`/api/sessions/claude/${SESSION}/blob?ref=blobref:image/png;${MAIN_HASH}`)).status).toBe(404)
  })
})
