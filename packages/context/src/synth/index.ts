import type { HarnessKind, SessionFileRef } from '@harness-trajectory/core'
import { createClaudeSynthesizer } from './claude.ts'
import { createCodexSynthesizer } from './codex.ts'
import { createDevinSynthesizer } from './devin.ts'
import { createDshSynthesizer } from './dsh.ts'
import { createGrokSynthesizer } from './grok.ts'
import { createKimiSynthesizer } from './kimi.ts'
import { createCursorSynthesizer } from './cursor.ts'
import { createOpencodeSynthesizer } from './opencode.ts'
import { createPiSynthesizer } from './pi.ts'
import type { EventSynthesizer } from './types.ts'

export * from './types.ts'
export {
  createClaudeSynthesizer,
  createCodexSynthesizer,
  createDevinSynthesizer,
  createDshSynthesizer,
  createGrokSynthesizer,
  createKimiSynthesizer,
  createCursorSynthesizer,
  createOpencodeSynthesizer,
  createPiSynthesizer,
}

export function createSynthesizer(kind: HarnessKind, file: SessionFileRef): EventSynthesizer {
  switch (kind) {
    case 'claude': return createClaudeSynthesizer(file)
    case 'codex': return createCodexSynthesizer(file)
    case 'kimi': return createKimiSynthesizer(file)
    case 'grok': return createGrokSynthesizer(file)
    case 'devin': return createDevinSynthesizer(file)
    case 'pi': return createPiSynthesizer(file)
    case 'opencode': return createOpencodeSynthesizer(file)
    case 'dsh': return createDshSynthesizer(file)
    case 'cursor': return createCursorSynthesizer(file)
  }
}
