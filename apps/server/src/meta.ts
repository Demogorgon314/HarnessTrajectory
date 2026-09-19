/**
 * Lightweight per-harness metadata scanners for the session list. They read
 * the same JSONL lines the full adapters do but only keep listing facts, so
 * the index stays small even with hundreds of transcripts.
 */

import {
  agentMentions, asArray, asNumber, asString, classifyInjectedUser, devinMessageClass, grokMessageClass, GrokPromptChunks,
  codexHumanPromptText, dshSubagentIdOf, dshTextOf, dshToolResultOf, dshUserClass, isRecord, isPiHumanPrompt,
  kimiMessageClass, kimiTitleText,
  parseDevinLine, parseDshLine, parseGrokLine,
  opencodeTextOf, opencodeUserClass, parseJsonLine, parseOpencodeLine, parsePiLine, parseTime, piContentText,
  titleFrom, type AgentFileMeta, type HarnessKind,
} from '@harness-trajectory/core'

export interface FileHead {
  /** Transcript identity from the file content (thread id for Codex, session id for Claude). */
  id: string | null
  /** Parent transcript id when this file is a subagent/child thread. */
  parentId: string | null
  /**
   * Codex paginated history: an exclusive prefix position inside another
   * rollout that this file's effective history starts from. `threadId` is
   * the BASE file's rollout id despite the field name (the rollout id is the
   * last UUID of its filename; `HistoryPosition` predates the rename).
   */
  historyBase?: {
    rolloutId: string
    endOrdinalExclusive: number | null
    endByteOffset: number | null
  } | null
  /**
   * Codex child threads only: `session_meta.subagent_history_start_ordinal`.
   * Logical-stream ordinals below it are the PARENT's history materialized
   * into the file (thread_history_materialization.rs), not the child's own
   * activity — listing, search, and replay all skip them.
   */
  historyStartOrdinal?: number | null
}

export interface MetaState {
  title: string | null
  aiTitle: string | null
  cwd: string | null
  model: string | null
  startedAt: number | null
  lastTime: number | null
  promptCount: number
  /**
   * Children this transcript named (spawn description, type, model). A parent
   * file fills this; a child file leaves it empty. Sidecar harnesses never
   * write it — they attach `file.agent` at registration.
   */
  agents: Map<string, AgentFileMeta>
  /** This file's own agent type, when the transcript records one (Kimi `profile.bind`). */
  agentType: string | null
}

export function emptyMeta(): MetaState {
  return {
    title: null, aiTitle: null, cwd: null, model: null, startedAt: null, lastTime: null, promptCount: 0,
    agents: new Map(), agentType: null,
  }
}

export interface MetaScanner {
  readonly state: MetaState
  push(line: string): void
  /**
   * Scanner-private state a byte-resume needs beyond `state`, serialized by the
   * listing cache. Most scanners derive everything into `state` and omit both.
   */
  save?(): unknown
  load?(saved: unknown): void
}

/**
 * Bump when any scanner's logic changes: cached listing states from an older
 * version are discarded and the transcripts they covered are re-read.
 */
export const META_SCANNER_VERSION = 8

/**
 * Serialized scanner payload for the listing cache: the public `state` plus
 * whatever private state the scanner chose to keep (`save`). `null` when the
 * file carried no scanner (a sidecar'd child), which still lets the cache
 * resume its byte cursor.
 */
export function serializeMeta(scanner: MetaScanner | null): string | null {
  if (scanner === null) return null
  const state = scanner.state
  return JSON.stringify({
    s: {
      title: state.title,
      aiTitle: state.aiTitle,
      cwd: state.cwd,
      model: state.model,
      startedAt: state.startedAt,
      lastTime: state.lastTime,
      promptCount: state.promptCount,
      agentType: state.agentType,
      agents: [...state.agents.entries()],
    },
    x: scanner.save?.(),
  })
}

/**
 * Apply a payload written by {@link serializeMeta} to a fresh scanner. Either
 * the whole snapshot lands or the scanner is left untouched (the caller then
 * re-reads the transcript from byte 0).
 */
