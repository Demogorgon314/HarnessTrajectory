# Harness Trajectory

A local viewer for coding-agent sessions. It reads the transcripts that **Claude Code**,
**Codex**, **Kimi Code**, **Grok Build**, **Devin CLI**, **pi**, **OpenCode**, **Cursor Agent**, and **DeepSeek Harness** write on your machine and renders each session
as a turn-by-turn trajectory with timing, token usage, subagents, and a context dashboard.
Live sessions update as they run. Nothing leaves your machine.

## Why

Every coding agent leaves a JSONL transcript behind, but each harness uses its own format
and none of them ship a viewer. Harness Trajectory gives all four the same UI: the
Trajectory view from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
and the context dashboard from [dsh-context](https://github.com/bowenliang123/dsh-context),
both ported to run on top of plain transcript files instead of a runtime.

## Features

- **Session picker** grouped by project, filterable by harness, searchable by title, path, or id.
- **Full-text search** across every transcript on the machine: prompts, assistant replies,
  and tool calls (commands, paths, patterns, and the contents of writes and edits — but not
  tool stdout). Substring matching (so `--project serv` or `packages/co` find
  something), case-insensitive, grouped by session, and each hit opens the exact record —
  including inside a subagent transcript. Built on SQLite FTS5 with the trigram tokenizer,
  updated incrementally as sessions run.
- **Trajectory ledger**: turns, steps, user / assistant / tool records, token usage, durations,
  a record inspector (payload, result, schema, timing), fold controls, and live search.
- **Timing overview**: drag to focus an interval, wheel to zoom, recorded or equal widths.
- **Token usage** in Settings: date/tool/model/provider filters, usage trends, a 53-week
  activity calendar, hourly rhythm, milestones, and model/provider/session rankings.
  Streams local histories on first open, with session progress and record counts;
  charts update as sessions finish. Refresh reuses unchanged session summaries.
  Missing usage is shown as incomplete coverage, never estimated. Input includes cache;
  reasoning is part of output. Codex forks exclude verified inherited history.
- **Execution diagnostics** from the Trajectory toolbar: tool-call loops (the same tool and
  arguments failing three or more times within one turn, even with other calls in between),
  model request trouble (repeated retries, request errors, output limits), and the slowest tool
  call compared against its own tool's median. Every card links to the evidence rows.
- **Live follow**: the server tails transcript files and streams new lines over SSE, so
  in-flight assistant output and running tool calls render as they happen.
- **Subagents** nest under the call that spawned them. Open one to view it as its own
  session, with a breadcrumb back to the parent.
- **Chat tab**: a read-only conversation inspired by deepseek-harness, with user bubbles,
  Markdown replies, images, and expandable reasoning, context, and tool results. It shares
  the Trajectory fold across all harnesses. While Chat is open, global content-search hits
  open the matching conversation (including subagents), reveal the record, and scroll to it.
  Older messages load in pages; live updates follow the bottom until you scroll away.
- **Context tab**: stats, token and timing donuts, context-window occupancy, per-step
  trend, a browser for every request's assembled context (system prompt, tool schemas,
  messages, results), context events (compactions, injections, model switches), file
  activity, and an agent network graph.
- Light / dark / system themes. English and Chinese copy.
- **Mermaid diagrams** in Markdown replies and detail views: local rendering after
  streaming completes, source/copy controls, and a fullscreen preview with pan,
  pinch/keyboard zoom, fit-to-view, and SVG download. Invalid
  diagrams remain readable as source. Rendering loads only near the viewport.

## Quick start

Requires Node 22.13+. (22.13 is where `node:sqlite`, which backs the search index,
stopped needing a flag. There is no native dependency to build.)

```sh
npx @demogorgon314/harness-trajectory@latest
```

Opens `http://127.0.0.1:5170` in the default browser. To serve without opening one:

```sh
npx @demogorgon314/harness-trajectory@latest --no-open
```

Full-text search is off by default. Turn on **Content search** in the UI's
settings dialog (the gear button in the sidebar) — indexing starts in the
background right away, no restart needed — or force it on for a launch:

```sh
HARNESS_TRAJECTORY_SEARCH=1 npx @demogorgon314/harness-trajectory@latest
```

That starts the API and the built UI together at `http://127.0.0.1:5170`. From a
checkout, with pnpm 12:

```sh
pnpm install
pnpm dev        # API on http://127.0.0.1:5170, web UI on http://localhost:5173
```

Production build served from a single process:

```sh
pnpm build
pnpm start      # http://127.0.0.1:5170
```

### macOS desktop app

