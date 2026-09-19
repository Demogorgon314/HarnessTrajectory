import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EMPTY_TRAJECTORY_SNAPSHOT, type ToolResultNode, type TrajectorySnapshot } from '@harness-trajectory/core'
import { ChatView } from '../src/chat/ChatView.tsx'
import { buildChatModel, chatTargetRow } from '../src/chat/model.ts'
import { chatFlow } from '../src/chat/flow.ts'

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView
})
const loadImage = async () => 'data:image/png;base64,fake'
const result: ToolResultNode = {
  kind: 'tool-result', seq: 3, time: 3000, callId: 'build',
  call: { name: 'Bash', argsRaw: 'make test' }, callTime: 2000,
  content: [{ type: 'text', text: 'All tests passed' }], isError: false, subCalls: [],
}
const snapshot: TrajectorySnapshot = {
  ...EMPTY_TRAJECTORY_SNAPSHOT,
  eventNodes: [
    { kind: 'user', seq: 1, time: 1000, content: [{ type: 'text', text: 'Fix **this** build' }], source: {} },
    { kind: 'assistant', seq: 2, time: 2000, turn: 1, step: 1, blocks: [
      { kind: 'reasoning', text: 'Check the failing test first.' },
      { kind: 'text', text: 'Running **tests**.' },
      { kind: 'tool-call', callId: 'build', name: 'Bash', argsRaw: 'make test' },
    ] },
    result,
  ],
  sourceLines: { targetAt: (line, file) => file === 'child' && line === 8 ? { kind: 'call', callId: 'build' } : undefined },
}

test('joins nested results to the call row and keeps orphan results readable', () => {
  const nested = { ...result, callId: 'nested', seq: 4 }
  const model = buildChatModel({ ...snapshot, eventNodes: [
    ...snapshot.eventNodes.slice(0, 2), { ...result, subCalls: [nested] }, nested,
    { ...result, callId: 'orphan', seq: 5 },
  ] })
  expect(model.nodes.map(node => node.seq)).toEqual([1, 2, 5])
  expect(chatTargetRow(model, { kind: 'call', callId: 'nested' })).toBe(1)
  expect(chatTargetRow(model, { kind: 'seq', seq: 3 })).toBe(1)
  expect(chatTargetRow(model, { kind: 'seq', seq: 4 })).toBe(1)
})

test('renders plain user bubbles, Markdown replies, and one expandable tool result', () => {
  const { container } = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  expect(screen.getByText('Fix **this** build')).toBeDefined()
  expect(container.querySelector('strong')?.textContent).toBe('tests')
  const tools = container.querySelectorAll<HTMLDetailsElement>('[data-call-id="build"]')
  expect(tools).toHaveLength(1)
  expect(tools[0]?.open).toBe(false)
  expect(screen.getByText('All tests passed')).toBeDefined()
  expect(screen.queryByRole('textbox')).toBeNull()
})

test('a result arriving before its streaming assistant settles appears only once', () => {
  const partial = { turn: 1, step: 1, blocks: [
    { kind: 'tool-call' as const, callId: 'build', name: 'Bash', argsRaw: 'make test' },
  ] }
  const live = { ...snapshot, eventNodes: [result], partial }
  const view = render(<ChatView snapshot={live} loadImage={loadImage} />)
  expect(view.container.querySelectorAll('[data-call-id="build"]')).toHaveLength(1)
  expect(screen.getAllByText('All tests passed')).toHaveLength(1)
  view.rerender(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  expect(view.container.querySelectorAll('[data-call-id="build"]')).toHaveLength(1)
  expect(screen.getAllByText('All tests passed')).toHaveLength(1)
})

test('waits for replay, reveals the file-specific tool, and re-arms the same hit', () => {
  const scroll = vi.fn()
  HTMLElement.prototype.scrollIntoView = scroll
  const applied = vi.fn()
  const anchor = { line: 8, fileId: 'child' }
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} loading inspectLine={anchor} onInspectApplied={applied} />)
  expect(applied).not.toHaveBeenCalled()
  view.rerender(<ChatView snapshot={snapshot} loadImage={loadImage} inspectLine={anchor} onInspectApplied={applied} />)
  expect(applied).toHaveBeenCalledTimes(1)
  expect(view.container.querySelector<HTMLDetailsElement>('[data-call-id="build"]')?.open).toBe(true)
  expect(scroll).toHaveBeenCalledTimes(1)
  expect(scroll).toHaveBeenLastCalledWith({ block: 'center' })
  view.rerender(<ChatView snapshot={{ ...snapshot }} loadImage={loadImage} inspectLine={anchor} onInspectApplied={applied} />)
  expect(scroll).toHaveBeenCalledTimes(1)
  view.rerender(<ChatView snapshot={snapshot} loadImage={loadImage} inspectLine={{ ...anchor }} onInspectApplied={applied} />)
  expect(scroll).toHaveBeenCalledTimes(2)
})

