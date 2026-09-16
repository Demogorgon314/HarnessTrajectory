/**
 * Devin CLI → fold events.
 *
 * One instance per virtual stream the server's DevinSource materializes out of
 * `sessions.db` (the main chain, or one subagent chain). The records are the
 * ones `parseDevinLine` reads — `devin.msg` carries a complete `chat_message`
 * (no stream deltas), `devin.session` the `sessions`-row sidecar, `devin.tool`
 * the ACP tool state.
 *
 * Devin-specific facts the mapping leans on:
 *
 * - `metadata.is_user_input` decides human vs injected (never the text).
 * - `metadata.metrics` carries per-call `input_tokens`/`output_tokens`/
 *   `cache_read_tokens` and the harness-measured `ttft_ms`; `created_at`/
 *   `started_generation_at` are ISO stamps with ms precision.
 * - `extensions['chisel/tool_call_timing'].duration_ms` is the tool's real
 *   wall time; `chisel/tool_result_meta.success` is the error flag.
 * - A `run_subagent` result binds its chain via `subagent/agent_id` +
 *   `subagent/chain_node_id` extensions; the sidecar's `agents` list resolves
 *   the agent id to the child stream's file id.
 * - Context renders duplicate the chain (the source dedupes by `message_id`),
 *   so the fold sees the logical transcript only — except the boundary: a
 *   compaction lands as a `system` node carrying `extensions['devin-rs/summary']`
 *   whose text is the rendered "continuing work" summary. It replaces the
 *   whole live surface (Devin keeps the system prefix, which never entered
 *   liveSeqs), exactly like Kimi's `context.apply_compaction`.
 * - `system` nodes split by their extensions: none = a rendered system-prefix
 *   part (each render rewrites it, so a new contiguous run replaces the text),
 *   `devin-rs/summary` = compaction, anything else = an injected context block
 *   (`agent-ext/rules-loaded`, `agent-ext/skills-loaded`, `affogato/cog-context`,
 *   `chisel/user-edits-*`). Injects are surface nodes priced as injected
 *   context; a re-injection replaces the earlier block under the same key.
 */

import {
  asArray, asNumber, asString, devinMessageClass, isRecord, parseDevinLine, titleFrom,
  type DevinRecord, type SessionFileRef,
} from '@harness-trajectory/core'
import type { ContentBlock, MessageSource, TimelineEvent } from '../fold/event.ts'
import type { AgentSpawn, EventSynthesizer, SynthMeta } from './types.ts'

const LABEL_MAX = 80

/** Devin is Cognition's own CLI (SWE-* models); no models.dev vendor id exists. */
const PROVIDER = 'cognition'

/** Wire name of the subagent-spawn tool. */
const SPAWN_TOOL = 'run_subagent'

function msgMeta(msg: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(msg['metadata']) ? msg['metadata'] : undefined
}

function msgExt(msg: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = msgMeta(msg)
  return isRecord(meta?.['extensions']) ? meta['extensions'] : undefined
}

/** `metadata.created_at`/`started_generation_at` (ISO, ms) or the line's own stamp. */
function msgInstant(msg: Record<string, unknown>, key: string, fallback: number): number {
  const stamp = asString(msgMeta(msg)?.[key])
  if (stamp === undefined) return fallback
  const parsed = Date.parse(stamp)
  return Number.isNaN(parsed) ? fallback : parsed
}

/** `chat_message.content` as text (a string, or ACP content parts). */
function msgText(msg: Record<string, unknown>): string {
  const content = msg['content']
  if (typeof content === 'string') return content
  return (asArray(content) ?? [])
    .flatMap(block => (isRecord(block) && block['type'] === 'text' ? [asString(block['text']) ?? ''] : []))
    .join('\n')
}

interface PendingSpawn {
  callId: string
  title: string | null
  task: string | null
  profile: string | null
  time: number
}

class DevinSynthesizer implements EventSynthesizer {
  readonly kind = 'devin' as const

  private seq = 0
  private lastTime = 0
  private turn = 0
  private step = 0

  private model: string | undefined
  private label: string | undefined
  private systemText: string | undefined
  private headerEmitted = false
  /** Whether the previous emitted node was a system-prefix part. */
  private prefixRun = false
  /** inject extension key → live seq, so a re-injection replaces the stale block. */
  private readonly injectSeqs = new Map<string, number>()
  private readonly openCalls = new Set<string>()
  private readonly spawns: PendingSpawn[] = []
  /** Seqs of every live surface node, for the compaction shadow claim. */
  private liveSeqs: number[] = []
  /** Seqs of kept-copy replays emitted since the last compaction — they belong
   * to the incoming render, so the next claim leaves them alone. */
  private replaySeqs: number[] = []
  /** message_ids already emitted once; a second sighting is a render's kept copy. */
  private readonly seenMids = new Set<string>()
  private readonly children = new Map<string, AgentSpawn>()
  /** agentId → child file id, from the session sidecar. */
  private readonly agentFiles = new Map<string, string>()
  /** sessions.metadata.total_acu_cost when the sidecar carries it. */
  private acuCost: number | undefined

