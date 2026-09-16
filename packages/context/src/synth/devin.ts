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
 * - The render's kept copies reach this stream twice per compaction: the
 *   summary's ANCESTOR flush rides `"kept":1` lines just before the summary
 *   (the incoming render's prefix/injections — the claim's exact exemption
 *   set), while kept tail messages arrive as UNTAGGED descendants after the
 *   summary and stay claimable — the next render re-copies them, so an
 *   untagged copy must not dodge the next claim or the surface would hold
 *   two copies of one logical message.
 * - `system` nodes split by their extensions: none = a rendered system-prefix
 *   part (each render rewrites it, so a new run — live, replayed or kept —
 *   replaces the text rather than appending to a different run), anything
 *   else = an injected context block (`agent-ext/rules-loaded`,
 *   `agent-ext/skills-loaded`, `affogato/cog-context`, `chisel/user-edits-*`).
 *   Injects are surface nodes priced as injected context; a re-injection
 *   replaces the earlier block under the same key.
 */

import {
  asArray, asNumber, asString, devinMessageClass, isRecord, parseDevinLine, titleFrom,
  type DevinRecord, type SessionFileRef,
} from '@harness-trajectory/core'
import type { ContentBlock, MessageSource, StreamRecord, TimelineEvent } from '../fold/event.ts'
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

/**
 * An inject block's identity key. The store does not preserve a stable key
 * order in `extensions` (multi-key nodes serialize them differently per
 * render), so the raw first key would hand the same block a new identity —
 * a missed `replace` and a duplicate surface — whenever the order flips.
 * Sorting makes the choice deterministic; one node is one inject block.
 */
