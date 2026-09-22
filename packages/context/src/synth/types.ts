/**
 * Event synthesizers: one per harness, one instance per transcript file.
 * A synthesizer reads raw JSONL lines and emits fold events (see
 * `../fold/event.ts`). It owns per-file state (open request grouping, seq
 * counter, uuid→seq map for compactions, spawned children) and never throws
 * on malformed input: a bad line yields no events.
 */

import type { HarnessKind, SessionFileRef } from '@harness-trajectory/core'
import type { InputEvent } from './requestInput.ts'
import type { ContextUsage } from '../shared/types.ts'

/** A child agent spawned from this file, keyed by the harness-native child key. */
export interface AgentSpawn {
  /**
   * Claude: the `agentId` (child file basename is `agent-<agentId>`);
   * Codex: the child thread id; Kimi: the `agents/<agentId>` directory name
   * (`task.started.info.agentId`); Grok: the `subagent_spawned.subagent_id`,
   * which is also the child session id and its top-level directory name;
   * dsh: the child session id (what `started subagent <id>` binds).
   */
  key: string
  /** Task description shown as the node caption. */
  label: string
  agentType?: string
  model?: string
  /** Parent-side tool call id that spawned it. */
  callId?: string
  startedAt?: number
  completedAt?: number
}

export interface SynthMeta {
  /** Recorded current occupancy and envelope sizes, independent of request events. */
  contextUsage?: ContextUsage
  model?: string
  provider?: string
  /** Context window in tokens when the harness recorded or implied it. */
  contextWindow?: number
  /** Display label of this file's agent: the session title for a main file, the task for a child. */
  label?: string
  /** A model step or tool run is still open (drives the Agent Network's running pulse). */
  running: boolean
  /** Children spawned from this file, keyed by `AgentSpawn.key`. */
  children: ReadonlyMap<string, AgentSpawn>
  /** Authoritative cost rollup recorded by the harness (Claude `cost-state`), when present. */
  reportedCostUsd?: number
  /** Harness CLI version, when recorded. */
  version?: string
}

export interface EventSynthesizer {
  readonly kind: HarnessKind
  /** Feed one raw JSONL line; returns the fold events it produced, in order. */
  push(line: string): readonly InputEvent[]
  /**
   * Optional, replaceable tail of a response still being grouped. Reading it
   * must not mutate the synthesizer. The session projects it over committed
   * events, then discards that projection before the next push. This makes EOF
   * visible without treating an arbitrary read boundary as a protocol boundary.
   */
  preview?(): readonly InputEvent[]
  meta(): SynthMeta
}

export type SynthesizerFactory = (file: SessionFileRef) => EventSynthesizer

/**
 * The harness-native child key of a child file, matching `AgentSpawn.key`.
 *
 * Only Claude needs a transform (its child files are named `agent-<agentId>`).
 * Codex child files are keyed by their thread id, KIMI child files by their
 * `agents/<agentId>` directory name, GROK child files by their own
 * top-level session directory name — which is exactly the `subagent_id` the
 * parent's `subagent_spawned` records (GROK-FORMAT §D.2/§D.4) — and dsh child
 * files by the child session id, which is exactly the id the parent's
 * `started subagent <id>` result binds. All four fall through to
 * `file.id` unchanged. Keep it that way: a transform here would break the Agent
 * Network's parent→child join for Kimi, Grok, and dsh.
 */
export function childKeyOf(kind: HarnessKind, file: SessionFileRef): string {
  if (kind === 'claude') {
    const base = file.id.slice(file.id.lastIndexOf('/') + 1)
    return base.startsWith('agent-') ? base.slice('agent-'.length) : base
  }
  return file.id
}
