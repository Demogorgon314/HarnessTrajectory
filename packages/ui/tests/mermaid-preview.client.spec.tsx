import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MermaidPreview } from '../src/primitives/markdown/MermaidPreview.tsx'
import { mermaidLabels } from '../src/primitives/markdown/MermaidBlock.tsx'

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(500)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = this instanceof HTMLImageElement ? Number.parseFloat(this.style.width) || 1000 : 600
    const height = this instanceof HTMLImageElement ? Number.parseFloat(this.style.height) || 500 : 400
    const x = this instanceof HTMLImageElement ? Math.max(0, (600 - width) / 2) - (this.parentElement?.scrollLeft ?? 0) : 0
    const y = this instanceof HTMLImageElement ? Math.max(0, (400 - height) / 2) - (this.parentElement?.scrollTop ?? 0) : 0
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) }
  })
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const [key, descriptor] of [['showModal', originalShow], ['close', originalClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key)
  }
})

function preview() {
  const close = vi.fn()
  const view = render(<MermaidPreview src="blob:test-diagram" labels={mermaidLabels.en} onClose={close} />)
  const img = screen.getByRole('img')
  fireEvent.load(img)
  const viewport = img.parentElement
  if (!viewport) throw new Error('Missing preview viewport')
  return { ...view, img, viewport, close }
}

test('fits without upscaling, zooms in natural pixels, and resets on reopen', () => {
  const first = preview()
  expect(first.img.style.width).toBe('600px')
  expect(screen.getByRole('button', { name: 'Fit to view' }).textContent).toBe('60%')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(first.img.style.width).toBe('750px')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: '=' })
  expect(first.img.style.width).toBe('1000px')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: '0' })
  expect(first.img.style.width).toBe('600px')
  expect(first.viewport.scrollLeft).toBe(0)
  first.unmount()
  expect(preview().img.style.width).toBe('600px')
})

test('Ctrl-wheel anchors the image point under the pointer; ordinary wheel is left for scrolling', () => {
  const { img, viewport } = preview()
  const initial = img.getBoundingClientRect()
  const fraction = (400 - initial.left) / initial.width
  fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -100, clientX: 400, clientY: 200 })
  const after = img.getBoundingClientRect()
  expect(after.left + after.width * fraction).toBeCloseTo(400)
  const width = img.style.width
  fireEvent.wheel(viewport, { deltaY: 100 })
  expect(img.style.width).toBe(width)
})

test('download preserves the SVG, Escape dismisses, and unmount restores focus and page scrolling', () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  document.body.style.overflow = 'auto'
  const view = preview()
  const download = screen.getByRole('link', { name: 'Download SVG' })
  expect(download.getAttribute('href')).toBe('blob:test-diagram')
  expect(download.getAttribute('download')).toBe('mermaid-diagram.svg')
  expect(document.body.style.overflow).toBe('hidden')
  fireEvent.click(view.img)
  expect(view.close).not.toHaveBeenCalled()
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(view.close).toHaveBeenCalledOnce()
  view.unmount()
  expect(document.activeElement).toBe(opener)
  expect(document.body.style.overflow).toBe('auto')
  opener.remove()
  document.body.style.overflow = ''
})
