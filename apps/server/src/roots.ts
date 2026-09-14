/** Where each harness keeps its transcripts on the local machine. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HarnessKind } from '@harness-trajectory/core'

export interface HarnessRoot {
  kind: HarnessKind
  /** Directory scanned recursively for transcript files. */
  dir: string
}

/**
 * Resolve transcript roots, honouring the same overrides the harnesses use
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CODE_HOME`) plus explicit
 * `HARNESS_TRAJECTORY_*` overrides.
 *
 * Defaults: `~/.claude/projects`, `~/.codex/sessions`, `~/.kimi-code/sessions`.
 */
export function defaultRoots(env: NodeJS.ProcessEnv = process.env): HarnessRoot[] {
  const home = homedir()
  const claudeConfig = env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude')
  const codexHome = env['CODEX_HOME'] ?? join(home, '.codex')
  const kimiHome = env['KIMI_CODE_HOME'] ?? join(home, '.kimi-code')
  return [
    { kind: 'claude', dir: resolve(env['HARNESS_TRAJECTORY_CLAUDE_ROOT'] ?? join(claudeConfig, 'projects')) },
    { kind: 'codex', dir: resolve(env['HARNESS_TRAJECTORY_CODEX_ROOT'] ?? join(codexHome, 'sessions')) },
    { kind: 'kimi', dir: resolve(env['HARNESS_TRAJECTORY_KIMI_ROOT'] ?? join(kimiHome, 'sessions')) },
  ]
}
