/** Small JSON/directory sidecar readers shared by the per-harness modules. */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '@harness-trajectory/core'

/** Parse a small JSON sidecar file; unreadable or non-object means no facts. */
export async function readJsonRecord(file: string): Promise<Record<string, unknown> | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

/** Immediate subdirectories of a directory; a missing directory has none. */
export async function subdirectories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => join(dir, entry.name))
  } catch {
    return []
  }
}
