# Harness format and lifecycle reference

Read the relevant harness section before changing its adapter, context synthesizer, meta
scanner, search extraction, or session source. Paths below are repository-relative. Keep these
constraints in sync with the implementation and its regression tests.

## Claude

Context window is not recorded. Only `[1m]` supplies an inferred 1M capacity;
neither an ordinary model id nor a prompt exceeding 200k establishes a window.
Request input is input + cache read + cache creation (output excluded); multi-iteration
aggregate usage is not a single input measurement. A main session's cost includes its
subagents. Subagent files bind through `.meta.json`.

Assistant block timestamps mark block completion, so Trajectory leaves first-token
time unknown. Group by request identity even when an early block carries a stop
reason or a tool result separates sibling blocks. Trajectory updates the existing
request; Context projects its buffered tail without committing a read/EOF boundary.

Context follows `parentUuid` at branch boundaries, including regeneration from an
earlier user message. UUID checkpoints share immutable surface prefixes. Sibling
assistant blocks and their parallel tool results share a recoverable checkpoint,
matching the upstream orphan recovery; a tool result's parent is not itself a rewind.
Compaction uses its explicit preserved-message selection rather than interpreting
the boundary's `parentUuid: null` as a new empty conversation. Restoring a branch
changes model-visible context and retains historical billing.

### Compaction, snip, and microcompact

`compact_boundary.compactMetadata.preservedSegment = { headUuid, tailUuid, anchorUuid }` names
the messages kept across the compact. They are NOT re-written (dedup-skipped) and keep their
pre-compact `parentUuid`, so the synthesizer walks tail → head through the recorded parent
chain. `anchorUuid` fixes the model-visible order: the last summary uuid (suffix-preserving:
reactive/session-memory compact) puts the kept span AFTER the summary — Context re-emits the
kept nodes as replay copies behind it, never re-billing them; the boundary's own uuid
(prefix-preserving partial compact) leaves them before it. A walk that cannot reach `headUuid`
keeps what it did collect (upstream instead skips pruning on resume). `preservedMessages.allUuids`
is a legacy fallback only. After a compact, every preserved uuid, the summary, and the boundary
point at the post-summary surface so the next record's `parentUuid` (the kept tail) is not a
branch rewind.

Two more `system` records change model context and are recognised STRUCTURALLY (never by
subtype literal — `snip_boundary` is an internal feature flag upstream): `snipMetadata.removedUuids`
deletes those records from the live surface and every saved branch checkpoint, preserving
each checkpoint's historical endpoint and shared prefixes. A parent inside a deleted gap
resolves to its surviving prefix; a surviving tail continues without a rewind.
`microcompactMetadata.compactedToolIds` /
`clearedAttachmentUUIDs` (with `tokensSaved`) removes the matching tool results and attachments.
Both fold as `compaction/prune` plus a contentless marker (`plugin: 'snip' | 'microcompact'`).
Support depends on the producing build's feature flags; a boundary without these keys is a no-op.

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

Request input measurements use the response's raw `input_tokens` (cache already included),
independently of billing normalization. `model_context_window` is the CLI's usable capacity,
which can reserve model headroom; bind it to the call, never to the whole history. Model
changes without a new window clear the prior capacity. Compaction billing calls are excluded
from request-input peaks.

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
`item_completed` is also the tool's TERMINAL status: `item.status === 'failed'` or a non-zero
`exit_code` marks the call failed in both views (the output text `Process exited with code N` /
`Error:` prefixes are only a fallback for old logs). Unified-exec exit codes are read only
from the leading header, after optional `Chunk ID`/`Wall time` and before `Output:`;
quoted body text is never status. The item is attributed by exact id (current CommandExecution
and McpToolCall producers use the call id), then a unique full command match against pending
and recently settled calls, then the lone open call when nothing settled since it opened; anything
ambiguous is left alone. Commands match decoded `cmd`/`command` arguments or the full raw input,
never substrings of JSON. An item landing after the output already folded flips the settled node
(`ToolCallTracker.markError`),
`tool_search_call`/`tool_search_output` pair by `call_id` and carry discovered schemas in
`tools`, `agent_message` items and top-level `inter_agent_communication` records are agent
relays (never human prompts), `configuration_update` records reasoning-effort changes,
`thread_settings_applied` snapshots can switch the model, `thread_goal_updated` carries the
objective, and `retained_context` holds host-only `verified_answer` Q&A, displayed as
content-free notices whose text does not enter model context or token estimates. Search indexes the relays,
goal, and tool calls; tool outputs (including discovered tool names), encrypted compaction
replays, and `event_msg` mirrors of response items stay unindexed.

