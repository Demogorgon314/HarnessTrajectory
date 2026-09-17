/** Input measurements are separate from billing and from the live context estimate. */
export interface RequestInput {
  source: 'reported' | 'estimated' | 'unknown'
  tokens?: number
  model?: string
  window?: { tokens: number; source: 'recorded' | 'inferred'; kind: 'usable' | 'model' }
}

export interface InputPeak extends RequestInput {
  tokens: number
  seq: number
  time: number
}

/** Whole loaded history of one agent; independent of the retained request list. */
export interface RequestInputSummary {
  calls: number
  reported: number
  estimated: number
  withWindow: number
  peak?: InputPeak
  estimatedPeak?: InputPeak
  highestRatio?: InputPeak
}

export function inputTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function addRequestInput(
  summary: RequestInputSummary, input: RequestInput, seq: number, time: number,
): RequestInputSummary {
  const next = { ...summary, calls: summary.calls + 1 }
  const tokens = inputTokenCount(input.tokens)
  if (tokens === undefined || input.source === 'unknown') return next
  const sample: InputPeak = { ...input, tokens, seq, time }
  if (input.source === 'estimated') {
    next.estimated++
    if (next.estimatedPeak === undefined || tokens > next.estimatedPeak.tokens) next.estimatedPeak = sample
    return next
  }
  next.reported++
  if (next.peak === undefined || tokens > next.peak.tokens) next.peak = sample
  const window = inputTokenCount(input.window?.tokens)
  // A catalog guess is not evidence for a historical occupancy percentage.
  if (window !== undefined && window > 0 && input.window?.source === 'recorded') {
    next.withWindow++
    const previous = next.highestRatio
    if (previous === undefined || tokens / window > previous.tokens / (previous.window?.tokens ?? 1)) {
      next.highestRatio = sample
    }
  }
  return next
}
