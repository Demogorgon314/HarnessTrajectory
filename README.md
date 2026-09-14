# Harness Trajectory

A local viewer for agent sessions. It scans the transcripts that **Claude Code** and
**Codex** write on this machine, folds them into a turn-aware event ledger with an
interactive timing overview, and follows sessions that are still running.

The ledger, timeline, inspector, and toolbar are a port of the Trajectory view from
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`ui-trajectory`,
MIT), kept pixel-faithful by vendoring the primitives and theme tokens it renders with.
The harness-specific plumbing was replaced with a small contract that any transcript
adapter can target.

## Run it

```sh
pnpm install
pnpm dev           # server on http://127.0.0.1:5170, web UI on http://localhost:5173
```

Production build, served from one process:

```sh
pnpm build         # builds every package and bundles the web UI into apps/server/dist/public
pnpm start         # http://127.0.0.1:5170
```

Transcript roots default to `~/.claude/projects` and `~/.codex/sessions`; the harness
overrides `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured, and
`HARNESS_TRAJECTORY_CLAUDE_ROOT` / `HARNESS_TRAJECTORY_CODEX_ROOT` point at other
directories. `--port` / `HARNESS_TRAJECTORY_PORT` change the port.

## What you get

- **Session picker** grouped by project, filterable by harness, searchable by title,
  project path, or id. Titles come from the harness (`ai-title`) or the first human prompt.
- **Trajectory ledger**: turns, steps, user/assistant/tool/subtool records, token usage,
  durations, a record inspector (payload, result, schema, timing), fold controls, and
  live search.
- **Timing overview** above the ledger: drag to focus an interval, wheel to zoom,
  recorded durations or equal widths.
- **Live follow**: the server tails transcript files and streams appended lines over
  SSE; in-flight assistant output and running tool calls render as they happen.
- **Subagents** nest under the call that spawned them: Claude Code `Agent` transcripts
  (`agent-*.jsonl`, `<session>/subagents/`) and Codex child threads
  (`parent_thread_id`) become sub-tool rows of the parent record.
- Light, dark, and system themes; English and Chinese copy.

## Layout

```
packages/core     contract types + Claude Code and Codex adapters (pure TS, runs in the browser)
packages/ui       the ported trajectory view, vendored primitives (markdown, JSON tree, tooltip, icons), theme CSS
apps/server       Hono server: transcript discovery, metadata index, file tailing, SSE, static UI
apps/web          Vite + React shell: session list, live session runtime, view host
```

Adapters are incremental parsers: the browser feeds raw JSONL lines as they arrive and
reads a memoized `TrajectorySnapshot` (nodes, requests, partial output, running calls).
Replays merge the main transcript and its child transcripts by timestamp so subagents
land where they actually happened.

## Develop

```sh
pnpm typecheck     # tsc for every package
pnpm test          # vitest: core adapters, ui (jsdom), server index
```

Adapter tests use synthetic fixtures only; never copy real transcript content into the
repository.

## Known limits

- Neither harness records first-token time, so the TTFT split in the overview is blank;
  durations come from record timestamps.
- Claude Code transcripts do not include the system prompt or tool catalog; Codex
  sessions show their base instructions as the initial system prompt.
- Whole sessions load into the browser (a 60 MB rollout takes a few seconds); the
  "load earlier history" control only pages the rendered window.
- Claude Code subagent transcript layouts were implemented from the documented file
  patterns but could not be verified against real files on the development machine.

## License

The vendored `packages/ui` sources derive from deepseek-harness (MIT); see
`packages/ui/LICENSE.deepseek-harness`. Everything else is MIT as well.
