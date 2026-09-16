# harness-trajectory — agent guide

Local viewer for Claude Code, Codex, Kimi Code, Grok Build, and Devin CLI sessions.
Trajectory is ported from deepseek-harness; Context is ported from dsh-context.
Transcripts stay local. Harness roots are read-only.

## Working rules

- Inspect the relevant implementation and tests before editing; preserve unrelated changes.
- Keep changes focused and follow existing architecture, naming, imports, and error handling.
- Do not commit or push unless explicitly asked. Do not add attribution lines to commit messages.
- Before changing a harness's parsing, context, metadata, search extraction, or source lifecycle,
  read its section in [the harness reference](docs/harness-formats.md).
- Keep this file focused on shared rules and navigation. Put harness-specific format and
  lifecycle details in the reference; update them when observable behavior changes.

## Commands and verification

Use Node ≥ 22.13 and pnpm 12 (the exact pnpm version is pinned in `package.json`).
No linter is configured; strict TypeScript checking is required.

```sh
pnpm install
pnpm dev                         # API :5170 + Vite UI :5173
pnpm vitest run --project core    # targeted project
pnpm test                        # all six Vitest projects
pnpm typecheck                    # all packages; must pass before finishing
pnpm build && pnpm start          # production bundle + server
pnpm pack:cli                     # build and pack the npm CLI tarball
```

- `HARNESS_TRAJECTORY_PORT` changes the API port. During development, open Vite on :5173.
  `pnpm dev` passes `--no-open`; the API port serves the last production UI bundle.
- Vitest projects: `core`, `ui`, `context`, `context-ui`, `server`, `web`.
  Run the affected projects for behavior changes and the full suite for cross-layer changes.
- Add regression coverage in each affected behavior layer. Use synthetic records with real
  field names and fake payloads; no fixture files. Server tests use real temporary directories.
  Do not add tests solely for documentation or mechanical edits.
- Run `pnpm typecheck` before finishing. Run `pnpm build` when changing build, packaging,
  or production-serving behavior. Report checks actually run and any failures or blockers.

## Code map

| Path | Responsibility |
| --- | --- |
| `packages/core/src/session.ts` | Session contracts, `HarnessKind`, `HARNESS_KINDS` |
| `packages/core/src/adapters/` | Incremental harness parsers and registry; browser/server-safe TypeScript |
| `packages/ui` | Trajectory view and vendored dsh primitives/theme (MIT) |
| `packages/context/src/fold/` | Vendored fold; do not change its event vocabulary |
| `packages/context/src/synth/` | Harness records → fold events, plus registry |
| `packages/context/src/client/` | Context dashboard |
| `apps/server/src/source.ts` | `SessionSource`, shared `SessionBook`, `CompositeSource` |
| `apps/server/src/index.ts` | Filesystem `SessionIndex`: scan, classify, replay, tail JSONL |
| `apps/server/src/devin/` | SQLite-backed source for virtual `devin://sessions/<id>` streams |
| `apps/server/src/meta.ts` | Listing scanners, serializable metadata, child-agent facts |
| `apps/server/src/search/` | Full-text index; contracts in `packages/core/src/search.ts` |
| `apps/server/src/settings.ts` | `settings.json` persistence and settings controller |
| `apps/server/src/listing-cache.ts` | Restart cursors and serialized scanner state |
| `apps/web/src/harnesses.tsx` | Harness UI registry, logos, resume commands |

`apps/web` is the Vite/React shell, sidebar, and routes. `packages/context` is an
Apache-2.0 port: retain LICENSE and NOTICE. Preserve all vendored attribution.
Logo credits live in the web registry and README license section.

## Cross-layer invariants

- Flow: `SessionSource` → raw-line SSE → core adapter (Trajectory) and context synthesizer.
  Both parsers are incremental and must not throw on malformed or unknown records.
- SSE reconnect replays the entire stream. Reset session folding to empty on
  `openSessionStream.onReconnect` or every record is counted twice.
- `CompositeSource` routes disjoint harness kinds through each source's `kinds()`.
  Always attach the Devin source: a missing/corrupt database degrades to empty and later
  polling must recover without restarting.
- Human prompt classification must agree across the core adapter, context synthesizer,
  server meta scanner, and search extractor. Reuse one exported classifier per harness;
  use structural fields, never text matching, to distinguish human and injected input.
