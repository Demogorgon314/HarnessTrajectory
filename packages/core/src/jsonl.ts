/** Tolerant JSONL helpers shared by adapters and the server scanner. */

/**
 * Parse one JSONL line, returning `undefined` for blank or malformed lines
 * (a transcript being written can end in a partial record).
 */
export function parseJsonLine(line: string): unknown {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/** Parse an ISO-8601 or epoch (seconds or milliseconds) timestamp to epoch milliseconds. */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: values below 1e12 are seconds (until year 33658).
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** Split a text chunk into complete lines, returning the unterminated remainder. */
export function splitLines(chunk: string): { lines: string[]; rest: string } {
  const lines = chunk.split('\n')
  const rest = lines.pop() ?? ''
  return { lines, rest }
}