test('search reveals history outside the initial page without losing later messages', () => {
  const scroll = vi.fn()
  HTMLElement.prototype.scrollIntoView = scroll
  const history: TrajectorySnapshot = { ...snapshot, eventNodes: Array.from({ length: 150 }, (_, seq) => ({
    kind: 'user', seq, time: 1000, source: {}, content: [{ type: 'text', text: `Prompt ${seq}` }],
  })), sourceLines: { targetAt: () => ({ kind: 'seq', seq: 2 }) } }
  const view = render(<ChatView snapshot={history} loadImage={loadImage} />)
  expect(screen.queryByText('Prompt 2')).toBeNull()
  view.rerender(<ChatView snapshot={history} loadImage={loadImage} inspectLine={{ line: 2 }} />)
  expect(view.container.querySelector('[data-selected]')?.textContent).toContain('Prompt 2')
  expect(screen.getByText('Prompt 149')).toBeDefined()
  expect(scroll).toHaveBeenLastCalledWith({ block: 'start' })
})

test('live updates follow the tail only until the reader scrolls away', () => {
  const view = render(<ChatView snapshot={snapshot} loadImage={loadImage} />)
  const region = screen.getByRole('region', { name: 'Chat' })
  Object.defineProperties(region, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200 } })
  region.scrollTop = 100
  fireEvent.scroll(region)
  const live = { ...snapshot, partial: { turn: 1, step: 2, blocks: [{ kind: 'text' as const, text: 'A new reply' }] } }
  view.rerender(<ChatView snapshot={live} loadImage={loadImage} />)
  expect(region.scrollTop).toBe(100)
  fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
  expect(region.scrollTop).toBe(1000)
  Object.defineProperty(region, 'scrollHeight', { value: 1200 })
  view.rerender(<ChatView snapshot={{ ...live }} loadImage={loadImage} />)
  expect(region.scrollTop).toBe(1200)
})

test('reports an unavailable anchor instead of selecting an unrelated message', () => {
  render(<ChatView snapshot={snapshot} loadImage={loadImage} inspectLine={{ line: 999 }} />)
  expect(screen.getByRole('status').textContent).toContain('not available')
})

test('completed turns collapse the process, and search reveals it without hiding the answer', () => {
  const complete: TrajectorySnapshot = { ...snapshot, eventNodes: [...snapshot.eventNodes, {
    kind: 'assistant', seq: 4, time: 4000, turn: 1, step: 2,
    blocks: [{ kind: 'text', text: 'The build is fixed.' }],
  }], eventLocations: new Map([[2, { kind: 'turn', turn: { turn: 1, status: 'closed' } }],
    [4, { kind: 'turn', turn: { turn: 1, status: 'closed' } }]]) }
  const view = render(<ChatView snapshot={complete} loadImage={loadImage} />)
  const process = view.container.querySelector<HTMLDetailsElement>('[data-turn-process]')
  expect(process).not.toBeNull()
  expect(process?.open).toBe(false)
  expect(screen.getByText('The build is fixed.').closest('[data-turn-process]')).toBeNull()
  // Only the user's message and the final answer own copy controls.
  expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2)
  view.rerender(<ChatView snapshot={complete} loadImage={loadImage} inspectLine={{ line: 8, fileId: 'child' }} />)
  expect(process?.open).toBe(true)
  expect(view.container.querySelector<HTMLDetailsElement>('[data-call-id="build"]')?.open).toBe(true)
})

test.each(['open', 'unknown'] as const)('%s turns keep intermediate activity visible', status => {
  const live: TrajectorySnapshot = { ...snapshot, eventLocations: new Map([
    [2, { kind: 'turn', turn: { turn: 1, status } }],
  ]), eventNodes: [...snapshot.eventNodes, {
    kind: 'assistant', seq: 4, time: 4000, turn: 1, step: 2,
    blocks: [{ kind: 'text', text: 'Still working' }],
  }] }
  const view = render(<ChatView snapshot={live} loadImage={loadImage} />)
  expect(view.container.querySelector('[data-turn-process]')).toBeNull()
})