The Tauri desktop app bundles the viewer and Node runtime; installed apps require
macOS 13.5+ and do not need a separate Node installation. From a checkout with
Rust and full Xcode 26 or newer installed:

```sh
pnpm desktop:dev      # build assets and launch the native debug app
pnpm desktop:build    # package a .app and .dmg for this Mac's architecture
```

Output: `src-tauri/target/release/bundle/`. See [desktop development and packaging](docs/desktop.md)
for architecture, Intel builds, verification, and signing requirements.

### Configuration

Transcript roots are discovered from the harness home directories. Environment variables
below; the server also accepts `--port`, `--host`, `--static`, and `--no-open`. Runtime
settings (content search on/off, search retention days, model price rules) live in `settings.json` under the cache
directory and are editable in the UI's settings dialog (the gear button in the sidebar). Model
price rules map a billed `provider/model` onto a listed entry or hand-entered USD/1M-token rates,
optionally with a peak/off-peak schedule. A billed model id first resolves against the registry on
its own — the provider's branch, then a book-wide scan that prefers the model's vendor list (e.g.
`gpt-*` → `openai`, `deepseek-*` → `deepseek`) over reseller re-pricings — so rules are only needed
when nothing official prices it; an unpriced model in a session's Context cost cell or Session Info
card opens the rule editor directly.

| Setting | Default | Notes |
| --- | --- | --- |
| `HARNESS_TRAJECTORY_PORT` | `5170` | Server port |
| `HARNESS_TRAJECTORY_HOST` | `127.0.0.1` | Bind address |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code home (`<home>/projects` is scanned) |
| `CODEX_HOME` | `~/.codex` | Codex home (`<home>/sessions`) |
| `KIMI_CODE_HOME` | `~/.kimi-code` | Kimi Code home (`<home>/sessions`) |
| `GROK_HOME` | `~/.grok` | Grok Build home (`<home>/sessions`) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi agent home (`<home>/sessions` is scanned) |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness home (`<home>/sessions` is scanned; `<home>/attachments` resolves `blobref:` images) |
| `HARNESS_TRAJECTORY_{CLAUDE,CODEX,KIMI,GROK,PI,DSH}_ROOT` | derived | Point one harness at an arbitrary directory |
| `HARNESS_TRAJECTORY_DEVIN_DB` | `$XDG_DATA_HOME/devin/cli/sessions.db`, else `~/.local/share/devin/cli/sessions.db` | Devin CLI session store — read directly (read-only); no transcript files exist |
| `HARNESS_TRAJECTORY_OPENCODE_DB` | `$XDG_DATA_HOME/opencode/opencode.db`, else `~/.local/share/opencode/opencode.db` | OpenCode V1 session store — read directly (read-only); no transcript files exist |
| `CURSOR_CONFIG_DIR` | `~/.cursor` | Cursor config home (`<home>/chats` is scanned) |
| `HARNESS_TRAJECTORY_CURSOR_CHATS` | `$CURSOR_CONFIG_DIR/chats`, else `~/.cursor/chats` | Cursor Agent per-session stores — read directly (read-only); no transcript files exist |
| `HARNESS_TRAJECTORY_CACHE_DIR` | `$XDG_CACHE_HOME/harness-trajectory`, else `~/.cache/harness-trajectory` | Holds `search.sqlite` and `settings.json`, the only files the server writes |
| `HARNESS_TRAJECTORY_SEARCH` | off | `1`, `true`, or `on` forces indexing on for the launch; otherwise the Content search toggle in `settings.json` decides. While off, `/api/search` answers `{ "enabled": false }` |
| `HARNESS_TRAJECTORY_NO_OPEN` | off | `1`, `true`, or `on` skips opening the default browser (same as `--no-open`). SSH sessions never open one. |

Transcript roots are only ever read. The search index is a cache: delete
`search.sqlite` and the next start rebuilds it.

## Architecture

```
packages/core     Contract types + one incremental adapter per harness. Pure TS; runs in browser and server.
packages/ui       Trajectory and Chat views. Vendored dsh primitives and theme.
packages/context  dsh-context port: fold engine (src/fold), transcript → fold-event synthesizers (src/synth), dashboard (src/client).
apps/server       Hono API: scans harness roots, classifies files, replays and tails JSONL over SSE.
                  src/search = SQLite FTS5 full-text index over the same lines.
apps/web          Vite + React shell: sidebar, routes, harness registry, live session runtime.
```

