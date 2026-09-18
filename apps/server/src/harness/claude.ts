/** Claude Code's filesystem layout: transcripts and `agent-*.meta.json` sidecars. */

import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { asString, isRecord, type AgentFileMeta } from '@harness-trajectory/core'
import type { Classified } from './classified.ts'

// <slug>/<uuid>.jsonl, <slug>/agent-<id>.jsonl, <slug>/<uuid>/subagents/agent-<id>.jsonl
export function classifyClaudePath(parts: string[], name: string): Classified | null {
  if (parts.length === 2) {
    return name.startsWith('agent-') ? { id: name, role: 'child' } : { id: name, role: 'main' }
  }
  const owner = parts[1]
  if (parts.length === 4 && parts[2] === 'subagents' && owner !== undefined) {
    return { id: `${owner}/${name}`, role: 'child', parentId: owner }
  }
  if (parts.length === 3 && owner !== undefined && name.startsWith('agent-')) {
    return { id: `${owner}/${name}`, role: 'child', parentId: owner }
  }
  return null
}

/** Claude Code writes `agent-<id>.meta.json` beside each subagent transcript. */
export async function readAgentMeta(transcriptPath: string): Promise<AgentFileMeta | undefined> {
  const name = basename(transcriptPath, '.jsonl')
  const agentId = name.startsWith('agent-') ? name.slice('agent-'.length) : name
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(`${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`, 'utf8'))
  } catch {
    return { agentId }
  }
  if (!isRecord(parsed)) return { agentId }
  const toolUseId = asString(parsed['toolUseId'])
  const description = asString(parsed['description'])
  const agentType = asString(parsed['agentType'])
  const model = asString(parsed['model'])
  return {
    agentId,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(description === undefined ? {} : { description }),
    ...(agentType === undefined ? {} : { agentType }),
    ...(model === undefined ? {} : { model }),
    ...(parsed['isFork'] === true ? { isFork: true } : {}),
  }
}

// claude: <slug>/<sessionId>/subagents/agent-<id>.jsonl
export function claudeChildDir(sessionId: string, mainPath: string): string {
  return join(dirname(mainPath), sessionId, 'subagents')
}
