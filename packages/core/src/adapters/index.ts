import type { HarnessKind, SessionParser } from '../session.ts'
import { createClaudeParser } from './claude.ts'
import { createCodexParser } from './codex.ts'
import { createDevinParser } from './devin.ts'
import { createGrokParser } from './grok.ts'
import { createKimiParser } from './kimi.ts'

export { createClaudeParser, classifyInjectedUser } from './claude.ts'
export { createCodexParser, isCodexHumanPrompt } from './codex.ts'
export {
  agentMentions, createKimiParser, kimiMessageClass, kimiTitleText,
  type KimiAgentMention, type KimiMessageClass,
} from './kimi.ts'
export {
  createGrokParser, grokMessageClass, grokContextWindow, isGrokTaskTool, parseGrokLine,
  GROK_CONTEXT_WINDOWS, GROK_DEFAULT_CONTEXT_WINDOW, GROK_SIDECAR_METHOD,
  type GrokMessageClass, type GrokRecord, type GrokSidecar,
} from './grok.ts'
export {
  createDevinParser, devinMessageClass, parseDevinLine,
  type DevinMessageClass, type DevinRecord,
} from './devin.ts'
export * from './shared.ts'

/** Create the incremental parser for one harness kind. */
export function createSessionParser(kind: HarnessKind): SessionParser {
  switch (kind) {
    case 'claude': return createClaudeParser()
    case 'codex': return createCodexParser()
    case 'kimi': return createKimiParser()
    case 'grok': return createGrokParser()
    case 'devin': return createDevinParser()
  }
}