  constructor(private readonly file: SessionFileRef) {}

  push(line: string): readonly TimelineEvent[] {
    const record = parseDevinLine(line)
    if (record === null) return []
    const time = record.time ?? this.lastTime
    if (time > this.lastTime) this.lastTime = time
    const out: TimelineEvent[] = []
    switch (record.tag) {
      case 'session':
        this.onSession(record)
        return out
      case 'tool':
        return out
      case 'msg':
        this.onMsg(record, time, out)
        return out
    }
  }

  meta(): SynthMeta {
    return {
      ...(this.model === undefined ? {} : { model: this.model }),
      provider: PROVIDER,
      ...(this.label === undefined ? {} : { label: this.label }),
      running: this.openCalls.size > 0,
      children: this.children,
    }
  }

  private emit(
    out: TimelineEvent[],
    type: string,
    time: number,
    data?: Record<string, unknown>,
    surfaceOp?: unknown,
  ): number {
    const seq = (this.seq += 1)
    out.push({
      type,
      seq,
      time,
      ...(data === undefined ? {} : { data }),
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    })
    return seq
  }

  /** Emit a surface-bearing event and remember its seq for the compaction claim. */
  private emitSurface(
    out: TimelineEvent[],
    type: string,
    time: number,
    data: Record<string, unknown>,
    surfaceOp?: unknown,
    replay = false,
  ): number {
    // `replay` rides the envelope: the fold surfaces the copy but skips every
    // kind of bookkeeping (request record, usage, human-input tally, inject
    // event) — the original emission was already booked.
    const seq = this.emit(out, type, time, replay ? { ...data, replay: true } : data, surfaceOp)
    this.liveSeqs.push(seq)
    if (replay) this.replaySeqs.push(seq)
    return seq
  }

  private onSession(record: Extract<DevinRecord, { tag: 'session' }>): void {
    if (record.title !== null && record.title !== '') this.label = titleFrom(record.title, LABEL_MAX)
    this.model ??= record.model ?? undefined
    this.acuCost = record.acuCost ?? this.acuCost
    for (const agent of record.agents) this.agentFiles.set(agent.id, agent.fileId)
  }

  private onMsg(record: Extract<DevinRecord, { tag: 'msg' }>, time: number, out: TimelineEvent[]): void {
    const msg = record.msg
    const stamp = msgInstant(msg, 'created_at', time)
    const role = asString(msg['role'])
    // A message_id the source already emitted once reaches us again only as a
    // post-compaction render's kept copy: it re-enters the surface but is not a
    // new turn/step/call, and the render's own summary must not claim it.
    const mid = asString(msg['message_id'])
    const replay = mid !== undefined && this.seenMids.has(mid)
    if (mid !== undefined) this.seenMids.add(mid)
    if (role === 'system') {
      const ext = msgExt(msg)
      const injectKey = ext === undefined ? undefined : Object.keys(ext)[0]
      if (ext?.['devin-rs/summary'] === undefined && injectKey === undefined) {
        this.onSystem(msg, stamp, out)
        return
      }
      this.prefixRun = false
      if (ext?.['devin-rs/summary'] !== undefined) {
        this.onCompaction(msg, stamp, out, replay)
        return
      }
      if (injectKey !== undefined) this.onSystemInject(msg, stamp, out, injectKey, replay)
      return
    }
    this.prefixRun = false
    switch (role) {
      case 'user':
        this.onUser(msg, stamp, out, replay)
        return
      case 'assistant':
        this.onAssistant(msg, stamp, out, replay)
        return
      case 'tool':
        this.onResult(msg, stamp, out, replay)
        return
      default:
        return
    }
  }

  /**
   * A contiguous run of extension-less `system` nodes is one render's system
   * prefix (the prompt is written in parts); a later run is a newer render's
   * prefix and replaces it rather than accumulating.
   */
  private onSystem(msg: Record<string, unknown>, time: number, out: TimelineEvent[]): void {
    const text = msgText(msg)
    if (text.trim() === '') return
    this.systemText = this.systemText === undefined || !this.prefixRun ? text : `${this.systemText}\n\n${text}`
    this.prefixRun = true
    this.emit(out, 'request/header', time, {
      header: {
        system: this.systemText,
        config: { provider: PROVIDER, ...(this.model === undefined ? {} : { model: this.model }) },
      },
      reason: this.headerEmitted ? 'change' : 'initial',
    })
    this.headerEmitted = true
  }