export function hydrateMeta(scanner: MetaScanner, saved: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(saved)
  } catch {
    return false
  }
  if (!isRecord(parsed)) return false
  const s = parsed['s']
  if (!isRecord(s)) return false
  const agents = new Map<string, AgentFileMeta>()
  const entries = asArray(s['agents'])
  if (entries === undefined) return false
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length !== 2) return false
    const id = asString(pair[0])
    const meta = isRecord(pair[1]) ? pair[1] : undefined
    if (id === undefined || meta === undefined) return false
    agents.set(id, {
      agentId: asString(meta['agentId']) ?? id,
      ...field('toolUseId', asString(meta['toolUseId'])),
      ...field('description', asString(meta['description'])),
      ...field('agentType', asString(meta['agentType'])),
      ...field('model', asString(meta['model'])),
      ...(meta['isFork'] === true ? { isFork: true } : {}),
    })
  }
  const state = scanner.state
  state.title = asString(s['title']) ?? null
  state.aiTitle = asString(s['aiTitle']) ?? null
  state.cwd = asString(s['cwd']) ?? null
  state.model = asString(s['model']) ?? null
  state.startedAt = asNumber(s['startedAt']) ?? null
  state.lastTime = asNumber(s['lastTime']) ?? null
  state.promptCount = asNumber(s['promptCount']) ?? 0
  state.agentType = asString(s['agentType']) ?? null
  state.agents = agents
  scanner.load?.(parsed['x'])
  return true
}

/**
 * Scanner for one transcript. `summary` is read by the store-backed scanners:
 * for grok it is the parsed `summary.json` sitting beside `updates.jsonl`
 * (GROK-FORMAT §B.1), for devin the `sessions` row the source already loaded
 * (title, cwd, model, `createdAt` ms). The scanner itself performs no I/O.
 */
export function createMetaScanner(
  kind: HarnessKind,
  summary?: Record<string, unknown> | null,
): MetaScanner {
  switch (kind) {
    case 'claude': return claudeMetaScanner()
    case 'codex': return codexMetaScanner()
    case 'kimi': return kimiMetaScanner()
    case 'grok': return grokMetaScanner(summary ?? null)
    case 'devin': return devinMetaScanner(summary ?? null)
    case 'pi': return piMetaScanner()
    case 'opencode': return opencodeMetaScanner(summary ?? null)
    case 'dsh': return dshMetaScanner()
  }
}

/**
 * Listing scan for one file: every main transcript, and any child that has no
 * sidecar facts yet. Harnesses with `.meta.json` / `summary.json` attach
 * `sidecar` at registration and skip the child scan; a harness that only
 * names children inside the parent JSONL leaves `sidecar` unset, so the
 * child's own title/type still reach the catalog.
 */
export function listingScannerFor(
  kind: HarnessKind,
  role: 'main' | 'child',
  sidecar: AgentFileMeta | undefined,
  summary?: Record<string, unknown> | null,
): MetaScanner | null {
  if (role === 'child' && sidecar !== undefined) return null
  return createMetaScanner(kind, summary ?? null)
}

function nonempty(value: string | null | undefined): string | undefined {
  return value !== undefined && value !== null && value !== '' ? value : undefined
}

/** Parent spawn facts win; the child's own listing title/type/model fill gaps; an existing sidecar is last. */
export function mergeChildAgent(
  id: string,
  parent: AgentFileMeta | undefined,
  own: MetaState | undefined,
  existing: AgentFileMeta | undefined,
): AgentFileMeta | undefined {
  const ownDescription = nonempty(own?.title)
  const ownType = nonempty(own?.agentType)
  const ownModel = nonempty(own?.model)
  if (parent === undefined && ownDescription === undefined && ownType === undefined && ownModel === undefined) {
    return existing
  }
  const description = nonempty(parent?.description) ?? ownDescription ?? existing?.description
  const agentType = nonempty(parent?.agentType) ?? ownType ?? existing?.agentType
  const model = nonempty(parent?.model) ?? ownModel ?? existing?.model
  const toolUseId = nonempty(parent?.toolUseId) ?? existing?.toolUseId
  const isFork = parent?.isFork ?? existing?.isFork
  if (description === undefined && agentType === undefined && model === undefined
    && toolUseId === undefined && isFork === undefined) {
    return existing
  }
  return {
    agentId: nonempty(existing?.agentId) ?? id,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(description === undefined ? {} : { description }),
    ...(agentType === undefined ? {} : { agentType }),
    ...(model === undefined ? {} : { model }),
    ...(isFork === undefined ? {} : { isFork }),
  }
}

