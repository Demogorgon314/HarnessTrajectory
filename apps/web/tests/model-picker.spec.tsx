/**
 * ModelPicker — the searchable models.dev chooser behind the price-rule
 * editor's alias mode: row rendering, the search/provider filters, picking a
 * row, the suggested-entry badge, `suggestedAliasOf`'s vendor preference, and
 * the editor's automatic alias prefill on an exact book hit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { resetModelPrices, setModelPricesLoader } from '@harness-trajectory/context/client'
import type { ModelPrices } from '@harness-trajectory/context/client'
import { ModelPicker, suggestedAliasOf } from '../src/ModelPicker.tsx'
import { PriceRuleEditor } from '../src/PriceRuleEditor.tsx'

const BOOK: ModelPrices = {
  openai: { 'gpt-9': { hit: 0.1, miss: 1, write: 1.25, out: 4 } },
  anthropic: { 'claude-x': { hit: 0.3, miss: 3, write: 3.75, out: 15 } },
  reseller: { 'claude-x': { hit: 9, miss: 9, write: 9, out: 9 } },
}

const API = {
  openai: { models: { 'gpt-9': { cost: { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 } } } },
  anthropic: { models: { 'claude-x': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
  reseller: { models: { 'claude-x': { cost: { input: 9, output: 9 } } } },
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(API))
})

afterEach(() => {
  cleanup()
  setModelPricesLoader(null)
  resetModelPrices()
})

describe('suggestedAliasOf', () => {
  it('prices nothing when no provider carries the exact model id', () => {
    expect(suggestedAliasOf(BOOK, 'cognition', 'swe-2-max')).toBeNull()
    expect(suggestedAliasOf(null, 'openai', 'gpt-9')).toBeNull()
    expect(suggestedAliasOf(BOOK, 'openai', 'gpt')).toBeNull()
  })

  it('prefers the billed provider, then the model\'s vendor, over other carriers', () => {
    expect(suggestedAliasOf(BOOK, 'openai', 'gpt-9')).toBe('openai/gpt-9')
    // gpt-* → openai: the billed provider absent, the vendor beats a reseller.
    expect(suggestedAliasOf(BOOK, 'azure', 'gpt-9')).toBe('openai/gpt-9')
    // claude-* → anthropic, over the same id's reseller entry.
    expect(suggestedAliasOf(BOOK, 'kilo', 'claude-x')).toBe('anthropic/claude-x')
    // The model id itself prefixes the provider id (deepseek/deepseek-…).
    const book: ModelPrices = {
      reseller: { 'deepseek-v9': { hit: 9, miss: 9, write: 9, out: 9 } },
      deepseek: { 'deepseek-v9': { hit: 0.1, miss: 1, write: 1, out: 2 } },
    }
    expect(suggestedAliasOf(book, 'kilo', 'deepseek-v9')).toBe('deepseek/deepseek-v9')
  })

  it('a field of lookalike resellers suggests nothing', () => {
    const book: ModelPrices = {
      'reseller-a': { 'acme-x': { hit: 9, miss: 9, write: 9, out: 9 } },
      'reseller-b': { 'acme-x': { hit: 8, miss: 8, write: 8, out: 8 } },
    }
    expect(suggestedAliasOf(book, 'kilo', 'acme-x')).toBeNull()
    // …but a single carrier is unambiguous.
    const one: ModelPrices = { 'reseller-a': { 'acme-x': { hit: 9, miss: 9, write: 9, out: 9 } } }
    expect(suggestedAliasOf(one, 'kilo', 'acme-x')).toBe('reseller-a/acme-x')
  })

  it('matches case-insensitively and strips routing tags', () => {
    expect(suggestedAliasOf(BOOK, 'x', 'Claude-X[1m]')).toBe('anthropic/claude-x')
  })
})

function pickerRows(): HTMLElement[] {
  return screen.queryAllByRole('button').filter((b): b is HTMLElement => b.className.includes('pickerRow'))
}

describe('ModelPicker', () => {
  it('lists every entry with its provider tag and rates, and picking reports the id', async () => {
    const onPick = vi.fn()
    render(<ModelPicker value="" onPick={onPick} />)
    await act(async () => {})
    const rows = pickerRows()
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.textContent)).toContain('gpt-9openaiin $1 · out $4 · hit $0.1 · write $1.25')
    const claude = rows.find(r => r.textContent?.includes('claude-x'))
    if (claude === undefined) throw new Error('claude-x row missing')
    fireEvent.click(claude)
    expect(onPick).toHaveBeenCalledWith('anthropic/claude-x', BOOK.anthropic?.['claude-x'])
  })

  it('filters by the search box and the provider menu', async () => {
    render(<ModelPicker value="" onPick={() => {}} />)
    await act(async () => {})
    fireEvent.change(screen.getByLabelText('Search models.dev entries'), { target: { value: 'gpt' } })
    expect(pickerRows()).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('Provider'))
    fireEvent.click(screen.getByRole('option', { name: 'anthropic' }))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByText(/No entry matches/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search models.dev entries'), { target: { value: 'claude' } })
    expect(pickerRows()).toHaveLength(1)
  })

  it('the provider menu closes on outside click and on Escape', async () => {
    render(<ModelPicker value="" onPick={() => {}} />)
    await act(async () => {})
    const providerBtn = screen.getByLabelText('Provider')
    fireEvent.click(providerBtn)
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(providerBtn)
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('marks the selected row and the suggested one', async () => {
    render(<ModelPicker suggested="anthropic/claude-x" value="reseller/claude-x" onPick={() => {}} />)
    await act(async () => {})
    const rows = pickerRows()
    const picked = rows.find(r => r.dataset.picked !== undefined)
    expect(picked?.textContent).toContain('reseller')
    expect(rows.find(r => r.textContent?.includes('suggested'))?.textContent).toContain('anthropic')
  })

  it('an existing alias prefills the search with its model part', async () => {
    render(<ModelPicker initialQuery="gpt-9" value="reseller/claude-x" onPick={() => {}} />)
    await act(async () => {})
    expect((screen.getByLabelText('Search models.dev entries') as HTMLInputElement).value).toBe('claude-x')
    const picked = pickerRows().find(r => r.dataset.picked !== undefined)
    expect(picked?.textContent).toContain('reseller')
  })

  it('ranks exact/startswith hits and prefers the model\'s vendor; multi-token queries match', async () => {
    render(<ModelPicker value="" onPick={() => {}} />)
    await act(async () => {})
    fireEvent.change(screen.getByLabelText('Search models.dev entries'), { target: { value: 'claude' } })
    // Both carriers match 'claude'; anthropic is the model's vendor, reseller is not.
    expect(pickerRows()[0]?.textContent).toContain('anthropic')
    fireEvent.change(screen.getByLabelText('Search models.dev entries'), { target: { value: 'gpt 9' } })
    const rows = pickerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('gpt-9')
  })

  it('pinned aliases lead the unfiltered list with an "in use" tag', async () => {
    render(<ModelPicker value="" pinned={['reseller/claude-x']} onPick={() => {}} />)
    await act(async () => {})
    const first = pickerRows()[0]
    expect(first?.textContent).toContain('reseller')
    expect(first?.textContent).toContain('in use')
  })

  it('degrades to a note when the book is unavailable — the manual alias stays usable', async () => {
    setModelPricesLoader(() => Promise.reject(new Error('offline')))
    render(<ModelPicker value="" onPick={() => {}} />)
    await act(async () => {})
    expect(screen.getByText(/models.dev list is unavailable/)).toBeTruthy()
    expect(pickerRows()).toHaveLength(0)
  })
})

describe('PriceRuleEditor suggestion', () => {
  it('an exact book hit prefills alias mode with the suggested id', async () => {
    render(
      <PriceRuleEditor
        seed={{ key: 'copilot/gpt-9', rule: {} }}
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    await act(async () => {})
    expect(screen.getByText('→ openai/gpt-9')).toBeTruthy()
  })

  it('copy rates fills the rate grid from a picked list entry', async () => {
    render(
      <PriceRuleEditor
        seed={{ key: 'x/y', rule: {} }}
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /Copy rates from a listed model/ }))
    // The copy picker opens unseeded (full list); narrow it to gpt-9.
    fireEvent.change(screen.getByLabelText('Search models.dev entries'), { target: { value: 'gpt' } })
    fireEvent.click(screen.getByRole('button', { name: /gpt-9/ }))
    expect((screen.getByPlaceholderText('Input') as HTMLInputElement).value).toBe('1')
    expect((screen.getByPlaceholderText('Output') as HTMLInputElement).value).toBe('4')
    expect((screen.getByLabelText('Cache read') as HTMLInputElement).value).toBe('0.1')
    expect((screen.getByLabelText('Cache write') as HTMLInputElement).value).toBe('1.25')
  })

  it('a book miss leaves the custom-rates default untouched', async () => {
    render(
      <PriceRuleEditor
        seed={{ key: 'cognition/swe-2-max', rule: {} }}
        submitLabel="Save"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    await act(async () => {})
    expect(screen.getByPlaceholderText('Input')).toBeTruthy()
    expect(screen.queryByPlaceholderText('deepseek/deepseek-v4-flash')).toBeNull()
  })
})
