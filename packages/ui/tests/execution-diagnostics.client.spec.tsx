import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ModelRetryNode, ToolResultNode } from '@harness-trajectory/core'
import { ExecutionDiagnostics } from '../src/trajectory/ExecutionDiagnostics.tsx'
import { t } from './locale.ts'

afterEach(cleanup)

function call(seq: number, isError = true): ToolResultNode {
  return { kind: 'tool-result', seq, time: seq * 1000 + 500, callTime: seq * 1000,
    callId: `call-${seq}`, call: { name: 'Bash', argsRaw: '{}' }, isError, content: [], subCalls: [] }
}

function retry(seq: number): ModelRetryNode {
  return { kind: 'model-retry', seq, time: seq * 1000, retryState: 'scheduled', turn: 1, step: 1,
    provider: 'anthropic', retry: 1, maxRetries: 3, delayMs: 1000,
    failure: { message: `fail ${seq}`, code: 'overloaded' } }
}

it('cycles focus in both directions, contains external focus and handles Escape with restoration', () => {
  const close = vi.fn()
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const props = { nodes: [call(1)], t, onInspect: vi.fn(), onInspectSeq: vi.fn(), onClose: close }
  const view = render(<ExecutionDiagnostics {...props} open />)
  const buttons = within(screen.getByRole('dialog')).getAllByRole('button')
  const first = buttons[0]
  const last = buttons.at(-1)
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(document.activeElement ?? window, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  fireEvent.keyDown(document.activeElement ?? window, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  opener.focus()
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  view.rerender(<ExecutionDiagnostics {...props} open={false} />)
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

it('expands long evidence chains and omitted groups, links recovery, and resets on reopen', () => {
  const inspect = vi.fn()
  const nodes = [
    ...Array.from({ length: 8 }, (_, i) => call(i + 1)), call(9, false),
    call(10), call(11), call(12), call(13, false), call(14), call(15), call(16),
    call(17, false), call(18), call(19), call(20),
  ]
  const props = { nodes, t, onInspect: inspect, onInspectSeq: vi.fn(), onClose: vi.fn() }
  const view = render(<ExecutionDiagnostics {...props} open />)
  const failuresSection = screen.getByRole('heading', { name: /Tool call loops/ }).closest('section')
  if (failuresSection === null) throw new Error('Missing failures section')
  expect(within(failuresSection).getAllByRole('article')).toHaveLength(3)
  expect(screen.getAllByRole('article')).toHaveLength(4)
  const expand = screen.getByRole('button', { name: 'Show all 8 calls' })
  const card = expand.closest('article')
  if (card === null) throw new Error('Missing evidence card')
  expect(within(card).queryByRole('button', { name: 'View call 3' })).toBeNull()
  fireEvent.click(expand)
  fireEvent.click(within(card).getByRole('button', { name: 'View call 3' }))
  expect(inspect).toHaveBeenLastCalledWith('call-3')
  fireEvent.click(within(card).getByRole('button', { name: 'View successful call' }))
  expect(inspect).toHaveBeenLastCalledWith('call-9')
  fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
  expect(within(failuresSection).getAllByRole('article')).toHaveLength(4)
  view.rerender(<ExecutionDiagnostics {...props} open={false} />)
  view.rerender(<ExecutionDiagnostics {...props} open />)
  const reopenedSection = screen.getByRole('heading', { name: /Tool call loops/ }).closest('section')
  if (reopenedSection === null) throw new Error('Missing reopened failures section')
  expect(within(reopenedSection).getAllByRole('article')).toHaveLength(3)
  const reopenedCard = screen.getByRole('button', { name: 'Show all 8 calls' }).closest('article')
  if (reopenedCard === null) throw new Error('Missing reopened evidence card')
  expect(within(reopenedCard).queryByRole('button', { name: 'View call 3' })).toBeNull()
})

it('locates a troubled model step by seq and renders empty sections without findings', () => {
  const inspectSeq = vi.fn()
  const props = { nodes: [retry(1), retry(2)], t, onInspect: vi.fn(), onInspectSeq: inspectSeq, onClose: vi.fn() }
  const view = render(<ExecutionDiagnostics {...props} open />)
  fireEvent.click(screen.getByRole('button', { name: 'Locate this step' }))
  expect(inspectSeq).toHaveBeenCalledWith(1)
  view.rerender(<ExecutionDiagnostics {...props} nodes={[]} open />)
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3)
  expect(screen.queryAllByRole('article')).toEqual([])
  for (const name of [/Tool call loops/, /Model requests/, /Tool timing/]) {
    const section = screen.getByRole('heading', { name }).closest('section')
    if (section === null) throw new Error(`Missing section for ${String(name)}`)
    expect(within(section).getAllByRole('paragraph')).toHaveLength(1)
  }
})
