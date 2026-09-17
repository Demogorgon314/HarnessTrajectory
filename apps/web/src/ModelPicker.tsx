/**
 * ModelPicker — the alias mode's chooser: a searchable, provider-filterable
 * list of every models.dev entry with its per-1M rates in the row, so picking
 * a reference model is an informed click rather than typing a datalist id.
 *
 * Seeding: the billed pair prefills the search with the normalized model id
 * (routing tags like `[1m]` stripped) and, when the book carries that exact
 * model id, pre-selects it — the billed provider is the harness's client id
 * (`anthropic` for a Claude Code session proxied at DeepSeek), so matching
 * runs across every provider rather than trusting it.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { formatPriceRate, useModelPrices, vendorProviderOf } from '@harness-trajectory/context/client'
import type { ModelPrices, PriceTriple } from '@harness-trajectory/context/client'
import css from './picker.module.css'
import base from './settings.module.css'

interface Entry {
  /** 'provider/model' — the value a pick produces. */
  id: string
  provider: string
  model: string
  price: PriceTriple
}

function entriesOf(prices: ModelPrices | null): Entry[] {
  const out: Entry[] = []
  for (const provider of Object.keys(prices ?? {})) {
    for (const model of Object.keys(prices?.[provider] ?? {})) {
      const price = prices?.[provider]?.[model]
      if (price === undefined) continue
      out.push({ id: `${provider}/${model}`, provider, model, price })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** The billed model id as a search term — lowercase, `[1m]`-style tags off. */
export function normalizeBilledModel(model: string): string {
  return model.toLowerCase().replace(/\[[^\]]*\]/g, '').trim()
}

/**
 * The alias to prefill for a billed pair, mirroring the cost card's own
 * fallback (`registryPriceOf`): only an exact normalized model-id hit counts,
 * a single carrier is unambiguous, and among several carriers only the billed
 * provider's own entry or the model's VENDOR (`vendorProviderOf` or the id
 * prefixing the provider name — the official list) earns the suggestion. A
 * field of lookalike resellers suggests nothing rather than nominating an
 * arbitrary one.
 */
export function suggestedAliasOf(prices: ModelPrices | null, provider: string, model: string): string | null {
  const norm = normalizeBilledModel(model)
  if (norm === '') return null
  const vendor = vendorProviderOf(model)
  let found: string | null = null
  let candidates = 0
  for (const p of Object.keys(prices ?? {})) {
    for (const m of Object.keys(prices?.[p] ?? {})) {
      if (m.toLowerCase() !== norm) continue
      candidates += 1
      if (p === provider || p === vendor || norm.startsWith(p.toLowerCase() + '-')) return `${p}/${m}`
      if (found === null) found = `${p}/${m}`
    }
  }
  return candidates === 1 ? found : null
}

export interface ModelPickerProps {
  /** The query the search box starts with when `value` carries no alias. */
  initialQuery?: string | undefined
  /** The alias value the editor holds ('provider/model' or ''). */
  value: string
  /** The alias id to badge "suggested" — precomputed by the caller. */
  suggested?: string | null | undefined
  /** Alias ids already referenced by price rules — shown first, tagged "in use". */
  pinned?: readonly string[] | undefined
  onPick: (id: string, price: PriceTriple) => void
}

export function ModelPicker({ initialQuery, value, suggested, pinned, onPick }: ModelPickerProps): ReactElement {
  const { prices, failed } = useModelPrices()
  // An existing alias pre-fills the search with its model part so the picked
  // row is visible; a fresh rule starts from the caller's query instead.
  const [query, setQuery] = useState(() => (
    value !== '' && value.includes('/')
      ? value.slice(value.indexOf('/') + 1)
      : (initialQuery ?? '')
  ))
  const [provider, setProvider] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const providerRef = useRef<HTMLSpanElement>(null)
  const scrolled = useRef(false)
  // Scroll the picked row into view once it exists — the list fills async, so
  // a mount-time effect would usually run before the row renders. jsdom has
  // no scrollIntoView; the typeof guard keeps tests quiet.
  const pickedRef = (el: HTMLButtonElement | null) => {
    if (el !== null && !scrolled.current && typeof el.scrollIntoView === 'function') {
      scrolled.current = true
      el.scrollIntoView({ block: 'nearest' })
    }
  }

  // A custom menu, not a <select>: a native popup orphaned by an options
  // update landing mid-open can never be dismissed. Outside click / Escape
  // close it; picking sets the filter and closes.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!providerRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const entries = useMemo(() => entriesOf(prices), [prices])
  const providers = useMemo(
    () => [...new Set(entries.map(e => e.provider))].sort(),
    [entries],
  )
  // Every whitespace-separated token must appear in the id — "gpt 9" finds
  // "openai/gpt-9". Matches rank by how closely the MODEL id hits the raw
  // query, then suggested, then the model's own vendor, then pinned, then
  // alphabetical. With no tokens the pinned ids simply lead the list.
  const tokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  )
  const shown = useMemo(() => {
    const raw = query.trim().toLowerCase()
    const joined = tokens.join('-')
    const pinnedSet = new Set(pinned ?? [])
    const rankOf = (e: Entry): number => {
      const model = e.model.toLowerCase()
      if (model === joined || model === raw) return 0
      if (model.startsWith(raw)) return 1
      if (model.includes(raw)) return 2
      return 3
    }
    return entries
      .filter(e =>
        (provider === '' || e.provider === provider)
        && tokens.every(t => e.id.toLowerCase().includes(t)))
      .sort((a, b) => {
        if (tokens.length > 0) {
          const d = rankOf(a) - rankOf(b)
          if (d !== 0) return d
          if ((a.id === suggested) !== (b.id === suggested)) return a.id === suggested ? -1 : 1
          const va = a.provider === vendorProviderOf(a.model)
          const vb = b.provider === vendorProviderOf(b.model)
          if (va !== vb) return va ? -1 : 1
        }
        const pa = pinnedSet.has(a.id)
        const pb = pinnedSet.has(b.id)
        if (pa !== pb) return pa ? -1 : 1
        return a.id.localeCompare(b.id)
      })
  }, [entries, provider, tokens, query, suggested, pinned])

  return (
    <span className={css.picker}>
      <span className={css.pickerBar}>
        <input
          type="text"
          className={`${base.text} ${css.pickerSearch}`}
          placeholder="Search models.dev entries…"
          aria-label="Search models.dev entries"
          value={query}
          onChange={event => { setQuery(event.currentTarget.value) }}
        />
        <span className={css.pickerProvider} ref={providerRef}>
          <button
            type="button"
            className={css.pickerProviderBtn}
            aria-label="Provider"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            onClick={() => { setMenuOpen(open => !open) }}
          >
            <span className={css.pickerProviderName}>{provider === '' ? 'All providers' : provider}</span>
            <span aria-hidden="true">▾</span>
          </button>
          {menuOpen && (
            <span className={css.pickerMenu} role="listbox" aria-label="Provider options">
              <button
                type="button"
                role="option"
                aria-selected={provider === ''}
                className={css.pickerMenuItem}
                onClick={() => { setProvider(''); setMenuOpen(false) }}
              >All providers</button>
              {providers.map(p => (
                <button
                  key={p}
                  type="button"
                  role="option"
                  aria-selected={provider === p}
                  className={css.pickerMenuItem}
                  onClick={() => { setProvider(p); setMenuOpen(false) }}
                >{p}</button>
              ))}
            </span>
          )}
        </span>
      </span>
      <span className={css.pickerList}>
        {shown.map(e => (
          <button
            key={e.id}
            type="button"
            className={css.pickerRow}
            ref={e.id === value ? pickedRef : undefined}
            data-picked={e.id === value || undefined}
            onClick={() => { onPick(e.id, e.price) }}
          >
            <span className={css.pickerName}>
              <b className={css.pickerModel}>{e.model}</b>
              <span className={css.pickerProviderTag}>{e.provider}</span>
              {e.id === suggested && <span className={css.pickerSuggested}>suggested</span>}
              {pinned?.includes(e.id) === true && <span className={css.pickerInUse}>in use</span>}
            </span>
            <span className={css.pickerRates}>
              in {formatPriceRate(e.price.miss, 'usd')} · out {formatPriceRate(e.price.out, 'usd')}
              {' '}· hit {formatPriceRate(e.price.hit, 'usd')} · write {formatPriceRate(e.price.write, 'usd')}
            </span>
          </button>
        ))}
        {prices === null && !failed && (
          <span className={css.pickerEmpty}>Loading the models.dev list…</span>
        )}
        {failed && (
          <span className={css.pickerEmpty}>
            The models.dev list is unavailable — type the alias as provider/model above.
          </span>
        )}
        {prices !== null && shown.length === 0 && (
          <span className={css.pickerEmpty}>
            No entry matches{tokens.length === 0 ? '' : ` "${query.trim()}"`}{provider === '' ? '' : ` under ${provider}`} — shorten the search or clear the provider filter.
          </span>
        )}
      </span>
    </span>
  )
}
