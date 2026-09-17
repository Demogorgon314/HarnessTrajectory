/**
 * Model price rules in the web app: the peak-hours text grammar, the shared
 * `PriceRuleEditor` (seeding, validation, the exact rule a submit produces),
 * the settings-page rule list, and the "price this model" dialog's save
 * path through the settings store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ModelPriceRules, SettingsResponse } from '@harness-trajectory/core'
import { resetModelPrices, setModelPricesLoader } from '@harness-trajectory/context/client'
import { ModelPricing } from '../src/ModelPricing.tsx'
import { PriceRuleEditor } from '../src/PriceRuleEditor.tsx'
import { PriceRuleDialog } from '../src/PriceRuleDialog.tsx'
import { settingsStore } from '../src/settings-store.ts'

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => new Promise(() => {}))
  settingsStore.set({ current: null, saving: false, purged: null, error: null })
})

afterEach(() => {
  cleanup()
  setModelPricesLoader(null)
  resetModelPrices()
  vi.unstubAllGlobals()
})

function matchInput(): HTMLInputElement {
  return screen.getByPlaceholderText('cognition/swe-2-max') as HTMLInputElement
}

describe('PriceRuleEditor', () => {
  it('seeds the match key and validates before submitting', () => {
    const onSubmit = vi.fn()
    render(
      <PriceRuleEditor
        seed={{ key: 'cognition/swe-2-max', rule: {} }}
        submitLabel="Add rule"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    expect(matchInput().value).toBe('cognition/swe-2-max')

    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/need at least input and output prices/)).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Input'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByPlaceholderText('Output'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    expect(onSubmit).toHaveBeenCalledWith('cognition/swe-2-max', { rates: { input: 1.5, output: 6 } })
  })

  it('an off-peak rule carries the parsed schedule and factor', () => {
    const onSubmit = vi.fn()
    render(
      <PriceRuleEditor
        seed={{ key: 'x/y', rule: {} }}
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('Input'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByPlaceholderText('Output'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Off-peak pricing/ }))
    fireEvent.change(screen.getByPlaceholderText('9-12, 14-18'), { target: { value: '9-12, 14-18' } })
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Asia/Shanghai' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Weekdays only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith('x/y', {
      rates: { input: 1.5, output: 6 },
      offPeak: {
        peakHours: [[9, 12], [14, 18]],
        timezone: 'Asia/Shanghai',
        weekdaysOnly: true,
        factor: 0.5,
      },
    })
  })

  it('alias mode submits only the alias', () => {
    const onSubmit = vi.fn()
    render(
      <PriceRuleEditor
        seed={{ key: 'x/y', rule: {} }}
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: /Alias to a models.dev entry/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Type it manually' }))
    fireEvent.change(screen.getByPlaceholderText('deepseek/deepseek-v4-flash'), {
      target: { value: 'deepseek/deepseek-v4-flash' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith('x/y', { alias: 'deepseek/deepseek-v4-flash' })
  })

  it('the DeepSeek preset fills the whole off-peak schedule', () => {
    const onSubmit = vi.fn()
    render(
      <PriceRuleEditor
        seed={{ key: 'x/y', rule: { rates: { input: 1, output: 2 } } }}
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /Off-peak pricing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek hours' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith('x/y', {
      rates: { input: 1, output: 2 },
      offPeak: {
        peakHours: [[9, 12], [14, 18]],
        timezone: 'Asia/Shanghai',
        weekdaysOnly: true,
        factor: 0.5,
      },
    })
  })

  it('rejects a malformed key and a malformed schedule, naming each problem', () => {
    const onSubmit = vi.fn()
    render(
      <PriceRuleEditor
        seed={{ key: '', rule: { rates: { input: 1, output: 2 } } }}
        submitLabel="Save"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText(/Match must be provider\/model/)).toBeTruthy()

    fireEvent.change(matchInput(), { target: { value: 'x/y' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Off-peak pricing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText(/Peak hours must read like/)).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('ModelPricing', () => {
  it('lists the persisted rules with a terse summary and a delete button', () => {
    const onSave = vi.fn()
    const rules: ModelPriceRules = {
      'cognition/swe-2-max': { rates: { input: 1.5, output: 6 }, offPeak: { peakHours: [[9, 12]], factor: 0.5 } },
      'x/y': { alias: 'deepseek/deepseek-v4-flash' },
    }
    render(<ModelPricing rules={rules} saving={false} onSave={onSave} />)
    expect(screen.getByText('cognition/swe-2-max')).toBeTruthy()
    expect(screen.getByText('$1.5/$6 · off-peak ×0.5')).toBeTruthy()
    expect(screen.getByText('→ deepseek/deepseek-v4-flash')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Delete price rule x/y'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onSave).toHaveBeenCalledWith({
      'cognition/swe-2-max': { rates: { input: 1.5, output: 6 }, offPeak: { peakHours: [[9, 12]], factor: 0.5 } },
    })
  })

  it('adds a rule through the inline editor', () => {
    const onSave = vi.fn()
    render(<ModelPricing rules={{}} saving={false} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add price rule' }))
    fireEvent.change(matchInput(), { target: { value: 'cognition/swe-2-max' } })
    fireEvent.change(screen.getByPlaceholderText('Input'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByPlaceholderText('Output'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    expect(onSave).toHaveBeenCalledWith({
      'cognition/swe-2-max': { rates: { input: 1.5, output: 6 } },
    })
  })

  it('editing a rule prefills the draft and a rename moves the key', () => {
    const onSave = vi.fn()
    const rules: ModelPriceRules = { 'a/b': { rates: { input: 1, output: 2 } } }
    render(<ModelPricing rules={rules} saving={false} onSave={onSave} />)
    fireEvent.click(screen.getByLabelText('Edit price rule a/b'))
    expect(matchInput().value).toBe('a/b')
    fireEvent.change(matchInput(), { target: { value: 'a/c' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }))
    expect(onSave).toHaveBeenCalledWith({ 'a/c': { rates: { input: 1, output: 2 } } })
  })
})

describe('PriceRuleDialog', () => {
  interface Call { method: string; url: string; body: unknown; resolve: (body: unknown) => void }
  let calls: Call[] = []

  function stubFetch(): void {
    calls = []
    vi.stubGlobal('fetch', (input: unknown, init?: { method?: string; body?: string }) => {
      return new Promise((resolve) => {
        calls.push({
          method: init?.method ?? 'GET',
          url: String(input),
          body: init?.body === undefined ? undefined : JSON.parse(init.body),
          resolve: body => {
            resolve({ ok: true, json: () => Promise.resolve(body) } as unknown)
          },
        })
      })
    })
  }

  it('opens seeded on the billed pair and saves through the settings store', async () => {
    stubFetch()
    const current: SettingsResponse = {
      contentSearch: false,
      searchMaxAgeDays: 90,
      searchEnabled: false,
      modelPricing: { 'other/m': { rates: { input: 3, output: 3 } } },
    }
    settingsStore.set({ current, saving: false, purged: null, error: null })

    const onClose = vi.fn()
    render(<PriceRuleDialog provider="cognition" model="swe-2-max" onClose={onClose} />)
    expect(matchInput().value).toBe('cognition/swe-2-max')

    fireEvent.change(screen.getByPlaceholderText('Input'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByPlaceholderText('Output'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))

    const put = calls.find(call => call.method === 'PUT')
    expect(put?.url).toBe('/api/settings')
    expect(put?.body).toEqual({
      modelPricing: {
        'other/m': { rates: { input: 3, output: 3 } },
        'cognition/swe-2-max': { rates: { input: 1.5, output: 6 } },
      },
    })
    await act(async () => { put?.resolve({ ...current }) })
    expect(onClose).toHaveBeenCalled()
  })

  it('the match shortcuts write the key for the billed pair', () => {
    stubFetch()
    const current: SettingsResponse = {
      contentSearch: false,
      searchMaxAgeDays: 90,
      searchEnabled: false,
      modelPricing: {},
    }
    settingsStore.set({ current, saving: false, purged: null, error: null })

    render(<PriceRuleDialog provider="kimi-for-coding" model="k3" onClose={() => {}} />)
    expect(matchInput().value).toBe('kimi-for-coding/k3')
    fireEvent.click(screen.getByRole('button', { name: 'All kimi-for-coding models' }))
    expect(matchInput().value).toBe('kimi-for-coding/*')
    fireEvent.click(screen.getByRole('button', { name: 'Any provider' }))
    expect(matchInput().value).toBe('k3')
    fireEvent.click(screen.getByRole('button', { name: 'This model' }))
    expect(matchInput().value).toBe('kimi-for-coding/k3')
  })

  it('edits the rule that governs the pair — a wildcard key, not the billed pair', async () => {
    stubFetch()
    const current: SettingsResponse = {
      contentSearch: false,
      searchMaxAgeDays: 90,
      searchEnabled: false,
      modelPricing: { 'kimi-for-coding/*': { rates: { input: 9, output: 9 } } },
    }
    settingsStore.set({ current, saving: false, purged: null, error: null })

    render(<PriceRuleDialog provider="kimi-for-coding" model="k3" onClose={() => {}} />)
    // The wildcard row is the one the pair resolves to — editing it in place.
    expect(matchInput().value).toBe('kimi-for-coding/*')
    expect((screen.getByPlaceholderText('Input') as HTMLInputElement).value).toBe('9')
    expect(screen.getByText(/is priced by the rule below/)).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Output'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }))
    const put = calls.find(call => call.method === 'PUT')
    expect(put?.body).toEqual({
      modelPricing: { 'kimi-for-coding/*': { rates: { input: 9, output: 12 } } },
    })
  })

  it('a rename replaces the matched key rather than shadowing it', async () => {
    stubFetch()
    const current: SettingsResponse = {
      contentSearch: false,
      searchMaxAgeDays: 90,
      searchEnabled: false,
      modelPricing: { 'kimi-for-coding/*': { rates: { input: 9, output: 9 } } },
    }
    settingsStore.set({ current, saving: false, purged: null, error: null })

    render(<PriceRuleDialog provider="kimi-for-coding" model="k3" onClose={() => {}} />)
    fireEvent.change(matchInput(), { target: { value: 'kimi-for-coding/k3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }))
    const put = calls.find(call => call.method === 'PUT')
    expect(put?.body).toEqual({
      modelPricing: { 'kimi-for-coding/k3': { rates: { input: 9, output: 9 } } },
    })
  })

  it('a failed save keeps the dialog open and shows the error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: () => Promise.resolve({ error: 'boom' }),
    }))
    const current: SettingsResponse = {
      contentSearch: false,
      searchMaxAgeDays: 90,
      searchEnabled: false,
      modelPricing: {},
    }
    settingsStore.set({ current, saving: false, purged: null, error: null })

    const onClose = vi.fn()
    render(<PriceRuleDialog provider="cognition" model="swe-2-max" onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('Input'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByPlaceholderText('Output'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await act(async () => {})
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('500 Server Error')
  })

  it('a registry-priced pair reads as an override, not a gap', async () => {
    stubFetch()
    setModelPricesLoader(() => Promise.resolve({
      'kimi-for-coding': { models: { k3: { cost: { input: 1, output: 2 } } } },
    }))
    const current: SettingsResponse = {
      contentSearch: false,
      searchMaxAgeDays: 90,
      searchEnabled: false,
    }
    settingsStore.set({ current, saving: false, purged: null, error: null })

    render(<PriceRuleDialog provider="kimi-for-coding" model="k3" onClose={() => {}} />)
    expect(matchInput().value).toBe('kimi-for-coding/k3')
    expect(await screen.findByText(/already priced from the models\.dev list/)).toBeTruthy()
  })
})
