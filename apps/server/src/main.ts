#!/usr/bin/env node
/** CLI entry: scan local transcripts and serve the trajectory UI. */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { SessionIndex } from './index.ts'
import { defaultRoots } from './roots.ts'

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function findStaticDir(): string | undefined {
  const explicit = process.env['HARNESS_TRAJECTORY_STATIC'] ?? argValue('--static')
  if (explicit !== undefined) return resolve(explicit)
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, 'public'),
    resolve(here, '..', 'public'),
    resolve(here, '..', '..', 'web', 'dist'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`harness-trajectory [--port N] [--host H] [--static DIR]

Scans Claude Code (~/.claude/projects) and Codex (~/.codex/sessions) transcripts on
this machine and serves the trajectory viewer. Override roots with
HARNESS_TRAJECTORY_CLAUDE_ROOT / HARNESS_TRAJECTORY_CODEX_ROOT.`)
    return
  }
  const port = Number(argValue('--port') ?? process.env['HARNESS_TRAJECTORY_PORT'] ?? 5170)
  const hostname = argValue('--host') ?? process.env['HARNESS_TRAJECTORY_HOST'] ?? '127.0.0.1'
  const roots = defaultRoots()
  const index = new SessionIndex({ roots })
  index.on('error', (error: unknown) => {
    console.error('[harness-trajectory] watcher error:', error)
  })
  const started = Date.now()
  await index.start()
  const sessions = index.list()
  console.log(`[harness-trajectory] indexed ${sessions.length} sessions in ${Date.now() - started}ms`)
  for (const root of roots) console.log(`  ${root.kind}: ${root.dir}`)
  const staticDir = findStaticDir()
  const app = createApp({ index, staticDir })
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`[harness-trajectory] listening on http://${info.address}:${info.port}`)
    if (staticDir === undefined) {
      console.log('[harness-trajectory] no built web UI found; run `pnpm --filter @harness-trajectory/web dev` for the dev server')
    }
  })
  const shutdown = () => {
    index.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
