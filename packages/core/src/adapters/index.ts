import type { HarnessKind, SessionParser } from '../session.ts'
import { createClaudeParser } from './claude.ts'
import { createCodexParser } from './codex.ts'

export { createClaudeParser, classifyInjectedUser } from './claude.ts'
export { createCodexParser, isCodexHumanPrompt } from './codex.ts'
export * from './shared.ts'

/** Create the incremental parser for one harness kind. */
export function createSessionParser(kind: HarnessKind): SessionParser {
  switch (kind) {
    case 'claude': return createClaudeParser()
    case 'codex': return createCodexParser()
  }
}
