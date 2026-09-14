/**
 * Vendored from dsh-context `src/host/pricing.ts` (Apache-2.0, see ../../NOTICE).
 *
 * Token pricing — the same fixed-density heuristic as the dsh token-meter
 * (`dsh-token-meter/estimate.ts`): ~4 chars ≈ 1 token, +4 per content block,
 * +4 role framing. Pure functions over message payloads.
 *
 * Two deliberate refinements over the meter:
 *
 * 1. `image` blocks. The meter prices them through its generic JSON branch
 *    (~40 tokens for the durable ref), while DeepSeek's vision model actually
 *    bills 117-384 tokens per image by pixel dimensions
 *    (https://api-docs.deepseek.com/zh-cn/guides/vision/). Image blocks
 *    therefore price through the official docs calculator port
 *    (shared/imageTokens.ts), falling back to the meter's JSON price when the
 *    attachment's dimensions are unknown.
 * 2. PORT ADDITION — `block.tokens`. A synthesizer that knows its harness's
 *    own price for a block (Claude's `ceil(w*h/750)` image estimate, say)
 *    states it there and the estimator uses it verbatim for the block's
 *    CONTENT, still adding the per-block overhead — the same treatment the
 *    image branch gives the vision calculator's result.
 *
 * The block/source vocabularies live in `./event.ts` (the synthesizer→fold
 * contract); this module only prices them.
 */

import { estimateImageTokens } from '../shared/imageTokens.ts'
import type { ContentBlock, MessageSource } from './event.ts'

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

export function estimateToolsTotal(tools: unknown[]): number {
  return tools.length > 0
    ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    : 0
}

/** The `ContentBlock` walkers take `unknown`: block arrays ride the untrusted
 * transcript, so their element shapes (null and primitives included) are
 * re-proved here, not trusted from the declared message types. */

/**
 * The synthesizer-stated content price of one block, or null when it states
 * none. Negative, NaN, and non-numeric values are ignored (an untrusted
 * figure must never drive a token count below zero).
 */
function statedTokensOf(block: ContentBlock): number | null {
  const stated: unknown = block.tokens
  if (typeof stated !== 'number' || !Number.isFinite(stated) || stated < 0) return null
  return Math.round(stated)
}

function estimateBlocks(blocks: unknown): number {
  let tokens = 0
  if (!Array.isArray(blocks)) return 0
  for (const item of blocks) {
    // A null or primitive element prices as bare overhead instead of
    // throwing the whole fold.
    if (item === null || typeof item !== 'object') {
      tokens += BLOCK_OVERHEAD
      continue
    }
    const block = item as ContentBlock
    // PORT ADDITION: a stated content price short-circuits the heuristic for
    // every block type (see the module header).
    const stated = statedTokensOf(block)
    if (stated !== null) {
      tokens += stated + BLOCK_OVERHEAD
      continue
    }
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil((block.text || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil((block.name || '').length / CHARS_PER_TOKEN)
          + Math.ceil((block.arguments || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateBlocks(block.content) + BLOCK_OVERHEAD
        break
      case 'image': {
        const ref = block.attachment
        const priced = ref !== null && ref !== undefined && typeof ref === 'object'
          && typeof ref.width === 'number' && typeof ref.height === 'number'
          ? estimateImageTokens(ref.width, ref.height)
          : null
        tokens += (priced ?? Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)) + BLOCK_OVERHEAD
        break
      }
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/**
 * Price one surface message exactly like the token-meter estimate:
 * an empty-content assistant/message projects to NO message (it only hosts
 * usage), so it prices 0; every other message pays content + role framing.
 */
export function estimateMessage(message: { content?: ContentBlock[] } | undefined | null, emptyIsZero = false): number {
  if (emptyIsZero && (message === null || message === undefined
    || !Array.isArray(message.content) || message.content.length === 0)) {
    return 0
  }
  return estimateBlocks(message?.content) + ROLE_OVERHEAD
}

/** Per-tool price for the top-tools display (the total uses the whole-array price). */
export function estimateToolSchema(tool: unknown): number {
  return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
  * Count image blocks in a message payload, recursing into nested content (tool-result blocks carry their inner blocks) — seeds each node's
  * `imgs`, which the stats board's image cell sums over the LIVE surface (compacted/pruned messages stop counting).
 */
export function imageCountOf(blocks: unknown): number {
  let count = 0
  if (!Array.isArray(blocks)) return 0
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'image') count++
    else if (Array.isArray(block.content)) count += imageCountOf(block.content)
  }
  return count
}

export function firstText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const b = item as ContentBlock
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  }
  return ''
}

export function toolCallNames(blocks: unknown): string[] {
  const names: string[] = []
  if (!Array.isArray(blocks)) return names
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const b = item as ContentBlock
    if (b.type === 'tool-call' && typeof b.name === 'string') names.push(b.name)
  }
  return names
}

/**
 * Producer label for an injection event, mirroring the dsh transcript's
 * context provenance: workspace instructions name the files they were
 * reconciled from, a plugin source its plugin id, and any other producer its
 * own kind. Returns '' when the source is missing or carries no readable
 * identity at all.
 */
export function injectionSourceName(source: MessageSource | null | undefined): string {
  if (source?.kind === 'agent-instructions' && Array.isArray(source.changes)) {
    const paths: string[] = []
    for (const change of source.changes) {
      const path = change?.path
      if (typeof path === 'string' && path !== '' && !paths.includes(path)) paths.push(path)
    }
    if (paths.length > 0) return paths.join(', ')
  }
  const plugin = source?.plugin
  if (typeof plugin === 'string' && plugin !== '') return plugin
  const kind = source?.kind
  return typeof kind === 'string' && kind !== '' ? kind : ''
}

export function isInjection(source: MessageSource | null | undefined): source is MessageSource {
  // A user/message is injected context when its source kind is anything but
  // 'user' — plugin context, skill invocations/catalogs, command expansions,
  // attachments, and any future producer kind all land here. The form check
  // stays as a fallback for a foreign source that declares a form without a
  // readable kind. `null` stays in the parameter type: a foreign message may
  // carry it, and the fold must not crash on it.
  return source !== null && source !== undefined
    && ((typeof source.kind === 'string' && source.kind !== '' && source.kind !== 'user')
      || typeof source.form === 'string')
}
