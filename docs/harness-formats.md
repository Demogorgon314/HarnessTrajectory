# Harness format and lifecycle reference

Read the relevant harness section before changing its adapter, context synthesizer, meta
scanner, search extraction, or session source. Paths below are repository-relative. Keep these
constraints in sync with the implementation and its regression tests.

## Claude

Context window is not recorded; assume 200k, 1M when the model tag is `[1m]`. A main session's
cost includes its subagents. Subagent files bind through `.meta.json`.

## Codex

Rollouts live under `~/.codex/sessions/<yyyy>/<mm>/<dd>/` (archived ones under
`~/.codex/archived_sessions/`) as `rollout-<timestamp>-<threadId>[_<rolloutId>].jsonl`;
the second UUID appears on reverts and forks, and the rollout id is always the LAST UUID in
the basename. Cold files are zstd-compressed in place to `.jsonl.zst` (one zstd frame over the
whole file) and materialize back to `.jsonl` on the next append, so discovery, replay, tailing,
and search must accept both spellings and never double-count the pair. Offsets in
`history_base` are DECODED bytes — `readLines` slices compressed files after decompressing.

### Logical history

A thread is not one file. Revert keeps the thread id, writes a new rollout id, and records
`session_meta.history_base = { thread_id: <BASE ROLLOUT id>, end_byte_offset }` pointing at a
finite prefix of an earlier file; fork does the same across threads, and one file can be the
base of several. `codex-rollouts.ts` owns this bookkeeping: it indexes rollouts by id, demotes
a superseded same-thread file to base duty, and replays `readLines(base, 0, '', end)` before
the fork's own records. A live demote clears the session's file membership first, so the
replacement head's `file` event carries `reset: true` — an open view must refold, not append.
The listing cache stores the resolved file set per session (`footprint`) so restarts reopen
bases too; a footprint mismatch — including a base that was still missing at save time — drops
the file's indexed search rows and re-reads the whole logical stream, because the base shifts
every later line's index. The legacy `thread_rolled_back` event drops the
last N surviving user turns — context maintains the effective turn stack and emits a
`compaction/prune` over those turns' nodes plus a zero-token marker; repeated rollbacks
continue from the surviving history, and markers never become user turns;
the core adapter records a `turn-error` node.

### Turn and response lifecycle

`task_started`/`task_complete` carry `turn_id` and delimit turns; extra user input inside an
open turn is steering, not a new turn. A `token_usage_record` settles the response it closes
(`response_id`); `token_count` events only update context occupancy — old rollouts have no
usage record, so `info.last_token_usage` is the non-authoritative fallback, never
double-counted. `turn_aborted` ends the open turn as an error. A usage record with no open
response — remote compaction writes one — is buffered by `response_id` until the `compacted`
record's `compaction_response_id` claims it; it must never retroactively rewrite the previous
response's usage.

### Input classification

`codexUserItems` classifies each content item of a user message: the structural
`internal_chat_message_metadata_passthrough.content_item_kinds` annotation decides when
present; otherwise the known injected fragments are matched by their exact start/end markers
(`<environment_context>`, `<user_instructions>`, `# AGENTS.md instructions`, guardian relays,
skill catalogs, …). Anything else — including XML-shaped prompts like `<question>…` — is human.
All four layers (adapter, synth, meta, search) share this classifier.

### Children and retained context

