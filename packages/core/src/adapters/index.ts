import type { HarnessKind, SessionParser } from '../session.ts'
import { createClaudeParser } from './claude.ts'
import { createCodexParser } from './codex.ts'
import { createDevinParser } from './devin.ts'
import { createDshParser } from './dsh.ts'
import { createGrokParser } from './grok.ts'
import { createKimiParser } from './kimi.ts'
import { createOpencodeParser } from './opencode.ts'
import { createPiParser } from './pi.ts'

export { createClaudeParser, classifyInjectedUser } from './claude.ts'
export {
  createCodexParser, isCodexHumanPrompt, codexUserItems, codexHumanPromptText,
  codexReasoningText, codexCommandOf, codexCommandMatches,
  type CodexUserItem,
} from './codex.ts'
export {
  agentMentions, createKimiParser, kimiMessageClass, kimiTitleText,
  type KimiAgentMention, type KimiMessageClass,
} from './kimi.ts'
export {
  createGrokParser, grokMessageClass, grokContextWindow, isGrokTaskTool, parseGrokLine, GrokPromptChunks,
  GROK_CONTEXT_WINDOWS, GROK_DEFAULT_CONTEXT_WINDOW, GROK_SIDECAR_METHOD,
  type GrokMessageClass, type GrokRecord, type GrokSidecar,
} from './grok.ts'
export {
  createDevinParser, devinMessageClass, parseDevinLine,
  type DevinMessageClass, type DevinRecord,
} from './devin.ts'
export {
  createPiParser, isPiHumanPrompt, parsePiLine, piContentText, PiPromptState,
  PiSessionTree, resolvePiContextState,
  type PiContextState, type PiEntry,
} from './pi.ts'
export {
  createOpencodeParser, parseOpencodeLine, opencodeUserClass, opencodeUsage,
  opencodeTextOf, opencodeChildTitle,
  type OpencodeRecord, type OpencodeUserClass,
} from './opencode.ts'
export { createDshParser } from './dsh.ts'
export {
  parseDshLine, expandDshStreamRun, dshReplaceRange, dshUserClass,
  dshTextOf, dshToolResultOf, dshUsageOf, dshFirstTokenTime, dshSubagentIdOf,
  type DshEvent, type DshHeader, type DshRecord, type DshStreamRun, type DshUserClass,
} from './dsh-protocol.ts'
export * from './shared.ts'

/** Create the incremental parser for one harness kind. */
export function createSessionParser(kind: HarnessKind): SessionParser {
  switch (kind) {
    case 'claude': return createClaudeParser()
    case 'codex': return createCodexParser()
    case 'kimi': return createKimiParser()
    case 'grok': return createGrokParser()
    case 'devin': return createDevinParser()
    case 'pi': return createPiParser()
    case 'opencode': return createOpencodeParser()
    case 'dsh': return createDshParser()
  }
}
