// Exercise the actual distributable outside the checkout, with synthetic roots.
// Optional argument: path to a built .app; otherwise tests prepared resources.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const app = process.argv[2] === undefined ? undefined : resolve(process.argv[2])
const target = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
const runtime = app ? join(app, 'Contents/MacOS/trajectory-node') : join(root, `src-tauri/binaries/trajectory-node-${target}`)
const resources = app ? join(app, 'Contents/Resources/resources') : join(root, 'src-tauri/resources')
const directory = await mkdtemp(join(tmpdir(), 'trajectory-desktop-'))
let child
try {
  const env = { ...process.env, HARNESS_TRAJECTORY_CACHE_DIR: join(directory, 'cache'), HARNESS_TRAJECTORY_SEARCH: '1' }
  for (const kind of ['CLAUDE', 'CODEX', 'CODEX_ARCHIVED', 'KIMI', 'GROK', 'PI', 'DSH']) {
    env[`HARNESS_TRAJECTORY_${kind}_ROOT`] = join(directory, kind)
  }
  env.HARNESS_TRAJECTORY_DEVIN_DB = join(directory, 'devin.db')
  env.HARNESS_TRAJECTORY_OPENCODE_DB = join(directory, 'opencode.db')
  // Desktop mode must override CLI/environment network settings.
  env.HARNESS_TRAJECTORY_HOST = 'invalid-host'
  env.HARNESS_TRAJECTORY_PORT = 'invalid-port'
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.HARNESS_TRAJECTORY_STATIC
  await mkdir(join(directory, 'CLAUDE/project'), { recursive: true })
  await writeFile(join(directory, 'CLAUDE/project/session.jsonl'), JSON.stringify({
    type: 'user', uuid: 'prompt-1', sessionId: 'session', timestamp: new Date().toISOString(),
    parentUuid: null, isSidechain: false, cwd: '/example/project', origin: { kind: 'human' },
    message: { role: 'user', content: 'Desktop packaging smoke test' },
  }) + '\n')
  child = spawn(runtime, [join(resources, 'server/main.js'), '--desktop', '--port', '0', '--static', join(resources, 'server/public')], {
    cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  const deadline = AbortSignal.timeout(30_000)
  const scanned = new Promise((resolveScan, reject) => {
    deadline.addEventListener('abort', () => reject(new Error('Startup scan timed out')), { once: true })
    lines.on('line', line => {
      if (line.startsWith('[harness-trajectory] indexed ')) resolveScan()
    })
  })
  // Observe failures immediately, even while waiting for the HTTP handshake.
  scanned.catch(() => {})
  const launchUrl = await new Promise((resolveUrl, reject) => {
    deadline.addEventListener('abort', () => reject(new Error(`Server readiness timed out\n${stderr}`)), { once: true })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Server exited (${code})\n${stderr}`)))
    lines.on('line', line => {
      if (line.startsWith('HARNESS_TRAJECTORY_READY ')) resolveUrl(JSON.parse(line.slice('HARNESS_TRAJECTORY_READY '.length)).url)
    })
  })
  const origin = new URL(launchUrl).origin
  assert.equal((await fetch(`${origin}/api/sessions`)).status, 401)
  const launch = await fetch(launchUrl, { redirect: 'manual' })
  assert.equal(launch.status, 303)
  const cookie = launch.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const headers = { cookie }
  await scanned
  const html = await fetch(`${origin}/`, { headers })
  assert.equal(html.status, 200)
  const document = await html.text()
  const script = document.match(/src="([^"]+\.js)"/)?.[1]
  assert.ok(script, 'Production HTML must reference its JavaScript bundle')
  assert.equal((await fetch(new URL(script, origin), { headers })).status, 200)
  assert.equal((await fetch(`${origin}/api/sessions`, { headers })).status, 200)
  assert.equal((await fetch(`${origin}/api/settings`, { headers })).status, 200)
  const stream = await fetch(`${origin}/api/sessions/claude/session/events`, {
    headers, signal: AbortSignal.timeout(10_000),
  })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type'), /text\/event-stream/)
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let replay = ''
  while (!replay.includes('"type":"ready"')) {
    const { value, done } = await reader.read()
    assert.equal(done, false, 'SSE ended before replay completed')
    replay += decoder.decode(value, { stream: true })
  }
  assert.match(replay, /Desktop packaging smoke test/)
  // EOF is the production shutdown path; no signal should be needed.
  child.stdin.end()
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
  const [code, signal] = await exited
  clearTimeout(timeout)
  assert.equal(signal, null, stderr)
  assert.equal(code, 0, stderr)
  await reader.cancel().catch(() => {})
  assert.ok((await readFile(join(directory, 'cache/listing.sqlite'))).length > 0)
  await assert.rejects(fetch(`${origin}/api/sessions`, { headers }))
  console.log('desktop smoke: bundled runtime, authenticated API/assets, SSE replay, SQLite and parent-exit cleanup passed')
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
  await rm(directory, { recursive: true, force: true })
}
