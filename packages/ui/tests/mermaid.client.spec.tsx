import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EMPTY_TRAJECTORY_SNAPSHOT } from '@harness-trajectory/core'
import { ChatView } from '../src/chat/ChatView.tsx'
import { MarkdownText } from '../src/primitives/markdown/MarkdownText.tsx'
import { renderMermaid } from '../src/primitives/markdown/mermaid.ts'

const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: engine }))
const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }
const source = 'flowchart LR\n  A[开始] --> B[完成]'
const text = `\`\`\`mermaid\n${source}\n\`\`\``
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><text>Diagram</text></svg>'
const revoke = vi.fn()

beforeEach(() => {
  engine.initialize.mockReset()
  engine.render.mockReset().mockResolvedValue({ svg })
  revoke.mockClear()
  let id = 0
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL(): string { return `blob:diagram-${++id}` }
    static override revokeObjectURL = revoke
  })
})
afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('Chat keeps streaming Mermaid as source and renders the completed reply', async () => {
  const block = { kind: 'text' as const, text }
  const loadImage = async () => ''
  const view = render(<ChatView loadImage={loadImage} snapshot={{ ...EMPTY_TRAJECTORY_SNAPSHOT,
    partial: { turn: 1, step: 1, blocks: [block] },
  }} />)
  expect(view.container.querySelector('pre')?.textContent).toContain(source)
  expect(engine.render).not.toHaveBeenCalled()
  view.rerender(<ChatView loadImage={loadImage} snapshot={{ ...EMPTY_TRAJECTORY_SNAPSHOT,
    eventNodes: [{ kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, blocks: [block] }],
  }} />)
  await screen.findByRole('img', { name: 'Mermaid · Diagram' })
  fireEvent.click(screen.getByRole('button', { name: 'Source' }))
  expect(view.container.querySelector('pre')?.textContent).toBe(source)
  view.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:diagram-1')
})

test('a failed diagram exposes source without blocking other diagrams or leaving scratch DOM', async () => {
  engine.render.mockImplementationOnce(async (_id, _source, container: HTMLElement) => {
    container.innerHTML = '<div>temporary failed render</div>'
    throw new Error('invalid syntax')
  })
  render(<MarkdownText text={`${text}\n\n${text}`} labels={labels} />)
  await screen.findByText('Unable to render diagram. Source shown below.')
  await screen.findByRole('img', { name: 'Mermaid · Diagram' })
  expect(screen.getByText(source, { normalizer: value => value }).tagName).toBe('CODE')
  expect(screen.queryByText('temporary failed render')).toBeNull()
  expect(engine.render.mock.calls[0]?.[0]).not.toBe(engine.render.mock.calls[1]?.[0])
})

test('source replacement ignores an obsolete result and theme changes regenerate the image', async () => {
  let finish: ((value: { svg: string }) => void) | undefined
  engine.render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<MarkdownText text={text} labels={labels} />)
  await waitFor(() => { expect(engine.render).toHaveBeenCalledTimes(1) })
  view.rerender(<MarkdownText text={text.replace('完成', '更新')} labels={labels} />)
  await act(async () => { finish?.({ svg }) })
  const image = await screen.findByRole('img', { name: 'Mermaid · Diagram' })
  expect(image.getAttribute('src')).toBe('blob:diagram-1')
  await act(async () => { document.body.setAttribute('data-ds-dark-theme', '') })
  await waitFor(() => { expect(screen.getByRole('img', { name: 'Mermaid · Diagram' }).getAttribute('src')).toBe('blob:diagram-2') })
  expect(engine.initialize.mock.lastCall?.[0].themeVariables.darkMode).toBe(true)
  expect(revoke).toHaveBeenCalledWith('blob:diagram-1')
})

test('offscreen diagrams wait until the observer activates them', async () => {
  let activate: (() => void) | undefined
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      activate = () => { callback([{ isIntersecting: true }]) }
    }
    observe(): void {}
    disconnect(): void {}
  })
  render(<MarkdownText text={text} labels={labels} />)
  expect(engine.render).not.toHaveBeenCalled()
  await act(async () => { activate?.() })
  await screen.findByRole('img', { name: 'Mermaid · Diagram' })
})

test('render queue holds configuration until each render finishes and recovers from rejection', async () => {
  let fail: ((reason: Error) => void) | undefined
  engine.render.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  const first = renderMermaid('invalid', false).catch(() => 'failed')
  const second = renderMermaid(source, true)
  await waitFor(() => { expect(engine.render).toHaveBeenCalledTimes(1) })
  expect(engine.initialize).toHaveBeenCalledTimes(1)
  fail?.(new Error('syntax'))
  expect(await first).toBe('failed')
  expect(await second).toBe(svg)
  expect(engine.initialize).toHaveBeenCalledTimes(2)
  expect(engine.initialize.mock.lastCall?.[0].securityLevel).toBe('strict')
})

test('SVG images retain diagram dimensions instead of the browser percentage-size fallback', async () => {
  engine.render.mockResolvedValueOnce({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 480 160"><text>Graph</text></svg>' })
  const result = new DOMParser().parseFromString(await renderMermaid(source, false), 'image/svg+xml')
  expect(result.documentElement.getAttribute('width')).toBe('480')
  expect(result.documentElement.getAttribute('height')).toBe('160')
  expect(result.querySelector('text')?.textContent).toBe('Graph')
})