export function agentMetaEqual(left: AgentFileMeta | undefined, right: AgentFileMeta | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.agentId === right.agentId
    && left.toolUseId === right.toolUseId
    && left.description === right.description
    && left.agentType === right.agentType
    && left.model === right.model
    && left.isFork === right.isFork
}

function noteTime(state: MetaState, value: unknown): void {
  const time = parseTime(value)
  if (time === null) return
  if (state.startedAt === null || time < state.startedAt) state.startedAt = time
  if (state.lastTime === null || time > state.lastTime) state.lastTime = time
}

function claudeMetaScanner(): MetaScanner {
  const state = emptyMeta()
  return {
    state,
    push(line) {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return
      noteTime(state, record['timestamp'])
      if (state.cwd === null) state.cwd = asString(record['cwd']) ?? null
      const type = record['type']
      if (type === 'ai-title') {
        state.aiTitle = asString(record['aiTitle']) ?? state.aiTitle
        return
      }
      if (type === 'summary' && state.title === null) {
        const summary = asString(record['summary'])
        if (summary !== undefined) state.title = titleFrom(summary)
        return
      }
      const message = record['message']
      if (!isRecord(message)) return
      if (type === 'user' && record['isMeta'] !== true && record['isSidechain'] !== true) {
        const content = message['content']
        const text = typeof content === 'string'
          ? content
          : (asArray(content) ?? [])
            .flatMap(block => (isRecord(block) && block['type'] === 'text' ? [asString(block['text']) ?? ''] : []))
            .join('\n')
        const hasToolResult = (asArray(content) ?? []).some(block => isRecord(block) && block['type'] === 'tool_result')
        if (!hasToolResult && text.trim() !== '' && record['isCompactSummary'] !== true
          && classifyInjectedUser(record, text) === null) {
          state.promptCount += 1
          if (state.title === null) state.title = titleFrom(text)
        }
      } else if (type === 'assistant' && state.model === null) {
        state.model = asString(message['model']) ?? null
      }
    },
  }
}

function codexMetaScanner(): MetaScanner {
  const state = emptyMeta()
  // A child thread's own records begin at `subagent_history_start_ordinal`;
  // below it the file carries the parent's inherited history, which must not
  // count toward the child's title or prompt tally.
  let historyStartOrdinal: number | undefined
  return {
    state,
    save() { return { historyStartOrdinal } },
    load(saved) {
      if (isRecord(saved)) historyStartOrdinal = asNumber(saved['historyStartOrdinal'])
    },
    push(line) {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return
      const payload = record['payload']
      if (record['type'] === 'session_meta' && isRecord(payload)) {
        const raw = payload['subagent_history_start_ordinal']
        historyStartOrdinal ??= asNumber(raw) ?? (typeof raw === 'string' ? asNumber(Number(raw)) : undefined)
      } else if (historyStartOrdinal !== undefined) {
        const ordinal = asNumber(record['ordinal'])
        if (ordinal !== undefined && ordinal < historyStartOrdinal) return
      }
      noteTime(state, record['timestamp'])
      if (!isRecord(payload)) return
      switch (record['type']) {
        case 'session_meta':
          state.cwd ??= asString(payload['cwd']) ?? null
          break
        case 'turn_context':
          state.model ??= asString(payload['model']) ?? null
          state.cwd ??= asString(payload['cwd']) ?? null
          break
        case 'response_item':
          if (payload['type'] === 'message' && payload['role'] === 'user') {
            const text = codexHumanPromptText(payload)
            if (text !== null) {
              state.promptCount += 1
              if (state.title === null && text.trim() !== '') state.title = titleFrom(text)
            }
          }
          break
        default:
          break
      }
    },
  }
}

