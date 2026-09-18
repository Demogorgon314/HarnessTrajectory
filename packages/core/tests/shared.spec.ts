import { describe, expect, it } from 'vitest'
import { ToolCallTracker } from '../src/adapters/shared.ts'

describe('ToolCallTracker', () => {
  it('lists a call only once when the same callId is started twice', () => {
    const tracker = new ToolCallTracker()
    const call = {
      callId: 'call-1', name: 'read_file', argsRaw: '{}', turn: 1, step: 1, time: 100, subCalls: [],
    }
    tracker.start(call)
    tracker.start(call)
    expect(tracker.runningCalls().map(item => item.callId)).toEqual(['call-1'])
    expect(tracker.pendingIds()).toEqual(['call-1'])
    tracker.complete('call-1', { seq: 1, time: 200, content: [], isError: false })
    expect(tracker.runningCalls()).toEqual([])
    expect(tracker.pendingIds()).toEqual([])
  })
})
