# Harness Trajectory

A local viewer for agent sessions. It scans the transcripts that **Claude Code**,
**Codex**, **Kimi Code**, and **Grok Build** write on this machine, folds them into a
turn-aware event ledger with an interactive timing overview and a context dashboard,
and follows sessions that are still running.

The ledger, timeline, inspector, and toolbar are a port of the Trajectory view from
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`ui-trajectory`,
MIT), kept pixel-faithful by vendoring the primitives and theme tokens it renders with.
The harness-specific plumbing was replaced with a small contract that any transcript
adapter can target. The **Context** tab is a port of
[dsh-context](https://github.com/bowenliang123/dsh-context) (Apache-2.0): the same cards,
charts, and browser, fed by the transcript files instead of the dsh runtime.

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

Transcript roots default to `~/.claude/projects`, `~/.codex/sessions`,
`~/.kimi-code/sessions`, and `~/.grok/sessions`; the harness overrides
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CODE_HOME`, and `GROK_HOME` are honoured, and
`HARNESS_TRAJECTORY_CLAUDE_ROOT` / `HARNESS_TRAJECTORY_CODEX_ROOT` /
`HARNESS_TRAJECTORY_KIMI_ROOT` / `HARNESS_TRAJECTORY_GROK_ROOT` point at other
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
  (`<session>/subagents/agent-*.jsonl`, older `agent-*.jsonl`), Codex child threads
  (`parent_thread_id`), Kimi Code child transcripts
  (`<session>/agents/<agentId>/wire.jsonl`), and Grok Build subagent sessions become
  sub-tool rows of the parent record. Claude children are bound to their call by the
  `toolUseId` in the sidecar `.meta.json`, the `agentId` in the parent's launch receipt,
  or a fork's inherited tool result; Kimi children are bound by `task.started` records
  of kind `agent` (`info.parentToolCallId` → `info.agentId`); a Grok child is a
  **top-level** session directory of its own (under its own encoded cwd when the run got
  a worktree), marked by `summary.json`'s `hidden` / `session_kind: subagent*` and bound
  through the parent's `subagents/<childId>/meta.json` — grok records no spawning
  tool-call id at all, so the run is attached to its `task` / `spawn_subagent` call by
  prompt id, order, and description; so parallel and relaunched agents land on the right
  row and an in-flight subagent tool shows before its result lands. The
  pane header lists every run (description, type, model, status from the parent's
  receipts and task notifications, tool count, duration); picking one opens that
  transcript as a session of its own, with a breadcrumb back to the parent. Subagent
  transcripts created while you watch are picked up live.
- **Context tab** (next to Trajectory in the session header): Context Stats (turns, steps,
  human inputs, live tool calls, cache hit, cost), Session Info (harness, model, context
  window, CLI version, resume command), Token Stats and Timing Stats donuts, Current
  Context occupancy bar, per-step / per-turn Context Trend with the step brief, the
  Context Browser (every request's assembled context, expandable to the actual system
  prompt, tool schemas, messages, and tool results), Context Events (injections,
  compactions, model switches, plan mode), File Activity (reads, writes with line deltas,
  searches), and the Agent Network (one node per subagent; click to open its own context,
  breadcrumb back). A gear popover keeps the trend granularity, trend mode, tool sort, and
  file sort defaults in localStorage.
- Light, dark, and system themes; English and Chinese copy.

## Layout

```
packages/core     contract types + Claude Code, Codex, Kimi Code, and Grok Build adapters (pure TS, runs in the browser)
packages/ui       the ported trajectory view, vendored primitives (markdown, JSON tree, tooltip, icons), theme CSS
packages/context  the ported dsh-context dashboard: fold (src/fold), transcript → fold-event synthesizers (src/synth), client (src/client)
apps/server       Hono server: transcript discovery, metadata index, file tailing, SSE, static UI
apps/web          Vite + React shell: session list, live session runtime, view host
```

Adapters are incremental parsers: the browser feeds raw JSONL lines as they arrive and
reads a memoized `TrajectorySnapshot` (nodes, requests, partial output, running calls).
Replays merge the main transcript and its child transcripts by timestamp so subagents
land where they actually happened.

The Context tab runs on the same line stream: a synthesizer for each harness (Claude
Code, Codex, Kimi Code, Grok Build) turns each transcript file into dsh-context's fold events
(`request/header`, `user/message`, `assistant/message`, `tool/call`, `tool/result`,
`compaction/summary`, …) and the vendored fold produces the dashboard's timeline. Every
file (main and each subagent) is folded on its own, exactly like a dsh subagent
session. Token figures follow the dsh-context convention: per-request prompt, cache,
and output tokens are the provider's own numbers; the per-category split is an
estimate (≈), anchored to the provider total.

## Develop

```sh
pnpm typecheck     # tsc for every package
pnpm test          # vitest: core adapters, ui (jsdom), context fold + synthesizers, context-ui (jsdom), server index, web
```

Adapter tests use synthetic fixtures only; never copy real transcript content into the
repository.

## Known limits

- Claude Code does not record first-token time (its records land at block completion), so
  TTFT stays unattributed for Claude sessions; the thinking / answer / tool-args split
  comes from block completion times. Codex reports both. Kimi Code records TTFT and
  decode timing per step (`llmFirstTokenLatencyMs`, `llmStreamDurationMs`), but its tool
  durations are not recoverable: loop events (parts, tool calls, tool results) are
  flushed to the transcript only after the response completes, so their recorded times
  are not the moments they actually happened. Grok Build tool durations are the deltas
  between its own update stamps: the measured figures live in `events.jsonl`, a
  telemetry side-channel the viewer does not read.
- Claude Code records the system prompt and tool schemas only in newer transcripts
  (`prompt_snapshot` attachments); older sessions show the System Prompt as a derived
  remainder (actual prompt tokens minus the estimated messages, marked "≈ derived") and
  Tool Schemas as "not recorded". Codex records its base instructions but no tool schemas.
  Kimi Code records both the system prompt and the tool schemas actually sent on every
  session (nothing derived). Grok Build keeps both outside the transcript —
  `system_prompt.txt` (written for every session) and `tool_definitions.json` (newest
  builds only) — and the server hands them to the fold as one synthetic first line
  alongside `summary.json`; a session without `tool_definitions.json` shows Tool Schemas
  as "not recorded".
- Claude Code does not record the context window; the dashboard assumes 200k tokens and
  switches to 1M when the model carries a `[1m]` tag or a request exceeds 200k. Codex
  reports its window per turn. Kimi Code reports its window (`llm.request.maxTokens`)
  per request as well. Grok Build records no window in-band, so 500k is assumed unless
  an auto-compaction record reports one.
- Cost uses list prices fetched from models.dev at page load (blank offline). The main
  session's cost includes every subagent (the tooltip breaks it down per agent); 1-hour
  cache writes are billed at twice the input rate, as Claude Code does; models missing
  from the price list are named under the figure. A Claude `cost-state` record, when
  present, is shown as the reported cost: it is session-wide and also counts calls the
  transcript never records (interrupted requests, the background title model), so it
  runs a few percent above the estimate. Kimi Code's subscription models
  (`kimi-for-coding`) price at $0 on models.dev, so Cost reads $0 for those sessions.
  Grok Build computes its own cost server-side and reports it per turn (`costUsdTicks`,
  1e10 ticks = $1); the Cost card shows the models.dev `xai`
  estimate, and grok's own figure — summed over the turns that reported one — appears in
  Session Info as "Reported by Grok Build".
- Codex compaction summaries are encrypted in the rollout, so a compaction shows its
  retained history but no summary text.
- Grok Build's `updates.jsonl` is append-only, so a rewind leaves the abandoned branch in
  the file: it is shown as a notice, and the records that were undone stay on the ledger.
  Its `hook_execution` records are not rendered.
- Grok Build reports tokens per turn, not per model call (`turn_completed.usage`), so the
  Context tab's per-request figures are that turn's usage apportioned across the turn's
  model calls, using the `totalTokens` each record stamps as the weight; the turn totals
  are exact, the per-step split is an estimate. Because the usage only arrives with
  `turn_completed`, the Context tab folds a Grok turn when it ends: while a live session
  is mid-turn, that turn's nodes are not on the Context tab yet (the Trajectory tab shows
  them as they stream). Its tool durations are the deltas between update stamps rather
  than measured times (see the first limit above).
- A Grok Build session directory is named after its encoded working directory, unless the
  encoding would exceed the filesystem's limit: then grok stores it under an irreversible
  `{slug}-{hash}` name instead. A subagent that ran in its own worktree cwd of that shape
  cannot be located from the parent's `subagents/<id>/meta.json`, so it is only picked up
  live when it sits in the parent's own group; otherwise it appears — correctly nested
  under its parent — from the next full scan of the root.
- Whole sessions load into the browser (a 60 MB rollout takes a few seconds); the
  "load earlier history" control only pages the rendered window.
- A subagent's status comes from the parent transcript (launch receipt, sync result,
  task notification); a run whose parent stopped without a notification stays "running"
  until the session is no longer live, when the catalog shows it as idle.

## License

The vendored `packages/ui` sources derive from deepseek-harness (MIT); see
`packages/ui/LICENSE.deepseek-harness`. `packages/context` derives from
[dsh-context](https://github.com/bowenliang123/dsh-context) and is distributed under the
Apache License 2.0; see `packages/context/LICENSE` and `packages/context/NOTICE`. Its
stylesheets use [Tailwind CSS](https://tailwindcss.com) utilities (MIT). Harness brand marks in `apps/web/src/harnesses.tsx`
use path data from [Simple Icons](https://simpleicons.org) (CC0, the Claude sunburst) and
[lobe-icons](https://github.com/lobehub/lobe-icons) (MIT, the Codex blossom, the Kimi mark, and
the Grok mark); the marks themselves belong to Anthropic, OpenAI, Moonshot AI, and xAI
respectively and identify their harnesses here. Claude, Codex, Kimi, and Grok are trademarks of
their respective owners; this project is not affiliated with any of them. Everything else is
MIT as well.
