import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { UsageBucket, UsageReport, UsageStreamEvent } from '@harness-trajectory/core'
import { TokenUsage } from '../src/TokenUsage.tsx'
import { activityStreak, filterUsage } from '../src/usage-summary.ts'
import { streamUsage } from '../src/api.ts'

const bucket: UsageBucket = { sessionId: 'one', kind: 'codex', model: 'model-a', provider: 'openai',
  time: new Date(2026, 8, 20, 12).getTime(), requests: 1, measured: 1, turnTotals: 0,
  input: 80, output: 20, total: 100, cacheRead: 30, cacheWrite: 0, reasoning: 5 }
const report: UsageReport = { buckets: [bucket, { ...bucket, model: 'model-b', total: 200, time: null }],
  sessions: [{ id: 'one', kind: 'codex', title: 'Example' }], failedSessions: 0, updatedAt: Date.now() }

const update = (value = report, completed = 1, total = 1, done = true): UsageStreamEvent => ({
  type: 'progress', report: value,
  progress: { completed, total, done, records: completed * 10, currentSession: done ? null : 'Reading session' },
})
const response = () => new Response(`${JSON.stringify(update())}\n`)

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('filters by local calendar date and keeps undated samples only in all time', () => {
  const filters = { start: '2026-09-20', end: '2026-09-20', kind: '', model: '', provider: '', query: '' }
  expect(filterUsage(report.buckets, filters)).toEqual([bucket])
  expect(filterUsage(report.buckets, { ...filters, start: '', end: '' })).toHaveLength(2)
  expect(filterUsage(report.buckets, { ...filters, model: 'model-b' })).toEqual([])
  expect(filterUsage(report.buckets, { ...filters, query: 'OPENAI' })).toEqual([bucket])
  expect(activityStreak(new Set(['2026-09-18', '2026-09-19', '2026-09-20']), '2026-09-21')).toEqual({ current: 3, longest: 3 })
})

it('updates totals when filters change and replaces refreshed data instead of adding it', async () => {
  const fetch = vi.fn().mockImplementation(async () => response())
  vi.stubGlobal('fetch', fetch)
  render(<TokenUsage />)
  await screen.findByText(/local sessions scanned/)
  fireEvent.click(screen.getByRole('button', { name: /^All$/ }))
  expect(screen.getByTestId('usage-total').textContent).toBe('300')
  fireEvent.click(screen.getByRole('button', { name: 'Usage model' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'model-b' }))
  expect(screen.getByTestId('usage-total').textContent).toBe('200')
  let finishRefresh = () => {}
  fetch.mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`${JSON.stringify(update({ ...report, buckets: [], sessions: [] }, 0, 1, false))}\n`))
    finishRefresh = () => {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(update())}\n`))
      controller.close()
    }
  } })))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
  expect(screen.getByTestId('usage-total').textContent).toBe('200')
  await act(async () => { finishRefresh() })
  await waitFor(() => { expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false) })
  expect(screen.getByTestId('usage-total').textContent).toBe('200')
  fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
  fireEvent.change(screen.getByLabelText('Usage end date'), { target: { value: '2020-01-01' } })
  expect(screen.getByRole('alert').textContent).toContain('valid start')
})

it('supports keyboard selection and outside dismissal for usage filters', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response()))
  render(<TokenUsage />)
  await screen.findByText(/local sessions scanned/)
  fireEvent.click(screen.getByRole('button', { name: /^All$/ }))
  const trigger = screen.getByRole('button', { name: 'Usage model' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'All models' }))
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'End' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'model-b' }))
  fireEvent.click(document.activeElement ?? document.body)
  expect(screen.getByTestId('usage-total').textContent).toBe('200')
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(screen.getByRole('button', { name: 'Usage provider' }))
  expect(screen.getByRole('menuitem', { name: 'openai' })).toBeTruthy()
  fireEvent.pointerDown(screen.getByLabelText('Filter token usage'))
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Usage tool' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
  expect(screen.getByRole('button', { name: 'Usage tool' }).textContent).toContain('Codex')
})

it('cancels on unmount and provides retry after a request failure', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => response())
  vi.stubGlobal('fetch', fetch)
  const view = render(<TokenUsage />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText(/local sessions scanned/)
  const signal = (fetch.mock.calls[1]?.[1] as RequestInit).signal
  view.unmount()
  expect(signal?.aborted).toBe(true)
})

it('renders partial totals and progress before the stream finishes, then adds only new data', async () => {
  let send: (event: UsageStreamEvent) => void = () => {}
  let finish = () => {}
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    send = event => { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)) }
    finish = () => { controller.close() }
  } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
  render(<TokenUsage />)
  fireEvent.click(screen.getByRole('button', { name: /^All$/ }))
  await act(async () => { send(update({ ...report, buckets: [bucket] }, 1, 2, false)) })
  expect(screen.getByTestId('usage-total').textContent).toBe('100')
  expect(screen.getByRole('status').textContent).toContain('1 / 2')
  expect((screen.getByRole('progressbar', { name: 'Token usage loading progress' }) as HTMLProgressElement).value).toBe(1)
  await act(async () => {
    send(update({ ...report, buckets: [{ ...bucket, total: 200 }], sessions: [] }, 2, 2, true))
    finish()
  })
  expect(screen.getByTestId('usage-total').textContent).toBe('300')
  expect(screen.queryByRole('status')).toBeNull()
})

it('decodes split UTF-8 frames and rejects a truncated stream', async () => {
  const event = update({ ...report, sessions: [{ id: 'one', kind: 'codex', title: '中文' }] })
  const bytes = new TextEncoder().encode(`${JSON.stringify(event)}\n`)
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  const fetch = vi.fn().mockResolvedValueOnce(new Response(body))
    .mockResolvedValueOnce(new Response(`${JSON.stringify(update(report, 0, 1, false))}\n`))
  vi.stubGlobal('fetch', fetch)
  const received: UsageStreamEvent[] = []
  await streamUsage(event => received.push(event), new AbortController().signal)
  expect(received).toEqual([event])
  await expect(streamUsage(() => {}, new AbortController().signal)).rejects.toThrow('before completion')
})

it('cancels an in-flight response body when the panel closes', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))))
  const view = render(<TokenUsage />)
  await act(async () => {})
  view.unmount()
  await waitFor(() => { expect(cancel).toHaveBeenCalledTimes(1) })
})