/** Text of a Kimi `message.content` array (`[{ type: 'text', text }]`). */
function kimiText(content: unknown): string {
  return (asArray(content) ?? [])
    .flatMap(block => (isRecord(block) && block['type'] === 'text' ? [asString(block['text']) ?? ''] : []))
    .join('\n')
}

/** `kimi-code/k3` → `k3`; the display model before the first `llm.request`. */
function aliasTail(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined
  const slash = alias.lastIndexOf('/')
  return slash === -1 ? alias : alias.slice(slash + 1)
}

/** Tools whose result names one or more subagents — same set as the adapter. */
const KIMI_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'AgentSwarm'])

function field<K extends string>(key: K, value: string | null | undefined): { [P in K]: string } | Record<string, never> {
  const text = nonempty(value)
  return text === undefined ? {} : { [key]: text } as { [P in K]: string }
}

function noteKimiAgent(state: MetaState, id: string, patch: {
  description?: string
  agentType?: string
  model?: string
  toolUseId?: string
}): void {
  const prev = state.agents.get(id)
  const description = nonempty(patch.description) ?? prev?.description
  const agentType = nonempty(patch.agentType) ?? prev?.agentType
  const model = nonempty(patch.model) ?? prev?.model
  const toolUseId = nonempty(patch.toolUseId) ?? prev?.toolUseId
  state.agents.set(id, {
    agentId: id,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(description === undefined ? {} : { description }),
    ...(agentType === undefined ? {} : { agentType }),
    ...(model === undefined ? {} : { model }),
  })
}

/** Kimi loop events nest their payload under `event`; read both levels. */
function kimiLoopEvent(record: Record<string, unknown>): Record<string, unknown> {
  const event = record['event']
  return isRecord(event) ? event : record
}

function kimiToolOutput(event: Record<string, unknown>): string {
  const result = isRecord(event['result']) ? event['result'] : undefined
  const output = result === undefined ? event['output'] : result['output']
  return typeof output === 'string' ? output : ''
}

/**
 * Kimi wire records are `{ type, time, agentId, ...payload }` with the payload
 * fields at the top level; `time` is epoch milliseconds.
 */
