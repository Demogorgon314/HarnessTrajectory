// Copy the built web UI into the server's dist so `node apps/server/dist/main.js`
// serves the whole app from one directory.
import { cp, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'apps/web/dist')
const target = resolve(root, 'apps/server/dist/public')

try {
  await stat(source)
} catch {
  console.error(`bundle-web: ${source} is missing; run the web build first`)
  process.exit(1)
}
await rm(target, { recursive: true, force: true })
await cp(source, target, { recursive: true })
console.log(`bundle-web: copied web UI to ${target}`)
