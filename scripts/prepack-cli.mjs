// Guard `npm pack` / `npm publish` of the CLI package: the tarball is only
// the built server plus the copied web UI, so packing without `pnpm build`
// would ship an empty or stale `dist/`.
import { access, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(root, 'apps/server')
const ui = resolve(server, 'dist/public/index.html')

try {
  await access(ui)
} catch {
  console.error('prepack-cli: dist/public/index.html is missing; run `pnpm build` from the repo root')
  process.exit(1)
}

await copyFile(resolve(root, 'LICENSE'), resolve(server, 'LICENSE'))
console.log('prepack-cli: dist/public present, LICENSE copied')
