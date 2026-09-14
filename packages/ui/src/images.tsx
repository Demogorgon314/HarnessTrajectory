/** Durable image rendering for trajectory records (replaces the dsh image slot). */

import { useEffect, useState, type ReactNode } from 'react'
import type { ImageAttachmentRef } from '@harness-trajectory/core'
import css from './images.module.css'

/** Resolve an image reference to a URL, with an optional synchronous cache probe. */
export type MessageImageLoader = ((attachment: ImageAttachmentRef) => Promise<string>) & {
  peek?: (attachment: ImageAttachmentRef) => string | undefined
}

export type MessageImageSource =
  | { readonly attachment: ImageAttachmentRef }
  | {
    readonly preview: {
      readonly url: string
      readonly name?: string
      readonly width?: number
      readonly height?: number
    }
  }

export interface MessageImagesOwnerProps {
  images: readonly MessageImageSource[]
  loadImage: MessageImageLoader
  align: 'start' | 'end'
  compact?: boolean
}

export type RenderMessageImages = (owner: Omit<MessageImagesOwnerProps, 'loadImage'>) => ReactNode

function AttachmentImage({ attachment, loadImage, compact }: {
  attachment: ImageAttachmentRef
  loadImage: MessageImageLoader
  compact: boolean
}) {
  const [url, setUrl] = useState<string | undefined>(() => loadImage.peek?.(attachment))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (url !== undefined) return
    let cancelled = false
    loadImage(attachment).then((resolved) => {
      if (!cancelled) setUrl(resolved)
    }, () => {
      if (!cancelled) setFailed(true)
    })
    return () => { cancelled = true }
  }, [attachment, loadImage, url])
  const label = attachment.name ?? attachment.attachmentId
  if (failed) {
    return <span className={css.missing} title={label}>{label}</span>
  }
  if (url === undefined) {
    return <span className={css.placeholder} aria-busy="true" title={label} />
  }
  return (
    <a className={css.link} href={url} target="_blank" rel="noreferrer" title={label}>
      <img className={compact ? css.compact : css.image} src={url} alt={label} loading="lazy" />
    </a>
  )
}

/** Default gallery: one row of thumbnails that open the full image in a new tab. */
export function TrajectoryImages({ images, loadImage, align, compact = false }: MessageImagesOwnerProps) {
  if (images.length === 0) return null
  return (
    <div className={css.root} data-align={align}>
      {images.map((source, index) => ('attachment' in source
        ? (
          <AttachmentImage
            key={source.attachment.attachmentId}
            attachment={source.attachment}
            loadImage={loadImage}
            compact={compact}
          />
        )
        : (
          <a
            key={`${source.preview.url}-${index}`}
            className={css.link}
            href={source.preview.url}
            target="_blank"
            rel="noreferrer"
            title={source.preview.name}
          >
            <img
              className={compact ? css.compact : css.image}
              src={source.preview.url}
              alt={source.preview.name ?? ''}
              loading="lazy"
            />
          </a>
        )))}
    </div>
  )
}
