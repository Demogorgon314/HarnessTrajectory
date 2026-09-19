import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EMPTY_TRAJECTORY_SNAPSHOT, type TrajectorySnapshot } from '@harness-trajectory/core'
import { ChatView } from '../src/chat/ChatView.tsx'
import { mockAnimationFrames } from './animation-frames.ts'

let flushFrame: () => void

// jsdom has no PointerEvent constructor and testing-library degrades to a
// bare Event, dropping button/clientX/pointerId. A MouseEvent subclass is
// enough for the capture/drag handlers under test.
if (typeof PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
    }
  }
  Object.assign(window, { PointerEvent: PointerEventPolyfill })
}

const WIDTH_KEY = 'harness-trajectory.chat.contentWidth'
const loadImage = async () => 'data:image/png;base64,fake'
const snapshot: TrajectorySnapshot = {
  ...EMPTY_TRAJECTORY_SNAPSHOT,
  eventNodes: [
    { kind: 'user', seq: 1, time: 1000, content: [{ type: 'text', text: 'Hello' }], source: {} },
    { kind: 'assistant', seq: 2, time: 2000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'Hi' }] },
  ],
}

/** jsdom reports zero layout; pin a column width for the duration of a test. */
function pinOffsetWidth(width: number): void {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width)
}

/** Pointer capture is a no-op in jsdom; the drag handlers gate on it. */
function capturable(handle: HTMLElement): void {
  Object.assign(handle, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => true,
  })
}

beforeEach(() => {
  flushFrame = mockAnimationFrames()
  localStorage.clear()
  pinOffsetWidth(1200)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function rightHandle(): HTMLElement {
  const handle = document.querySelector<HTMLElement>('[data-width-handle="right"]')
  if (handle === null) throw new Error('missing right width handle')
  return handle
}

test('renders both edge handles and publishes the measured column width', () => {
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const handles = screen.getAllByRole('separator', { name: 'Resize conversation width' })
  expect(handles).toHaveLength(2)
  expect(view.container.querySelector('[data-width-handle="left"]')).not.toBeNull()
  expect(view.container.querySelector('[data-width-handle="right"]')).not.toBeNull()
  const root = view.container.firstElementChild as HTMLElement
  expect(root.style.getPropertyValue('--dsh-conversation-column-width')).toBe('1200px')
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('')
})

test('a saved preference applies at mount, corrupt values fall back to the axis', () => {
  localStorage.setItem(WIDTH_KEY, '800')
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const root = view.container.firstElementChild as HTMLElement
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('800px')
  cleanup()
  localStorage.setItem(WIDTH_KEY, 'not-a-number')
  const again = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const root2 = again.container.firstElementChild as HTMLElement
  expect(root2.style.getPropertyValue('--dsh-chat-user-width')).toBe('')
})

test('dragging outward widens symmetrically and persists on release', () => {
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const root = view.container.firstElementChild as HTMLElement
  const handle = rightHandle()
  capturable(handle)
  // column 1200 → adaptive base = clamp(680, 768, 920) = 768; +60 outward → 888.
  fireEvent.pointerDown(handle, { button: 0, clientX: 600, pointerId: 1 })
  expect(handle.dataset.dragging).toBeDefined()
  fireEvent.pointerMove(handle, { clientX: 660, pointerId: 1, clientY: 40 })
  flushFrame()
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('888px')
  expect(localStorage.getItem(WIDTH_KEY)).toBeNull()
  fireEvent.pointerUp(handle, { clientX: 660, pointerId: 1 })
  expect(localStorage.getItem(WIDTH_KEY)).toBe('888')
  expect(handle.dataset.dragging).toBeUndefined()
})

test('the left handle drags in the opposite direction', () => {
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const root = view.container.firstElementChild as HTMLElement
  const handle = document.querySelector<HTMLElement>('[data-width-handle="left"]')
  if (handle === null) throw new Error('missing left width handle')
  capturable(handle)
  fireEvent.pointerDown(handle, { button: 0, clientX: 340, pointerId: 1 })
  fireEvent.pointerMove(handle, { clientX: 280, pointerId: 1, clientY: 40 })
  fireEvent.pointerUp(handle, { clientX: 280, pointerId: 1 })
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('888px')
  expect(localStorage.getItem(WIDTH_KEY)).toBe('888')
})

test('a press without movement leaves the preference untouched', () => {
  render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const handle = rightHandle()
  capturable(handle)
  fireEvent.pointerDown(handle, { button: 0, clientX: 600, pointerId: 1 })
  fireEvent.pointerUp(handle, { clientX: 600, pointerId: 1 })
  expect(localStorage.getItem(WIDTH_KEY)).toBeNull()
})

test('a dragged width beyond the window clamps instead of persisting raw', () => {
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const root = view.container.firstElementChild as HTMLElement
  const handle = rightHandle()
  capturable(handle)
  // column 1200 → max = 1200 - 176 = 1024; a +400 outward pull resolves to 1024.
  fireEvent.pointerDown(handle, { button: 0, clientX: 600, pointerId: 1 })
  fireEvent.pointerMove(handle, { clientX: 1000, pointerId: 1, clientY: 40 })
  fireEvent.pointerUp(handle, { clientX: 1000, pointerId: 1 })
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('1024px')
  expect(localStorage.getItem(WIDTH_KEY)).toBe('1024')
})

test('wheel over a handle scrolls the transcript', () => {
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const scroller = view.container.querySelector<HTMLElement>('[data-chat-scroll]')
  if (scroller === null) throw new Error('missing chat scrollport')
  const scrollBy = vi.fn()
  scroller.scrollBy = scrollBy
  const handle = rightHandle()
  fireEvent.wheel(handle, { deltaY: 120 })
  expect(scrollBy).toHaveBeenCalledWith({ top: 120 })
  fireEvent.wheel(handle, { deltaY: 120, ctrlKey: true })
  fireEvent.wheel(handle, { deltaY: 0 })
  expect(scrollBy).toHaveBeenCalledTimes(1)
})

test('a failed persistence write keeps the committed width and cancellation restores it', () => {
  let resize: () => void = () => { throw new Error('width observer was not attached') }
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: () => void) {}
    observe(target: HTMLElement) {
      if (target.querySelector(':scope > [data-chat-scroll]') !== null) resize = this.callback
    }
    disconnect() {}
  })
  localStorage.setItem(WIDTH_KEY, '800')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const root = view.container.firstElementChild as HTMLElement
  const handle = rightHandle()
  capturable(handle)
  fireEvent.pointerDown(handle, { button: 0, clientX: 600, pointerId: 1 })
  fireEvent.pointerMove(handle, { clientX: 640, pointerId: 1 })
  flushFrame()
  fireEvent.pointerUp(handle, { clientX: 640, pointerId: 1 })
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('880px')
  pinOffsetWidth(900)
  act(() => { resize() })
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('724px')
  pinOffsetWidth(1200)
  act(() => { resize() })
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('880px')
  fireEvent.pointerDown(handle, { button: 0, clientX: 640, pointerId: 1 })
  fireEvent.pointerMove(handle, { clientX: 680, pointerId: 1 })
  flushFrame()
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('960px')
  fireEvent.pointerCancel(handle, { pointerId: 1 })
  expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('880px')
  expect(localStorage.getItem(WIDTH_KEY)).toBe('800')
})
