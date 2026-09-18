/** Kimi Code's filesystem layout: `agents/<id>/wire.jsonl` and `state.json`. */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { asString, isRecord } from '@harness-trajectory/core'
import type { Classified } from './classified.ts'

// <workspace>/session_<id>/agents/<agentId>/wire.jsonl — identity is entirely path-derived.
export function classifyKimiPath(parts: string[], name: string): Classified | null {
  if (parts.length !== 5 || parts[2] !== 'agents' || name !== 'wire') return null
  const sessionId = parts[1]
  const agentId = parts[3]
  if (sessionId === undefined || sessionId === '' || agentId === undefined || agentId === '') return null
  return agentId === 'main'
    ? { id: sessionId, role: 'main' }
    : { id: agentId, role: 'child', parentId: sessionId }
}

/**
 * Kimi's session title sidecar: `<session>/state.json`, two levels above the
 * `agents/main/wire.jsonl` transcript. Best effort — unreadable means no title.
 */
export async function readKimiTitle(transcriptPath: string): Promise<string | undefined> {
  const sessionDir = dirname(dirname(dirname(transcriptPath)))
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const title = asString(parsed['title'])
  return title === undefined || title.trim() === '' ? undefined : title
}

// kimi: the main file is <session>/agents/main/wire.jsonl, siblings are <session>/agents/<agentId>/wire.jsonl
export function kimiChildDir(mainPath: string): string {
  return dirname(dirname(mainPath))
}
