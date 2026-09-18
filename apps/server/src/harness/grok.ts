/**
 * Grok Build's filesystem layout: `updates.jsonl` transcripts, `summary.json`
 * and sibling sidecars, `subagents/<id>/meta.json` child bindings, and the
 * child → parent binding cache (`GrokBindings`).
 */

import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  asArray, asString, GROK_SIDECAR_METHOD, type AgentFileMeta,
} from '@harness-trajectory/core'
import type { Classified } from './classified.ts'
import { readJsonRecord, subdirectories } from './sidecar.ts'

/**
 * <encoded-cwd>/<session-id>/updates.jsonl is the only transcript grok
 * writes (GROK-FORMAT §A.2, §C.0): `chat_history.jsonl` is a derived cache,
 * `events.jsonl` is telemetry, `rewind_points.jsonl` a side store, and the
 * cwd-level `prompt_history.jsonl` sits one level up. Session id is the
 * directory name (a UUIDv7); the role is provisional, because a child
 * session is a top-level directory too and only `summary.json` tells them
 * apart (GROK-FORMAT §D.2, §D.5 — see `SessionIndex.register`).
 */
export function classifyGrokPath(parts: string[], name: string): Classified | null {
  if (parts.length !== 3 || name !== 'updates') return null
  const sessionId = parts[1]
  if (sessionId === undefined || sessionId === '') return null
  return { id: sessionId, role: 'main' }
}

/**
 * Whether a grok `summary.json` describes a subagent child rather than a
 * session of its own (GROK-FORMAT §D.5): `hidden` is the explicit override and
 * wins when present, else a `session_kind` **starting with** `subagent`
 * (`subagent`, `subagent_fork`, `subagent_resume`).
 */
export function isGrokChildSummary(summary: Record<string, unknown>): boolean {
  const hidden = summary['hidden']
  if (typeof hidden === 'boolean') return hidden
  return asString(summary['session_kind'])?.startsWith('subagent') === true
}

/** What `summary.json` (plus the binding search) says about one grok session directory. */
export interface GrokProbe {
  /** The parsed `summary.json`, or `null` when grok has not written it yet. */
  summary: Record<string, unknown> | null
  /** Whether the summary marks this session as a subagent run (GROK-FORMAT §D.5). */
  child: boolean
  /** The parent it was bound to; unset for a main session and for an unbindable child. */
  parentId?: string
  agent?: AgentFileMeta
}

/** A parent's durable record of one subagent run (GROK-FORMAT §D.3). */
export interface GrokChildBinding {
  /** Child session id: the name of the top-level directory its transcript lives in. */
  childId: string
  parentId: string
  agent: AgentFileMeta
  /** The child's own working directory, when the meta recorded one. */
  childCwd: string | null
}

/**
 * Read `<session>/subagents/<childId>/meta.json` for every subagent a grok
 * session spawned. This is the binding authority: a child transcript is a
 * top-level session directory that names no parent of its own, and
 * `summary.parent_session_id` is unreliable (GROK-FORMAT §D.3, §D.5).
 */
export async function readGrokSubagentMetas(subagentsDir: string): Promise<GrokChildBinding[]> {
  const bindings: GrokChildBinding[] = []
  for (const dir of await subdirectories(subagentsDir)) {
    const meta = await readJsonRecord(join(dir, 'meta.json'))
    if (meta === null) continue
    const childId = asString(meta['child_session_id']) ?? asString(meta['subagent_id']) ?? basename(dir)
    const parentId = asString(meta['parent_session_id'])
    if (childId === '' || parentId === undefined || parentId === '') continue
    const description = asString(meta['description'])
    const agentType = asString(meta['subagent_type'])
    const model = asString(meta['effective_model_id'])
    bindings.push({
      childId,
      parentId,
      // grok records no spawning tool-call id anywhere (GROK-FORMAT §D.4), so
      // `toolUseId` stays unset and the adapter binds by prompt id and order.
      agent: {
        agentId: childId,
        ...(description === undefined ? {} : { description }),
        ...(agentType === undefined ? {} : { agentType }),
        ...(model === undefined ? {} : { model }),
      },
      childCwd: asString(meta['child_cwd']) ?? null,
    })
  }
  return bindings
}

/** Bytes that pass through grok's cwd encoding unescaped: the RFC 3986 unreserved set. */
const GROK_UNRESERVED = /[A-Za-z0-9\-_.~]/

/**
 * Grok's encoded-cwd directory name (GROK-FORMAT §A.3): RFC 3986
 * unreserved-set percent-encoding with **upper-case** hex — not
 * `encodeURIComponent`, which leaves `!'()*` alone. A cwd whose encoding would
 * exceed 255 bytes is stored under an irreversible `{slug}-{blake3}` name
 * instead, which cannot be recomputed here; `undefined` says so.
 */