function injectKeyOf(ext: Record<string, unknown>): string | undefined {
  return Object.keys(ext).sort()[0]
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
  /**
   * Provenance of the prefix run in progress: parts append only to a run of
   * the same provenance — a render's re-copied prefix (tagged `kept`, or an
   * untagged replay descendant) starts a NEW run that replaces the header
   * text rather than concatenating onto the live one.
   */
  private prefixRun: 'off' | 'live' | 'replay' | 'kept' = 'off'
  /** inject extension key → live seq, so a re-injection replaces the stale block. */
  private readonly injectSeqs = new Map<string, number>()
  private readonly openCalls = new Set<string>()
  private readonly spawns: PendingSpawn[] = []
  /** Seqs of every live surface node, for the compaction shadow claim. */
  private liveSeqs: number[] = []
  /**
   * Seqs of `kept`-tagged surface nodes since the last compaction — the
   * incoming render's ancestor flush, i.e. exactly what the render declares
   * still-live. The next claim exempts this set and nothing more: untagged
   * kept copies (post-summary descendants) are replaced by the next render's
   * own copies and must be claimed.
   */
  private keptSeqs: number[] = []
  /** message_ids already emitted once; a second sighting is a render's kept copy. */
  private readonly seenMids = new Set<string>()
  private readonly children = new Map<string, AgentSpawn>()
  /** agentId → child file id, from the session sidecar. */
  private readonly agentFiles = new Map<string, string>()

  push(line: string): readonly TimelineEvent[] {
    const out: TimelineEvent[] = []
    try {
      const record = parseDevinLine(line)
      if (record === null) return out
      const time = record.time ?? this.lastTime
      if (time > this.lastTime) this.lastTime = time
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
    } catch {
      // The stream is untrusted input: a malformed record yields whatever
      // events were already produced for this line and never throws.
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

  /**
   * Emit a surface-bearing event and remember its seq for the compaction
   * claim. `replay` (the mid was seen before) rides the envelope so the fold
   * surfaces the copy without bookkeeping; `kept` (the source tagged the
   * line as the summary's ancestor flush) enlists the seq in the claim's
   * exemption set.
   */
  private emitSurface(
    out: TimelineEvent[],
    type: string,
    time: number,
    data: Record<string, unknown>,
    surfaceOp?: unknown,
    replay = false,
    kept = false,
  ): number {
    const seq = this.emit(out, type, time, replay ? { ...data, replay: true } : data, surfaceOp)
    this.liveSeqs.push(seq)
    if (kept) this.keptSeqs.push(seq)
    return seq
  }

  private onSession(record: Extract<DevinRecord, { tag: 'session' }>): void {
    if (record.title !== null && record.title !== '') this.label = titleFrom(record.title, LABEL_MAX)
    this.model ??= record.model ?? undefined
    for (const agent of record.agents) this.agentFiles.set(agent.id, agent.fileId)
  }

  private onMsg(record: Extract<DevinRecord, { tag: 'msg' }>, time: number, out: TimelineEvent[]): void {
    const msg = record.msg
    const stamp = msgInstant(msg, 'created_at', time)
    const role = asString(msg['role'])
    // A message_id already emitted reaches us again only as a render's kept
    // copy: it re-enters the surface but is not a new turn/step/call. Whether
    // the next summary's claim leaves it alone is decided by the `kept` tag,
    // not by replay-ness — only the ancestor flush carries the tag.
    const mid = asString(msg['message_id'])
    const replay = mid !== undefined && this.seenMids.has(mid)
    if (mid !== undefined) this.seenMids.add(mid)
    const kept = record.kept
    if (role === 'system') {
      const ext = msgExt(msg)
      const injectKey = ext === undefined ? undefined : injectKeyOf(ext)
      if (ext?.['devin-rs/summary'] === undefined && injectKey === undefined) {
        this.onSystem(msg, stamp, out, replay, kept)
        return
      }
      this.prefixRun = 'off'
      if (ext?.['devin-rs/summary'] !== undefined) {
        this.onCompaction(msg, stamp, out, replay, kept)
        return
      }
      if (injectKey !== undefined) this.onSystemInject(msg, stamp, out, injectKey, replay, kept)
      return
    }
    this.prefixRun = 'off'
    switch (role) {
      case 'user':
        this.onUser(msg, stamp, out, replay, kept)
        return
      case 'assistant':
        this.onAssistant(msg, stamp, out, replay, kept)
        return
      case 'tool':
        this.onResult(msg, stamp, out, replay, kept)
        return
      default:
        return
    }
  }

  /**
   * A contiguous run of extension-less `system` nodes is one render's system
   * prefix (the prompt is written in parts). A run only continues while the
   * parts share a provenance: a render's re-copied parts (tagged `kept`, or
   * untagged replay copies) arriving adjacent to the live run must REPLACE
   * the header text — appending would double every prefix part.
   */
  private onSystem(
    msg: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
    replay: boolean,
    kept: boolean,
  ): void {
    const text = msgText(msg)
    if (text.trim() === '') return
    const run = kept ? 'kept' : replay ? 'replay' : 'live'
    this.systemText = this.systemText === undefined || this.prefixRun !== run
      ? text
      : `${this.systemText}\n\n${text}`
    this.prefixRun = run
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
    kept: boolean,
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
    }, op, replay, kept)
    this.injectSeqs.set(key, seq)
  }

  private onUser(
    msg: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
    replay: boolean,
    kept: boolean,
  ): void {
    const cls = devinMessageClass(msg)
    const text = msgText(msg)
    const content: ContentBlock[] = text === '' ? [] : [{ type: 'text', text }]
    // An injected user record's first extension key names its producer
    // (`barista/prompt_cache_footer`, hooks, guidance) — the same convention
    // the system-inject path uses for its `plugin` label.
    const injectKey = injectKeyOf(msgExt(msg) ?? {})
    const plugin = injectKey?.split('/').pop() ?? injectKey
    const source: MessageSource = cls?.kind === 'human'
      ? { kind: 'user' }
      : {
        kind: 'inject',
        form: 'context',
        name: injectKey ?? cls?.name ?? 'user',
        ...(plugin === undefined ? {} : { plugin }),
      }
    if (cls?.kind === 'human' && !replay) {
      this.turn += 1
      this.step = 0
      if (this.label === undefined && text.trim() !== '') this.label = titleFrom(text, LABEL_MAX)
    }
    this.emitSurface(out, 'user/message', time, { content, source }, undefined, replay, kept)
  }

  private onAssistant(
    msg: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
    replay: boolean,
    kept: boolean,
  ): void {
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
      this.emitSurface(out, 'assistant/message', time, { message: { content: blocks } }, undefined, true, kept)
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
    // Observed stores write `cache_creation_tokens`; `cache_write_tokens` is
    // kept as a forward-compat alias (matches the core adapter's mapping).
    const cacheWrite = asNumber(metrics?.['cache_write_tokens']) ?? asNumber(metrics?.['cache_creation_tokens'])
    const usage = metrics === undefined ? undefined : {
      inputTokens: asNumber(metrics['input_tokens']) ?? 0,
      outputTokens: asNumber(metrics['output_tokens']) ?? 0,
      ...(asNumber(metrics['cache_read_tokens']) === undefined
        ? {}
        : { cacheReadTokens: asNumber(metrics['cache_read_tokens']) }),
      ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    }
    const model = asString(msgMeta(msg)?.['generation_model'])
    if (model !== undefined) this.model = model

    // Devin stores no stream deltas, only the settled message — but it DOES
    // record `ttft_ms` (harness-measured first-token latency). Synthesize the
    // stream the fold reads: one marker delta at the first-token instant,
    // then a `block-start` per content block (untimed → all stamped at the
    // first-token instant, same convention as Kimi's settled blocks).
    const stream: StreamRecord[] = []
    const ttft = asNumber(metrics?.['ttft_ms'])
    let blockStart = started
    if (ttft !== undefined && Number.isFinite(ttft) && ttft >= 0) {
      const at = started + ttft
      if (at <= time) {
        stream.push({ type: 'chunk', time: at, chunk: { type: 'text-delta', text: ' ' } })
        blockStart = at
      }
    }
    for (const block of blocks) {
      const blockType = block.type === 'reasoning' ? 'reasoning' : block.type === 'tool-call' ? 'tool-call' : 'text'
      stream.push({ type: 'chunk', time: blockStart, chunk: { type: 'block-start', blockType } })
    }

    this.emitSurface(out, 'assistant/message', time, {
      message: { content: blocks },
      ...(usage === undefined ? {} : { usage }),
      turn: this.turn,
      step: this.step,
      stream,
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

  private onResult(
    msg: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
    replay: boolean,
    kept: boolean,
  ): void {
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
    }, undefined, replay, kept)
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
   * shadowed EXCEPT the `kept`-tagged ancestor flush that preceded this
   * summary: those copies are the incoming render's declared-kept context.
   * Kept copies that arrived as untagged post-summary descendants ARE claimed
   * — the next render carries its own copies of them, so exempting them would
   * leave the same logical message on the surface twice. The summary message
   * itself carries the `replace` op that consumes the armed claim (the fold
   * rewrites the freed-token figure). A replayed summary node is just kept
   * text: surface it without arming another claim.
   */
  private onCompaction(
    msg: Record<string, unknown>,
    time: number,
    out: TimelineEvent[],
    replay: boolean,
    kept: boolean,
  ): void {
    if (replay) {
      const text = msgText(msg)
      this.emitSurface(out, 'user/message', time, {
        content: text === '' ? [] : [{ type: 'text', text }],
        source: { kind: 'plugin', form: 'compaction', plugin: 'compaction' } satisfies MessageSource,
      }, undefined, true, kept)
      return
    }
    const exempt = new Set(this.keptSeqs)
    const shadowed = this.liveSeqs.filter(seq => !exempt.has(seq))
    this.liveSeqs = this.keptSeqs
    this.keptSeqs = []
    // Kept injects survive the claim — keep their key→seq mapping so a later
    // re-injection under the same key still replaces them; only shadowed
    // entries are stale.
    for (const [key, seq] of this.injectSeqs) {
      if (!exempt.has(seq)) this.injectSeqs.delete(key)
    }
    this.emit(out, 'compaction/summary', time, { shadowedSeqs: [...shadowed] })
    // `shadowed` keeps `liveSeqs`' ascending order — first/last, never a
    // spread: `Math.min(...seqs)` stack-overflows on a long-lived session.
    const op = shadowed.length === 0
      ? undefined
      : { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] }
    const text = msgText(msg)
    this.emitSurface(out, 'user/message', time, {
      content: text === '' ? [] : [{ type: 'text', text }],
      source: { kind: 'plugin', form: 'compaction', plugin: 'compaction' } satisfies MessageSource,
    }, op, false, kept)
  }
}

/** Create the synthesizer for one devin stream (main chain or one subagent chain). */
export function createDevinSynthesizer(_file: SessionFileRef): EventSynthesizer {
  return new DevinSynthesizer()
}
