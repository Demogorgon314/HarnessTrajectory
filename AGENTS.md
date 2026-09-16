# harness-trajectory — agent guide

Local viewer for coding-agent sessions (Claude Code, Codex, Kimi Code, Grok Build, Devin CLI): a
Trajectory view (ported from deepseek-harness) and a Context dashboard (ported from
dsh-context). Everything runs on this machine; transcripts are read from the harness
home directories and never leave it.

## Commands

```sh
pnpm install
pnpm dev          # server on :5170 (HARNESS_TRAJECTORY_PORT) + Vite web on :5173
pnpm test         # vitest, all projects (core, ui, context, context-ui, server, web)
pnpm vitest run --project core   # one project
pnpm typecheck    # tsc in every package; must be clean before you finish
pnpm build && pnpm start         # production bundle served by the server
pnpm pack:cli                    # npm tarball for `npx @demogorgon314/harness-trajectory`
```

Node ≥ 22, pnpm 12. No linter is configured; `tsc` strictness is the lint.

## Layout

```
packages/core     contract types + one adapter per harness (packages/core/src/adapters/*.ts).
                  Pure TS, runs in the browser and the server. HarnessKind union lives in session.ts.
packages/ui       Trajectory view + vendored dsh primitives/theme (MIT).
packages/context  dsh-context port (Apache-2.0; keep LICENSE + NOTICE):
                  src/fold = vendored fold (do not change its event vocabulary),
                  src/synth/<kind>.ts = transcript → fold events, src/client = dashboard.
apps/server       Hono API: `src/source.ts` is the `SessionSource` contract + shared
                  `SessionBook`/`CompositeSource`; `src/index.ts` (`SessionIndex`) is the
                  filesystem implementation (scans harness roots, classifies files,
                  replays + tails JSONL over SSE); `src/devin/` is the SQLite-backed
                  implementation reading Devin CLI's `sessions.db` into virtual
                  `devin://sessions/<id>` line streams.
                  src/search = SQLite FTS5 (node:sqlite, trigram, detail=none, contentless)
                  full-text index: store.ts schema (doc text deflate-compressed in
                  docs.text, docs.file → files.id FK), extract.ts record → docs (tool
                  outputs capped at 4 KB), indexer.ts batched writes, query.ts the
                  /api/search read (trigram-AND cover + inflate/verify/snippet/rank in
                  JS — FTS phrase, snippet and bm25 are unused).
                  Contract types live in core/src/search.ts.
                  src/settings.ts = settings.json persistence + the /api/settings controller.
                  contentSearch (default off; HARNESS_TRAJECTORY_SEARCH=1 forces on) decides
                  at startup whether the index exists at all. indexer.shouldIndex enforces
                  the retention window (searchMaxAgeDays,
                  default 90, 0 = all) at registration; the startup sweep and
                  applyMaxAgeDays purge what falls outside it.
                  src/listing-cache.ts = the restart fast path: per-file consume
                  cursors (bytes, rest, line count) + serialized meta-scanner
                  state, so a restart re-reads only transcripts whose
                  (size, mtime) changed, and resumes grown ones at the saved
                  offset. Fingerprint includes the scanner version
                  (`META_SCANNER_VERSION` in meta.ts — bump on scanner-logic
                  changes) and, for grok, `summary.json`'s mtime; a file the
                  search index has not fully covered (`searchFrom` below the
                  cached line count) is re-read so its docs can flow.
