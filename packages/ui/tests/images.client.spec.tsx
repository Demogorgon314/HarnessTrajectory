// @vitest-environment jsdom
/**
 * Trajectory image gallery and its original-image preview, ported together with
 * their sources from deepseek-harness:
 *   packages/client/ui-attachment/tests/image-lightbox.client.spec.tsx
 *   packages/client/ui-attachment/tests/message-image.client.spec.tsx
 *
 * Thumbnails are buttons, never anchors — Chrome refuses top-level navigation to
 * the `data:` URLs these previews carry — and the preview is a body portal closed
 * by Escape, a mask press, or the close control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ImageAttachmentRef } from '@harness-trajectory/core'
import { ImageLightbox } from '../src/ImageLightbox.tsx'
import { TrajectoryImages, DEFAULT_MESSAGE_IMAGE_LABELS as labels, type MessageImageLoader } from '../src/images.tsx'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

const NEVER_LOADS: MessageImageLoader = () => new Promise<string>(() => {})

const attachment: ImageAttachmentRef = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 1024,
  width: 640,
  height: 320,
  name: 'history.png',
}

const OPEN_HISTORY = labels.openNamed('history.png')

afterEach(cleanup)

describe('TrajectoryImages gallery', () => {
  it('renders nothing without images', () => {
    const { container } = render(<TrajectoryImages images={[]} loadImage={NEVER_LOADS} align="start" />)
    expect(container.firstChild).toBe(null)
  })

  it('renders a lone image large and compact or grouped images as square tiles', () => {
    const lone = render(<TrajectoryImages images={[{ attachment }]} loadImage={NEVER_LOADS} align="start" />)
    expect(lone.container.querySelectorAll('[data-variant="single"]')).toHaveLength(1)
    expect(lone.container.querySelector('[data-align="start"]')).not.toBe(null)
    lone.unmount()
    const compact = render(
      <TrajectoryImages images={[{ attachment }]} loadImage={NEVER_LOADS} align="end" compact />,
    )
    expect(compact.container.querySelectorAll('[data-variant="tile"]')).toHaveLength(1)
    compact.unmount()
    const several = render(
      <TrajectoryImages
        images={[{ attachment }, { attachment }, { preview: { url: PNG } }]}
        loadImage={NEVER_LOADS}
        align="end"
      />,
    )
    expect(several.container.querySelectorAll('[data-variant="tile"]')).toHaveLength(3)
    expect(several.container.querySelector('[data-align="end"]')).not.toBe(null)
  })

  it('bounds a lone image by its recorded dimensions and a tile by the fixed square', () => {
    const lone = render(<TrajectoryImages images={[{ attachment }]} loadImage={NEVER_LOADS} align="start" />)
    const frame = lone.getByRole('button', { name: OPEN_HISTORY })
    expect(frame.getAttribute('style')).toContain('width: 240px')
    expect(frame.getAttribute('style')).toContain('height: 120px')
    lone.unmount()
    const tile = render(<TrajectoryImages images={[{ attachment }]} loadImage={NEVER_LOADS} align="start" compact />)
    expect(tile.getByRole('button', { name: OPEN_HISTORY }).getAttribute('style')).toBe(null)
  })

  it('treats a 0×0 record as an unknown size instead of dividing by it', () => {
    // Claude transcripts record no dimensions; dsh's intake probe always had them.
    render(
      <TrajectoryImages
        images={[{ attachment: { ...attachment, width: 0, height: 0 } }]}
        loadImage={NEVER_LOADS}
        align="start"
      />,
    )
    const frame = screen.getByRole('button', { name: OPEN_HISTORY })
    expect(frame.getAttribute('style')).toContain('width: 240px')
    expect(frame.getAttribute('style')).toContain('height: 240px')
  })

  it('shows the loading label until bytes resolve and ignores a click meanwhile', () => {
    render(<TrajectoryImages images={[{ attachment }]} loadImage={NEVER_LOADS} align="start" />)
    expect(screen.getByText(labels.loading)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: OPEN_HISTORY }))
    expect(screen.queryByRole('dialog')).toBe(null)
  })

  it('renders a peeked URL on the first frame while refreshing it', () => {
    const loadImage = Object.assign(
      vi.fn(() => new Promise<string>(() => {})) as unknown as MessageImageLoader,
      { peek: vi.fn(() => PNG) },
    )
    render(<TrajectoryImages images={[{ attachment }]} loadImage={loadImage} align="start" />)
    expect(screen.queryByText(labels.loading)).toBe(null)
    expect((screen.getByAltText('history.png') as HTMLImageElement).src).toBe(PNG)
    expect(loadImage).toHaveBeenCalledWith(attachment)
  })

  it('falls back to the image label for an unnamed attachment', async () => {
    const { name: _named, ...unnamed } = attachment
    const loadImage = vi.fn(async () => JPEG) as unknown as MessageImageLoader
    render(<TrajectoryImages images={[{ attachment: unnamed }]} loadImage={loadImage} align="start" />)
    await waitFor(() => { expect(screen.getByAltText(labels.image)).toBeTruthy() })
    expect(screen.getByRole('button', { name: labels.openNamed(labels.image) })).toBeTruthy()
  })

  it('surfaces a retry control when the load fails, then recovers on retry', async () => {
    const loadImage = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce(JPEG) as unknown as MessageImageLoader
    render(<TrajectoryImages images={[{ attachment }]} loadImage={loadImage} align="start" compact />)
    const retry = await screen.findByRole('button', { name: labels.loadFailed })
    expect(retry.getAttribute('data-variant')).toBe('tile') // the failed tile keeps its grid cell
    fireEvent.click(retry)
    fireEvent.click(await screen.findByRole('button', { name: labels.loadFailed }))
    await waitFor(() => { expect(screen.getByAltText('history.png')).toBeTruthy() })
    expect(loadImage).toHaveBeenCalledTimes(3)
  })

  it('displays a local preview immediately, without the loader', () => {
    const loadImage = vi.fn() as unknown as MessageImageLoader
    render(
      <TrajectoryImages
        images={[{ preview: { url: PNG, name: 'echo.png', width: 640, height: 320 } }]}
        loadImage={loadImage}
        align="start"
      />,
    )
    expect(loadImage).not.toHaveBeenCalled()
    const img = screen.getByAltText('echo.png') as HTMLImageElement
    expect(img.src).toBe(PNG)
    expect((img.closest('button') as HTMLButtonElement).style.width).toBe('240px')
  })

  it('ignores a load settling after unmount', async () => {
    let resolve: ((url: string) => void) | undefined
    const loadImage = vi.fn(() => new Promise<string>((r) => { resolve = r })) as unknown as MessageImageLoader
    const view = render(<TrajectoryImages images={[{ attachment }]} loadImage={loadImage} align="start" />)
    view.unmount()
    resolve?.(JPEG)
    await Promise.resolve()
    let reject: ((error: Error) => void) | undefined
    const failing = vi.fn(() => new Promise<string>((_r, rej) => { reject = rej })) as unknown as MessageImageLoader
    const second = render(<TrajectoryImages images={[{ attachment }]} loadImage={failing} align="start" />)
    second.unmount()
    reject?.(new Error('late failure'))
    await Promise.resolve()
  })
})

describe('TrajectoryImages preview', () => {
  it('renders no anchors at all, only a dialog-opening button', () => {
    const { container } = render(
      <TrajectoryImages
        images={[{ preview: { url: PNG, name: 'shot.png', width: 12, height: 8 } }]}
        loadImage={NEVER_LOADS}
        align="start"
      />,
    )
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.querySelectorAll('[target="_blank"]')).toHaveLength(0)
    const button = screen.getByRole('button')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('title')).toBe(labels.open)
    expect(screen.queryByRole('dialog')).toBe(null)
  })

  it('opens a dialog holding the same src, captioned with the recorded size', () => {
    render(
      <TrajectoryImages
        images={[{ preview: { url: PNG, name: 'shot.png', width: 12, height: 8 } }]}
        loadImage={NEVER_LOADS}
        align="start"
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    const dialog = screen.getByRole('dialog', { name: labels.lightbox.dialog })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.parentElement).toBe(document.body)
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(PNG)
    expect(dialog.textContent).toContain('shot.png')
    expect(dialog.textContent).toContain('12×8')
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: labels.lightbox.close }))
  })

  it('prefers the decoded natural size and never prints 0×0', () => {
    const loadImage = Object.assign(
      (() => new Promise<string>(() => {})) as MessageImageLoader,
      { peek: () => PNG },
    )
    render(
      <TrajectoryImages
        images={[{ attachment: { ...attachment, width: 0, height: 0 } }]}
        loadImage={loadImage}
        align="start"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: OPEN_HISTORY }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('history.png')
    expect(dialog.textContent).not.toContain('×') // unknown stays silent, never 0×0
    const full = within(dialog).getByRole('img')
    Object.defineProperty(full, 'naturalWidth', { configurable: true, value: 300 })
    Object.defineProperty(full, 'naturalHeight', { configurable: true, value: 150 })
    fireEvent.load(full)
    expect(dialog.textContent).toContain('300×150')
  })

  it('resolves an attachment through the loader, then opens the same URL', async () => {
    const loadImage = vi.fn(async () => JPEG) as unknown as MessageImageLoader
    render(<TrajectoryImages images={[{ attachment }]} loadImage={loadImage} align="start" />)
    await waitFor(() => { expect(screen.getByAltText('history.png')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: OPEN_HISTORY }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(JPEG)
    expect(dialog.textContent).toContain('640×320')
    expect(document.querySelectorAll('a')).toHaveLength(0)
  })

  it('closes on a mask press but not on a press or click over the image', () => {
    render(
      <TrajectoryImages images={[{ preview: { url: PNG, name: 'shot.png' } }]} loadImage={NEVER_LOADS} align="start" />,
    )
    fireEvent.click(screen.getByRole('button'))
    const dialog = screen.getByRole('dialog')
    const full = within(dialog).getByRole('img')
    fireEvent.mouseDown(full)
    fireEvent.click(full)
    expect(screen.queryByRole('dialog')).toBeTruthy()
    const mask = dialog.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(screen.queryByRole('dialog')).toBe(null)
  })

  it('closes on Escape and restores focus to the thumbnail that opened it', () => {
    render(
      <TrajectoryImages images={[{ preview: { url: PNG, name: 'shot.png' } }]} loadImage={NEVER_LOADS} align="start" />,
    )
    const thumbnail = screen.getByRole('button')
    thumbnail.focus()
    fireEvent.click(thumbnail)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'a' })
    expect(screen.queryByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBe(null)
    expect(document.activeElement).toBe(thumbnail)
  })

  it('closes from the close control', () => {
    render(
      <TrajectoryImages images={[{ preview: { url: PNG, name: 'shot.png' } }]} loadImage={NEVER_LOADS} align="start" />,
    )
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: labels.lightbox.close }))
    expect(screen.queryByRole('dialog')).toBe(null)
  })
})

describe('ImageLightbox', () => {
  it('focuses its close control, closes by button and Escape, and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(<ImageLightbox src={PNG} alt="original" onClose={onClose} />)
    const close = view.getByRole('button', { name: labels.lightbox.close })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('renders no caption at all when the owner supplies none', () => {
    render(<ImageLightbox src={PNG} alt="original" onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: labels.lightbox.dialog })
    expect(dialog.querySelector('p')).toBe(null)
    // The caption is opt-in, so an unattached onLoad cannot print anything either.
    const full = within(dialog).getByRole('img')
    Object.defineProperty(full, 'naturalWidth', { configurable: true, value: 300 })
    Object.defineProperty(full, 'naturalHeight', { configurable: true, value: 150 })
    fireEvent.load(full)
    expect(dialog.textContent).not.toContain('300')
  })

  it('accepts owner-supplied labels', () => {
    render(
      <ImageLightbox
        src={PNG}
        alt="original"
        labels={{ dialog: 'Attachment preview', close: 'Close' }}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Attachment preview' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('tolerates a focus owner it cannot restore (no active element at mount)', () => {
    // jsdom always reports body as the fallback active element; stub the
    // element-less state a detached focus can leave.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<ImageLightbox src={PNG} alt="original" onClose={vi.fn()} />)
      view.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
  })

  it('closes on a mask press but not on a press over the image', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src={PNG} alt="original" onClose={onClose} />)
    fireEvent.mouseDown(view.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