Children are top-level rollouts with `parent_thread_id`; `session_meta.source.subagent` names
them. A child's own `task_complete` ends its run but not its life — only a later
`task_started` reopens it; late statistics or state records update the finished run without
spawning a new one. `subagent_history_start_ordinal` marks where its own records begin
(inherited parent history before it is not the child's activity); the boundary travels on
`SessionFileRef` so it applies equally when the child is viewed standalone, through the
parent, in listing metadata, and in the search index. Ownership uses the record's durable
`ordinal`, never the SSE/search line index (a missing base or ordinal gap separates them).
Only the owning thread's header supplies child identity. Context preserves inherited
model-visible messages using replay events, without importing the parent's requests,
human-input counts, tool execution timing, or file activity. Compaction arrives as a top-level
`compacted` record: `replacement_history` is a full ResponseItem list — user/developer
messages, retained `agent_message` relays, and encrypted `compaction` items that carry no
readable text — and alone decides the model-visible surface. `retained_context.user_messages`
is host-side review evidence, shown on the summary event but never re-added to the surface;
`latest_token_usage_record.usage.input_tokens` — never the cumulative thread total — is the
shadowed context size.

### Durable items

The rollout policy persists more than messages and shell calls: `web_search_call` and
`image_generation_call` are self-contained (result embedded, no output record follows; the
synthesizer emits `tool/call` before `tool/result` so fold pairing settles immediately),
`item_completed` bookkeeping that lands after a call settled is attributed by exact call id —
first against open calls, then already-settled ones — before any lone-open-call fallback,
`tool_search_call`/`tool_search_output` pair by `call_id` and carry discovered schemas in
`tools`, `agent_message` items and top-level `inter_agent_communication` records are agent
relays (never human prompts), `configuration_update` records reasoning-effort changes,
`thread_settings_applied` snapshots can switch the model, `thread_goal_updated` carries the
objective, and `retained_context` holds host-only `verified_answer` Q&A, displayed as
content-free notices whose text does not enter model context or token estimates. Search indexes the relays,
goal, and discovered tool names; encrypted compaction replays and `event_msg` mirrors of
response items stay unindexed.

### Dynamic tools

`session_meta.dynamic_tools` is a heterogeneous list: canonical `{"type":"function", …}` and
`{"type":"namespace", name, tools:[…]}` entries plus legacy flat `{name, inputSchema,
namespace?, exposeToContext?}` specs. `normalizeDynamicTools` flattens them, maps
`exposeToContext: false` to `deferLoading: true`, and keeps `namespace` on each emitted spec.
Calls resolve as `namespace.name` for non-`functions` namespaces.

## Kimi

`time` is epoch ms; loop events are flushed after the response, so tool durations are not
recoverable; `message.origin` decides human vs injected, with one exception that looks wrong
but isn't: a subagent's delegated prompt is `system_trigger`/`subagent`, the one trigger the
CLI itself displays as a prompt, so `kimiMessageClass` counts it as human (titles skip its
`<git-context>` prelude via `kimiTitleText`).

### Compaction

An `llm.request` with `kind: 'compaction'` is not a loop step: it has no `turnStep` and its
`maxTokens` is the summary model's cap, not the context window. A compaction replaces the
context with a summary message (the `contextSummary` field — the shorter `summary` is the
working summary the trajectory shows) plus a SELECTION OF USER MESSAGES
(`keptUserMessageCount`, `keptHeadUserMessageCount` when the middle was elided), never whole
turns; a trend that keeps whole turns alive never drops.

### Subagent binding

There is no durable spawn record for subagents: a background launch binds through
`task.started` (`info.parentToolCallId`), a foreground one only through the `Agent` result's
`agent_id:` header (arriving after the child's whole transcript — child loop events are
buffered until it lands), an `AgentSwarm` through the result's `<subagent agent_id="…">` XML.
There is no sidecar: the listing description is the parent Agent call's `description` (else the
child's delegated prompt), discovered by the meta scanner.

### Late records and images

Finished subagent wires can still grow after `turn.ended` — the AGENTS.md reminder service
lives in the agent's scope, which outlives the turn and keeps watching the session's
instruction files; `reminder.notify()` appends `agents_md_change` to context memory immediately
(no turn gate), so they are real context records. The TUI replay skips rendering `origin.kind
=== 'injection'`; this viewer folds them as context, the same way it shows Claude
system-reminders. Images are `image_url` parts: inline `data:` URLs below ~4 KB, else
`blobref:<mime>;<sha256>` whose bytes sit in `agents/<id>/blobs/` and are served by the
server's blob route.

## Grok

Parse only `updates.jsonl` (`chat_history.jsonl` is a derived cache, `events.jsonl` is
telemetry). Envelope `timestamp` is seconds, `_meta.agentTimestampMs` is ms. Usage arrives per
turn in `turn_completed`; per-call split uses each stream's first `_meta.totalTokens`. Children
are top-level session dirs bound through the parent's `subagents/<id>/meta.json`, never by tool
call id. Title, cwd, system prompt, and tool schemas live outside the JSONL and reach the
parsers through the server's sidecar line.

## Devin

No JSONL transcripts — `sessions.db` (WAL, live-written) holds `sessions`, `message_nodes`,
`tool_call_state`; `subagent_heads` exists but is empty in practice. Column timestamps are
epoch SECONDS; `chat_message.metadata.created_at`/`started_generation_at` are ISO ms.

### Chain identity

`message_nodes` is a forest that re-renders context as copied chains: group them by union-find
over `parent_node_id` + `compact/prior_node_ids` — carried in the ROW's `metadata.extensions`
column, not inside `chat_message` — plus shared `message_id` edges for NON-`system` roles,
applied only when neither component carries a prior edge. `message_id` is OBJECT identity, not
conversation membership: every subagent's context opens with the same system-prompt object (one
mid across all agent chains), and `system` records generally are context objects — render
prefixes, injections, summaries — shared across conversations by design, so they never build
identity edges at all. A mid merge contradicted by a later prior edge re-materializes the
session. Unclaimed groups buffer per chain (never deduped by mid while pending — two lineages
may each need their own copy of a shared opener); dedup runs at emit time where the owner is
known.

### Subagent claims