apps/web          Vite/React shell: sidebar, routes, harness registry (src/harnesses.tsx).
```

Data flow: a `SessionSource` finds transcript content (files for fs harnesses, virtual
streams for Devin) → SSE replays raw lines → the browser
feeds each line to the core adapter (Trajectory) and the context synthesizer (Context tab).
Both parsers are incremental and must never throw on a malformed or unknown record.
EventSource auto-reconnects after a drop and the server replays the whole stream on the
new socket — `openSessionStream`'s `onReconnect` fires then and the session runtime must
refold from empty, or every record lands twice.

## Conventions

- Strict TS: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (spread optional
  fields conditionally), no `any`, no non-null assertions to hide real cases. Use the
  `isRecord/asString/asNumber/parseTime` helpers from `packages/core/src/jsonl.ts`.
- Adapters document their verified on-disk format in the module header: transcript
  path, harness version checked, unit traps (seconds vs ms, ids, flush order). Decide
  human-vs-injected by a structural field, never by matching text.
- A meta scanner's state must be serializable for the listing cache:
  `serializeMeta`/`hydrateMeta` (meta.ts) cover `MetaState`; scanner-private
  state (Kimi's pending Agent calls) goes through the optional `save`/`load`
  pair. `pnpm dev` passes `--no-open` — the dev UI is Vite on :5173, and the
  auto-opened :5170 serves only the stale production bundle.
- Human prompt counting must agree across three places: the core adapter, the context
  synthesizer, and the server meta scanner (`apps/server/src/meta.ts`). Share one
  exported classifier per harness. The search extractor
  (`apps/server/src/search/extract.ts`) is the fourth caller and must reuse the same
  classifiers — never re-derive human-vs-injected from the text.
- The server writes only under the cache dir (`apps/server/src/cache.ts`):
  `search.sqlite`, `listing.sqlite` (`apps/server/src/listing-cache.ts`), and
  `settings.json` (`apps/server/src/settings.ts`). Harness roots stay
  read-only. The index is a cache:
  bump `SEARCH_SCHEMA_VERSION` instead of migrating. A search hit addresses a record by
  `(kind, sessionId, fileId, line)`, where `line` is the 0-based index of the record among
  the file's non-blank lines — the same numbering `readLines` produces. SSE replay uses
  that index as `startLine`. Grok's synthetic sidecar is emitted with `startLine: -1` and
  is not a search hit, so it shifts nothing.
- `snapshot()` returns the same object when nothing changed; touch the assembler only on
  real changes (the UI re-renders on identity).
- Tests: no fixture files. Each spec hand-writes synthetic records with the real field
  names and fake payloads; server specs use real temp directories. Add tests in every
  layer you touch.
- Vendored code keeps its attribution; logos come from lobe-icons or Simple Icons and are
  credited in `apps/web/src/harnesses.tsx` and the README license section.
- Do not commit or push unless asked. No attribution lines in commit messages.

## Adding a harness

Mirror the most recent one (`git show --stat` of the Kimi or Grok commit lists every
touchpoint): `HarnessKind` + `HARNESS_KINDS`, `adapters/<kind>.ts` + registry,
`synth/<kind>.ts` + registry, server `roots.ts` / `classifyPath` / meta scanner /
child binding / `search/extract.ts` branch, web registry entry with logo + resume command,
README roots and limits, and specs in core, context, server, and web. Child listing
titles go through `listingScannerFor` / `MetaState.agents` / `mergeChildAgent` in
`apps/server/src/meta.ts` — a sidecar harness attaches `file.agent` at registration
and skips the child scan; a JSONL-only harness fills the parent scanner's `agents`
map (spawn description) and the child's own `title`/`agentType`. Do not branch on
kind in `index.ts` to stamp those facts.

## Harness facts that are easy to get wrong

- Claude: context window is not recorded; assume 200k, 1M when the model tag is `[1m]`.
  A main session's cost includes its subagents. Subagent files bind through `.meta.json`.
- Codex: children are top-level rollouts with `parent_thread_id`.
- Kimi: `time` is epoch ms; loop events are flushed after the response, so tool
  durations are not recoverable; `message.origin` decides human vs injected, with one
  exception that looks wrong but isn't: a subagent's delegated prompt is
  `system_trigger`/`subagent`, the one trigger the CLI itself displays as a prompt, so
  `kimiMessageClass` counts it as human (titles skip its `<git-context>` prelude via
  `kimiTitleText`). An `llm.request` with `kind: 'compaction'` is not a loop step: it
  has no `turnStep` and its `maxTokens` is the summary model's cap, not the context
  window. A compaction replaces the context with a summary message (the
  `contextSummary` field — the shorter `summary` is the working summary the
  trajectory shows) plus a SELECTION OF USER MESSAGES (`keptUserMessageCount`,
  `keptHeadUserMessageCount` when the middle was elided), never whole turns; a
  trend that keeps whole turns alive never drops. There is no durable spawn
  record for subagents: a background launch binds through `task.started`
  (`info.parentToolCallId`), a foreground one only through the `Agent` result's
  `agent_id:` header (arriving after the child's whole transcript — child loop
  events are buffered until it lands), an `AgentSwarm` through the result's
  `<subagent agent_id="…">` XML. There is no sidecar: the listing description is
  the parent Agent call's `description` (else the child's delegated prompt),
  discovered by the meta scanner. Finished subagent wires can still grow after
  `turn.ended` — the AGENTS.md reminder service lives in the agent's scope,
  which outlives the turn and keeps watching the session's instruction files;
  `reminder.notify()` appends `agents_md_change` to context memory immediately
  (no turn gate), so they are real context records.
  The TUI replay skips rendering `origin.kind === 'injection'`; this viewer
  folds them as context, the same way it shows Claude system-reminders. Images
  are `image_url` parts:
  inline `data:` URLs below ~4 KB, else `blobref:<mime>;<sha256>` whose bytes
  sit in `agents/<id>/blobs/` and are served by the server's blob route.
- Grok: parse only `updates.jsonl` (`chat_history.jsonl` is a derived cache, `events.jsonl`
  is telemetry). Envelope `timestamp` is seconds, `_meta.agentTimestampMs` is ms. Usage
  arrives per turn in `turn_completed`; per-call split uses each stream's first
  `_meta.totalTokens`. Children are top-level session dirs bound through the parent's
  `subagents/<id>/meta.json`, never by tool call id. Title, cwd, system prompt, and tool
  schemas live outside the JSONL and reach the parsers through the server's sidecar line.
- Devin: no files — `sessions.db` (WAL, live-written) holds `sessions`, `message_nodes`,
  `tool_call_state`; `subagent_heads` exists but is empty in practice. Column timestamps
  are epoch SECONDS; `chat_message.metadata.created_at`/`started_generation_at` are ISO
  ms. `message_nodes` is a forest that re-renders context as copied chains: group them by
  union-find over `parent_node_id` + `compact/prior_node_ids` + shared `message_id`; the
  group holding `main_chain_id` is the main stream. Other groups are NOT automatically
  children — compactor/render chains look identical to subagent chains — so unclaimed
  groups buffer as `pending` and surface only when a `subagent_heads` row or a spawn
  result's `subagent/agent_id`/`chain_node_id`/`profile_name` extensions claim them
  (claims can land after the child's lines; the child file is `agent-<agentId>`). Dedup
  is per `(message_id, stream, compaction epoch)`: a `system` node with
  `extensions['devin-rs/summary']` ends a render — copies of pre-summary mids then
  re-emit because they are kept context, and the summary's chain ancestors (re-rendered
  prefix, kept injections) flush with it. `system` splits by extension: none = rendered
  prefix (each render rewrites it — a new contiguous run replaces the header text),
  `devin-rs/summary` = compaction, anything else = an injected block
  (`agent-ext/rules-loaded`, `agent-ext/skills-loaded`, `affogato/cog-context`,
  `chisel/user-edits-*`; a re-injection under the same key replaces the stale one).
  Replays re-enter the fold surface carrying `data.replay: true` — the fold surfaces
  the copy but skips all bookkeeping (request record, usage, step timing, human-input
  tally, inject re-listing); they are exempt from the claim that produced them and are
  not re-indexed for search. Human
  vs injected is `metadata.is_user_input`; usage lives in `metadata.metrics`, tool wall
  time in `chisel/tool_call_timing.duration_ms`, and ACP state in `tool_call_state`
  (settles a call whose result message never landed). `devin.session`/`devin.tool` are
  synthetic sidecar lines (`startLine: -1`, never indexed).