test('a single closed answer folds its reasoning and search reveals both', () => {
  const complete: TrajectorySnapshot = { ...snapshot, eventNodes: [{
    kind: 'assistant', seq: 4, time: 4000, turn: 1, step: 1,
    blocks: [{ kind: 'reasoning', text: 'Consider alternatives.' }, { kind: 'text', text: 'Answer' }],
  }], eventLocations: new Map([[4, { kind: 'turn', turn: { turn: 1, status: 'closed' } }]]),
  sourceLines: { targetAt: () => ({ kind: 'seq', seq: 4 }) } }
  const view = render(<ChatView snapshot={complete} loadImage={loadImage} inspectLine={{ line: 4 }} />)
  expect(view.container.querySelector<HTMLDetailsElement>('[data-turn-process]')?.open).toBe(true)
  expect(screen.getAllByText('Answer')).toHaveLength(1)
  expect(screen.getByText('Answer').closest('[data-turn-process]')).toBeNull()
})

test('a page starting inside a closed turn leaves activity visible and errors outside processes', () => {
  const complete: TrajectorySnapshot = { ...snapshot, eventNodes: [...snapshot.eventNodes, {
    kind: 'turn-error', seq: 4, time: 3500, message: 'Request interrupted', turn: 1, step: 1,
  }, { kind: 'assistant', seq: 5, time: 4000, turn: 1, step: 2, blocks: [{ kind: 'text', text: 'Recovered' }] }],
  eventLocations: new Map([2, 4, 5].map(seq => [seq, { kind: 'turn', turn: { turn: 1, status: 'closed' } }])) }
  const nodes = buildChatModel(complete).nodes
  expect(chatFlow(nodes, complete, 2).entries.every(entry => entry.kind === 'message')).toBe(true)
  const view = render(<ChatView snapshot={complete} loadImage={loadImage} />)
  expect(screen.getByText('Request interrupted').closest('[data-turn-process]')).toBeNull()
  expect(view.container.querySelector('[data-turn-process]')).not.toBeNull()
})

function toolSnapshot(name: string, args: object, output: string, isError = false): TrajectorySnapshot {
  return { ...EMPTY_TRAJECTORY_SNAPSHOT, eventNodes: [
    { kind: 'assistant', seq: 1, time: 1000, turn: 1, step: 1,
      blocks: [{ kind: 'tool-call', callId: 'tool', name, argsRaw: JSON.stringify(args) }] },
    { ...result, callId: 'tool', content: [{ type: 'text', text: output }], isError },
  ] }
}

test('recognized tool results use rich cards while errors and malformed output retain their text', () => {
  const view = render(<ChatView snapshot={toolSnapshot('Read', { file_path: '/src/a.ts' }, '1→const x = 1\n2→export { x }')} loadImage={loadImage} />)
  expect(view.container.querySelector('[data-read]')?.textContent).toContain('const x = 1')
  view.rerender(<ChatView snapshot={toolSnapshot('Read', { file_path: '/src/a.ts' }, 'Permission denied', true)} loadImage={loadImage} />)
  expect(view.container.querySelector('[data-read]')).toBeNull()
  expect(screen.getByText('Permission denied')).toBeDefined()
  view.rerender(<ChatView snapshot={toolSnapshot('Edit', { file_path: '/src/a.ts', old_string: 'before', new_string: 'after' }, 'Edited')} loadImage={loadImage} />)
  expect(view.container.querySelector('[data-diff]')).not.toBeNull()
  view.rerender(<ChatView snapshot={toolSnapshot('Grep', { pattern: 'hello' }, '/src/a.ts:7:hello world')} loadImage={loadImage} />)
  expect(view.container.querySelector('[data-search]')?.textContent).toContain('hello world')
  view.rerender(<ChatView snapshot={toolSnapshot('Grep', { pattern: 'hello' }, 'Output omitted: too many matches')} loadImage={loadImage} />)
  expect(view.container.querySelector('[data-search]')).toBeNull()
  expect(screen.getByText('Output omitted: too many matches')).toBeDefined()
})

test('terminal output replays ANSI, distinguishes empty results, and never invents a pending exit code', () => {
  const view = render(<ChatView snapshot={toolSnapshot('Bash', { command: 'echo ok' }, '\u001b[32mok\u001b[0m\n')} loadImage={loadImage} />)
  expect(view.container.querySelector('[data-terminal]')?.textContent).toContain('ok')
  expect(view.container.textContent).not.toContain('\u001b')
  view.rerender(<ChatView snapshot={toolSnapshot('Bash', { command: 'true' }, '')} loadImage={loadImage} />)
  expect(screen.getByText('No output')).toBeDefined()
  const pending = toolSnapshot('Bash', { command: 'true' }, '')
  view.rerender(<ChatView snapshot={{ ...pending, eventNodes: pending.eventNodes.slice(0, 1) }} loadImage={loadImage} />)
  expect(view.container.querySelector('[data-terminal] [data-state="idle"]')).not.toBeNull()
  expect(screen.queryByText('No output')).toBeNull()
})

