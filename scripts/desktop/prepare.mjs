// Assemble a relocatable server and an official, self-contained Node runtime.
// Never copy process.execPath: Homebrew Node depends on libraries outside the app.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const nodeVersion = '24.21.0'
const targets = {
  'aarch64-apple-darwin': {
    arch: 'arm64',
    sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  },
  'x86_64-apple-darwin': {
    arch: 'x64',
    sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  },
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
}

async function prepareRuntime(target) {
  const runtime = targets[target]
  if (!runtime) throw new Error(`Unsupported desktop target: ${target}. Build for aarch64-apple-darwin or x86_64-apple-darwin.`)
  const name = `node-v${nodeVersion}-darwin-${runtime.arch}`
  const cache = join(root, '.desktop-cache')
  const archive = join(cache, `${name}.tar.gz`)
  await mkdir(cache, { recursive: true })
  let bytes
  try {
    bytes = await readFile(archive)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    console.log(`desktop: downloading Node ${nodeVersion} (${runtime.arch})`)
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${name}.tar.gz`, {
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(bytes).digest('hex') !== runtime.sha256) {
    throw new Error(`Node archive checksum mismatch. Remove ${archive} and retry.`)
  }
  await writeFile(archive, bytes)
  const extracted = join(cache, name)
  await rm(extracted, { recursive: true, force: true })
  run('tar', ['-xzf', archive, '-C', cache, `${name}/bin/node`, `${name}/LICENSE`])
  const binary = join(root, 'src-tauri/binaries', `trajectory-node-${target}`)
  await mkdir(dirname(binary), { recursive: true })
  await copyFile(join(extracted, 'bin/node'), binary)
  await chmod(binary, 0o755)
  await copyFile(join(extracted, 'LICENSE'), join(root, 'src-tauri/resources/NODE-LICENSE'))
}

if (process.platform !== 'darwin') throw new Error('Desktop packaging currently supports macOS only.')
const target = process.env.TAURI_ENV_TARGET_TRIPLE
  ?? execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
if (!targets[target]) throw new Error(`Unsupported desktop target: ${target}. Universal builds are not supported yet.`)

run(process.execPath, ['scripts/desktop/prepare-icons.mjs'])
run('pnpm', ['build'])
run('pnpm', ['--filter', '@demogorgon314/harness-trajectory', 'exec', 'tsdown', '--config', 'tsdown.desktop.config.ts'])
const resources = join(root, 'src-tauri/resources')
await cp(join(root, 'apps/web/dist'), join(resources, 'server/public'), { recursive: true })
// Make ESM interpretation explicit even outside a checkout with package.json.
await writeFile(join(resources, 'server/package.json'), '{"type":"module"}\n')
await copyFile(join(root, 'LICENSE'), join(resources, 'LICENSE'))
await copyFile(join(root, 'packages/context/LICENSE'), join(resources, 'CONTEXT-LICENSE'))
await copyFile(join(root, 'packages/context/NOTICE'), join(resources, 'CONTEXT-NOTICE'))
await copyFile(join(root, 'apps/server/node_modules/hono/LICENSE'), join(resources, 'HONO-LICENSE'))
await copyFile(join(root, 'apps/server/node_modules/@hono/node-server/LICENSE'), join(resources, 'HONO-NODE-SERVER-LICENSE'))
await prepareRuntime(target)
console.log(`desktop: prepared server, UI and Node runtime for ${target}`)