  /**
   * An extension-bearing `system` node is an injected context block (rules,
   * skills, workspace context, user-edits reports), not part of the prefix.
   * Re-injection under the same extension key replaces the stale block — the
   * render keeps only the latest version.
   */
  private onSystemInject(
    msg: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
    key: string,
    replay: boolean,
  ): void {
    const text = msgText(msg)
    if (text.trim() === '') return
    const prev = this.injectSeqs.get(key)
    const op = prev !== undefined && this.liveSeqs.includes(prev)
      ? { op: 'replace', startSeq: prev, endSeq: prev }
      : undefined
    const seq = this.emitSurface(out, 'user/message', time, {
      content: [{ type: 'text', text }],
      // `plugin` carries the label — the fold's injectionSourceName reads it
      // over `kind`; `name` keeps the full extension key for identity.
      source: { kind: 'inject', form: 'context', name: key, plugin: key.split('/').pop() ?? key },
    }, op, replay)
    this.injectSeqs.set(key, seq)
  }

  private onUser(msg: Record<string, unknown>, time: number, out: TimelineEvent[], replay: boolean): void {
    const cls = devinMessageClass(msg)
    const text = msgText(msg)
    const content: ContentBlock[] = text === '' ? [] : [{ type: 'text', text }]
    const source: MessageSource = cls?.kind === 'human'
      ? { kind: 'user' }
      : { kind: 'inject', form: 'context', name: cls?.name ?? 'user' }
    if (cls?.kind === 'human' && !replay) {
      this.turn += 1
      this.step = 0
      if (this.label === undefined && text.trim() !== '') this.label = titleFrom(text, LABEL_MAX)
    }
    this.emitSurface(out, 'user/message', time, { content, source }, undefined, replay)
  }

  private onAssistant(msg: Record<string, unknown>, time: number, out: TimelineEvent[], replay: boolean): void {
    if (replay) {
      // A kept copy: surface the content again, but turn/step/usage/calls were
      // already booked when the original emitted.
      const blocks: ContentBlock[] = []
      const thinking = msg['thinking']
      const thinkText = isRecord(thinking) ? asString(thinking['thinking']) : asString(thinking)
      if (thinkText !== undefined && thinkText !== '') blocks.push({ type: 'reasoning', text: thinkText })
      const text = msgText(msg)
      if (text !== '') blocks.push({ type: 'text', text })
      for (const call of asArray(msg['tool_calls']) ?? []) {
        if (!isRecord(call)) continue
        const fn = isRecord(call['function']) ? call['function'] : undefined
        const id = asString(call['id'])
        const name = asString(call['name']) ?? asString(fn?.['name'])
        const args = call['arguments'] ?? fn?.['arguments']
        if (id === undefined || name === undefined) continue
        blocks.push({ type: 'tool-call', callId: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) })
      }
      this.emitSurface(out, 'assistant/message', time, { message: { content: blocks } }, undefined, true)
      return
    }
    if (this.turn === 0) this.turn = 1
    this.step += 1
    const started = msgInstant(msg, 'started_generation_at', time)
    this.emit(out, 'step/start', started)

    const blocks: ContentBlock[] = []
    const thinking = msg['thinking']
    const thinkText = isRecord(thinking) ? asString(thinking['thinking']) : asString(thinking)
    if (thinkText !== undefined && thinkText !== '') blocks.push({ type: 'reasoning', text: thinkText })
    const text = msgText(msg)
    if (text !== '') blocks.push({ type: 'text', text })

    const calls: { id: string; name: string; argsRaw: string }[] = []
    for (const call of asArray(msg['tool_calls']) ?? []) {
      if (!isRecord(call)) continue
      const fn = isRecord(call['function']) ? call['function'] : undefined
      const id = asString(call['id'])
      const name = asString(call['name']) ?? asString(fn?.['name'])
      const args = call['arguments'] ?? fn?.['arguments']
      if (id === undefined || name === undefined) continue
      const argsRaw = typeof args === 'string' ? args : JSON.stringify(args ?? {})
      calls.push({ id, name, argsRaw })
      blocks.push({ type: 'tool-call', callId: id, name, arguments: argsRaw })
    }

    const meta = msgMeta(msg)
    const metrics = isRecord(meta?.['metrics']) ? meta['metrics'] : undefined
    const usage = metrics === undefined ? undefined : {
      inputTokens: asNumber(metrics['input_tokens']) ?? 0,
      outputTokens: asNumber(metrics['output_tokens']) ?? 0,
      ...(asNumber(metrics['cache_read_tokens']) === undefined
        ? {}
        : { cacheReadTokens: asNumber(metrics['cache_read_tokens']) }),
    }
    const model = asString(msgMeta(msg)?.['generation_model'])
    if (model !== undefined) this.model = model