function kimiMetaScanner(): MetaScanner {
  const state = emptyMeta()
  // Agent/AgentSwarm calls remembered until their result names the child.
  const pending = new Map<string, { description: string | undefined; agentType: string | undefined }>()
  return {
    state,
    // A call awaiting its result across a restart keeps its description.
    save() {
      return [...pending.entries()]
    },
    load(saved) {
      for (const pair of asArray(saved) ?? []) {
        if (!Array.isArray(pair) || pair.length !== 2) continue
        const callId = asString(pair[0])
        const value = isRecord(pair[1]) ? pair[1] : undefined
        if (callId === undefined || value === undefined) continue
        pending.set(callId, {
          description: asString(value['description']),
          agentType: asString(value['agentType']),
        })
      }
    },
    push(line) {
      const record = parseJsonLine(line)
      if (!isRecord(record)) return
      noteTime(state, record['time'])
      switch (record['type']) {
        case 'metadata':
          noteTime(state, record['created_at'])
          break
        case 'profile.bind': {
          const environment = record['environmentDisclosure']
          if (isRecord(environment)) state.cwd ??= asString(environment['cwd']) ?? null
          state.model ??= aliasTail(asString(record['modelAlias'])) ?? null
          state.agentType ??= asString(record['profileName']) ?? null
          break
        }
        case 'llm.request':
          // `provider` here is the wire protocol ('openai'), never the vendor.
          state.model ??= asString(record['model']) ?? null
          break
        case 'context.append_message': {
          const message = record['message']
          if (!isRecord(message) || message['role'] !== 'user') break
          // Human vs injected/task/skill/plugin/compaction is decided by the origin, never by text.
          if (kimiMessageClass(message['origin']).kind !== 'human') break
          // A delegated prompt's `<git-context>` prelude is not its title.
          const text = kimiTitleText(kimiText(message['content']))
          if (text.trim() === '') break
          state.promptCount += 1
          if (state.title === null) state.title = titleFrom(text)
          break
        }
        case 'task.started': {
          const info = isRecord(record['info']) ? record['info'] : undefined
          if (info === undefined || asString(info['kind']) !== 'agent') break
          const agentId = asString(info['agentId'])
          if (agentId === undefined) break
          noteKimiAgent(state, agentId, {
            ...field('description', asString(info['description'])),
            ...field('agentType', asString(info['subagentType'])),
            ...field('model', aliasTail(asString(info['model']))),
            ...field('toolUseId', asString(info['parentToolCallId'])),
          })
          break
        }
        case 'context.append_loop_event': {
          const event = kimiLoopEvent(record)
          const kind = asString(event['type'])
          if (kind === 'tool.call') {
            const name = asString(event['name'])
            const callId = asString(event['toolCallId'])
            if (callId === undefined || name === undefined || !KIMI_SUBAGENT_TOOLS.has(name)) break
            const args = isRecord(event['args']) ? event['args'] : undefined
            const description = nonempty(asString(args?.['description']))
              ?? nonempty(asString(args?.['prompt'])?.slice(0, 80))
            pending.set(callId, {
              description,
              agentType: nonempty(asString(args?.['subagent_type'])),
            })
            break
          }
          if (kind !== 'tool.result') break
          const callId = asString(event['toolCallId'])
          if (callId === undefined) break
          const fallback = pending.get(callId)
          pending.delete(callId)
          // Only Agent/AgentSwarm results name children; other outputs can
          // quote the same `agent_id:` shape (TaskOutput's task dump does).
          if (fallback === undefined) break
          const output = kimiToolOutput(event)
          if (output === '') break
          for (const mention of agentMentions(output)) {
            noteKimiAgent(state, mention.agentId, {
              ...field('description', nonempty(mention.description) ?? fallback?.description),
              ...field('agentType', nonempty(mention.agentType) ?? fallback?.agentType),
              ...field('toolUseId', callId),
            })
          }
          break
        }
        default:
          break
      }
    },
  }
}

/** Text of a grok `user_message_chunk`: the typed form when one was recorded (GROK-FORMAT §F.4). */
function grokChunkText(update: Record<string, unknown>): string {
  const content = update['content']
  if (!isRecord(content)) return ''
  const meta = isRecord(content['_meta']) ? content['_meta'] : undefined
  return asString(meta?.['displayText']) ?? asString(content['text']) ?? ''
}

/**
 * Grok keeps the session's title, cwd, model and creation instant in
 * `summary.json` beside `updates.jsonl` rather than in it (GROK-FORMAT §B.1),
 * so the scanner takes that object from its caller and then only counts prompts.
 *
 * `session_summary` is the harness's own generated title, so it lands on
 * `aiTitle` the way Claude's `ai-title` record does — verbatim, like Kimi's
 * `state.json` title, so the listing and the live sync agree; the first human
 * prompt stays the fallback for a directory whose `summary.json` is not written
 * yet (grok writes it last — GROK-DESIGN §1).
 */
