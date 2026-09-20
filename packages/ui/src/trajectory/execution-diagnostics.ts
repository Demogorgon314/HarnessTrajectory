import type {
  ConversationNode, ModelRetryNode, ToolResultNode, TurnErrorNode, TurnMaxTokensNode,
} from '@harness-trajectory/core'

export interface FailureGroup {
  kind: 'repeated-failure'
  calls: readonly ToolResultNode[]
  recovery: ToolResultNode | null
  interleaved: boolean
  errorCodes: readonly string[]
}

export interface ModelTrouble {
  kind: 'model-trouble'
  turn: number
  step: number
  seq: number
  time: number
  retries: readonly ModelRetryNode[]
  errors: readonly TurnErrorNode[]
  maxTokens: readonly TurnMaxTokensNode[]
  lastFailure: { code: string; message: string } | null
}

export interface SlowTool {
  kind: 'slow-tool'
  call: ToolResultNode
  durationMs: number
  sampleCount: number
  toolSampleCount: number
  medianMs: number
  batchedExcluded: number
}

export type ExecutionObservation = FailureGroup | ModelTrouble | SlowTool

export interface ExecutionDiagnosticsReport {
  failures: readonly FailureGroup[]
  model: readonly ModelTrouble[]
  slow: SlowTool | null
}

function argumentKey(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw)
    // Only structured arguments are normalized; command strings and array order matter.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return raw
    return JSON.stringify(value, (_key, item: unknown) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    })
  } catch {
    return raw
  }
}

const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']

/** Short human-readable label for one call's raw arguments. */
export function argumentSummary(argsRaw: string): string {
  let picked: string | undefined
  try {
    const value: unknown = JSON.parse(argsRaw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const strings = new Map<string, string>()
      for (const [key, item] of Object.entries(value))
        if (typeof item === 'string') strings.set(key, item)
      for (const key of SUMMARY_KEYS) {
        const hit = strings.get(key)
        if (hit !== undefined) { picked = hit; break }
      }
      picked ??= strings.values().next().value
    }
  } catch {
    picked = undefined
  }
  const collapsed = (picked ?? argsRaw).replace(/\s+/g, ' ').trim()
  return collapsed.length > 160 ? `${collapsed.slice(0, 159)}…` : collapsed
}

interface FailureRun {
  calls: ToolResultNode[]
  lastIndex: number
  interleaved: boolean
}

function finishRun(run: FailureRun, recovery: ToolResultNode | null): FailureGroup {
  const codes = new Set<string>()
  for (const node of run.calls) if (node.error !== undefined) codes.add(node.error.code)
  return { kind: 'repeated-failure', calls: run.calls, recovery,
    interleaved: run.interleaved, errorCodes: [...codes] }
}

/**
 * Runs of identical failing calls within one segment (between user/steering/
 * unknown/compaction boundaries). Other calls may interleave a run; only a
 * matching success closes it as recovered.
 */
function failureGroups(nodes: readonly ConversationNode[]): FailureGroup[] {
  const groups: FailureGroup[] = []
  const runs = new Map<string, FailureRun>()
  let topLevelIndex = 0
  const flushAll = () => {
    for (const run of runs.values())
      if (run.calls.length >= 3) groups.push(finishRun(run, null))
    runs.clear()
  }
  for (const node of nodes) {
    if (node.kind === 'user' || node.kind === 'steering' || node.kind === 'unknown'
      || node.kind === 'compaction') { flushAll(); continue }
    if (node.kind !== 'tool-result' || node.parentCallId !== undefined) continue
    const index = topLevelIndex
    topLevelIndex += 1
    if (node.call === null) continue
    const key = `${node.call.name}\u0000${argumentKey(node.call.argsRaw)}`
    if (node.isError) {
      let run = runs.get(key)
      if (run === undefined) {
        run = { calls: [], lastIndex: index, interleaved: false }
        runs.set(key, run)
      } else if (index - run.lastIndex > 1) {
        run.interleaved = true
      }
      run.calls.push(node)
      run.lastIndex = index
    } else {
      const run = runs.get(key)
      if (run === undefined) continue
      // A successful retry resets the streak whether or not it formed a group.
      if (run.calls.length >= 3) groups.push(finishRun(run, node))
      runs.delete(key)
    }
  }
  flushAll()
  groups.sort((a, b) => Number(a.recovery !== null) - Number(b.recovery !== null)
    || b.calls.length - a.calls.length
    || (a.calls[0]?.seq ?? 0) - (b.calls[0]?.seq ?? 0))
  return groups
}

// Codex folds user interruptions/rollbacks into turn-error; see codex.ts.
const USER_INITIATED_TURN_ERRORS = new Set(['turn_aborted', 'thread_rolled_back'])

