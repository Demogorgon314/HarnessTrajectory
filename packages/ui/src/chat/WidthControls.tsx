/**
 * Transcript width handles (ported from dsh ConversationWidthControls): two
 * pointer-captured strips in the margins beside the message column. They only
 * publish measurements and the drag preference as custom properties on the
 * view root — the shared `--dsh-chat-content-width` axis in ChatView.module.css
 * resolves the geometry, and the handles' own CSS reads that same axis, so the
 * strips can never drift from the column they resize.
 *
 * The upstream component is elected per factory slot; this viewer has exactly
 * one occurrence (ChatView), so the axis install lives here unconditionally.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import css from './WidthHandle.module.css'

/** localStorage key for the dragged transcript width preference (px). */
const WIDTH_PREF_KEY = 'harness-trajectory.chat.contentWidth'
/** Floor for a dragged content width; matches the layout center-column minimum. */
const CONTENT_MIN = 640
/** Horizontal room reserved for both handles and their safe edge zones. */
const CONTENT_EDGE_BUDGET = 176
const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
const FALLBACK_WHEEL_LINE_PX = 16

/** Read a valid persisted width preference, or null when absent or corrupt. */
function readWidthPreference(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(WIDTH_PREF_KEY)
    if (raw === null || raw === undefined) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    // Storage may be unavailable (private mode, SSR); keep the adaptive width.
    return null
  }
}

/** Resolve the width displayed for one measured Chat column. */
function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

/** Convert a wheel event's vertical delta to scrollport pixels. */
function wheelDeltaY(event: React.WheelEvent, scrollport: HTMLElement): number {
  if (event.deltaMode === WHEEL_DELTA_LINE) {
    const lineHeight = Number.parseFloat(getComputedStyle(scrollport).lineHeight)
    return event.deltaY * (Number.isFinite(lineHeight) ? lineHeight : FALLBACK_WHEEL_LINE_PX)
  }
  if (event.deltaMode === WHEEL_DELTA_PAGE) return event.deltaY * scrollport.clientHeight
  return event.deltaY
}

/** One pointer-captured transcript width handle. */
function WidthHandle(props: {
  side: 'left' | 'right'
  label: string
  onStart: () => number
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const base = useRef(0)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const outwardWidth = () => {
    const dx = latest.current - origin.current
    const outward = callbacks.current.side === 'right' ? dx : -dx
    return base.current + outward * 2
  }
  const cancelFrame = () => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
  }
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    origin.current = event.clientX
    latest.current = event.clientX
    base.current = callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--dsh-width-handle-pointer-y', `${event.clientY - box.top}px`)
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    latest.current = event.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(outwardWidth())
    })
  }, [])
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    cancelFrame()
    latest.current = event.clientX
    // A press-only gesture must not overwrite a wider preference with its window-clamped display value.
    if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth())
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  const onPointerCancel = useCallback(() => {
    // Cancellation abandons persistence and restores the saved width through onEnd.
    cancelFrame()
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const body = event.currentTarget.parentElement
    if (body === null) return
    // The strip overlays the gutter beside the scrollport; forward the wheel so
    // a gesture starting on it still moves the transcript.
    const scrollport = body.querySelector<HTMLElement>(':scope > [data-chat-scroll]')
    if (scrollport === null) return
    if (event.ctrlKey || event.deltaY === 0) return
    scrollport.scrollBy({ top: wheelDeltaY(event, scrollport) })
  }, [])

  return (
    <div
      className={css.widthHandle}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      data-side={props.side}
      data-width-handle={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onWheel={onWheel}
    />
  )
}

/**
 * Install the chat width axis and render its drag handles.
 * @param props.container - the ChatView root element; null until its ref lands.
 * @returns the two width handles, or nothing before the root exists.
 */
export function WidthControls({ container, label }: { container: HTMLElement | null; label: string }) {
  // Persistence is best-effort. Cancellation and resize use the committed
  // in-memory preference even when storage rejects a write.
  const [initialPreference] = useState(readWidthPreference)
  const preference = useRef(initialPreference)
  const publishWidths = useCallback((container: HTMLElement): void => {
    const column = container.offsetWidth
    container.style.setProperty('--dsh-conversation-column-width', `${column}px`)
    if (preference.current === null) container.style.removeProperty('--dsh-chat-user-width')
    else container.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference.current)}px`)
  }, [])

  useLayoutEffect(() => {
    if (container === null) return
    // Publish before observing so environments without ResizeObserver (jsdom)
    // still install the measured axis once.
    publishWidths(container)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { publishWidths(container) })
    observer.observe(container)
    return () => { observer.disconnect() }
  }, [container, publishWidths])

  const onStart = useCallback((): number => {
    if (container === null) return 680
    return resolveContentWidth(container.offsetWidth, preference.current)
  }, [container])
  const onDrag = useCallback((width: number): void => {
    container?.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(container.offsetWidth, width)}px`)
  }, [container])
  const onCommit = useCallback((width: number): void => {
    if (container === null) return
    preference.current = resolveContentWidth(container.offsetWidth, width)
    try {
      globalThis.localStorage?.setItem(WIDTH_PREF_KEY, `${preference.current}`)
    } catch {
      // Storage may be unavailable; the in-session width still applies.
    }
  }, [container])
  const onEnd = useCallback((): void => {
    if (container !== null) publishWidths(container)
  }, [container, publishWidths])

  if (container === null) return null
  return (['left', 'right'] as const).map(side => (
    <WidthHandle
      key={side}
      side={side}
      label={label}
      onStart={onStart}
      onDrag={onDrag}
      onCommit={onCommit}
      onEnd={onEnd}
    />
  ))
}