`function_call_output.call_id` is optional. An unpaired standalone output is
model-visible injected context, never a fabricated call or a human prompt. It
remains excluded from search under the tool-output policy.

Top-level `realtime_item/transcript_segment` records are presentation-only speech:
Trajectory displays them and search indexes their role/text. They do not alter
Context, human prompt counts, request timing or billing. `bem_item_promoted` only
references an existing response item and must not duplicate its display or index.

`reasoning` items carry `summary[]` and may carry plaintext `content` of type `reasoning_text` or `text`
beside the opaque `encrypted_content`. `codexReasoningText` (core) is the one readable-text rule
for Trajectory, Context and search: summary texts, then readable content not already in the
summary. Never decode `encrypted_content`.

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

Current `llm.request.maxTokens` comes from `maxCompletionTokens`, not the context window.
Older wire records do not reliably identify the field's semantics: preserve the raw request
limit in Trajectory but do not infer a Context window from it. Ordinary input measurements
sum `inputOther + inputCacheRead + inputCacheCreation`, excluding output. Missing input is
unknown even if output is reported. Compaction requests and their usage must not change the
ordinary model route or provide ordinary request-input samples.

`usage.record { agentId, model, usage, usageScope? }` is written when the response completes,
BEFORE the step's loop events flush, and a failed/interrupted `step.end` carries no `usage`. Both
views hold the pending record and credit it to the step that closes next (`step.end.usage` wins
when present; the two are never summed); an `llm.request` with `kind: 'compaction'` clears it so
auxiliary usage cannot leak into the next loop step. TTFT is `step.end.llmFirstTokenLatencyMs`
relative to the step start — when absent, Trajectory reports `firstTokenTime: null`, never the
start time. The response end is the `usage.record` instant (when ≥ the step start), else start +
`llmStreamDurationMs`, else the settling record's time; tool durations remain unrecoverable.

### Compaction

An `llm.request` with `kind: 'compaction'` is not a loop step: it has no `turnStep` and its
`maxTokens` is the summary model's cap, not the context window. A compaction replaces the
context with a summary message (the `contextSummary` field — the shorter `summary` is the
working summary the trajectory shows) plus a SELECTION OF USER MESSAGES
(`keptUserMessageCount`, `keptHeadUserMessageCount` when the middle was elided), never whole
turns; a trend that keeps whole turns alive never drops.

Undo anchors differ from human-input classification: absent/user origins and
`skill_activation`/`plugin_command` with `trigger: user-slash` establish anchors.
Undo also removes immediately preceding injections with the anchor's
`ownerPromptId`. Invalid or unavailable counts do nothing. Compaction and clear
invalidate undo checkpoints; Kimi undo cannot cross a compaction summary.

`swarm_mode.exit` pops the swarm-mode reminder only when it is the LAST context message
(`popSwarmModeReminder`): Context prunes that one node (marker `plugin: 'swarm-exit'`), never
earlier reminders, and strips the seq from undo anchors so `context.undo` cannot resurrect it.
A buffered assistant blocks deletion only when it was inserted after the reminder; a reminder
appended later can still be removed. Exit never splits the response. Undo checkpoint filtering
preserves shared prefixes rather than copying each complete history.

### Subagent binding

There is no durable spawn record for subagents: a background launch binds through
`task.started` (`info.parentToolCallId`), a foreground one only through the `Agent` result's
`agent_id:` header (arriving after the child's whole transcript — child loop events are
buffered until it lands), an `AgentSwarm` through the result's `<subagent agent_id="…">` XML.
There is no sidecar: the listing description is the parent Agent call's `description` (else the
child's delegated prompt), discovered by the meta scanner.