/** Retries, request errors and output-limit stops grouped per model request step. */
function modelTroubles(nodes: readonly ConversationNode[]): ModelTrouble[] {
  interface Trouble {
    seq: number
    time: number
    turn: number
    step: number
    retries: ModelRetryNode[]
    errors: TurnErrorNode[]
    maxTokens: TurnMaxTokensNode[]
  }
  const groups = new Map<string, Trouble>()
  for (const node of nodes) {
    if (node.kind !== 'model-retry' && node.kind !== 'turn-error' && node.kind !== 'turn-max-tokens') continue
    // 'scheduled' is emitted once per retry; 'started'/'cancelled' would double-count it.
    if (node.kind === 'model-retry' && node.retryState !== 'scheduled') continue
    if (node.kind === 'turn-error' && node.code !== undefined
      && USER_INITIATED_TURN_ERRORS.has(node.code)) continue
    const key = `${node.turn}\u0000${node.step}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { seq: node.seq, time: node.time, turn: node.turn, step: node.step,
        retries: [], errors: [], maxTokens: [] }
      groups.set(key, group)
    }
    if (node.seq < group.seq) { group.seq = node.seq; group.time = node.time }
    if (node.kind === 'model-retry') group.retries.push(node)
    else if (node.kind === 'turn-error') group.errors.push(node)
    else group.maxTokens.push(node)
  }
  const troubles: ModelTrouble[] = []
  for (const group of groups.values()) {
    if (group.retries.length < 2 && group.errors.length === 0 && group.maxTokens.length === 0) continue
    const lastRetry = group.retries.at(-1)
    const lastError = group.errors.at(-1)
    troubles.push({
      kind: 'model-trouble',
      turn: group.turn,
      step: group.step,
      seq: group.seq,
      time: group.time,
      retries: group.retries,
      errors: group.errors,
      maxTokens: group.maxTokens,
      lastFailure: lastRetry !== undefined
        ? { code: lastRetry.failure.code, message: lastRetry.failure.message }
        : lastError !== undefined
          ? { code: lastError.code ?? 'error', message: lastError.message }
          : null,
    })
  }
  troubles.sort((a, b) => a.seq - b.seq)
  return troubles
}

/**
 * Slowest completed top-level call by timestamp-derived duration. Results the
 * assistant issued in the same message cannot overlap serially, so durations of
 * calls sharing one issuing message are dropped as unreliable samples.
 */
function slowestTool(nodes: readonly ConversationNode[]): SlowTool | null {
  interface Sample { node: ToolResultNode; duration: number; batch: number | null }
  const samples: Sample[] = []
  let lastAssistantSeq: number | null = null
  for (const node of nodes) {
    if (node.kind === 'assistant') { lastAssistantSeq = node.seq; continue }
    if (node.kind !== 'tool-result' || node.parentCallId !== undefined || node.call === null) continue
    const { callTime, time } = node
    if (callTime === null || !Number.isFinite(callTime) || callTime < 0 || !Number.isFinite(time)) continue
    const duration = time - callTime
    if (!Number.isFinite(duration) || duration < 0) continue
    samples.push({ node, duration, batch: lastAssistantSeq })
  }
  const batchCounts = new Map<number, number>()
  for (const sample of samples) {
    if (sample.batch === null) continue
    batchCounts.set(sample.batch, (batchCounts.get(sample.batch) ?? 0) + 1)
  }
  const kept = samples.filter(sample =>
    sample.batch === null || (batchCounts.get(sample.batch) ?? 0) <= 1)
  let slowest: Sample | undefined
  for (const sample of kept)
    if (slowest === undefined || sample.duration > slowest.duration) slowest = sample
  const name = slowest?.node.call?.name
  if (slowest === undefined || name === undefined) return null
  const toolSamples = kept
    .filter(sample => sample.node.call?.name === name)
    .map(sample => sample.duration)
    .sort((a, b) => a - b)
  const middle = Math.floor(toolSamples.length / 2)
  const upper = toolSamples[middle] ?? 0
  const medianMs = toolSamples.length % 2 === 0
    ? ((toolSamples[middle - 1] ?? upper) + upper) / 2
    : upper
  return { kind: 'slow-tool', call: slowest.node, durationMs: slowest.duration,
    sampleCount: kept.length, toolSampleCount: toolSamples.length, medianMs,
    batchedExcluded: samples.length - kept.length }
}

/** Conservative observations over the open transcript, excluding nested agent work. */
export function executionDiagnostics(nodes: readonly ConversationNode[]): ExecutionDiagnosticsReport {
  return { failures: failureGroups(nodes), model: modelTroubles(nodes), slow: slowestTool(nodes) }
}
