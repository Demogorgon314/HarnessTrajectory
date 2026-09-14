// Fold drivers for the fold specs: run event envelopes through the REAL fold
// (pure init/apply/view — no projection registry, no harness plumbing), with
// the plain-JSON precondition pinned on every intermediate state.
//
// Vendored from dsh-context `tests/host/helpers/projection.ts` (Apache-2.0);
// the projection-definition faces and the zod schema gates are gone (this
// package has neither), so the driver calls applyTimeline/buildTimelineView
// directly.

import assert from './assert.ts'
import type { Config } from '../../../src/fold/config.ts'
import { resolveBounds } from '../../../src/fold/config.ts'
import type { TimelineEvent, TimelineState } from '../../../src/fold/fold.ts'
import { applyTimeline, buildTimelineView, createTimelineState } from '../../../src/fold/fold.ts'
import type { ContextTimeline } from '../../../src/shared/types.ts'

/** Indexed read that fails the test instead of the type checker (noUncheckedIndexedAccess). */
export function row<T>(list: readonly T[], index: number): T {
  const value = list.at(index)
  assert.ok(value !== undefined, `expected a row at index ${index} (length ${list.length})`)
  return value
}

export interface TimelineDefLike {
  init(): TimelineState
  apply(state: TimelineState, event: TimelineEvent): TimelineState
  view(state: TimelineState): ContextTimeline
}

export function timelineDef(config?: Config): TimelineDefLike {
  const bounds = resolveBounds(config)
  return {
    init: () => createTimelineState(),
    apply: (state, event) => applyTimeline(state, event, bounds),
    view: state => buildTimelineView(state, bounds),
  }
}

/**
 * Lossless-JSON probe and detach. Returns undefined when the value is not
 * losslessly JSON-serializable: an undefined/function/symbol member, a
 * non-finite number, a non-plain object, or a cycle.
 */
export function snapshotJson(value: unknown, ancestors: Set<object> = new Set()): unknown {
  switch (typeof value) {
    case 'string': case 'boolean': return value
    case 'number': return Number.isFinite(value) ? value : undefined
    case 'object': break
    default: return undefined
  }
  if (value === null) return null
  if (ancestors.has(value)) return undefined
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) return undefined
        const entry = snapshotJson(value[index], ancestors)
        if (entry === undefined) return undefined
        out.push(entry)
      }
      return out
    }
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return undefined
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const entry = snapshotJson((value as Record<string, unknown>)[key], ancestors)
      if (entry === undefined) return undefined
      out[key] = entry
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

/**
 * The state precondition inherited from dsh: every state the fold produces
 * must be losslessly JSON-serializable (no `undefined`-valued properties), so
 * a fold state can be structuredClone'd / persisted wholesale. Returns the
 * detached copy.
 */
export function assertPlainJson<T>(state: T): T {
  const copy = snapshotJson(state)
  assert.ok(copy !== undefined, 'fold state must be losslessly JSON-serializable')
  return copy as T
}

export interface TimelineDrive {
  def: TimelineDefLike
  state: TimelineState
  /** Every intermediate state, including init (index = events folded). */
  states: TimelineState[]
  view: ContextTimeline
}

/** Fold the whole log and build the inline view. */
export function driveTimeline(events: TimelineEvent[], config?: Config): TimelineDrive {
  const def = timelineDef(config)
  let state = def.init()
  const states = [state]
  for (const ev of events) {
    state = def.apply(state, ev)
    states.push(state)
  }
  return { def, state, states, view: def.view(state) }
}

/** Pin the plain-JSON precondition on every intermediate fold state. */
export function assertStatesPlainJson(drive: TimelineDrive): void {
  for (const state of drive.states) assertPlainJson(state)
}

/** Reference-stability probe: an uninteresting event must return the SAME state. */
export function assertStable(state: TimelineState, event: TimelineEvent, def = timelineDef()): void {
  assert.equal(def.apply(state, event), state, 'uninteresting events must return the same reference')
}
