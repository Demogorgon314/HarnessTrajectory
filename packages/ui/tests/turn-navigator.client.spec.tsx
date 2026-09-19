import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  EMPTY_TRAJECTORY_SNAPSHOT,
  type ConversationLocation,
  type ConversationNode,
  type TrajectorySnapshot,
} from '@harness-trajectory/core'
import { ChatView } from '../src/chat/ChatView.tsx'
import { TurnNavigator } from '../src/chat/TurnNavigator.tsx'
import { chatLabels } from '../src/chat/labels.ts'
import { mockAnimationFrames } from './animation-frames.ts'

let flushFrame: () => void
beforeEach(() => { flushFrame = mockAnimationFrames() })

const loadImage = async () => 'data:image/png;base64,fake'

/** Two rows per turn: a located user prompt and a located assistant answer. */
function turnSnapshot(turns: number): TrajectorySnapshot {
  const eventNodes: ConversationNode[] = []
  const eventLocations = new Map<number, ConversationLocation>()
  let seq = 0
  for (let turn = 1; turn <= turns; turn++) {
    const location: ConversationLocation = { kind: 'turn', turn: { turn, status: 'closed' } }
    seq += 1
    eventNodes.push({ kind: 'user', seq, time: seq, content: [{ type: 'text', text: `Prompt ${turn}` }], source: {} })
    eventLocations.set(seq, location)
    seq += 1
    eventNodes.push({ kind: 'assistant', seq, time: seq, turn, step: 1, blocks: [{ kind: 'text', text: `Answer ${turn}` }] })
    eventLocations.set(seq, location)
  }
  return { ...EMPTY_TRAJECTORY_SNAPSHOT, eventNodes, eventLocations }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('one mark per distinct turn, none under two, tail turn active', () => {
  const snapshot = turnSnapshot(3)
  // A second assistant step in turn 2 must not duplicate its mark.
  const nodes = [...snapshot.eventNodes]
  nodes.splice(3, 0, { kind: 'assistant', seq: 99, time: 99, turn: 2, step: 2, blocks: [{ kind: 'text', text: 'Again' }] })
  const eventLocations = new Map(snapshot.eventLocations)
  eventLocations.set(99, { kind: 'turn', turn: { turn: 2, status: 'closed' } })
  const view = render(<ChatView snapshot={{ ...snapshot, eventNodes: nodes, eventLocations }} loadImage={loadImage} />)
  flushFrame()
  const nav = view.container.querySelector<HTMLElement>('nav[aria-label="Turn navigation"]')
  expect(nav?.querySelectorAll('button')).toHaveLength(3)
  expect(screen.getByRole('button', { name: 'Jump to turn 3' }).getAttribute('aria-current')).toBe('true')
  cleanup()
  const again = render(<ChatView snapshot={turnSnapshot(1)} loadImage={loadImage} />)
  expect(again.container.querySelector('nav[aria-label="Turn navigation"]')).toBeNull()
})

test('clicking a mark scrolls to its turn and marks it active', () => {
  const view = render(<ChatView snapshot={turnSnapshot(4)} loadImage={loadImage} />)
  const scroller = screen.getByRole('region', { name: 'Chat' })
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 2000 },
  })
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect)
  for (const row of view.container.querySelectorAll<HTMLElement>('[data-chat-row]')) {
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({
      top: 16 + Number(row.dataset.chatRow) * 200 - scroller.scrollTop,
    }) as DOMRect)
  }
  scroller.scrollTop = 800
  flushFrame()
  const button = screen.getByRole('button', { name: 'Jump to turn 2' })
  fireEvent.click(button)
  expect(scroller.scrollTop).toBe(392)
  expect(button.getAttribute('aria-current')).toBe('true')
  // Subsequent scroll frames must still run; a synchronous RAF mock hides this.
  scroller.scrollTop = 800
  fireEvent.scroll(scroller)
  flushFrame()
  expect(screen.getByRole('button', { name: 'Jump to turn 3' }).getAttribute('aria-current')).toBe('true')
})

test('a paged-out turn mark extends the window on click', () => {
  // 60 turns = 120 rows: the initial window keeps only the last 100.
  const view = render(<ChatView snapshot={turnSnapshot(60)} loadImage={loadImage} />)
  const scroller = view.container.querySelector<HTMLElement>('[data-chat-scroll]')
  if (scroller === null) throw new Error('missing chat scrollport')
  expect(scroller.querySelector('[data-chat-row="0"]')).toBeNull()
  const button = screen.getByRole('button', { name: 'Jump to turn 1 (loads earlier messages)' })
  fireEvent.click(button)
  expect(scroller.querySelector('[data-chat-row="0"]')).not.toBeNull()
  expect(button.getAttribute('aria-current')).toBe('true')
})

