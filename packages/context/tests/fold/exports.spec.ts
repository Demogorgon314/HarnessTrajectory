// The package barrel (src/index.ts) re-exports the shared contract, the
// synth registry and the whole fold half with `export *`. An ambiguous star
// export is silently DROPPED by the module system rather than reported, so
// this spec pins that every public fold name actually reaches the barrel.

import { describe, expect, it } from 'vitest'
import * as api from '../../src/index.ts'
import type {
  ContentBlock,
  ContextSession as ContextSessionType,
  FileOpInput,
  FoldBounds,
  HeadersState,
  TimelineEvent,
  TimelineState,
} from '../../src/index.ts'

// Type-only names cannot be probed at runtime; referencing them here fails
// the typecheck if the barrel ever stops re-exporting one.
type _Pinned = [ContentBlock, ContextSessionType, FileOpInput, FoldBounds, HeadersState, TimelineEvent, TimelineState]

describe('@harness-trajectory/context barrel', () => {
  it('re-exports every public fold, shared and synth name', () => {
    for (const name of [
      'applyTimeline', 'createTimelineState', 'buildTimelineHead', 'buildTimelineDetail', 'buildTimelineView',
      'trimToLastTurns', 'ContextSession', 'resolveBounds', 'DEFAULT_BOUNDS', 'HEADERS_MAX',
      'applyHeaders', 'buildHeadersView', 'createHeadersState', 'estimateMessage', 'estimateToolsTotal',
      'estimateToolSchema', 'imageCountOf', 'firstText', 'toolCallNames', 'injectionSourceName', 'isInjection',
      'replaceRangeOf', 'isTokenChunk', 'decodeKindOfBlock', 'decodeSpansOfStream', 'firstTokenTimeOfStream',
      'mcpServerOf', 'mcpSourceOf', 'pinnedSourceOf', 'toolSourceOf', 'FIRST_PARTY_SOURCES', 'MCP_PREFIX',
      'opsOfCall', 'parseCallArgs', 'kindOfTool', 'kindOfCall', 'pathOfArgs', 'linesOf',
      'estimateSystemTokens', 'estimateSystemContent', 'estimateImageTokens',
      'modelsDevProviderOf', 'isDeepSeekProvider', 'UNKNOWN_TOOL_SOURCE',
      'createSynthesizer', 'childKeyOf',
    ]) {
      expect(name in api, name).toBe(true)
    }
  })
})
