import type { HarnessKind, SessionFileRef } from '@harness-trajectory/core'
import { createClaudeSynthesizer } from './claude.ts'
import { createCodexSynthesizer } from './codex.ts'
import type { EventSynthesizer } from './types.ts'

export * from './types.ts'
export { createClaudeSynthesizer, createCodexSynthesizer }

export function createSynthesizer(kind: HarnessKind, file: SessionFileRef): EventSynthesizer {
  switch (kind) {
    case 'claude': return createClaudeSynthesizer(file)
    case 'codex': return createCodexSynthesizer(file)
  }
}