test('streaming unrelated content preserves the manually scrolled rail', () => {
  const disconnect = vi.fn()
  const observe = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    observe = observe
    disconnect = disconnect
  })
  const snapshot = turnSnapshot(60)
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  flushFrame()
  const rail = screen.getByRole('navigation').firstElementChild
  if (!(rail instanceof HTMLElement)) throw new Error('missing rail scroller')
  Object.defineProperties(rail, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 602 },
  })
  const scrollTo = vi.fn()
  rail.scrollTo = scrollTo
  rail.scrollTop = 0
  fireEvent.scroll(rail)
  const observations = observe.mock.calls.length
  disconnect.mockClear()
  view.rerender(<ChatView snapshot={{ ...snapshot,
    partial: { turn: 60, step: 2, blocks: [{ kind: 'text', text: 'Streaming' }] },
  }} loadImage={loadImage} />)
  flushFrame()
  expect(scrollTo).not.toHaveBeenCalled()
  expect(observe).toHaveBeenCalledTimes(observations)
  expect(disconnect).not.toHaveBeenCalled()
})

test('a queued scroll frame samples a new turn arriving before it runs', () => {
  const view = render(<ChatView snapshot={turnSnapshot(3)} loadImage={loadImage} />)
  // The initial frame is still pending when a new snapshot commits.
  view.rerender(<ChatView snapshot={turnSnapshot(4)} loadImage={loadImage} />)
  flushFrame()
  expect(screen.getByRole('button', { name: 'Jump to turn 4' }).getAttribute('aria-current')).toBe('true')
})

test('returning to latest cancels a history jump waiting for replay', () => {
  const snapshot = turnSnapshot(60)
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} loading />)
  const scroll = screen.getByRole('region', { name: 'Chat' })
  Object.defineProperties(scroll, { scrollHeight: { value: 4000 }, clientHeight: { value: 400 } })
  fireEvent.click(screen.getByRole('button', { name: 'Jump to turn 1 (loads earlier messages)' }))
  const first = scroll.querySelector<HTMLElement>('[data-chat-turn="1"]')
  if (first === null) throw new Error('missing first row')
  vi.spyOn(first, 'getBoundingClientRect').mockImplementation(() => ({ top: 24 - scroll.scrollTop }) as DOMRect)
  fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
  expect(scroll.scrollTop).toBe(4000)
  view.rerender(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  expect(scroll.scrollTop).toBe(4000)
  // Follow remains enabled for subsequent content, rather than landing in history.
  view.rerender(<ChatView snapshot={turnSnapshot(61)} loadImage={loadImage} />)
  expect(scroll.scrollTop).toBe(4000)
})

test('a search landing supersedes a pending history jump on later snapshots', () => {
  const snapshot: TrajectorySnapshot = {
    ...turnSnapshot(60), sourceLines: { targetAt: () => ({ kind: 'seq', seq: 59 }) },
  }
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} loading />)
  const scroll = screen.getByRole('region', { name: 'Chat' })
  Object.defineProperties(scroll, { scrollHeight: { value: 4000 }, clientHeight: { value: 400 } })
  fireEvent.click(screen.getByRole('button', { name: 'Jump to turn 1 (loads earlier messages)' }))
  const first = scroll.querySelector<HTMLElement>('[data-chat-turn="1"]')
  const destination = scroll.querySelector<HTMLElement>('[data-chat-turn="30"]')
  if (first === null || destination === null) throw new Error('missing navigation rows')
  vi.spyOn(first, 'getBoundingClientRect').mockImplementation(() => ({ top: 24 - scroll.scrollTop }) as DOMRect)
  destination.scrollIntoView = () => { scroll.scrollTop = 2000 }
  const inspectLine = { line: 58 }
  view.rerender(<ChatView snapshot={snapshot} loadImage={loadImage} inspectLine={inspectLine} />)
  expect(scroll.scrollTop).toBe(2000)
  view.rerender(<ChatView snapshot={{ ...snapshot }} loadImage={loadImage} inspectLine={inspectLine} />)
  expect(scroll.scrollTop).toBe(2000)
})

test('actual rail height changes keep the active mark visible but respect pointer interaction', () => {
  let height = 420
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.parentElement?.tagName === 'NAV' ? height : 600
  })
  const observers = new Map<Element, () => void>()
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: () => void) {}
    observe(target: Element) { observers.set(target, this.callback) }
    disconnect() {}
  })
  const items = Array.from({ length: 60 }, (_, index) => ({ turn: index + 1, index, loaded: true, prompt: '', response: '' }))
  render(<div><TurnNavigator items={items} activeTurn={60} onNavigate={() => {}} labels={chatLabels.en} /></div>)
  const nav = screen.getByRole('navigation')
  const rail = nav.firstElementChild
  if (!(rail instanceof HTMLElement)) throw new Error('missing rail')
  const resize = observers.get(rail)
  if (resize === undefined) throw new Error('missing rail observer')
  const before = rail.scrollTop
  // Only the inner viewport changes, as during a CSS transition; band and items stay fixed.
  height = 100
  act(resize)
  expect(rail.scrollTop).toBeGreaterThan(before)
  expect(596 - rail.scrollTop).toBeGreaterThanOrEqual(0)
  expect(596 - rail.scrollTop).toBeLessThan(height)
  fireEvent.pointerEnter(nav)
  rail.scrollTop = 0
  fireEvent.scroll(rail)
  height = 80
  act(resize)
  expect(rail.scrollTop).toBe(0)
})