`agentMentions` reads `agent_id:` / `actual_subagent_type:` / `status:` from the result HEADER
only (the lines before the first blank line; the `[summary]` body is the agent's own text and may
quote any shape). Swarm parsing requires a complete `<agent_swarm_result>` wrapper and closed
top-level `<subagent …>` elements at line starts; nested quoted elements are skipped, and
unbalanced input suppresses the candidates. The producer does not escape result bodies, so
text deliberately shaped as closing and reopening sibling elements remains indistinguishable
from real siblings without independent identity evidence. Scanner version 5 invalidates older
cached child associations, including those extracted from single-agent result bodies.

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
telemetry). Envelope `timestamp` is seconds, `_meta.agentTimestampMs` is ms.
`_x.ai/session/update` `response_completed.usage` (snake_case, `input_tokens` already
uncached) is the per-model-call figure and lands on the streaming step, or on the turn's last
request when the step was already sealed. `turn_completed.usage` (`PromptUsage`, camelCase,
`inputTokens` includes cache) is the whole turn's total: it is used only when no request of the
turn has an exact figure, attached once to the turn's last request with `TokenUsage.scope:
'turn'` — never stacked on exact usage, including turns with only partial per-call coverage.
The UI labels these counts “Turn total”/“本轮合计” and excludes them from per-response
throughput. Per-call `reasoning_tokens` is retained as a subset of output, never added again.
Billing allocation uses each stream's minimum `_meta.totalTokens`.
That field is a live-context estimate (including post-response additions), not measured
request input. Only a per-call `response_completed.usage` supplies reported input; otherwise
the viewer labels the reconstructed input estimate separately. One stream's multiple
surface fragments are one measurement. Recorded windows apply only to their model epoch;
the catalog fallback never supplies a measured historical occupancy ratio. Children
are top-level session dirs bound through the parent's `subagents/<id>/meta.json`, never by tool
call id. Title, cwd, system prompt, and tool schemas live outside the JSONL and reach the
parsers through the server's sidecar line.

One prompt can persist multiple consecutive content chunks with the same
`_meta.promptIndex`. Core, Context and metadata share `GrokPromptChunks`; chunks
retain all content but count once. A non-chunk boundary ends the run, so rewinding
and reusing an index starts a new prompt. Metadata persists the current run index
alongside its byte-resume cursor.

`streamStartMs` identifies a model response, including parallel tool calls. Core
publishes and updates that response as tools arrive; missing stream identities use
the legacy tool-call boundary. `rewind_marker.target_prompt_index` restores the
surface saved before that prompt, including across compaction. Replayed surface
copies do not rebill requests or re-execute tools. Checkpoints belong to the active
branch; those at and beyond the rewind target are discarded.

## Devin

No JSONL transcripts — `sessions.db` (WAL, live-written) holds `sessions`, `message_nodes`,
`tool_call_state`; `subagent_heads` exists but is empty in practice. Column timestamps are
epoch SECONDS; `chat_message.metadata.created_at`/`started_generation_at` are ISO ms.

Without upstream source or a verified protocol, `metrics.input_tokens` may include cached
input or exclude it. Preserve existing billing behavior, but mark request input unknown;
do not infer a window. Re-rendered assistant copies are never new measurements.

`metadata.generation_model` is per message; the session row's `model` is only the initial
route. Context emits a `request/header` (`reason: 'change'`, repeating the system prefix) before
any non-replay assistant whose `generation_model` differs from the last header, so the fold
prices each response at its own model; replay copies never change the route. `metrics`
buckets are disjoint for `totalTokens`: input + output + cache read + cache creation, and a
metrics object with only `cache_creation_tokens` is still usage.

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

Context applies the same background lifecycle, preserves a completion notification
that arrives before its launch receipt, and rekeys children when a late sidecar
resolves their file id. Terminal ACP tool state can settle a missing result with an
empty placeholder; ACP UI text is not model output. A later real result replaces
that placeholder without booking tool execution a second time.

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

## Pi

Verified against pi 0.85.1 (`packages/coding-agent/src/core/session-manager.ts`,
`docs/session-format.md`, and nine local transcripts).

- Sessions live in `<agentDir>/sessions/--<encoded-cwd>--/<iso-ts>_<session-id>.jsonl`
  where agentDir is `$PI_CODING_AGENT_DIR` else `~/.pi/agent` and the cwd encoding
  strips the leading `/` and maps `/`, `\`, `:` to `-`. The timestamp part of the
  filename contains no `_`, so the id is everything after the FIRST `_` (custom ids
  may contain `_`). One file per session; no subagents. A fork/clone writes a NEW
  independent file whose header carries `parentSession` — treated as its own main
  session, never a child.
- Line 1 is a `{type:'session'}` header (version, id, ISO `timestamp`, `cwd`,
  `parentSession?`) with no tree fields. Every other entry is
  `{type, id (8 hex), parentId: string|null, timestamp: ISO}`. TIMESTAMP TRAP: the
  entry `timestamp` is ISO; a nested `message.timestamp` is epoch MILLISECONDS. Only
  the entry stamp is used.
- The entry TREE is the only source of truth for the model-visible context
  (`PiSessionTree.contextEntries` ports pi's `buildContextEntries`; rendered
  surfaces are never consulted). The Trajectory shows file order; the Context
  rebuilds the surface and re-resolves the route/prompt from the parent's path
  whenever an entry's parentId is not the previous entry (a `/tree` branch,
  pruning the abandoned suffix; `parentId: null` restarts an empty context).
  The Trajectory likewise re-resolves the request route/prompt at a branch so
  nothing from an abandoned branch leaks through. `resolvePiContextState`
  splits state the way pi's `buildSessionContext` does: the PROMPT replays
  the compacted entry list, while the ROUTE (provider/model/thinking) reads
  the FULL parent path (`getSessionContextSettings`) — a compaction that
  shadows a `model_change`/`thinking_level_change` does not forget it.
- `compaction` entries carry `summary`, `firstKeptEntryId`, `tokensBefore`, optional
  `systemMessage`, and `usage`. The summary is placed BEFORE the kept range (file
  order keeps the retained entries first — the suffix-preserving case). The kept
  range is path entries from `firstKeptEntryId` up to the compaction, minus system
  messages; an off-path `firstKeptEntryId` keeps nothing, a later compaction
  re-keeps the path range even when the surface holds replay copies, and an
  extension compaction may WIDEN the range — entries the surface no longer
  holds replay their original emitted events. The optional `systemMessage` is
  a COMPLETE prompt checkpoint (pi stores `getCurrentSystemMessage`): it
  replaces the replayed state, never applies as a delta. `branch_summary`
  entries ({fromId, summary}) inject a summary node at the branch point.
- Roles under `message` entries: `system` (content + `sections` patches where `null`
  deletes + `toolsAdded`/`toolsRemoved` — removals land FIRST, so a same-name
  pair redefines the tool; replayed prompt = accumulated contents then
  section values in insertion order, nonempty joined with `\n\n`), `user` (always
  human — pi injects nothing through this role), `assistant` (one persisted record
  per model call: content blocks, provider/model, usage, `stopReason` ∈
  stop|length|toolUse|error|aborted|deferred), `toolResult`, `bashExecution`
  (`!cmd` transcripts; `excludeFromContext` = `!!` prefix), `custom`
  (extension/hook content; normally persisted as a `custom_message` entry instead —
  both become context nodes). `branchSummary`/`compactionSummary` roles never appear
  as message entries.
- Usage buckets are DISJOINT: `input` excludes `cacheRead`/`cacheWrite`,
  `totalTokens` is their sum, `reasoning` is a subset of `output`, `cacheWrite1h` a
  subset of `cacheWrite`. Reported cost comes from `usage.cost.total` on assistant,
  compaction, and branch_summary records.
- There are no turn records: EVERY user message opens a new turn (steering messages
  are persisted identically), each assistant record is a step, and `stopReason !==
  'toolUse'` closes the turn.
- Sessions written before ~0.8x have no system messages at all — everything must
  work without one. `custom` entries (`{customType, data}` extension state, e.g.
  `shadow-mind-event` heartbeats) are NOT context. `label` entries are ignored.
  `session_info.name` is the display title. `model_change` and
  `thinking_level_change` update the request route/config.
- Context window is never recorded and never inferred. Pi persists only complete
  messages, so there is no streaming/TTFT data.

## OpenCode

No JSONL transcripts — `opencode.db` (WAL) at `$XDG_DATA_HOME/opencode/opencode.db`,
else `~/.local/share/opencode/opencode.db` (`HARNESS_TRAJECTORY_OPENCODE_DB` overrides).
Verified against opencode 1.18.31 (`packages/schema/src/v1/session.ts`,
`packages/core/src/session/sql.ts`) and a 1.18.x local store. Tables read: `session`,
`message` (V1 `Info` JSON in `data`, minus `id`/`sessionID`), `part` (V1 `Part` JSON in
`data`). `session_message`/`session_v2`/`session_input` are the V2 projection and are
ignored. ALL times are epoch MILLISECONDS; row order is `(time_created, id)` for
messages and `(message_id, id)` for parts.

Token buckets are disjoint: `tokens.input` excludes cache read/write and `tokens.output`
excludes `reasoning` (unlike pi, where reasoning ⊂ output). Wire usage maps
`outputTokens = output + reasoning`, `reasoningTokens = reasoning`, `totalTokens =
total ?? input+output+reasoning+cache.read+cache.write`; request input =
input + cache.read + cache.write. No context window is ever recorded; never infer one.
`cost` is USD per assistant message.

### Wire vocabulary

The server synthesizes five line kinds (`opencode.session` sidecar with title/cwd/
model/children facts, `opencode.message` header carrying parts inline ONLY for user
messages, `opencode.part` for settled assistant parts, `opencode.finish` for a terminal
assistant's tokens/cost/finish/error, `opencode.prune` sidecar when a tool output is
cleared). `summary.diffs` on user messages is stripped at wire time — session diff
blobs (~500 KB) are not model content. Sidecars ride `startLine: -1`, are never
indexed, and are re-sent when their facts change.

### Settle and close rules

`planLines` in `opencode/transcript.ts` is the single emission plan for live and
replay: per message, header once → parts in strict `id` order once SETTLED → finish
once TERMINAL; the walk stops at the first unclosed message so live and replay share
line numbering. A part is settled by its own terminal state (text `time.end`,
reasoning `time.end`, tool `completed|error`), by its message being terminal, or by a
later ASSISTANT message existing — the only reliable "writer moved on" signal. A
queued prompt's user row lands while the previous assistant is still streaming
(the prompt path inserts the row, then joins the running loop; ~10% of prompts in
a real store), so a later row of any other role settles nothing — the user header
waits behind the open assistant, as OpenCode itself renders it. Assistant messages
never overlap (one row per step, sequential). An out-of-order part waits for its
predecessors. A trailing user message with no later message waits one tick
(`trailingSeen`) because its parts land in separate statements after the row. A
crashed assistant (never terminal) closes when the next ASSISTANT message appears;
a part arriving for an already-closed message still emits as an append at the
stream tail (the cursor records the append order so replay reproduces it
exactly). TERMINAL = `time.completed` or `error` present. A compaction user
header has its own gate: OpenCode writes the `compaction` part WITHOUT
`tail_start_id` and updates it ~1–2 ms AFTER the summary's `time.completed`,
so the header waits for an ASSISTANT beyond the summary (a prompt queued while
the summary still generates lands a user row there — only the next assistant
proves the loop moved past the part update), an errored summary, or one
tick after the summary went terminal (`compactionSeen`) — shipping early would
emit `tailStartId: null` and shadow the whole surface. Replay pins to the
cursor's emitted id sets and re-derives the stream from current rows — the store is
the buffer, no lines are retained.

### Classifier, compaction, prune, children

`opencodeUserClass` is structural: `compaction` when the message carries a
`compaction` part, `human` when any non-synthetic text/file/agent/subtask part exists,
else `injection` (`compaction-continue` when `metadata.compaction_continue` is set).
Compaction = a compaction-class user, then a `summary: true` assistant (the summary —
never an assistant step), then a synthetic continue message; `tail_start_id` on the
compaction part names the first retained message and the tail (up to the compaction
user) replays after the summary. An unfinished or errored summary does not compact.
Prune mutates in place: `SessionCompaction.prune` sets `state.time.compacted` on old
completed tool parts; the source emits one `opencode.prune` per part and the fold
replaces the output with the cleared marker. A part that arrives already carrying
`state.time.compacted` (pruned before materialization) folds the cleared marker
directly — same rule OpenCode's `filterCompacted` applies. Revert (`session.revert`) deletes rows on
the next prompt — count regression → full rebuild with `file reset`. Children are
`session` rows with `parent_id`, flattened under the ROOT session at
`opencode://sessions/<root>/<childId>`; the parent's `task` tool part binds
`toolUseId`/model/description/agentType via `state.metadata.sessionId`
(`metadata.background: true` keeps the run open until the child stream's own finish).

### Source tiers and polling

Two tiers keep startup off the message/part blobs (~340 MB of JSON on the reference
store): the catalog tier reads `session` rows plus grouped `COUNT`/`MAX`/`SUM(length)`
queries — sizes once at startup and per changed session, never per tick — and feeds
each scanner user header lines only; the transcript tier materializes a session's full
stream lazily on first `subscribe`/`readAll`/search registration and rebuilds the
scanner fresh (a catalog-fed scanner must never double count). The tick gate is
`PRAGMA data_version` (unchanged → skip everything), then grouped count/max probes per
session: regression → `file reset` + search reset; advanced max → incremental fetch of
rows with `time_updated >= lastMax` (`>=` so a second write in the same millisecond
is not lost; re-reads are idempotent). A materialized stream with an open tail
re-queries on every moved tick — a same-ms terminal update hides behind the strict
watermark otherwise; closed streams keep the cheap strict gate. File identity
(`dev:ino`) detects atomic replacement; a missing db degrades to empty and recovers
on its own.

Search attached at startup backfills through the same tiers: a stream the index
already covers (`coverage` — the index's registered row-count `size` EQUALS the
current count, its `mtimeMs` is at least as new, AND `indexedBytes` ≥ `size` —
a reverted, rewritten, or not-fully-consumed stream is not mistaken for
covered) is never re-read, every other indexable stream materializes and
queues as it emits, with an event-loop yield between streams. `size` and
`indexedBytes` carry the same shape as JSONL's file-bytes/bytes-consumed pair:
`size` is the total row count (`beginFile`'s shrink check needs it) and
`indexedBytes` is `countOf − openRowCount` — the rows the emitted lines
account for, so a stream stopped with an open tail (a prompt still behind
the patience gate) reads as incomplete on the next boot and materializes.
A covered stream stays unmaterialized, but a later touch while search
is live materializes it on the spot — `beginFile` anchors at the index's
`indexedLines` watermark and only the appended lines queue. Toggling search on
later reuses the same pass and replay-queues the backlog of streams already
materialized; a new session registered while search is live materializes
immediately.

## DeepSeek Harness

dsh keeps each session under
`$DSH_HOME/sessions/<--encoded-cwd-->/<session-id>/` (`~/.dsh` when unset) as
`session[.vN].jsonl[.zstd]` plus a `session.lock` lease that is never a
transcript. Line 1 is a `{"type":"session"}` header; every later line is an
event envelope `{type, seq, time, data, surfaceOp?, sourceEventSeqs?}`.
`time`, `time0`, and `createdAt` are epoch MILLISECONDS — never ISO strings,
never seconds; do not run them through `parseTime`.

### Generations

Each format generation is an immutable file of its own: `session.jsonl` is v0
and `session.vN` is version N. A migrated session keeps every committed
generation, and a seeded successor already carries its inherited prefix (the
events up to `session/end-seed`), so the CURRENT generation — the numerically
highest `N`, preferring `.zstd` over `.jsonl` for the same `N` — is the only
file ever read; folding a predecessor too would count the history twice.
`resolveDshLog` picks it per directory, `DshGenerations` dedups every
generation path onto one registered file, and a newer generation's arrival
migrates the entry inside the consume lock: offsets, metadata, and search
watermarks reset and the successor replays from byte 0 with a `file reset`
event. Watcher and poll paths resolve the directory's current generation
first, so an event naming an old path still reaches the entry.

### Concatenated zstd frames

`.jsonl.zstd` is NOT Codex's `.zst`: the file is a growing sequence of
independent checksummed zstd frames, one per flush batch
(session-persistence-jsonl/src/zstd.ts). `zstdDecompressSync` decodes only
the first frame, so `tail.ts` scans frame headers itself (magic → descriptor
→ blocks → optional 4-byte checksum), decodes complete frames in order, and
keeps the cursor in PHYSICAL bytes at frame boundaries. A torn final frame —
a flush in flight or a crash — consumes nothing and is retried once its bytes
complete; structurally corrupt data stops the scan rather than misreading.
`readFirstLine` decodes just enough of the first frame to probe the header.
Lines may span frames; the decoded text feeds the same splitter a plain read
uses, so search line numbers stay the non-blank record index.

### Events and classification

v0/v1 stream deltas are PACKED: `reasoning-chunks` / `text-chunks` /
`tool-call-chunks` rows carry `{seq0, time0, data:{index, dt, texts|args}}`
and stand for N `assistant/chunk` events at `time0 + cumulative dt`; v2+
moves the same records into `assistant/message.data.stream` /
`assistant/attempt.data.stream` without seqs. `surfaceOp` is the bare string
`'append'` by default; replace is spelled `{op:'replace', startSeq, endSeq}`
in v3 and `{op:'replace', start, end}` in v0/v1 — read both.
`sourceEventSeqs` may compress consecutive runs of ≥3 into `[start,end]`
pairs mixed with plain numbers. `usage` buckets are DISJOINT: `inputTokens`
excludes `cacheReadTokens`/`cacheWriteTokens`, and `reasoningTokens` ⊂
`outputTokens`.

`request/header` is logged AFTER `step/start` opens its request and applies
to that request; an unchanged header is not re-logged, so a header-less step
inherits the last effective config and prompt snapshot. `data.reason` is
`initial`, `resume`, `change`, or `series`; only `initial` reports the first
request's prompt as a change — a resumed or mid-stream first header restates
the effective state without one. The prompt itself is
`request/header.data.header.system` in v0/v1 and `system/message` surface
nodes in v3; an `'append'` on a live non-empty prompt is an in-history
update the NEXT header must not re-report, and an empty replacing node
clears the prompt and re-anchors the next change at the replacement event.
An effective prompt move also re-snapshots the request it lands inside —
the in-flight request runs under the updated prompt even when the silent
update logs no header, while already-settled requests keep the prompt they
were made under.

`run_code` nests its dispatched calls under `tool/ptc-dispatch-start` /
`tool/ptc-dispatch` (legacy: `tool/code-dispatch*`): `parentCallId` +
`subCallId` parent each sub-call's arguments, content, error, and timing to
the outer `run_code` call rather than surfacing as top-level tools.
`image/offload` is NOT log metadata: `targets[].seq` + `imageIndexes` durably
marks image blocks on earlier `user/message`/`tool/result` nodes (indexes
count every occurrence, already-offloaded included). The context synthesizer
then replays each target as a surface replacement — like `surfaceRestore`,
the projected copy takes a FRESH seq just past the offload event and becomes
the original's `gone` boundary, so the retained content under the original
seq still reconstructs what pre-offload requests saw while the live surface
carries the model-visible placeholder text. The copy keeps its surface slot
through the node's `pos` sort key — `seq`/`gone` bound history, `pos`
orders display — so assemble shows it where the original sat rather than at
its own seq. Later producer claims (replace ranges, `shadowedSeqs`) still
name the ORIGINAL seq; the synth's `liveSeqs` map translates them onto
whichever copy is currently live and releases the mapping only when that
node truly leaves the surface — the bounded payload cache evicts separately
and only forfeits future offload targeting. Fold billing and tool names are
preserved.

`dshUserClass` is structural: a `user/message` is `human` only when
`source.kind === 'user'`; any other source kind is injected context, and a
replace `surfaceOp` marks a compaction summary. Search indexes human prompts,
committed assistant text/reasoning blocks, `tool/call` arguments, and
`command/run` invocations (`name` + its `args` tail string); `tool/result`
outputs, packed stream rows, and surface bookkeeping are never indexed.

### Children and attachments

A child session is a SEPARATE log under the same `<encoded-cwd>` parent whose
header carries `origin:'subagent'` plus `parentSession`; a fork records
`parentSession` without the origin and stays an independent session. The only
binding a parent's transcript records is the exact result text
`started subagent <childSessionId>` on a continuable background tool call —
the meta scanner pairs it with the pending call's description. Parent and
child logs are read in either order, so a late binding only adds identity
(call id, description) — it never reopens a run the child already finished;
only the child's own `turn/start` does that. A compressed
child's first frame can still be torn at registration: the entry then lands
as a main session and is re-homed when `probeDshHeader` later reads the
completed header. `blobref:` image URLs resolve against the GLOBAL
content-addressed store `$DSH_HOME/attachments/v1/objects/<2-hex>/<sha256>`
(a sibling of `sessions/`, not per-session), and a hash that is not 64 hex
chars resolves to nothing.

Resume command: `dsh tui --resume <id>`.

## Source lifecycle and replay (shared)

`SearchLifecycle` owns the search service across discovery and runtime toggles.
Sources borrow its indexer, attach before initial discovery, and never finish or
close the shared index themselves. A runtime enable waits for discovery; backfill
finishes with the union of all sources' live paths. Disabling detaches immediately,
then waits for pending work before closing the store. A replacement backfill waits
for the preceding service to retire.

`SessionSource.readAll` captures replay content before awaiting its consumer and
waits for each emission. An abort signal stops further replay emissions and file
reads between read operations. Replay, queued appends, `ready`, and keepalives share
one SSE writer. Queued live JSON is limited to an 8 MiB UTF-16 storage budget per
connection; overflow disconnects that viewer so EventSource reconnects with a full
replay. Synthetic records retain `startLine: -1`. Replay still materializes session
content for chronological merging; transport backpressure does not bound that cost.

## Request-input statistics (shared)

### Incremental parser extension points

`EventSynthesizer.push` emits committed events. A synthesizer that must buffer a
response across arbitrary read boundaries can also expose pure `preview()` events.
`ContextSession` projects that replaceable tail over its committed fold and content
maps, memoizes the view, and discards only the projection before the next push.
Do not flush an open request merely because a chunk or file read ended.

`surfaceCheckpoint.ts` provides shared-prefix checkpoints; capturing a boundary is
O(1). `surfaceRestore.ts` uses the existing prune/replace/replay vocabulary to restore
model-visible content while preserving historical requests, input counts and tool
timing. Harnesses own boundary identity and undo policy. Keep those protocol rules
in their synthesizers rather than adding harness branches to the fold or session.

### Measurements

Context follows dsh-context's fold vocabulary and billing buckets; Trajectory follows
deepseek-harness. Port-owned `InputEvent.requestInput` metadata is consumed by ContextSession,
outside the vendored fold event data. The per-agent summary survives request retention limits
and excludes inherited/replayed activity and auxiliary calls. A fresh session on SSE replay
or file reset rebuilds it from scratch. Peaks cover the loaded logical history, including
requests preceding ordinary compaction; they never sum parent/child agents.

The UI always displays input peaks in tokens. Reported and reconstructed estimates remain
separate, with sample coverage. Highest input occupancy is the maximum of per-call
input/window ratios using recorded windows only; it can belong to a different request from
the maximum token count. Unknown input is distinct from measured zero. Billing-only output
samples retain the upstream fold's zero-input accounting without becoming input measurements.
