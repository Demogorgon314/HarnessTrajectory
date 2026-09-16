#!/usr/bin/env node
/** CLI entry: scan local transcripts and serve the trajectory UI. */

import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { listingDbPath, searchDbPath, searchEnabled } from './cache.ts'
import { DevinSource } from './devin/source.ts'
import { SessionIndex } from './index.ts'
import { ListingCache } from './listing-cache.ts'
import { defaultRoots, devinDbPath } from './roots.ts'
import { CompositeSource, type SessionSource } from './source.ts'
import { browserUrl, openBrowser, shouldOpenBrowser } from './open-browser.ts'
import { createSearchService, type SearchService } from './search/index.ts'
import { SettingsController, readSettings, settingsPath } from './settings.ts'

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
    console.log(`harness-trajectory [--port N] [--host H] [--static DIR] [--no-open]

Scans Claude Code (~/.claude/projects), Codex (~/.codex/sessions), Kimi Code
(~/.kimi-code/sessions), Grok Build (~/.grok/sessions) and Devin CLI
(~/.local/share/devin/cli/sessions.db) transcripts on this machine
and serves the trajectory viewer. Harness home overrides (CLAUDE_CONFIG_DIR /
CODEX_HOME / KIMI_CODE_HOME / GROK_HOME) are honoured; override a root directly with
HARNESS_TRAJECTORY_CLAUDE_ROOT / HARNESS_TRAJECTORY_CODEX_ROOT /
HARNESS_TRAJECTORY_KIMI_ROOT / HARNESS_TRAJECTORY_GROK_ROOT /
HARNESS_TRAJECTORY_DEVIN_DB.

A local launch opens the UI in the default browser. Pass --no-open (or set
HARNESS_TRAJECTORY_NO_OPEN=1) to skip. An SSH session never opens a browser.

Full-text search is off by default. Turn on "Content search" in the UI's
Settings dialog (persisted to settings.json), or set HARNESS_TRAJECTORY_SEARCH=1
to force it on for a launch. The index is one SQLite file under
HARNESS_TRAJECTORY_CACHE_DIR (default $XDG_CACHE_HOME/harness-trajectory, else
~/.cache/harness-trajectory). Harness roots are never written to. Server
settings (search retention days, default 90) live in settings.json there and
are editable in the UI.`)
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
  const settingsFile = settingsPath()
  const startupSettings = readSettings(settingsFile)
  // The persisted toggle decides; the env var forces search on for a launch
  // without touching the file. There is deliberately no env "force off":
  // `0`/`false` simply mean "no override", exactly what unset meant before.
  if (searchEnabled() || startupSettings.contentSearch) {
    try {
      search = createSearchService({ path: dbPath, maxAgeDays: startupSettings.searchMaxAgeDays })
    } catch (error) {
      console.error('[harness-trajectory] search index unavailable:', error)
    }
  }
  const settings = new SettingsController(settingsFile, search?.indexer)
  // The listing cache makes restarts cheap: unchanged transcripts are not
  // re-read at all, grown ones resume at the persisted byte offset.
  let listing: ListingCache | undefined
  try {
    listing = new ListingCache({ path: listingDbPath() })
  } catch (error) {
    console.error('[harness-trajectory] listing cache unavailable:', error)
  }
  const devinDb = devinDbPath()
  const index = new SessionIndex({
    roots,
    ...(listing === undefined ? {} : { listing }),
    ...(search === undefined ? {} : { search: search.indexer }),
    // The composite closes the search backfill once every source has swept.
    deferBackfill: true,
  })
  // DevinSource is attached unconditionally: a missing sessions.db degrades
  // to an empty source that retries on every poll, so a Devin CLI installed
  // or first-run while the viewer is up shows its sessions without a restart.
  const devin = new DevinSource({
    dbPath: devinDb,
    ...(search === undefined ? {} : { search: search.indexer }),
  })
  const source: SessionSource = new CompositeSource([index, devin], search?.indexer)
  console.log(`  devin: ${devinDb}${existsSync(devinDb) ? '' : ' (waiting for sessions.db)'}`)
  source.on('error', (error: unknown) => {
    console.error('[harness-trajectory] watcher error:', error)
  })
  const staticDir = findStaticDir()
  const app = createApp({ index: source, staticDir, search, settings })
  const open = shouldOpenBrowser()
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    const url = browserUrl(info.address, info.port)
    console.log(`[harness-trajectory] listening on ${url}`)
    if (staticDir === undefined) {
      console.log('[harness-trajectory] no built web UI found; run `pnpm --filter @harness-trajectory/web dev` for the dev server')
      return
    }
    if (!open) return
    console.log('[harness-trajectory] opening the default browser; pass --no-open to disable')
    void openBrowser(url).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`[harness-trajectory] could not open the default browser (${reason}); open ${url} yourself`)
    })
  })
  for (const root of roots) console.log(`  ${root.kind}: ${root.dir}`)
  if (search === undefined) {
    console.log('[harness-trajectory] search disabled (enable "Content search" in Settings, or set HARNESS_TRAJECTORY_SEARCH=1)')
  } else {
    const days = startupSettings.searchMaxAgeDays
    const retention = days === 0 ? 'no retention limit' : `retention ${days}d`
    console.log(`[harness-trajectory] search index ${dbPath} (${retention}, building in the background)`)
  }
  const started = Date.now()
  let lastProgress = ''
  const logSearchProgress = (): void => {
    if (search === undefined) return
    const stats = search.indexer.stats()
    if (stats.filesTotal === 0 && !stats.ready) return
    const line = `[harness-trajectory] startup scan ${stats.filesDone}/${stats.filesTotal} files, `
      + `${search.store.docCount()} docs`
    if (line === lastProgress) return
    lastProgress = line
    console.log(line)
  }
  const progressTimer = search === undefined ? null : setInterval(logSearchProgress, 1000)
  source.start().then(() => {
    if (progressTimer !== null) clearInterval(progressTimer)
    const sessions = source.list()
    const sweep = index.sweepStats()
    const cached = listing === undefined ? '' : ` (${sweep.cached} cached, ${sweep.read} re-read)`
    console.log(`[harness-trajectory] indexed ${sessions.length} sessions in ${Date.now() - started}ms${cached}`)
    if (search === undefined) return
    logSearchProgress()
    let bytes = 0
    try {
      bytes = statSync(dbPath).size
    } catch {
      // In-memory or not yet flushed to disk.
    }
    console.log(`[harness-trajectory] search index: ${search.store.fileCount()} files, `
      + `${search.store.docCount()} docs, ${Date.now() - started}ms, ${(bytes / 1e6).toFixed(1)} MB`)
  }, (error: unknown) => {
    if (progressTimer !== null) clearInterval(progressTimer)
    console.error('[harness-trajectory] startup scan failed:', error)
    process.exit(1)
  })
  const shutdown = () => {
    if (progressTimer !== null) clearInterval(progressTimer)
    source.stop()
    listing?.close()
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
