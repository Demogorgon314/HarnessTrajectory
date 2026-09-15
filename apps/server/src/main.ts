#!/usr/bin/env node
/** CLI entry: scan local transcripts and serve the trajectory UI. */

import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { searchDbPath, searchEnabled } from './cache.ts'
import { SessionIndex } from './index.ts'
import { defaultRoots } from './roots.ts'
import { createSearchService, type SearchService } from './search/index.ts'

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

Scans Claude Code (~/.claude/projects), Codex (~/.codex/sessions), Kimi Code
(~/.kimi-code/sessions) and Grok Build (~/.grok/sessions) transcripts on this machine
and serves the trajectory viewer. Harness home overrides (CLAUDE_CONFIG_DIR /
CODEX_HOME / KIMI_CODE_HOME / GROK_HOME) are honoured; override a root directly with
HARNESS_TRAJECTORY_CLAUDE_ROOT / HARNESS_TRAJECTORY_CODEX_ROOT /
HARNESS_TRAJECTORY_KIMI_ROOT / HARNESS_TRAJECTORY_GROK_ROOT.

Transcripts are also indexed for full-text search into one SQLite file under
HARNESS_TRAJECTORY_CACHE_DIR (default $XDG_CACHE_HOME/harness-trajectory, else
~/.cache/harness-trajectory). Set HARNESS_TRAJECTORY_SEARCH=0 to switch it off.
Harness roots are never written to.`)
    return
  }
  const port = Number(argValue('--port') ?? process.env['HARNESS_TRAJECTORY_PORT'] ?? 5170)
  const hostname = argValue('--host') ?? process.env['HARNESS_TRAJECTORY_HOST'] ?? '127.0.0.1'
  const roots = defaultRoots()
  // `node:sqlite` still prints one ExperimentalWarning on first import; that is
  // fine and deliberately not suppressed, since silencing warnings globally
  // would hide real ones.
  let search: SearchService | undefined
  const dbPath = searchDbPath()
  if (searchEnabled()) {
    try {
      search = createSearchService({ path: dbPath })
    } catch (error) {
      console.error('[harness-trajectory] search index unavailable:', error)
    }
  }
  const index = new SessionIndex({ roots, ...(search === undefined ? {} : { search: search.indexer }) })
  index.on('error', (error: unknown) => {
    console.error('[harness-trajectory] watcher error:', error)
  })
  const started = Date.now()
  await index.start()
  const sessions = index.list()
  console.log(`[harness-trajectory] indexed ${sessions.length} sessions in ${Date.now() - started}ms`)
  for (const root of roots) console.log(`  ${root.kind}: ${root.dir}`)
  if (search === undefined) {
    console.log('[harness-trajectory] search disabled (HARNESS_TRAJECTORY_SEARCH=0)')
  } else {
    let bytes = 0
    try {
      bytes = statSync(dbPath).size
    } catch {
      // In-memory or not yet flushed to disk.
    }
    console.log(`[harness-trajectory] search index ${dbPath}`)
    console.log(`[harness-trajectory] search backfill: ${search.store.fileCount()} files, `
      + `${search.store.docCount()} docs, ${Date.now() - started}ms, ${(bytes / 1e6).toFixed(1)} MB`)
  }
  const staticDir = findStaticDir()
  const app = createApp({ index, staticDir, search })
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`[harness-trajectory] listening on http://${info.address}:${info.port}`)
    if (staticDir === undefined) {
      console.log('[harness-trajectory] no built web UI found; run `pnpm --filter @harness-trajectory/web dev` for the dev server')
    }
  })
  const shutdown = () => {
    index.stop()
    search?.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
