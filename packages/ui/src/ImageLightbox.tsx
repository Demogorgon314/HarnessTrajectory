/**
 * Original-image preview, ported from deepseek-harness (MIT, © DeepSeek — see
 * packages/ui/LICENSE.deepseek-harness):
 *   packages/client/ui-attachment/src/ImageLightbox.tsx
 *   packages/client/ui-attachment/src/ImageLightbox.module.css
 *
 * Ported verbatim except for two additions this app needs: the labels default to
 * English constants (packages/ui carries no i18n, where dsh injected them through
 * ui-attachment/src/client/labels.ts), and an optional caption — display name plus
 * the decoded natural size — because harness transcripts hand us references whose
 * recorded dimensions are often absent or 0×0.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from './primitives/icons/index.tsx'
import css from './ImageLightbox.module.css'

/** Lightbox strings the owner resolves from its own locale namespace. */
export interface ImageLightboxLabels {
  /** Accessible name of the preview dialog. */
  dialog: string
  /** Accessible label of the close control. */
  close: string
}

/** English defaults; dsh resolved these from the conversation namespace. */
export const DEFAULT_IMAGE_LIGHTBOX_LABELS: ImageLightboxLabels = {
  dialog: 'Image preview',
  close: 'Close image preview',
}

/** Optional caption facts. A dimension that is missing or 0 prints nothing — never `0×0`. */
export interface ImageLightboxCaption {
  readonly name?: string | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
}

export interface ImageLightboxProps {
  /** The original image URL. */
  src: string
  /** The image's alt text. */
  alt: string
  /** Dialog and close-control strings; English defaults when omitted. */
  labels?: ImageLightboxLabels
  /** Caption facts; omitted entirely renders the bare dsh preview. */
  caption?: ImageLightboxCaption | undefined
  /** Dismiss callback owned by the opener. */
  onClose: () => void
}

/**
 * Document-level original-image preview opened by clicking a thumbnail.
 * Closes on Escape, backdrop press, or the close control, and restores focus
 * to the opener on unmount. Rendered through a body portal: an opener inside
 * a transformed or filtered ancestor would otherwise trap the fixed backdrop
 * in that ancestor's box instead of covering the viewport.
 *
 * @param props.src - the original image URL.
 * @param props.alt - the image's alt text.
 * @param props.labels - dialog and close-control strings.
 * @param props.caption - optional display name and recorded dimensions.
 * @param props.onClose - dismiss callback owned by the opener.
 * @returns the modal preview dialog.
 */
export function ImageLightbox({
  src,
  alt,
  labels = DEFAULT_IMAGE_LIGHTBOX_LABELS,
  caption,
  onClose,
}: ImageLightboxProps): ReactElement {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  // The decoded size beats the recorded one: harness refs may carry no dimensions
  // at all (Claude records none), so the caption stays silent until a size is real.
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [onClose])

  const recorded = caption?.width !== undefined && caption.height !== undefined
    ? { width: caption.width, height: caption.height }
    : null
  const known = natural ?? recorded
  const size = known !== null && known.width > 0 && known.height > 0
    ? `${known.width}×${known.height}`
    : undefined
  const name = caption?.name
  const captioned = caption !== undefined && (name !== undefined || size !== undefined)

  return createPortal(
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
      <img
        className={css.image}
        src={src}
        alt={alt}
        onLoad={caption === undefined
          ? undefined
          : (event) => {
            const img = event.currentTarget
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setNatural({ width: img.naturalWidth, height: img.naturalHeight })
            }
          }}
      />
      {captioned && (
        <p className={css.caption}>
          {name !== undefined && <span className={css.captionName}>{name}</span>}
          {size !== undefined && <span className={css.captionSize}>{size}</span>}
        </p>
      )}
      <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>
        <IconCloseOutline16 size={16} />
      </button>
    </div>,
    document.body,
  )
}
