/**
 * Vendored from dsh-context `src/shared/providers.ts` (Apache-2.0, see ../../NOTICE).
 *
 * The provider-id seam between request envelopes and the models.dev registry:
 * the client's cost card resolves price-book branches through it, and
 * `fold/fold.ts` uses the DeepSeek resolution to split the session-cost totals
 * into peak/off-peak periods. Only the renames live here — an id absent from
 * the table passes through verbatim, so `anthropic` and `openai` (the two
 * providers this viewer sees) resolve to themselves and always book `peak`.
 */

const MODELS_DEV_PROVIDER_IDS: Record<string, string> = {
  'deepseek-official': 'deepseek',
  'kimi-coding': 'moonshotai',
  'minimax-cn': 'minimax',
  'zai-coding-cn': 'zhipuai',
}

/** The models.dev provider id that prices a dsh provider (identity for unmapped ids). */
export function modelsDevProviderOf(dshProviderId: string): string {
  return MODELS_DEV_PROVIDER_IDS[dshProviderId] ?? dshProviderId
}

/** Whether a dsh provider prices through DeepSeek's period-based list (peak / half-price off-peak). */
export function isDeepSeekProvider(dshProviderId: string): boolean {
  return modelsDevProviderOf(dshProviderId) === 'deepseek'
}