- `snapshot()` must retain object identity when unchanged. Touch the assembler only
  for real changes; the UI renders on identity.
- Use strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), conditional
  spreads for optional fields, and the `isRecord/asString/asNumber/parseTime` helpers
  from `packages/core/src/jsonl.ts`. Do not use `any` or non-null assertions to hide cases.
- Adapter headers document the verified transcript path, harness version, and format
  traps such as timestamp units, IDs, and flush order.

## Storage, search, and cache contracts

- Server writes belong under the cache directory defined in `apps/server/src/cache.ts`:
  `search.sqlite`, `listing.sqlite`, and `settings.json`. Never write to harness roots.
- Search uses `node:sqlite` FTS5 with trigram, `detail=none`, and contentless storage.
  `store.ts` deduplicates document text: `texts` holds each unique text once
  (8-byte SHA-1-prefix key, deflate-compressed) and `docs` stores only occurrences
  (`file, line, role, time_ms → texts.id`); the FTS rowid is the text id, so the
  inverted index dedups too. `extract.ts` indexes tool *calls* (command, paths,
  patterns, write/edit contents) but never tool *outputs* — stdout is ~73% of
  the unique text on the reference corpus and duplicates what the trajectory
  view's client-side search already covers. `indexer.ts` batches writes. `query.ts` ANDs trigrams, verifies each unique text once in JS,
  expands occurrences through `docs_by_text` and the in-memory `files` snapshot
  (kind filter applies at expansion), ranks by occurrence count, and builds
  snippets only for displayed hits. FTS phrase queries, `snippet()`, and `bm25`
  are not used.
- Deletes remove only `docs` rows; texts orphaned when their last occurrence goes
  away still match but expand to zero hits. `store.gcTexts()` reclaims them (with
  their FTS rows) on the paths that already accept a multi-second cost —
  `finishBackfill` after purging vanished files and `applyMaxAgeDays` — never
  inline in a flush.
- The search database is a cache: bump `SEARCH_SCHEMA_VERSION` instead of migrating.
- `contentSearch` defaults off; `HARNESS_TRAJECTORY_SEARCH=1` forces it on. The setting
  takes effect at startup; disabling it preserves any existing database on disk.
  `searchMaxAgeDays` defaults to 90; 0 means all. `indexer.shouldIndex` enforces retention
  at registration; the startup sweep and `applyMaxAgeDays` purge expired entries.
- A search hit uses `(kind, sessionId, fileId, line)`. For JSONL, `line` is the zero-based
  non-blank record index produced by `readLines`; SSE uses it as `startLine`.
  Devin uses the emission index within its virtual stream. Grok and Devin synthetic
  sidecars use `startLine: -1` and are never search hits or counted as stream records.
- Listing cache stores consume cursors (bytes, rest, line count) and scanner state.
  `serializeMeta`/`hydrateMeta` cover `MetaState`; scanner-private state uses `save`/`load`.
  Bump `META_SCANNER_VERSION` in `meta.ts` whenever scanner logic changes.
- Restart compares size/mtime and resumes growing files at the saved offset. Cache
  validation also includes scanner version and Grok's `summary.json` mtime. Re-read files
  whose search coverage (`searchFrom`) is below the cached line count.

## Adding a harness

Use an existing harness with a similar storage and subagent model as a reference.
Check each integration point:

1. Core: `HarnessKind`, `HARNESS_KINDS`, adapter, exported classifier, adapter registry.
2. Context: synthesizer and synthesizer registry.
3. Server: roots, `classifyPath`, meta scanner, child binding, search extraction.
   For a new storage backend, implement `SessionSource` and compose disjoint kinds.
4. Web: registry entry, attributed logo, and resume command.
5. Documentation: README roots/limits and the harness reference.
6. Tests: affected core, context, server, and web behavior.

Child listing facts go through `listingScannerFor`, `MetaState.agents`, and
`mergeChildAgent` in `apps/server/src/meta.ts`. A sidecar harness attaches `file.agent`
at registration and skips the child scan; a JSONL-only harness fills the parent's
`agents` map with spawn descriptions and the child's own `title`/`agentType`.
Do not add kind-specific branches in `index.ts` to stamp those facts.
