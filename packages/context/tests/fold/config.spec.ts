// The fold bounds contract (src/fold/config.ts): defaults fill, strict keys,
// integer/lower-bound validation. dsh ran these through cordis' zod schema;
// this port hand-rolls the same contract, so the cases carry over verbatim
// against `resolveBounds`.

import assert from './helpers/assert.ts'
import { describe, test } from 'vitest'
import type { Config } from '../../src/fold/config.ts'
import { DEFAULT_BOUNDS, resolveBounds } from '../../src/fold/config.ts'

describe('resolveBounds', () => {
  test('an absent config resolves to defaults', () => {
    assert.deepEqual(resolveBounds(undefined), DEFAULT_BOUNDS)
    assert.deepEqual(resolveBounds(null), DEFAULT_BOUNDS)
    assert.deepEqual(resolveBounds({}), DEFAULT_BOUNDS)
  })

  test('the resolved object never aliases the defaults', () => {
    const resolved = resolveBounds({})
    assert.notEqual(resolved, DEFAULT_BOUNDS)
    resolved.maxNodes = 1
    assert.notEqual(DEFAULT_BOUNDS.maxNodes, 1)
  })

  test('each field overrides independently', () => {
    assert.equal(resolveBounds({ maxRequestSteps: 7 }).maxRequestSteps, 7)
    assert.equal(resolveBounds({ maxKeptTurns: 7 }).maxKeptTurns, 7)
    assert.equal(resolveBounds({ maxEvents: 7 }).maxEvents, 7)
    assert.equal(resolveBounds({ maxNodes: 7 }).maxNodes, 7)
    assert.equal(resolveBounds({ maxArchiveNodes: 7 }).maxArchiveNodes, 7)
    assert.equal(resolveBounds({ maxFileOps: 7 }).maxFileOps, 7)
    // Untouched fields keep their defaults.
    assert.equal(resolveBounds({ maxNodes: 7 }).maxEvents, DEFAULT_BOUNDS.maxEvents)
  })

  test('an explicitly undefined field keeps its default', () => {
    // `exactOptionalPropertyTypes` forbids this shape at the type level; a
    // caller reading a config off JSON can still produce it at runtime.
    assert.equal(resolveBounds({ maxNodes: undefined } as unknown as Config).maxNodes, DEFAULT_BOUNDS.maxNodes)
  })

  test('rejects zero/negative bounds (min 1)', () => {
    assert.throws(() => resolveBounds({ maxRequestSteps: 0 }))
    assert.throws(() => resolveBounds({ maxNodes: -1 }))
  })

  test('rejects non-integer bounds', () => {
    assert.throws(() => resolveBounds({ maxEvents: 1.5 }))
    assert.throws(() => resolveBounds({ maxEvents: Number.NaN }))
  })

  test('rejects non-number bounds', () => {
    assert.throws(() => resolveBounds({ maxKeptTurns: '300' } as unknown as Config))
  })

  test('strict: unknown keys fail loudly', () => {
    assert.throws(() => resolveBounds({ unknown: 1 } as unknown as Config))
  })

  test('the port raises every dsh default (a local viewer keeps whole sessions)', () => {
    assert.deepEqual(DEFAULT_BOUNDS, {
      maxRequestSteps: 5000,
      maxKeptTurns: 2000,
      maxEvents: 2000,
      maxNodes: 20000,
      maxArchiveNodes: 5000,
      maxFileOps: 5000,
    })
  })
})
