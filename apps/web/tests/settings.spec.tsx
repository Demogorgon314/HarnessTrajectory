/**
 * The settings dialog: loads the persisted value when opened, saves a valid
 * edit on commit and adopts what the server answers, resets anything else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingsDialog } from '../src/SettingsDialog.tsx'
import { settingsStore } from '../src/settings-store.ts'

interface Call {
  method: string
  url: string
  body: unknown
  resolve: (body: unknown) => void
}

let calls: Call[] = []

/** A fetch that parks every request until the spec answers it. */
function stubFetch(): void {
  calls = []
  vi.stubGlobal('fetch', (input: unknown, init?: { method?: string; body?: string }) => {
    return new Promise((resolve) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: init?.body === undefined ? undefined : JSON.parse(init.body),
        resolve: body => {
          resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => Promise.resolve(body),
          })
        },
      })
    })
  })
}

function daysInput(): HTMLInputElement {
  return screen.getByLabelText('Index retention days') as HTMLInputElement
}

function toggleInput(): HTMLInputElement {
  return screen.getByLabelText('Content search') as HTMLInputElement
}

async function answerCurrent(days: number, searchEnabled = true, contentSearch = searchEnabled): Promise<void> {
  await act(async () => { calls[0]?.resolve({ contentSearch, searchMaxAgeDays: days, searchEnabled }) })
}

beforeEach(() => {
  stubFetch()
  settingsStore.set({ current: null, saving: false, purged: null, error: null })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SettingsDialog', () => {
  it('renders nothing while closed and never fetches', () => {
    render(<SettingsDialog open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('loads the persisted value when opened', async () => {
    render(<SettingsDialog open onClose={() => {}} />)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe('/api/settings')
    await answerCurrent(90)
    expect(daysInput().value).toBe('90')
  })

  it('saves a valid edit on commit and adopts the answered value', async () => {
    render(<SettingsDialog open onClose={() => {}} />)
    await answerCurrent(90)
    const input = daysInput()
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)
    const put = calls.find(call => call.method === 'PUT')
    expect(put?.url).toBe('/api/settings')
    expect(put?.body).toEqual({ searchMaxAgeDays: 30 })
    await act(async () => {
      put?.resolve({ contentSearch: true, searchMaxAgeDays: 30, searchEnabled: true, purged: 12 })
    })
    expect(daysInput().value).toBe('30')
    expect(screen.getByText(/Dropped 12 older transcript files/)).toBeTruthy()
  })

  it('resets an invalid draft instead of saving it', async () => {
    render(<SettingsDialog open onClose={() => {}} />)
    await answerCurrent(90)
    const input = daysInput()
    for (const draft of ['abc', '4.5', '40000', '030', '']) {
      fireEvent.change(input, { target: { value: draft } })
      fireEvent.blur(input)
      expect(input.value).toBe('90')
    }
    expect(calls.find(call => call.method === 'PUT')).toBeUndefined()
  })

  it('does not save an unchanged value', async () => {
    render(<SettingsDialog open onClose={() => {}} />)
    await answerCurrent(90)
    fireEvent.change(daysInput(), { target: { value: '90' } })
    fireEvent.blur(daysInput())
    expect(calls.find(call => call.method === 'PUT')).toBeUndefined()
  })

  it('toggles content search on and notes the restart it waits for', async () => {
    render(<SettingsDialog open onClose={() => {}} />)
    await answerCurrent(90, false, false)
    expect(toggleInput().checked).toBe(false)
    expect(screen.queryByText(/restarts/)).toBeNull()
    fireEvent.click(toggleInput())
    const put = calls.find(call => call.method === 'PUT')
    expect(put?.body).toEqual({ contentSearch: true })
    // The server still runs without the index: the toggle applies on the next start.
    await act(async () => { put?.resolve({ contentSearch: true, searchMaxAgeDays: 90, searchEnabled: false, purged: 0 }) })
    expect(toggleInput().checked).toBe(true)
    expect(screen.getByText(/Search starts after the server restarts/)).toBeTruthy()
  })

  it('toggles content search off and notes the index file is kept', async () => {
    render(<SettingsDialog open onClose={() => {}} />)
    await answerCurrent(90, true, true)
    fireEvent.click(toggleInput())
    const put = calls.find(call => call.method === 'PUT')
    expect(put?.body).toEqual({ contentSearch: false })
    await act(async () => { put?.resolve({ contentSearch: false, searchMaxAgeDays: 90, searchEnabled: true, purged: 0 }) })
    expect(toggleInput().checked).toBe(false)
    expect(screen.getByText(/Search stops after the server restarts; the index file stays on disk/)).toBeTruthy()
  })

  it('closes on Escape, on the mask, and on the close button', async () => {
    const onClose = vi.fn()
    render(<SettingsDialog open onClose={onClose} />)
    await answerCurrent(90)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByLabelText('Close settings'))
    fireEvent.click(screen.getByLabelText('Close', { exact: true }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})