export function encodeGrokCwd(cwd: string): string | undefined {
  let encoded = ''
  for (const byte of Buffer.from(cwd, 'utf8')) {
    const char = String.fromCharCode(byte)
    encoded += GROK_UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return encoded.length > 255 ? undefined : encoded
}

/**
 * Where a grok child's `updates.jsonl` can be: under its own cwd's group when
 * the meta recorded one, else beside the parent (GROK-FORMAT §D.2, mirroring
 * grok's own `ReplayPathHint`).
 */
export function grokChildPaths(rootDir: string, parentPath: string, binding: GrokChildBinding): string[] {
  const paths: string[] = []
  const encoded = binding.childCwd === null ? undefined : encodeGrokCwd(binding.childCwd)
  if (encoded !== undefined) paths.push(join(rootDir, encoded, binding.childId, 'updates.jsonl'))
  const sibling = join(dirname(dirname(parentPath)), binding.childId, 'updates.jsonl')
  if (!paths.includes(sibling)) paths.push(sibling)
  return paths
}

/**
 * Grok's own generated session title: `summary.json`'s `session_summary`
 * (GROK-FORMAT §B.1), verbatim like Kimi's `state.json` title — the meta
 * scanner reads the same field the same way.
 */
export function grokSummaryTitle(summary: Record<string, unknown> | null): string | null {
  const title = summary === null ? undefined : asString(summary['session_summary'])?.trim()
  return title === undefined || title === '' ? null : title
}

/**
 * The synthetic first line of a grok replay (GROK-DESIGN §3): the session facts
 * (`summary.json`), the verbatim system prompt (`system_prompt.txt`, written
 * for every session) and the tool schemas (`tool_definitions.json`, newest
 * builds only) that grok keeps outside `updates.jsonl` (GROK-FORMAT §E.1,
 * §E.3). `undefined` when the directory holds none of them — a transcript folds
 * without a sidecar, it just has no system prompt and no schemas.
 */
export async function readGrokSidecar(transcriptPath: string, sessionId: string): Promise<GrokSidecarLine | undefined> {
  const dir = dirname(transcriptPath)
  return buildGrokSidecar(dir, sessionId, await readJsonRecord(join(dir, 'summary.json')))
}

/** A rendered sidecar line and the facts it carries, so an unchanged one is not re-sent. */
export interface GrokSidecarLine {
  line: string
  key: string
}

/**
 * `summary.json` fields grok patches on every appended line: write bookkeeping,
 * not session facts (GROK-FORMAT §B.1). They ride along in the sidecar, so they
 * are excluded from the key that decides whether a sidecar is news.
 */
export const GROK_VOLATILE_SUMMARY_KEYS: ReadonlySet<string> = new Set([
  'updated_at', 'num_messages', 'num_chat_messages', 'next_trace_turn',
])

/** The sidecar line for a session directory whose `summary.json` the caller already read. */
export async function buildGrokSidecar(
  dir: string,
  sessionId: string,
  summary: Record<string, unknown> | null,
): Promise<GrokSidecarLine | undefined> {
  let systemPrompt: string | null
  try {
    systemPrompt = await readFile(join(dir, 'system_prompt.txt'), 'utf8')
  } catch {
    systemPrompt = null
  }
  let definitions: unknown
  try {
    definitions = JSON.parse(await readFile(join(dir, 'tool_definitions.json'), 'utf8'))
  } catch {
    definitions = undefined
  }
  const toolDefinitions = asArray(definitions) ?? null
  if (summary === null && systemPrompt === null && toolDefinitions === null) return undefined
  // `created_at` is RFC 3339; the envelope carries epoch SECONDS (GROK-FORMAT §C.1).
  const created = Date.parse(asString(summary?.['created_at']) ?? '')
  const stable = summary === null
    ? null
    : Object.fromEntries(Object.entries(summary).filter(([key]) => !GROK_VOLATILE_SUMMARY_KEYS.has(key)))
  return {
    line: JSON.stringify({
      timestamp: Number.isNaN(created) ? 0 : Math.floor(created / 1000),
      method: GROK_SIDECAR_METHOD,
      params: { sessionId, summary, systemPrompt, toolDefinitions },
    }),
    key: JSON.stringify({ sessionId, stable, systemPrompt, toolDefinitions }),
  }
}

/**
 * grok: only the child's METADATA nests under the parent, as
 * <session>/subagents/<childId>/meta.json; the transcript itself is a
 * top-level session directory, possibly under another encoded cwd
 * (GROK-FORMAT §D.2, §D.3). `pollGrokChildren` resolves each meta to it.
 */
export function grokChildDir(mainPath: string): string {
  return join(dirname(mainPath), 'subagents')
}

/**
 * Grok child → parent bindings read from `<parent>/subagents/<childId>/meta.json`.
 * A grok child is a top-level session directory that names no parent of its
 * own, so this map is the only way a child registered before (or far away
 * from) its parent finds it (GROK-FORMAT §D.2, §D.3).
 */
export class GrokBindings {
  private readonly children = new Map<string, GrokChildBinding>()
  /** Bumped whenever a new grok binding is learned; see `parentOf`. */
  private generation = 0
  /** Grok root → the generation its whole-root sweep ran at (negative cache). */
  private readonly swept = new Map<string, number>()

  /**
   * Decide whether a grok session directory is a subagent child and bind it to
   * its parent (GROK-DESIGN §2).
   *
   * The marker is `summary.json`: `hidden === true`, else a `session_kind`
   * starting with `subagent` — a prefix match, since the flavors are
   * `subagent`, `subagent_fork` and `subagent_resume` (GROK-FORMAT §D.5).
   * The parent is named by `<parentDir>/subagents/<childId>/meta.json`, which
   * carries the run's facts too; `summary.parent_session_id` is a fallback only
   * for a `subagent_fork`, because on a `subagent_resume` it points at the
   * previous CHILD rather than at the real parent. A child that binds to
   * neither registers as a main session — an orphan is better than an
   * invisible one.
   *
   * The parsed `summary.json` comes back with the verdict: it is also the
   * listing metadata (`createMetaScanner`), so the file is read exactly once
   * per registration.
   */
  async probe(rootDir: string, path: string, id: string): Promise<GrokProbe> {
    const sessionDir = dirname(path)
    const summary = await readJsonRecord(join(sessionDir, 'summary.json'))
    if (summary === null || !isGrokChildSummary(summary)) {
      // A main session (or one whose summary is not written yet): publish its
      // bindings so its children resolve from the cache however far away (and
      // however much later) they are registered.
      await this.cacheBindings(sessionDir)
      return { summary, child: false }
    }
    const binding = await this.parentOf(rootDir, sessionDir, id)
    if (binding !== undefined) {
      return { summary, child: true, parentId: binding.parentId, agent: binding.agent }
    }
    if (asString(summary['session_kind']) === 'subagent_fork') {
      const parentId = asString(summary['parent_session_id'])
      if (parentId !== undefined && parentId !== '' && parentId !== id) {
        return { summary, child: true, parentId, agent: { agentId: id } }
      }
    }
    return { summary, child: true }
  }

  /**
   * Cached binding for a grok child, widening the search until one is found.
   *
   * The sibling group (the same encoded cwd) is always re-read: it is one
   * `readdir` per session directory there and it is where a child normally
   * lands. The whole-root fallback — for a child that got its own worktree cwd
   * (GROK-FORMAT §D.2) — is swept at most once per generation, so a child that
   * binds to nothing does not walk every session directory on every
   * registration. Learning any new binding starts a new generation, and a new
   * session directory can only contribute bindings through
   * `cacheBindings`, which is exactly what bumps it.
   */
  async parentOf(rootDir: string, sessionDir: string, childId: string): Promise<GrokChildBinding | undefined> {
    const cached = this.children.get(childId)
    if (cached !== undefined) return cached
    // Siblings under the same encoded cwd first: the common case.
    await this.cacheGroup(dirname(sessionDir))
    const sibling = this.children.get(childId)
    if (sibling !== undefined) return sibling
    if (this.swept.get(rootDir) === this.generation) return undefined
    // A worktree or explicit cwd puts the child under a different group
    // entirely (GROK-FORMAT §D.2), so fall back to the whole root.
    for (const group of await subdirectories(rootDir)) await this.cacheGroup(group)
    this.swept.set(rootDir, this.generation)
    return this.children.get(childId)
  }

  private async cacheGroup(groupDir: string): Promise<void> {
    for (const sessionDir of await subdirectories(groupDir)) await this.cacheBindings(sessionDir)
  }

  private async cacheBindings(sessionDir: string): Promise<void> {
    for (const binding of await readGrokSubagentMetas(join(sessionDir, 'subagents'))) {
      this.note(binding)
    }
  }

  /** Remember one child → parent binding; a new one invalidates the swept generation. */
  note(binding: GrokChildBinding): void {
    if (this.children.has(binding.childId)) return
    this.children.set(binding.childId, binding)
    this.generation += 1
  }
}