Data flow: the server finds transcript files and streams raw JSONL lines to the browser.
The browser feeds each line to two incremental parsers, the core adapter shared by the
Trajectory and Chat views and the context synthesizer for the Context tab. Replays merge a session with its
subagent transcripts by timestamp. Parsers never throw on malformed or unknown records, so a
newer harness version degrades to "unknown record" rather than a blank page.

Devin CLI, OpenCode, and Cursor Agent keep sessions in SQLite, so the server reads
them read-only and materializes virtual line streams (`devin://sessions/<id>`,
`opencode://sessions/<id>`, and `cursor://sessions/<id>` — nothing is written to
disk). Devin's store is a message forest: chains duplicate
context under shared `message_id`s, so the logical transcript dedupes them, and
subagent chains are the forest components disjoint from the main chain, named by the
`subagent/agent_id` metadata on the spawning `run_subagent` result. OpenCode's store is
flat `message`/`part` rows per session; transcripts are emitted lazily (the catalog of
sessions is read eagerly, message/part bodies only when a session is opened), and child
sessions are bound to the parent's `task` tool call by `state.metadata.sessionId`.
Cursor keeps one `store.db` per agent under `~/.cursor/chats/<md5>/<agentId>/`;
the catalog reads `meta.json`, and the transcript is the protobuf root's ordered
model-message blobs.

Adding a harness means one adapter, one synthesizer, a server root and classifier, and a
web registry entry. See [AGENTS.md](AGENTS.md) for the checklist and per-harness format
traps.

## Development

```sh
pnpm typecheck                    # tsc in every package; strict TS is the linter
pnpm test                         # vitest across all projects
pnpm vitest run --project core    # one project: core, ui, context, context-ui, server, web
```

Tests use hand-written synthetic records only. Never commit real transcript content.

## Known limits

- **Timing.** Claude Code records no first-token time. Kimi Code flushes tool events after
  the response, so tool durations are not recoverable. Grok Build tool durations are deltas
  between update stamps, not measured values.
- **Context window.** Claude Code does not record it: 200k is assumed, 1M when the model tag
  is `[1m]`. Grok Build assumes 500k unless a compaction record reports one. Devin CLI
  records neither a window nor per-request prompts — the Context tab shows what the store
  carries (per-call `input_tokens`, `ttft_ms`, tool durations from `tool_call_state`).
  OpenCode records no window either; usage buckets are disjoint (output excludes
  reasoning, input excludes cache), so request input is input + cache read + cache write.
  Cursor Agent records a context-usage snapshot (`used` / `window` and named
  buckets) on the session root. Per-message times come from the turn chain when
  it has timestamps, and otherwise from `meta.json`. Subagent discovery is
  unverified (no observed `Task` tool call), and IDE (non-`cli`) sessions are
  not yet verified.
- **System prompt and tool schemas.** Only newer Claude Code transcripts record them. Codex
  records instructions but no schemas. Grok Build keeps both outside the JSONL and newest
  builds only write the schemas.
- **Cost** uses list prices from models.dev fetched at page load, so it is blank offline. A
  main session's cost includes its subagents. Kimi subscription models price at $0.
- **Per-call tokens.** Grok Build reports usage per turn; the per-call split is an estimate
  weighted by each call's own total. Codex compaction summaries are encrypted in the rollout.
- **Large sessions** load fully into the browser. A 60 MB rollout takes a few seconds.
- **The search index is big.** Off by default. With Content search on the
  server writes one `search.sqlite` under the cache directory (first build runs in the
  background). Delete the file to reclaim the space.
- **Search granularity.** Queries shorter than three characters return nothing: the trigram
  tokenizer cannot index them. Tool output (stdout, command results) is not indexed at all —
  the call that produced it is — and other records are indexed up to 16 KB, so a match past
  that point in a very large record is not found. Only transcripts
  modified within the retention window are indexed: 90 days by default, adjustable in the
  settings dialog (`0` indexes everything; widening re-indexes older sessions on the next
  start). Compaction summaries, system reminders, images, and base64 payloads are
  deliberately not indexed.

## Acknowledgements and license

MIT, except where noted:

- `packages/ui` derives from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  (MIT), see `packages/ui/LICENSE.deepseek-harness`.
- `packages/context` derives from [dsh-context](https://github.com/bowenliang123/dsh-context)
  and is Apache-2.0, see `packages/context/LICENSE` and `NOTICE`.
- Harness marks use path data from [Simple Icons](https://simpleicons.org) (CC0) and
  [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT), including Devin, pi, and OpenCode.
  Claude, Codex, Kimi, Grok, Devin, pi, OpenCode, and Cursor are
  trademarks of their respective owners. This project is not affiliated with any of them.
