// Compile Icon Composer source before bundling. Tauri copies Assets.car as-is;
// its direct .icon compilation can poison Xcode's reusable ibtoold worker.
// Upstream: https://github.com/tauri-apps/tauri/issues/15315
import { execFileSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const xcodeVersion = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).match(/^Xcode (\d+)/m)?.[1]
if (Number(xcodeVersion ?? 0) < 26) throw new Error('Desktop packaging requires full Xcode 26 or newer for the macOS icon.')

const source = join(root, 'src-tauri/icons/Trajectory.icon')
const output = join(root, 'src-tauri/icons/generated')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
execFileSync('xcrun', [
  'actool', source,
  '--compile', output,
  '--output-format', 'human-readable-text',
  '--output-partial-info-plist', join(output, 'info.plist'),
  '--app-icon', 'Trajectory',
  '--include-all-app-icons',
  '--target-device', 'mac',
  '--minimum-deployment-target', '13.5',
  '--platform', 'macosx',
], {
  cwd: root,
  // Give actool a valid stdin and a fresh worker. This avoids both closed-fd
  // failures and reuse of a worker left broken by an earlier Tauri invocation.
  stdio: ['pipe', 'inherit', 'inherit'],
  env: { ...process.env, IBToolNeverDeque: '1' },
})
