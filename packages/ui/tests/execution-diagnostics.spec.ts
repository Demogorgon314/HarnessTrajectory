import { describe, expect, it } from 'vitest'
import type {
  AssistantMessageNode, ModelRetryNode, SteeringMessageNode, ToolResultNode,
  TurnErrorNode, TurnMaxTokensNode,
} from '@harness-trajectory/core'
import { argumentSummary, executionDiagnostics } from '../src/trajectory/execution-diagnostics.ts'

function call(seq: number, overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return { kind: 'tool-result', seq, time: seq * 1000 + 500, callTime: seq * 1000,
    callId: `call-${seq}`, call: { name: 'Bash', argsRaw: '{"command":"make","cwd":"/project"}' },
    isError: true, content: [], subCalls: [], ...overrides }
}

function assistant(seq: number, turn: number, step: number): AssistantMessageNode {
  return { kind: 'assistant', seq, time: seq * 1000, turn, step, blocks: [] }
}

function retry(seq: number, turn: number, step: number,
  retryState: ModelRetryNode['retryState'], code: string): ModelRetryNode {
  return { kind: 'model-retry', seq, time: seq * 1000, retryState, turn, step,
    provider: 'anthropic', retry: 1, maxRetries: 3, delayMs: 1000,
    failure: { message: `fail ${seq}`, code } }
}

function turnError(seq: number, turn: number, step: number, code?: string): TurnErrorNode {
  return { kind: 'turn-error', seq, time: seq * 1000, turn, step, message: 'boom',
    ...(code === undefined ? {} : { code }) }
}

function maxTokens(seq: number, turn: number, step: number): TurnMaxTokensNode {
  return { kind: 'turn-max-tokens', seq, time: seq * 1000, turn, step }
}

function steering(seq: number): SteeringMessageNode {
  return { kind: 'steering', messageId: `m-${seq}`, seq, time: seq * 1000, content: [], source: {} }
}

