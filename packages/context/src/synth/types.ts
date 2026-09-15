/**
 * Event synthesizers: one per harness, one instance per transcript file.
 * A synthesizer reads raw JSONL lines and emits fold events (see
 * `../fold/event.ts`). It owns per-file state (open request grouping, seq
 * counter, uuid→seq map for compactions, spawned children) and never throws
 * on malformed input: a bad line yields no events.
 */

import type { HarnessKind, SessionFileRef } from '@harness-trajectory/core'
import type { TimelineEvent } from '../fold/event.ts'

/** A child agent spawned from this file, keyed by the harness-native child key. */
export interface AgentSpawn {
  /**
   * Claude: the `agentId` (child file basename is `agent-<agentId>`);
   * Codex: the child thread id; Kimi: the `agents/<agentId>` directory name
   * (`task.started.info.agentId`); Grok: the `subagent_spawned.subagent_id`,
   * which is also the child session id and its top-level directory name.
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
  push(line: string): readonly TimelineEvent[]
  meta(): SynthMeta
}

export type SynthesizerFactory = (file: SessionFileRef) => EventSynthesizer

/**
 * The harness-native child key of a child file, matching `AgentSpawn.key`.
 *
 * Only Claude needs a transform (its child files are named `agent-<agentId>`).
 * Codex child files are keyed by their thread id, KIMI child files by their
 * `agents/<agentId>` directory name, and GROK child files by their own
 * top-level session directory name — which is exactly the `subagent_id` the
 * parent's `subagent_spawned` records (GROK-FORMAT §D.2/§D.4) and exactly the
 * id the server hands back as `file.id` — so all three fall through to
 * `file.id` unchanged. Keep it that way: a transform here would break the Agent
 * Network's parent→child join for Kimi and Grok.
 */
export function childKeyOf(kind: HarnessKind, file: SessionFileRef): string {
  if (kind === 'claude') {
    const base = file.id.slice(file.id.lastIndexOf('/') + 1)
    return base.startsWith('agent-') ? base.slice('agent-'.length) : base
  }
  return file.id
}