function grokMetaScanner(summary: Record<string, unknown> | null): MetaScanner {
  const state = emptyMeta()
  const chunks = new GrokPromptChunks()
  if (summary !== null) {
    const title = asString(summary['session_summary'])?.trim()
    if (title !== undefined && title !== '') state.aiTitle = title
    const info = isRecord(summary['info']) ? summary['info'] : undefined
    state.cwd = asString(info?.['cwd']) ?? null
    state.model = asString(summary['current_model_id']) ?? null
    // `created_at` is RFC 3339 with microsecond precision; `parseTime` reads it as epoch ms.
    noteTime(state, summary['created_at'])
  }
  return {
    state,
    push(line) {
      const record = parseGrokLine(line)
      if (record === null) return
      noteTime(state, record.time)
      const update = record.update
      if (update === null) return
      const continuation = chunks.continues(record.sessionUpdate ?? '', update)
      // The model of the turn rides on the user chunk; it is the only in-band
      // source when `summary.json` has not been written yet.
      if (record.sessionUpdate === 'user_message_chunk') {
        const chunkMeta = isRecord(update['_meta']) ? update['_meta'] : undefined
        state.model ??= asString(chunkMeta?.['modelId']) ?? null
      } else if (record.sessionUpdate === 'model_changed') {
        state.model ??= asString(update['model_id']) ?? null
        return
      }
      // Human vs injected is decided by the `_meta` flags, never by the text.
      if (grokMessageClass(update)?.kind !== 'human') return
      // The prompt counts even when it carries no text (an image-only prompt),
      // exactly as the adapter and the context synthesizer count it; the text
      // only serves as the title fallback.
      if (!continuation) state.promptCount += 1
      const text = grokChunkText(update)
      if (state.title === null && text.trim() !== '') state.title = titleFrom(text)
    },
    save() { return { promptChunkIndex: chunks.save() } },
    load(saved) { if (isRecord(saved)) chunks.load(saved['promptChunkIndex']) },
  }
}

/**
 * Devin keeps title/cwd/model in the `sessions` row — handed in as `summary` —
 * and its generated title lands late, so it goes to `aiTitle` like grok's
 * `session_summary`. The prompt count comes from `is_user_input` on the
 * emitted `devin.msg` lines; every stream gets its own scanner, so a
 * subagent chain's delegated task (`is_user_input:true`, same as the main
 * stream's prompts) counts toward the child file, never the parent's.
 */
function devinMetaScanner(session: Record<string, unknown> | null): MetaScanner {
  const state = emptyMeta()
  // Kept render copies re-emit past a summary boundary — same message_id, not
  // a new prompt.
  const seenMids = new Set<string>()
  if (session !== null) {
    const title = asString(session['title'])?.trim()
    if (title !== undefined && title !== '') state.aiTitle = title
    state.cwd = asString(session['cwd']) ?? null
    state.model = asString(session['model']) ?? null
    noteTime(state, session['createdAt'])
  }
  return {
    state,
    push(line) {
      const record = parseDevinLine(line)
      if (record === null) return
      if (record.time !== null) noteTime(state, record.time)
      if (record.tag !== 'msg') return
      const mid = asString(record.msg['message_id'])
      if (mid !== undefined) {
        if (seenMids.has(mid)) return
        seenMids.add(mid)
      }
      if (devinMessageClass(record.msg)?.kind !== 'human') return
      state.promptCount += 1
      const content = record.msg['content']
      const text = typeof content === 'string'
        ? content
        : (asArray(content) ?? [])
          .flatMap(block => (isRecord(block) && block['type'] === 'text' ? [asString(block['text']) ?? ''] : []))
          .join('\n')
      if (state.title === null && text.trim() !== '') state.title = titleFrom(text)
    },
  }
}

/**
 * pi sessions are one JSONL of `{type, id, parentId, timestamp}` entries under
 * `<agentDir>/sessions/<encoded-cwd>/<ts>_<sessionId>.jsonl`: every human
 * `user` message counts as a prompt (pi's steering messages are persisted as
 * plain user messages), the first model id — `model_change.modelId`, else the
 * first assistant's `message.model` — is the session model, and a
 * `session_info.name` lands on `aiTitle` like Kimi/Grok's generated titles.
 * `parentSession` on a fork's header is lineage, not a child link.
 */