describe('execution diagnostics', () => {
  it('groups repeated failures and treats a successful retry as recovery', () => {
    const report = executionDiagnostics([call(1), call(2), call(3), call(4, { isError: false }), call(5)])
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]?.calls.map(node => node.callId)).toEqual(['call-1', 'call-2', 'call-3'])
    expect(report.failures[0]).toMatchObject({ recovery: { callId: 'call-4' }, interleaved: false })
    expect(executionDiagnostics([call(1), call(2, { isError: false }), call(3)]).failures).toEqual([])
  })
  it('separates different arguments, human turns and nested work', () => {
    const changed = call(2, { call: { name: 'Bash', argsRaw: '{"command":"make","cwd":"/other"}' } })
    for (const nodes of [
      [call(1), changed, call(3)],
      [call(1), call(2), { kind: 'user' as const, seq: 3, time: 3000, content: [], source: {} }, call(4)],
      [call(1), call(2, { parentCallId: 'parent' }), call(3)],
    ]) expect(executionDiagnostics(nodes).failures).toEqual([])
  })
  it('keeps interleaved failures in one group and links the eventual recovery', () => {
    const edit = (seq: number) => call(seq, {
      isError: false, call: { name: 'Edit', argsRaw: '{"file_path":"a.ts"}' } })
    const nodes = [call(1), edit(2), call(3), edit(4), call(5)]
    const interleaved = executionDiagnostics(nodes).failures
    expect(interleaved).toHaveLength(1)
    expect(interleaved[0]).toMatchObject({
      calls: [{ callId: 'call-1' }, { callId: 'call-3' }, { callId: 'call-5' }],
      interleaved: true, recovery: null,
    })
    const recovered = executionDiagnostics([...nodes, call(6, { isError: false })]).failures
    expect(recovered[0]?.recovery?.callId).toBe('call-6')
    expect(executionDiagnostics([
      call(1), call(2), call(3, { isError: false }), call(4), call(5),
    ]).failures).toEqual([])
  })
  it('collects distinct error codes in first-seen order', () => {
    const report = executionDiagnostics([
      call(1, { error: { name: 'E', code: 'ETIMEDOUT' } }),
      call(2, { error: { name: 'E', code: 'ENOENT' } }),
      call(3, { error: { name: 'E', code: 'ETIMEDOUT' } }),
      call(4),
    ])
    expect(report.failures[0]?.errorCodes).toEqual(['ETIMEDOUT', 'ENOENT'])
    expect(executionDiagnostics([call(1), call(2), call(3)]).failures[0]?.errorCodes).toEqual([])
  })
  it('ends a run at a steering message', () => {
    expect(executionDiagnostics([call(1), call(2), steering(3), call(4)]).failures).toEqual([])
  })
  it('normalizes nested objects while preserving command strings, array order and invalid JSON', () => {
    const failuresFor = (first: string, second: string) => executionDiagnostics([
      call(1, { call: { name: 'Bash', argsRaw: first } }),
      call(2, { call: { name: 'Bash', argsRaw: second } }),
      call(3, { call: { name: 'Bash', argsRaw: first } }),
    ]).failures
    expect(failuresFor('{"command":"make", "env":{"b":2,"a":1}}', '{"env":{"a":1,"b":2},"command":"make"}')).toHaveLength(1)
    expect(failuresFor('{"command":"echo a"}', '{"command":"echo  a"}')).toHaveLength(0)
    expect(failuresFor('{"args":[1,2]}', '{"args":[2,1]}')).toHaveLength(0)
    expect(failuresFor('{bad', '{bad ')).toHaveLength(0)
    expect(failuresFor('{bad', '{bad')).toHaveLength(1)
    expect(failuresFor('{"__proto__":{"a":1}}', '{}')).toHaveLength(0)
  })
  it('keeps all groups, prioritizes unconfirmed recovery and does not infer recovery across boundaries', () => {
    const report = executionDiagnostics([
      call(1), call(2), call(3), call(4), call(5, { isError: false }),
      call(6), call(7), call(8),
      { kind: 'user', seq: 9, time: 9000, content: [], source: {} },
      call(10, { isError: false }), call(11), call(12), call(13),
      call(14, { isError: false, call: { name: 'Read', argsRaw: '{}' } }),
    ])
    expect(report.failures.map(item => [item.calls[0]?.callId, item.recovery?.callId ?? null]))
      .toEqual([['call-6', null], ['call-11', null], ['call-1', 'call-5']])
  })
  it('counts only scheduled retries and reports the last failure', () => {
    const report = executionDiagnostics([
      retry(1, 1, 1, 'scheduled', 'overloaded'),
      retry(2, 1, 1, 'started', 'overloaded'),
      retry(3, 1, 1, 'scheduled', 'rate_limit'),
      retry(4, 1, 1, 'started', 'rate_limit'),
    ])
    expect(report.model).toHaveLength(1)
    expect(report.model[0]).toMatchObject({
      turn: 1, step: 1, seq: 1,
      retries: [{ seq: 1 }, { seq: 3 }],
      lastFailure: { code: 'rate_limit', message: 'fail 3' },
    })
    expect(executionDiagnostics([retry(1, 1, 1, 'scheduled', 'overloaded')]).model).toEqual([])
  })
  it('groups turn errors and output limits per step in anchor order', () => {
    const errorOnly = executionDiagnostics([turnError(5, 2, 1, 'server_error')])
    expect(errorOnly.model).toHaveLength(1)
    expect(errorOnly.model[0]).toMatchObject({
      errors: [{ seq: 5 }], lastFailure: { code: 'server_error', message: 'boom' },
    })
    expect(executionDiagnostics([turnError(5, 2, 1)]).model[0]?.lastFailure?.code).toBe('error')
    expect(executionDiagnostics([maxTokens(5, 2, 1)]).model[0])
      .toMatchObject({ maxTokens: [{ seq: 5 }], lastFailure: null })
    const split = executionDiagnostics([
      retry(1, 1, 1, 'scheduled', 'overloaded'),
      retry(2, 1, 1, 'scheduled', 'overloaded'),
      turnError(3, 1, 2, 'server_error'),
    ])
    expect(split.model.map(group => group.step)).toEqual([1, 2])
  })
  it('ignores user-initiated Codex turn errors', () => {
    expect(executionDiagnostics([
      { kind: 'turn-error', seq: 1, time: 1000, turn: 1, step: 1,
        message: 'Turn aborted (interrupted)', code: 'turn_aborted' },
    ]).model).toEqual([])
    expect(executionDiagnostics([
      { kind: 'turn-error', seq: 1, time: 1000, turn: 1, step: 1,
        message: 'Turn aborted (interrupted)', code: 'thread_rolled_back' },
    ]).model).toEqual([])
  })
  it('ranks the slowest sample without counting missing or invalid timing', () => {
    const report = executionDiagnostics([
      call(1, { callTime: null }), call(2, { callTime: 3000 }),
      call(3, { callTime: 1000, time: 10000 }),
      call(4, { callTime: 2000, time: 11000 }),
      call(5, { callTime: Number.NaN }),
    ])
    expect(report.slow).toMatchObject({ durationMs: 9000, call: { callId: 'call-3' } })
    expect(executionDiagnostics([call(1, { callTime: null })]).slow).toBeNull()
  })
  it('accepts an epoch-zero call start when measuring duration', () => {
    expect(executionDiagnostics([call(1, { callTime: 0, time: 250 })]).slow)
      .toMatchObject({ call: { callId: 'call-1' }, durationMs: 250 })
  })
  it('compares only the same tool while excluding invalid and nested samples', () => {
    const report = executionDiagnostics([
      call(1, { time: 1000 }), call(2, { time: 2200 }),
      call(3, { time: 3400 }), call(4, { time: 4900 }),
      call(5, { call: { name: 'Read', argsRaw: '{}' }, time: 5500 }),
      call(6, { time: 5999 }), call(7, { callTime: null }),
      call(8, { parentCallId: 'parent', time: 100000 }), call(9, { time: Infinity }),
    ])
    expect(report.slow).toMatchObject({
      call: { callId: 'call-4' }, sampleCount: 5, toolSampleCount: 4,
      medianMs: 300, durationMs: 900, batchedExcluded: 0,
    })
    expect(executionDiagnostics([call(1, { time: 1000 })]).slow).toMatchObject({ durationMs: 0 })
  })
  it('excludes samples issued alongside other calls in one assistant message', () => {
    const batched = executionDiagnostics([
      assistant(1, 1, 1),
      call(2, { callTime: 1000, time: 1500 }),
      call(3, { callTime: 1000, time: 2500 }),
      call(4, { callTime: 1000, time: 9000 }),
      assistant(5, 1, 2),
      call(6, { callTime: 5000, time: 5400 }),
    ])
    expect(batched.slow).toMatchObject({
      call: { callId: 'call-6' }, durationMs: 400, sampleCount: 1, batchedExcluded: 3,
    })
    expect(executionDiagnostics([
      assistant(1, 1, 1),
      call(2, { callTime: 1000, time: 1500 }),
      call(3, { callTime: 1000, time: 2500 }),
      call(4, { callTime: 1000, time: 9000 }),
    ]).slow).toBeNull()
    const unbatched = executionDiagnostics([
      call(1, { callTime: 1000, time: 1500 }),
      call(2, { callTime: 1000, time: 2500 }),
    ])
    expect(unbatched.slow).toMatchObject({ call: { callId: 'call-2' }, batchedExcluded: 0 })
  })
})

describe('argument summary', () => {
  it('prefers the primary argument value', () => {
    expect(argumentSummary('{"command":"pnpm  test\\n--run","cwd":"/x"}')).toBe('pnpm test --run')
    expect(argumentSummary('{"cwd":"/x","file_path":"a.ts"}')).toBe('a.ts')
    expect(argumentSummary('{"n":1,"s":"v"}')).toBe('v')
    expect(argumentSummary('{bad')).toBe('{bad')
  })
  it('truncates long values', () => {
    const summary = argumentSummary(`{"command":"${'x'.repeat(300)}"}`)
    expect(summary).toHaveLength(160)
    expect(summary.endsWith('…')).toBe(true)
  })
})
