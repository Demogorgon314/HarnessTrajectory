import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { flushSync } from 'react-dom'
import { IconCloseOutline16, IconDownloadOutline16 } from '../icons/index.tsx'
import type { MermaidLabels } from './MermaidBlock.tsx'
import css from './MermaidPreview.module.css'

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8]
interface Point { x: number; y: number }
interface Size { width: number; height: number }

function pinch(points: Map<number, Point>): { center: Point; distance: number } | undefined {
  const [first, second] = points.values()
  if (!first || !second) return undefined
  return {
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    distance: Math.hypot(first.x - second.x, first.y - second.y),
  }
}

/** Modal image preview: percentages refer to SVG pixels, not the viewport width. */
export function MermaidPreview({ src, labels, onClose }: {
  src: string
  labels: MermaidLabels
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef({ backdrop: false, moved: false })
  const [natural, setNatural] = useState<Size>()
  const [available, setAvailable] = useState<Size>()
  const [manualZoom, setManualZoom] = useState<number>()
  const fit = natural && available ? Math.min(1, available.width / natural.width, available.height / natural.height) : 1
  const zoom = manualZoom ?? fit
  const minimum = Math.min(0.25, fit)
  const steps = [...new Set([...ZOOM_STEPS, fit])].sort((a, b) => a - b)

  useEffect(() => {
    const opener = document.activeElement
    const element = dialog.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element?.showModal()
    return () => {
      element?.close()
      document.body.style.overflow = previousOverflow
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = (): void => {
      setAvailable({ width: element.clientWidth, height: element.clientHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // Keep the point beneath the pointer fixed while the image changes size.
  function zoomAt(value: number, point?: Point): void {
    const element = viewport.current
    const img = image.current
    if (!element || !img || !natural) return
    const next = Math.min(8, Math.max(minimum, value))
    const box = element.getBoundingClientRect()
    const anchor = point ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    const before = img.getBoundingClientRect()
    if (before.width === 0 || before.height === 0) return
    const x = Math.min(1, Math.max(0, (anchor.x - before.left) / before.width))
    const y = Math.min(1, Math.max(0, (anchor.y - before.top) / before.height))
    flushSync(() => { setManualZoom(next) })
    const after = img.getBoundingClientRect()
    element.scrollLeft += after.left + after.width * x - anchor.x
    element.scrollTop += after.top + after.height * y - anchor.y
  }

  function stepZoom(direction: number): void {
    const next = direction > 0 ? steps.find(step => step > zoom + 0.001) : steps.findLast(step => step < zoom - 0.001)
    if (next !== undefined) zoomAt(next)
  }

  function resetZoom(): void {
    setManualZoom(undefined)
    if (viewport.current) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0 }
  }

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      // Ordinary wheel gestures pan; pinch/Ctrl-wheel zooms at the pointer.
      if (!event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1)
      zoomAt(zoom * Math.exp(-delta / 200), { x: event.clientX, y: event.clientY })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel) }
  })

  function pointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    if (pointers.current.size === 0) gesture.current = { backdrop: event.target === event.currentTarget, moved: false }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>): void {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    const before = pinch(pointers.current)
    const point = { x: event.clientX, y: event.clientY }
    pointers.current.set(event.pointerId, point)
    const after = pinch(pointers.current)
    if (Math.hypot(point.x - previous.x, point.y - previous.y) > 2) gesture.current.moved = true
    if (before && after && before.distance > 0) {
      gesture.current.moved = true
      zoomAt(zoom * after.distance / before.distance, after.center)
    } else {
      event.currentTarget.scrollLeft -= point.x - previous.x
      event.currentTarget.scrollTop -= point.y - previous.y
    }
  }

  function pointerEnd(event: PointerEvent<HTMLDivElement>): void {
    pointers.current.delete(event.pointerId)
    if (event.type === 'pointercancel') gesture.current.moved = true
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return <dialog ref={dialog} className={css.dialog} aria-label={`Mermaid · ${labels.diagram}`}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
    onKeyDown={event => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); stepZoom(1) }
      if (event.key === '-') { event.preventDefault(); stepZoom(-1) }
      if (event.key === '0') { event.preventDefault(); resetZoom() }
    }}>
    <div className={css.actions}>
      <a className={css.button} href={src} download="mermaid-diagram.svg" aria-label={labels.download} title={labels.download}>
        <span aria-hidden="true"><IconDownloadOutline16 size={18} /></span>
      </a>
      <button type="button" className={css.button} aria-label={labels.close} title={labels.close} onClick={onClose}>
        <span aria-hidden="true"><IconCloseOutline16 size={18} /></span>
      </button>
    </div>
    <div ref={viewport} className={css.viewport}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
      onClick={() => { if (gesture.current.backdrop && !gesture.current.moved) onClose() }}>
      <img ref={image} src={src} alt={`Mermaid · ${labels.diagram}`} draggable={false}
        className={css.image} style={natural ? { width: natural.width * zoom, height: natural.height * zoom } : undefined}
        onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }} />
    </div>
    <div className={css.zoomBar} role="group" aria-label={labels.zoom}>
      <button type="button" className={css.button} aria-label={labels.zoomOut} title={labels.zoomOut}
        disabled={!natural || zoom <= minimum} onClick={() => { stepZoom(-1) }}>−</button>
      <button type="button" className={css.percentage} aria-label={labels.resetZoom} title={`${labels.resetZoom} (0)`}
        onClick={resetZoom}>{Math.round(zoom * 100)}%</button>
      <button type="button" className={css.button} aria-label={labels.zoomIn} title={labels.zoomIn}
        disabled={!natural || zoom >= 8} onClick={() => { stepZoom(1) }}>+</button>
    </div>
  </dialog>
}