The group holding `main_chain_id` is the main stream. Other groups are NOT automatically
children — compactor/render chains look identical to subagent chains — so unclaimed groups
buffer as `pending` and surface when a `subagent_heads` row or a spawn result's
`subagent/agent_id`/`chain_node_id`/`profile_name` extensions claim them (claims can land after
the child's lines; the child file is `agent-<agentId>`). A background `run_subagent` result
carries `subagent/agent_id` only — the `chain_node_id` arrives on a
`<subagent_completion_notification>` system node on the main chain. Before that, the source
can bind a running child by exact task text: one spawn call must match one non-main chain's
opening human user message (only system ancestors allowed), after merging render copies.
The launch receipt supplies the agent id. Repeated task arguments, multiple matching chains,
and later/injected user messages do not qualify. Explicit claims take precedence; a later
ambiguity or conflicting claim rebuilds inferred attribution so live and replay agree.
While unclaimed the run's `fileId` stays null in the catalog (the agent id is never a stream
id). The child ref's `agent` facts are assembled from the `run_subagent` call's
`title`/`task`/`profile` arguments joined through the result's `tool_call_id` →
`subagent/agent_id` (so `agent.description` is the spawn title even in a child view that never
folded the parent's calls), plus `subagent/profile_name` and `subagent/model` from the claim —
late facts re-emit the `file` event.

`run_subagent` with `is_background: true` returns a launch receipt: a successful tool
result (or ACP `completed` state) does not mean the agent finished. The run stays
`running`, with no end time, until the main stream's system notification supplies
`subagent/agent_id` and `subagent/chain_node_id`. That notification completes the run;
foreground results and failed spawn results settle immediately. Run duration starts
at the spawn call, not its result receipt.

### Store rewrites and compaction

The CLI periodically rewrites a session's whole forest in one commit — same node_ids
re-inserted in node order under fresh AUTOINCREMENT row_ids (row_ids form contiguous
per-generation blocks, ~8 generations observed in one session) — so `row_id` is an append
watermark within a generation only; content is keyed by `node_id` (byte-identical across
generations), and materialization skips already-seen node_ids or every rewrite would append a
whole extra copy of the transcript. Dedup is per `(message_id, stream, compaction epoch)`: a
`system` node with `extensions['devin-rs/summary']` ends a render — copies of pre-summary mids
then re-emit because they are kept context, and the summary's chain ancestors (re-rendered
prefix, kept injections) flush with it. `system` splits by extension: none = rendered prefix
(each render rewrites it — a new contiguous run replaces the header text), `devin-rs/summary` =
compaction, anything else = an injected block (`agent-ext/rules-loaded`,
`agent-ext/skills-loaded`, `affogato/cog-context`, `chisel/user-edits-*`; a re-injection under
the same key replaces the stale one; the store does not preserve `extensions` key order across
renders, so a multi-key node's identity key is its sorted-first key). A summary node bundles
the render's whole retained context: `content` is summary text plus the kept conversation tail
under `<conversation_history>`, and `extensions['chisel/conversation_history'].messages`
carries the same tail in structured form (with `compact/todo_list`/`compact/edited_files`
alongside). The fold prices it as ONE compaction block — after a compaction `user` can read
zero even though kept prompts sit inside the bundle; that is the wire truth, not a dropped
message.

### Replay bookkeeping

Replays re-enter the fold surface carrying `data.replay: true` — the fold surfaces the copy but
skips all bookkeeping (request record, usage, step timing, human-input tally, inject
re-listing) and they are not re-indexed for search. The wire marks the summary's ancestor flush
`kept:1`; the synth exempts exactly that tagged run from the summary's claim. Untagged
post-summary descendant copies stay claimable — exempting them would leave the same logical
message on the surface twice after the next render. Human vs injected is
`metadata.is_user_input`; usage lives in `metadata.metrics`, tool wall time in
`chisel/tool_call_timing.duration_ms`, and ACP state in `tool_call_state` (settles a call whose
result message never landed). `devin.session`/`devin.tool` are synthetic sidecar lines
(`startLine: -1`, never indexed).

### Replay reconstruction

Stream lines are never retained — the store IS the buffer: entries keep counters, and `readAll`
re-derives the stream by re-running materialization on a scratch state pinned to live's
consumed node_ids (unconsumed rows must not replay or the next live emit doubles them). The
cost is one full replay per SSE open — ~250 ms on a 2.5k-node session, and reconnects re-derive
again; caching replay output is a follow-up that first needs rewrite/epoch invalidation solved.

### Polling and recovery

The poll keys work off the `message_nodes` row_id watermark (growth → incremental materialize,
even with no subscribers and an unchanged `sessions` row; regression → full rebuild), and the
watermark only advances after a batch fully lands — but a mid-batch failure also poisons the
derived maps (`state.nodes` holds rows that never emitted, so an incremental retry would skip
them), so any per-session error flags the state `needsRebuild` and the next materialize
rebuilds it whole, meta scanner and tool fingerprints included. Per-session errors are isolated
the same way, and a `sessions()` failure degrades the source without rejecting start.

### Database replacement and lifecycle

The store file's identity (`dev:ino`) is compared every tick — an atomic replace or
delete+recreate closes the stale handle, reopens, and rebuilds every derived map in place
(`file reset` to subscribers, search watermarks reset), while a plain delete leaves the open
handle serving its last snapshot (sessions go stale, not empty); ordinary commits move mtime
without touching identity and never trigger a reopen. Both `sessions.db` and `sessions.db-wal`
are watched (the WAL is attached lazily once it exists — fs.watch only buys promptness, the 1.5
s poll is the correctness path). The `sessions` row's title/cwd/model re-seed the meta scanner
in place on change — never re-created, or promptCount and the mid-dedup set would reset.
`stop()` is idempotent and `start()` re-runs cleanly on the same instance.
