/**
 * Sidebar listing state helpers: the server pages `/api/sessions`, and the
 * client merges each page into the loaded window keeping the identity of
 * unchanged summaries — the list renders on identity, so a poll that changed
 * nothing must not allocate new row props.
 */

import { useEffect, useState } from 'react'
import { LIVE_WINDOW_MS, type SessionSummary } from '@harness-trajectory/core'

export function sessionKeyOf(session: Pick<SessionSummary, 'kind' | 'id'>): string {
  return `${session.kind}/${session.id}`
}

/** Field-wise equality; cheaper than a re-render of every row the poll touched. */
export function sameSession(left: SessionSummary, right: SessionSummary): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.title === right.title
    && left.cwd === right.cwd
    && left.model === right.model
    && left.startedAt === right.startedAt
    && left.updatedAt === right.updatedAt
    && left.bytes === right.bytes
    && left.live === right.live
    && left.childCount === right.childCount
    && left.promptCount === right.promptCount
}

/**
 * Any loaded session inside the live window keeps `?rev=` off the next poll:
 * its `live` flag flips on a clock, not on a `change` event, so an idle
 * revision could not report it. Once everything shown is idle, conditional
 * requests resume.
 */
export function anySessionLive(sessions: readonly SessionSummary[], now = Date.now()): boolean {
  return sessions.some(session => now - session.updatedAt < LIVE_WINDOW_MS)
}

/**
 * Replace the loaded window with a fresh page covering it, reusing the prior
 * object for every summary whose fields did not change. Returns `prev` itself
 * when nothing — membership, order, or content — moved, so callers can
 * `setSessions` the result and let React bail out.
 */
export function mergeSessions(
  prev: readonly SessionSummary[],
  next: readonly SessionSummary[],
): readonly SessionSummary[] {
  const byKey = new Map<string, SessionSummary>()
  for (const session of prev) byKey.set(sessionKeyOf(session), session)
  const merged = next.map((session) => {
    const prior = byKey.get(sessionKeyOf(session))
    return prior !== undefined && sameSession(prior, session) ? prior : session
  })
  return merged.length === prev.length && merged.every((session, at) => session === prev[at])
    ? prev
    : merged
}

/**
 * Append a fetched page below the loaded window. Keys already loaded are
 * skipped — the next top-window refresh reconciles their fields — so a slow
 * `loadMore` landing after a refresh can never duplicate a row. Returns `prev`
 * itself when the page added nothing.
 */
export function appendSessions(
  prev: readonly SessionSummary[],
  next: readonly SessionSummary[],
): readonly SessionSummary[] {
  const seen = new Set(prev.map(sessionKeyOf))
  const fresh = next.filter(session => !seen.has(sessionKeyOf(session)))
  return fresh.length === 0 ? prev : [...prev, ...fresh]
}

/** Ticks `Date.now()` on a slow interval so idle labels (relative times) age. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, intervalMs)
    return () => { clearInterval(timer) }
  }, [intervalMs])
  return now
}