function piMetaScanner(): MetaScanner {
  const state = emptyMeta()
  return {
    state,
    push(line) {
      const entry = parsePiLine(line)
      if (entry === null) return
      noteTime(state, entry.record['timestamp'])
      switch (entry.type) {
        case 'session':
          state.cwd ??= asString(entry.record['cwd']) ?? null
          break
        case 'model_change':
          state.model ??= asString(entry.record['modelId']) ?? null
          break
        case 'session_info': {
          const name = asString(entry.record['name'])
          if (name !== undefined && name !== '') state.aiTitle = name
          break
        }
        case 'message': {
          if (!isPiHumanPrompt(entry)) break
          const message = isRecord(entry.record['message']) ? entry.record['message'] : undefined
          state.promptCount += 1
          const text = piContentText(message?.['content'])
          if (state.title === null && text.trim() !== '') state.title = titleFrom(text)
          break
        }
        default:
          break
      }
      if (entry.type === 'message') {
        const message = isRecord(entry.record['message']) ? entry.record['message'] : undefined
        if (message?.['role'] === 'assistant') state.model ??= asString(message['model']) ?? null
      }
    },
  }
}

/**
 * OpenCode keeps title/directory/model in the `session` row — handed in as
 * `summary` (or refreshed by the `opencode.session` sidecar) — and its title
 * lands late or starts as `New session - <iso>`, so it goes to `aiTitle`.
 * The source feeds the catalog scanner only `role: 'user'` header lines
 * (cheap listing facts without assistant bodies) and the materialized one
 * the full stream; the shared `opencodeUserClass` decides human vs injected
 * in both, so a prompt count never disagrees with the trajectory. The model
 * falls back to the first assistant header's `modelID`.
 */
function opencodeMetaScanner(session: Record<string, unknown> | null): MetaScanner {
  const state = emptyMeta()
  // The `opencode.session` sidecar carries `directory`/`model.id`; the summary
  // seed arrives pre-shaped (`cwd`, `model` as a plain string) like Devin's.
  const seed = (record: Record<string, unknown>): void => {
    const title = asString(record['title'])?.trim()
    if (title !== undefined && title !== '') state.aiTitle = title
    state.cwd = asString(record['directory']) ?? state.cwd
    const model = isRecord(record['model']) ? record['model'] : undefined
    state.model = asString(model?.['id']) ?? state.model
    noteTime(state, record['createdAt'])
    noteTime(state, record['updatedAt'])
  }
  if (session !== null) {
    const title = asString(session['title'])?.trim()
    if (title !== undefined && title !== '') state.aiTitle = title
    state.cwd = asString(session['cwd']) ?? null
    state.model = asString(session['model']) ?? null
    noteTime(state, session['createdAt'])
    noteTime(state, session['updatedAt'])
  }
  return {
    state,
    push(line) {
      const record = parseOpencodeLine(line)
      if (record === null) return
      if (record.time !== null) noteTime(state, record.time)
      switch (record.tag) {
        case 'session':
          seed(record.session)
          break
        case 'message': {
          const role = asString(record.msg['role'])
          if (role === 'assistant') {
            state.model ??= asString(record.msg['modelID']) ?? null
            break
          }
          if (role !== 'user') break
          if (opencodeUserClass(record.msg, record.parts).kind !== 'human') break
          state.promptCount += 1
          const text = opencodeTextOf(record.parts)
          if (state.title === null && text.trim() !== '') state.title = titleFrom(text)
          break
        }
        case 'finish':
          state.model ??= asString(record.msg['modelID']) ?? null
          break
        default:
          break
      }
    },
  }
}

/**
 * Dsh listing scanner: time, cwd, `session/title`, the first `request/header`
 * model, the human-prompt count through the shared `dshUserClass` classifier,
 * and the spawn map the Agent Network reads — a `tool/result` whose text is
 * exactly `started subagent <childSessionId>` binds a child, described by the
 * call's `description` argument. Times are epoch MILLISECONDS — noted
 * directly, never `parseTime`.
 */
