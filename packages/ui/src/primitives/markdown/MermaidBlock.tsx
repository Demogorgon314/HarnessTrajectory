import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { writeClipboard } from '../clipboard.ts'
import { IconFullscreenOutline16 } from '../icons/index.tsx'
import type { MarkdownCodeLabels } from './render.tsx'
import { renderMermaid } from './mermaid.ts'
import { MermaidPreview } from './MermaidPreview.tsx'
import css from './MermaidBlock.module.css'

export const mermaidLabels = {
  en: { diagram: 'Diagram', source: 'Source', loading: 'Rendering diagram…', error: 'Unable to render diagram. Source shown below.', expand: 'Expand diagram', close: 'Close', zoom: 'Zoom', zoomIn: 'Zoom in', zoomOut: 'Zoom out', resetZoom: 'Fit to view', download: 'Download SVG' },
  zh: { diagram: '图表', source: '源码', loading: '正在渲染图表…', error: '无法渲染图表，已显示源码。', expand: '放大图表', close: '关闭', zoom: '缩放', zoomIn: '放大', zoomOut: '缩小', resetZoom: '适应窗口', download: '下载 SVG' },
}
export type MermaidLabels = typeof mermaidLabels.en

function subscribeTheme(notify: () => void): () => void {
  const observer = new MutationObserver(notify)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => { observer.disconnect() }
}
function isDark(): boolean { return document.body.hasAttribute('data-ds-dark-theme') }

/** SVG is displayed as an image, isolating its IDs and disabling active SVG content. */
export function MermaidBlock({ source, codeLabels, labels = mermaidLabels.en }: {
  source: string
  codeLabels: MarkdownCodeLabels
  labels?: MermaidLabels | undefined
}) {
  const root = useRef<HTMLDivElement>(null)
  const dark = useSyncExternalStore(subscribeTheme, isDark, () => false)
  const [visible, setVisible] = useState(false)
  const [result, setResult] = useState<{ source: string; dark: boolean; url?: string }>()
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string>()
  const current = result?.source === source && result.dark === dark ? result : undefined

  useEffect(() => {
    const element = root.current
    if (element === null) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '300px' })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let url: string | undefined
    void renderMermaid(source, dark).then(svg => {
      if (cancelled) return
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      setResult({ source, dark, url })
    }).catch(() => {
      if (!cancelled) setResult({ source, dark })
    })
    return () => {
      cancelled = true
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [source, dark, visible])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => { setCopied(false) }, 1200)
    return () => { window.clearTimeout(timer) }
  }, [copied])

  const failed = current !== undefined && current.url === undefined
  return <div className={css.block} ref={root}>
    <div className={css.toolbar}>
      <span className={css.title}>Mermaid</span>
      <button type="button" aria-pressed={showSource} onClick={() => { setShowSource(value => !value) }}>
        {showSource ? labels.diagram : labels.source}
      </button>
      <button type="button" onClick={() => { void writeClipboard(source).then(setCopied) }}>
        {copied ? codeLabels.copiedLabel : codeLabels.copyLabel}
      </button>
      {current?.url && <button type="button" className={css.expand} aria-haspopup="dialog"
        aria-label={labels.expand} title={labels.expand} onClick={() => { setPreviewUrl(current.url) }}>
        <span aria-hidden="true"><IconFullscreenOutline16 size={16} /></span>
      </button>}
    </div>
    {failed && <div className={css.status} role="status">{labels.error}</div>}
    {showSource || failed
      ? <pre className={css.source}><code>{source}</code></pre>
      : current?.url
        ? <div className={css.surface}><img src={current.url} alt={`Mermaid · ${labels.diagram}`}
            onError={() => { setResult({ source, dark }) }} /></div>
        : <div className={css.loading} role="status">{labels.loading}</div>}
    {previewUrl !== undefined && previewUrl === current?.url && <MermaidPreview
      src={previewUrl} labels={labels} onClose={() => { setPreviewUrl(undefined) }} />}
  </div>
}
