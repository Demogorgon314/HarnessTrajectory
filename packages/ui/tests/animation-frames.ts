import { act } from '@testing-library/react'
import { vi } from 'vitest'

/** Queue callbacks like the browser: callbacks scheduled during a frame wait for the next one. */
export function mockAnimationFrames(): () => void {
  const pending = new Map<number, FrameRequestCallback>()
  let nextId = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++nextId
    pending.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { pending.delete(id) })
  return () => {
    act(() => {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback(0)
    })
  }
}
