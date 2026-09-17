/**
 * Vendored from dsh-context `src/shared/providers.ts` (Apache-2.0, see ../../NOTICE).
 *
 * The provider-id seam between request envelopes and the models.dev registry:
 * the client's cost card resolves price-book branches through it, and
 * `fold/fold.ts` uses the DeepSeek resolution to split the session-cost totals
 * into peak/off-peak periods. Only the renames live here — an id absent from
 * the table passes through verbatim, so `anthropic` and `openai` (the two
 * providers this viewer sees) resolve to themselves and always book `peak`.
 *
 * PORT NOTE — Kimi needs no entry: the Kimi synthesizer emits models.dev
 * provider ids directly. `kimi-for-coding` (the `kimi-code/*` subscription
 * aliases, whose rates are all $0) and `moonshotai` (the public list) are both
 * real models.dev ids, so they pass through unchanged and book `peak`. The
 * `kimi-coding` → `moonshotai` rename below is a legacy dsh provider id and is
 * unrelated to the harness kind `kimi`.
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

/**
 * A billed model id's vendor — the models.dev provider that publishes the
 * OFFICIAL list price — for ids whose first dash-segment names a vendor the
 * registry spells differently (`claude-…` → `anthropic`, `gpt-…` → `openai`).
 * Prefixes the registry spells the same (`deepseek/deepseek-…`) never reach
 * this table — the provider-prefix test catches them. The cost card's
 * cross-provider scan prefers this provider's entry when several branches
 * carry the model (the official list over a reseller's re-pricing); a vendor
 * the book lacks simply never matches, so an entry here can only help.
 */
const MODEL_VENDOR_PROVIDERS: Record<string, string> = {
  claude: 'anthropic',
  gpt: 'openai', o1: 'openai', o3: 'openai', o4: 'openai', chatgpt: 'openai',
  gemini: 'google', gemma: 'google',
  grok: 'xai',
  kimi: 'moonshotai', moonshot: 'moonshotai',
  qwen: 'alibaba', qwq: 'alibaba',
  glm: 'zhipuai', chatglm: 'zhipuai',
  mistral: 'mistral', codestral: 'mistral', devstral: 'mistral',
  magistral: 'mistral', pixtral: 'mistral', ministral: 'mistral', voxtral: 'mistral',
  command: 'cohere',
}

/** The vendor's models.dev provider id for a billed model id, or null when unknown. */
export function vendorProviderOf(model: string): string | null {
  const prefix = model.toLowerCase().split('-', 1)[0] ?? ''
  return MODEL_VENDOR_PROVIDERS[prefix] ?? null
}
