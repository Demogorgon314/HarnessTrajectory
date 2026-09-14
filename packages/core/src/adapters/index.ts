import type { HarnessKind, SessionParser } from '../session.ts'
import { createClaudeParser } from './claude.ts'
import { createCodexParser } from './codex.ts'
import { createKimiParser } from './kimi.ts'

export { createClaudeParser, classifyInjectedUser } from './claude.ts'
export { createCodexParser, isCodexHumanPrompt } from './codex.ts'
export { createKimiParser, kimiMessageClass, type KimiMessageClass } from './kimi.ts'
export * from './shared.ts'

/** Create the incremental parser for one harness kind. */
export function createSessionParser(kind: HarnessKind): SessionParser {
  switch (kind) {
    case 'claude': return createClaudeParser()
    case 'codex': return createCodexParser()
    case 'kimi': return createKimiParser()
  }
}
