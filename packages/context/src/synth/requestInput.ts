import type { TimelineEvent } from '../fold/event.ts'
import type { RequestInput } from '../shared/requestInput.ts'
import { inputTokenCount } from '../shared/requestInput.ts'

/** Port-owned metadata; deliberately outside the vendored fold's data vocabulary. */
export interface InputEvent extends TimelineEvent {
  requestInput?: RequestInput
}

export function setRequestInput(event: TimelineEvent | undefined, input: RequestInput): void {
  if (event !== undefined) Object.assign(event, { requestInput: input })
}

/** Missing input is not a measured zero, even if output is present. */
export function measuredInput(tokens: unknown, model?: string): RequestInput {
  const count = inputTokenCount(tokens)
  return {
    source: count === undefined ? 'unknown' : 'reported',
    ...(count === undefined ? {} : { tokens: count }),
    ...(model === undefined ? {} : { model }),
  }
}

/** Only use for harnesses whose input and cache buckets are verified disjoint. */
export function disjointInput(usage: unknown, model?: string): RequestInput {
  if (usage === undefined) return { source: 'estimated', ...(model === undefined ? {} : { model }) }
  if (usage === null || typeof usage !== 'object') return measuredInput(undefined, model)
  const raw = usage as Record<string, unknown>
  const input = inputTokenCount(raw['inputTokens'])
  const read = raw['cacheReadTokens'] === undefined ? 0 : inputTokenCount(raw['cacheReadTokens'])
  const write = raw['cacheWriteTokens'] === undefined ? 0 : inputTokenCount(raw['cacheWriteTokens'])
  return measuredInput(input === undefined || read === undefined || write === undefined ? undefined : input + read + write, model)
}
