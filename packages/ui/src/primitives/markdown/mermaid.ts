/** Mermaid owns global configuration and temporary DOM: serialize both together. */
let queue: Promise<unknown> = Promise.resolve()
let nextId = 0

export function renderMermaid(source: string, dark: boolean): Promise<string> {
  const job = queue.then(async () => {
    if (source.length > 50_000) throw new Error('Diagram exceeds rendering limit')
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      // Transcript directives cannot override the application's trust boundary.
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
        'suppressErrorRendering', 'themeCSS', 'htmlLabels'],
      htmlLabels: false,
      flowchart: { htmlLabels: false, curve: 'rounded' },
      theme: 'base',
      themeVariables: {
        darkMode: dark,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: '14px',
        background: dark ? '#18181b' : '#ffffff',
        primaryColor: dark ? '#27272a' : '#f4f4f5',
        primaryTextColor: dark ? '#f4f4f5' : '#27272a',
        primaryBorderColor: dark ? '#71717a' : '#a1a1aa',
        lineColor: dark ? '#a1a1aa' : '#71717a',
        secondaryColor: dark ? '#303036' : '#eeeef0',
        tertiaryColor: dark ? '#202024' : '#fafafa',
      },
    })
    const container = document.createElement('div')
    container.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden'
    document.body.append(container)
    try {
      const { svg } = await mermaid.render(`trajectory-mermaid-${++nextId}`, source, container)
      // Mermaid's percentage width is intended for inline SVG. Give image-mode
      // SVG intrinsic dimensions so small diagrams do not stretch to fill chat.
      const svgDocument = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const element = svgDocument.documentElement
      const bounds = element.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
      const width = bounds?.[2]
      const height = bounds?.[3]
      if (width !== undefined && height !== undefined && Number.isFinite(width) && Number.isFinite(height)
        && width > 0 && height > 0) {
        element.setAttribute('width', String(width))
        element.setAttribute('height', String(height))
      }
      return new XMLSerializer().serializeToString(element)
    } finally {
      container.remove()
    }
  })
  // A malformed diagram must not poison subsequent jobs.
  queue = job.catch(() => undefined)
  return job
}
