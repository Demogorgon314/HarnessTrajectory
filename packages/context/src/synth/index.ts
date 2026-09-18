import type { HarnessKind, SessionFileRef } from '@harness-trajectory/core'
import { createClaudeSynthesizer } from './claude.ts'
import { createCodexSynthesizer } from './codex.ts'
import { createDevinSynthesizer } from './devin.ts'
import { createGrokSynthesizer } from './grok.ts'
import { createKimiSynthesizer } from './kimi.ts'
import { createOpencodeSynthesizer } from './opencode.ts'
import { createPiSynthesizer } from './pi.ts'
import type { EventSynthesizer } from './types.ts'

export * from './types.ts'
export {
  createClaudeSynthesizer,
  createCodexSynthesizer,
  createDevinSynthesizer,
  createGrokSynthesizer,
  createKimiSynthesizer,
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
  }
}