test('edit previews retain the recorded outcome and explicitly describe the requested change', () => {
  const edit = toolSnapshot('Edit', { file_path: '/src/a.ts', old_string: 'before', new_string: 'after' },
    'No changes made: replacement was skipped.')
  const view = render(<ChatView snapshot={edit} loadImage={loadImage} />)
  expect(screen.getByText('No changes made: replacement was skipped.')).toBeDefined()
  expect(screen.getByText('Requested change')).toBeDefined()
  expect(view.container.querySelector('[data-diff]')).not.toBeNull()
  view.rerender(<ChatView snapshot={{ ...edit, eventNodes: edit.eventNodes.slice(0, 1) }} loadImage={loadImage} />)
  expect(screen.getByText('Requested change')).toBeDefined()
  expect(screen.queryByText('No changes made: replacement was skipped.')).toBeNull()
})

test('search opens compaction summaries and unavailable summaries stay disabled', () => {
  const scroll = vi.fn(() => {
    // The scroll must run after React mounts the controlled disclosure body.
    expect(screen.getByText('Retain the active task.')).toBeDefined()
  })
  HTMLElement.prototype.scrollIntoView = scroll
  const compact: TrajectorySnapshot = { ...EMPTY_TRAJECTORY_SNAPSHOT, eventNodes: [{
    kind: 'compaction', seq: 1, time: 1000, summary: 'Retain the active task.', summaryEventSeq: null,
    shadowedItemCount: null, shadowedTokenCount: null,
  }], sourceLines: { targetAt: () => ({ kind: 'seq', seq: 1 }) } }
  const view = render(<ChatView snapshot={compact} loadImage={loadImage} inspectLine={{ line: 1 }} />)
  expect(screen.getByText('Retain the active task.')).toBeDefined()
  expect(scroll).toHaveBeenCalledTimes(1)
  view.rerender(<ChatView snapshot={{ ...compact, eventNodes: [{
    kind: 'compaction', seq: 1, time: 1000, summary: null, summaryEventSeq: null,
    shadowedItemCount: null, shadowedTokenCount: null,
  }] }} loadImage={loadImage} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /Summary unavailable/ }).disabled).toBe(true)
})

test('image-only answers retain clocks and turn usage counts cumulative samples once', () => {
  const image = { attachmentId: 'image', mediaType: 'image/png' as const, bytes: 200, width: 200, height: 100 }
  const complete: TrajectorySnapshot = { ...EMPTY_TRAJECTORY_SNAPSHOT, eventNodes: [
    { kind: 'assistant', seq: 1, time: 1000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'Working' }],
      usage: { inputTokens: 10, outputTokens: 5 } },
    { kind: 'assistant', seq: 2, time: 2000, turn: 1, step: 2, blocks: [{ kind: 'image', attachment: image }],
      usage: { scope: 'turn', inputTokens: 20, outputTokens: 10, cacheReadTokens: 50 },
      timing: { stepStartTime: 1000, firstTokenTime: 1100, completedTime: 2000 } },
  ] }
  const view = render(<ChatView snapshot={complete} loadImage={loadImage} />)
  expect(view.container.querySelector('[data-chat-row="1"] time')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '80 tokens' }))
  const dialog = screen.getByRole('dialog', { name: 'Turn usage' })
  expect(within(dialog).getByText('80 tokens')).toBeDefined()
  expect(within(dialog).getByText('50')).toBeDefined()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('only the current streaming reasoning shows its latest line, and disclosure state follows native expansion', async () => {
  const live: TrajectorySnapshot = { ...EMPTY_TRAJECTORY_SNAPSHOT, partial: { turn: 1, step: 1,
    blocks: [{ kind: 'reasoning', text: 'First line\nLatest line' }] } }
  const view = render(<ChatView snapshot={live} loadImage={loadImage} />)
  const reasoning = view.container.querySelector('[data-variant="think"]')
  expect(reasoning?.getAttribute('data-state')).toBe('running')
  expect(reasoning?.querySelector('summary')?.textContent).toContain('Latest line')
  const details = reasoning?.querySelector('details')
  if (details === null || details === undefined) throw new Error('Missing reasoning disclosure')
  details.open = true
  fireEvent(details, new Event('toggle'))
  await waitFor(() => { expect(reasoning?.hasAttribute('data-expanded')).toBe(true) })
})
