import type { TimelineEvent } from '../fold/event.ts'

/**
 * Restore a saved model-visible surface using the fold's existing vocabulary.
 * Historical requests and billing remain intact. Fresh seqs identify restored
 * copies; replay suppresses dispatch/input/tool bookkeeping. Checkpoints retain
 * immutable event content, so they also survive an intervening compaction.
 */
export function restoreSurface(
  current: readonly number[],
  saved: readonly TimelineEvent[],
  time: number,
  nextSeq: number,
  label: string,
): TimelineEvent[] {
  const events: TimelineEvent[] = []
  // Do not spread a long transcript into Math.min/max's argument list.
  const surfaceOp = current.length === 0 ? undefined : {
    op: 'replace',
    startSeq: current.reduce((min, seq) => Math.min(min, seq), Infinity),
    endSeq: current.reduce((max, seq) => Math.max(max, seq), -Infinity),
  }
  if (current.length > 0) {
    events.push({ type: 'compaction/prune', seq: nextSeq++, time, data: { shadowedSeqs: [...current] } })
  }
  if (saved.length === 0 && surfaceOp !== undefined) {
    events.push({
      type: 'user/message', seq: nextSeq++, time,
      data: { content: [], replay: true, source: { kind: 'plugin', form: 'compaction', plugin: label } },
      surfaceOp,
    })
  }
  for (const [index, event] of saved.entries()) {
    events.push({
      type: event.type, seq: nextSeq++, time, data: { ...event.data, replay: true },
      ...(index === 0 && surfaceOp !== undefined ? { surfaceOp } : {}),
    })
  }
  return events
}
