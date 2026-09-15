# harness-trajectory — agent guide

Local viewer for coding-agent sessions (Claude Code, Codex, Kimi Code, Grok Build): a
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
apps/server       Hono API: scans harness roots, classifies files, replays + tails JSONL over SSE.
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
apps/web          Vite/React shell: sidebar, routes, harness registry (src/harnesses.tsx).
```

Data flow: server finds transcript files → SSE replays raw JSONL lines → the browser
feeds each line to the core adapter (Trajectory) and the context synthesizer (Context tab).
Both parsers are incremental and must never throw on a malformed or unknown record.

## Conventions

- Strict TS: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (spread optional
  fields conditionally), no `any`, no non-null assertions to hide real cases. Use the
  `isRecord/asString/asNumber/parseTime` helpers from `packages/core/src/jsonl.ts`.
- Adapters document their verified on-disk format in the module header: transcript
  path, harness version checked, unit traps (seconds vs ms, ids, flush order). Decide
  human-vs-injected by a structural field, never by matching text.
- Human prompt counting must agree across three places: the core adapter, the context
  synthesizer, and the server meta scanner (`apps/server/src/meta.ts`). Share one
  exported classifier per harness. The search extractor
  (`apps/server/src/search/extract.ts`) is the fourth caller and must reuse the same
  classifiers — never re-derive human-vs-injected from the text.
- The server writes only under the cache dir (`apps/server/src/cache.ts`):
  `search.sqlite` and `settings.json` (`apps/server/src/settings.ts`). Harness roots stay
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
README roots and limits, and specs in core, context, server, and web.

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
  `<subagent agent_id="…">` XML. Images are `image_url` parts: inline `data:` URLs
  below ~4 KB, else `blobref:<mime>;<sha256>` whose bytes sit in `agents/<id>/blobs/`
  and are served by the server's blob route.
- Grok: parse only `updates.jsonl` (`chat_history.jsonl` is a derived cache, `events.jsonl`
  is telemetry). Envelope `timestamp` is seconds, `_meta.agentTimestampMs` is ms. Usage
  arrives per turn in `turn_completed`; per-call split uses each stream's first
  `_meta.totalTokens`. Children are top-level session dirs bound through the parent's
  `subagents/<id>/meta.json`, never by tool call id. Title, cwd, system prompt, and tool
  schemas live outside the JSONL and reach the parsers through the server's sidecar line.