function dshMetaScanner(): MetaScanner {
  const state = emptyMeta()
  /** `tool/call` id → subagent task caption, pending until its result lands. */
  const pendingCalls = new Map<string, string>()
  const noteDshTime = (value: number): void => {
    if (state.startedAt === null || value < state.startedAt) state.startedAt = value
    if (state.lastTime === null || value > state.lastTime) state.lastTime = value
  }
  return {
    state,
    // A call awaiting its result across a restart keeps its description.
    save() {
      return [...pendingCalls.entries()]
    },
    load(saved) {
      for (const pair of asArray(saved) ?? []) {
        if (!Array.isArray(pair) || pair.length !== 2) continue
        const callId = asString(pair[0])
        const description = asString(pair[1])
        if (callId === undefined || description === undefined) continue
        pendingCalls.set(callId, description)
      }
    },
    push(line) {
      const record = parseDshLine(line)
      if (record === null) return
      if (record.tag === 'header') {
        state.cwd ??= record.header.cwd ?? null
        if (record.header.createdAt !== null) noteDshTime(record.header.createdAt)
        return
      }
      if (record.tag === 'run') {
        noteDshTime(record.run.time0)
        return
      }
      const event = record.event
      noteDshTime(event.time)
      switch (event.type) {
        case 'session/title': {
          const title = asString(event.data['title'])
          if (title !== undefined && title !== '') state.aiTitle = title
          break
        }
        case 'request/header': {
          const header = isRecord(event.data['header']) ? event.data['header'] : undefined
          const config = isRecord(header?.['config']) ? header['config'] : undefined
          state.model ??= asString(config?.['model']) ?? null
          break
        }
        case 'user/message': {
          if (dshUserClass(event) !== 'human') break
          state.promptCount += 1
          const text = dshTextOf(event.data['content'])
          if (state.title === null && text.trim() !== '') state.title = titleFrom(text)
          break
        }
        case 'tool/call': {
          const callId = asString(event.data['callId'])
          if (callId === undefined) break
          // `arguments` is a JSON string on the wire; `description` is the
          // subagent task caption the spawn listing displays.
          const rawArgs = event.data['arguments']
          const args = isRecord(rawArgs)
            ? rawArgs
            : (asString(rawArgs) === undefined ? undefined : parseJsonLine(asString(rawArgs) ?? ''))
          const description = isRecord(args) ? asString(args['description']) : undefined
          if (description !== undefined) pendingCalls.set(callId, description)
          break
        }
        case 'tool/result': {
          const { callId, result } = dshToolResultOf(event.data)
          const childId = dshSubagentIdOf(dshTextOf(result?.['content']))
          if (childId === undefined) break
          const description = callId === undefined ? undefined : pendingCalls.get(callId)
          if (callId !== undefined) pendingCalls.delete(callId)
          state.agents.set(childId, {
            agentId: childId,
            ...(callId === undefined ? {} : { toolUseId: callId }),
            ...(description === undefined ? {} : { description }),
          })
          break
        }
        default:
          break
      }
    },
  }
}

/** Read identity facts from the first record of a transcript. */
export function readHead(kind: 'claude' | 'codex', firstLine: string): FileHead {
  const record = parseJsonLine(firstLine)
  if (!isRecord(record)) return { id: null, parentId: null }
  if (kind === 'codex') {
    const payload = record['payload']
    if (record['type'] === 'session_meta' && isRecord(payload)) {
      const base = isRecord(payload['history_base']) ? payload['history_base'] : null
      // Persisted as a stringified number (`"24"`) in some builds.
      const rawStart = payload['subagent_history_start_ordinal']
      const startOrdinal = asNumber(rawStart) ?? (typeof rawStart === 'string' ? asNumber(Number(rawStart)) : undefined)
      return {
        id: asString(payload['id']) ?? asString(payload['session_id']) ?? null,
        parentId: asString(payload['parent_thread_id']) ?? null,
        ...(startOrdinal === undefined ? {} : { historyStartOrdinal: startOrdinal }),
        historyBase: base === null ? null : {
          rolloutId: asString(base['thread_id']) ?? '',
          endOrdinalExclusive: asNumber(base['end_ordinal_exclusive']) ?? null,
          endByteOffset: asNumber(base['end_byte_offset']) ?? null,
        },
      }
    }
    return { id: null, parentId: null }
  }
  return { id: asString(record['sessionId']) ?? null, parentId: null }
}
