/**
 * Column drag handle (ported from dsh AppFrame): pointer capture plus
 * rAF-throttled dx reports against the drag-start origin.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import css from './app.module.css'

export interface DragHandleProps {
  /** Horizontal position of the column border the handle straddles. */
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
}

export function DragHandle(props: DragHandleProps) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || capture.current !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    capture.current = { element: event.currentTarget, id: event.pointerId }
    origin.current = event.clientX
    latest.current = event.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    latest.current = event.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    callbacks.current.onDrag(event.clientX - origin.current)
    endDrag()
  }, [endDrag])
  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id === event.pointerId) endDrag()
  }, [endDrag])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}
