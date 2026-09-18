// @vitest-environment jsdom
/**
 * Line anchors: the trajectory opens and scrolls to the record one raw
 * transcript line folded into (what a content-search hit addresses).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  ImageAttachmentRef, SourceLineIndex, SourceLineTarget, TrajectorySnapshot,
} from '@harness-trajectory/core'
import { TrajectoryView, type TrajectoryInspectLine } from '../src/trajectory/TrajectoryView.tsx'
import { createTrajectoryDurationStore } from '../src/trajectory/duration-store.ts'
import type { MessageImageLoader } from '../src/images.tsx'
import { t } from './locale.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const loadImage: MessageImageLoader = Object.assign(
  async (_attachment: ImageAttachmentRef): Promise<string> => { throw new Error('no images') },
  { peek: () => undefined },
)

/** A fold with one prompt, one assistant step, and one completed tool call. */
function snapshotOf(lines: SourceLineIndex | undefined): TrajectorySnapshot {
  return {
    eventNodes: [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'Fix the build' }], source: {} },
      {
        kind: 'assistant',
        seq: 2,
        time: 2_000,
        turn: 1,
        step: 1,
        blocks: [
          { kind: 'text', text: 'Running it.' },
          { kind: 'tool-call', callId: 'call-1', name: 'Bash', argsRaw: '{"command":"make"}' },
        ],
      },
      {
        kind: 'tool-result',
        seq: 3,
        time: 3_000,
        callId: 'call-1',
        call: { name: 'Bash', argsRaw: '{"command":"make"}' },
        callTime: 2_000,
        content: [{ type: 'text', text: 'built' }],
        isError: false,
        subCalls: [],
      },
    ],
    eventLocations: new Map([
      [1, { kind: 'turn', turn: { turn: 1, status: 'closed' } }],
      [2, { kind: 'turn', turn: { turn: 1, status: 'closed' } }],
      [3, { kind: 'turn', turn: { turn: 1, status: 'closed' } }],
    ]),
    requests: [],
    callSchemas: new Map(),
    partial: null,
    runningCalls: [],
    ...(lines === undefined ? {} : { sourceLines: lines }),
  }
}

/** A line index that answers from a fixed table, like a parser that folded that far. */
function lineIndex(table: ReadonlyMap<number, SourceLineTarget>): SourceLineIndex {
  return { targetAt: line => table.get(line) }
}

const RESOLVED = lineIndex(new Map<number, SourceLineTarget>([
  [4, { kind: 'seq', seq: 1 }],
  [7, { kind: 'call', callId: 'call-1' }],
]))

function View({ inspectLine, snapshot, onInspectApplied }: {
  inspectLine: TrajectoryInspectLine | null
  snapshot: TrajectorySnapshot
  onInspectApplied?: () => void
}) {
  return (
    <TrajectoryView
      snapshot={snapshot}
      loadImage={loadImage}
      durationStore={createTrajectoryDurationStore()}
      inspectLine={inspectLine}
      {...(onInspectApplied === undefined ? {} : { onInspectApplied })}
      t={t}
    />
  )
}

describe('TrajectoryView line anchor', () => {
  it('labels whole-turn usage in the ledger and request details', () => {
    const base = snapshotOf(undefined)
    const usage = { inputTokens: 30, outputTokens: 12, scope: 'turn' as const }
    const snapshot: TrajectorySnapshot = {
      ...base,
      eventNodes: base.eventNodes.map(node => node.kind === 'assistant' ? { ...node, usage } : node),
      requests: [{ purpose: 'assistant', turn: 1, step: 1, startSeq: 2,
        startedAt: 1_000, completedAt: 2_000, resultSeq: 2, status: 'complete', usage }],
    }
    render(<View snapshot={snapshot} inspectLine={null} />)
    expect(screen.getByText('Turn total')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Request #1' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    expect(screen.getByRole('heading', { name: 'Turn total' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'This request' })).toBeNull()
  })
  it('opens the record a line folded into and acknowledges once', () => {
    const onInspectApplied = vi.fn()
    render(<View snapshot={snapshotOf(RESOLVED)} inspectLine={{ line: 4 }} onInspectApplied={onInspectApplied} />)
    expect(screen.getByRole('row', { name: /USER/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('complementary', { name: 'Event details' })).toBeTruthy()
    expect(onInspectApplied).toHaveBeenCalledOnce()
  })

  it('resolves a tool call line to the record that holds the call and its result', () => {
    render(<View snapshot={snapshotOf(RESOLVED)} inspectLine={{ line: 7 }} />)
    expect(screen.getByRole('row', { name: /TOOL/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('row', { name: /USER/ }).getAttribute('aria-selected')).toBe('false')
  })

  it('holds a line the fold has not reached yet until its record exists', () => {
    const onInspectApplied = vi.fn()
    const { rerender } = render(
      <View snapshot={snapshotOf(lineIndex(new Map()))} inspectLine={{ line: 4 }} onInspectApplied={onInspectApplied} />,
    )
    expect(screen.getByRole('row', { name: /USER/ }).getAttribute('aria-selected')).toBe('false')
    expect(onInspectApplied).not.toHaveBeenCalled()

    // The replay went on: the same request now resolves, without being re-armed.
    rerender(
      <View snapshot={snapshotOf(RESOLVED)} inspectLine={{ line: 4 }} onInspectApplied={onInspectApplied} />,
    )
    expect(screen.getByRole('row', { name: /USER/ }).getAttribute('aria-selected')).toBe('true')
    expect(onInspectApplied).toHaveBeenCalledOnce()
  })

  it('re-arms on a new request for the same line and ignores a repeated one', () => {
    const onInspectApplied = vi.fn()
    const first: TrajectoryInspectLine = { line: 7 }
    const { rerender } = render(
      <View snapshot={snapshotOf(RESOLVED)} inspectLine={first} onInspectApplied={onInspectApplied} />,
    )
    expect(onInspectApplied).toHaveBeenCalledOnce()
    // Re-rendering with the SAME request object changes nothing.
    rerender(<View snapshot={snapshotOf(RESOLVED)} inspectLine={first} onInspectApplied={onInspectApplied} />)
    expect(onInspectApplied).toHaveBeenCalledOnce()
    // Selecting the same hit again is a new request object, and scrolls again.
    rerender(<View snapshot={snapshotOf(RESOLVED)} inspectLine={{ line: 7 }} onInspectApplied={onInspectApplied} />)
    expect(onInspectApplied).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('row', { name: /TOOL/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('does nothing when the fold carries no line index at all', () => {
    const onInspectApplied = vi.fn()
    render(<View snapshot={snapshotOf(undefined)} inspectLine={{ line: 4 }} onInspectApplied={onInspectApplied} />)
    expect(screen.getByRole('row', { name: /USER/ }).getAttribute('aria-selected')).toBe('false')
    expect(onInspectApplied).not.toHaveBeenCalled()
  })
})