    this.emitSurface(out, 'assistant/message', time, {
      message: { content: blocks },
      ...(usage === undefined ? {} : { usage }),
      turn: this.turn,
      step: this.step,
    })
    for (const call of calls) {
      this.openCalls.add(call.id)
      this.emit(out, 'tool/call', time, { callId: call.id, name: call.name, arguments: call.argsRaw })
      if (call.name === SPAWN_TOOL) {
        const args: unknown = (() => {
          try {
            return JSON.parse(call.argsRaw) as unknown
          } catch {
            return undefined
          }
        })()
        this.spawns.push({
          callId: call.id,
          title: isRecord(args) ? asString(args['title']) ?? null : null,
          task: isRecord(args) ? asString(args['task']) ?? null : null,
          profile: isRecord(args) ? asString(args['profile']) ?? null : null,
          time,
        })
      }
    }
    this.emit(out, 'step/end', time)
  }

  private onResult(msg: Record<string, unknown>, time: number, out: TimelineEvent[], replay: boolean): void {
    const callId = asString(msg['tool_call_id'])
    if (callId === undefined) return
    const ext = msgExt(msg)
    const resultMeta = isRecord(ext?.['chisel/tool_result_meta']) ? ext['chisel/tool_result_meta'] : undefined
    const timing = isRecord(ext?.['chisel/tool_call_timing']) ? ext['chisel/tool_call_timing'] : undefined
    const isError = resultMeta?.['success'] === false
    const text = msgText(msg)
    if (!replay) this.openCalls.delete(callId)
    this.emitSurface(out, 'tool/result', time, {
      message: {
        content: [{
          type: 'tool-result', toolCallId: callId, isError,
          content: text === '' ? [] : [{ type: 'text', text }],
        }],
        source: { callId },
      },
      ...(isError ? { error: true } : {}),
      meta: {
        ...(asNumber(timing?.['duration_ms']) === undefined
          ? {}
          : { durationMs: asNumber(timing?.['duration_ms']) }),
      },
    }, undefined, replay)
    if (replay) return

    // A run_subagent result names its chain: register the child under the file
    // id the sidecar resolved (else the agent id — the join still works once
    // the server names the file after it).
    const agentId = asString(ext?.['subagent/agent_id'])
    if (agentId === undefined) return
    const spawn = this.spawns.find(candidate => candidate.callId === callId)
    const key = this.agentFiles.get(agentId) ?? agentId
    const model = asString(ext?.['subagent/model'])
    this.children.set(key, {
      key,
      label: titleFrom(spawn?.title ?? spawn?.task ?? agentId, LABEL_MAX),
      ...(spawn?.profile == null && asString(ext?.['subagent/profile_name']) === undefined
        ? {}
        : { agentType: asString(ext?.['subagent/profile_name']) ?? spawn?.profile ?? '' }),
      ...(model === undefined ? {} : { model }),
      callId,
      ...(spawn === undefined ? {} : { startedAt: spawn.time }),
      completedAt: time,
    })
  }

  /**
   * A compaction lands as a `system` node marked `extensions['devin-rs/summary']`.
   * Devin's compaction replaces the whole rendered history with that summary —
   * the kept system prefix never entered liveSeqs — so every live seq is
   * shadowed and the summary message itself carries the `replace` op that
   * consumes the armed claim (the fold rewrites the freed-token figure).
   * Replays emitted since the previous summary are the incoming render's kept
   * copies — they survive this claim. A replayed summary node is just kept
   * text: surface it without arming another claim.
   */
  private onCompaction(msg: Record<string, unknown>, time: number, out: TimelineEvent[], replay: boolean): void {
    if (replay) {
      const text = msgText(msg)
      this.emitSurface(out, 'user/message', time, {
        content: text === '' ? [] : [{ type: 'text', text }],
        source: { kind: 'plugin', form: 'compaction', plugin: 'compaction' } satisfies MessageSource,
      }, undefined, true)
      return
    }
    const exempt = new Set(this.replaySeqs)
    const shadowed = this.liveSeqs.filter(seq => !exempt.has(seq))
    this.liveSeqs = this.replaySeqs
    this.replaySeqs = []
    this.injectSeqs.clear()
    this.emit(out, 'compaction/summary', time, { shadowedSeqs: [...shadowed] })
    const op = shadowed.length === 0
      ? undefined
      : { op: 'replace', startSeq: Math.min(...shadowed), endSeq: Math.max(...shadowed) }
    const text = msgText(msg)
    this.emitSurface(out, 'user/message', time, {
      content: text === '' ? [] : [{ type: 'text', text }],
      source: { kind: 'plugin', form: 'compaction', plugin: 'compaction' } satisfies MessageSource,
    }, op)
  }
}

/** Create the synthesizer for one devin stream (main chain or one subagent chain). */
export function createDevinSynthesizer(file: SessionFileRef): EventSynthesizer {
  return new DevinSynthesizer(file)
}
