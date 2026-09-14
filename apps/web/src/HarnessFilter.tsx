/**
 * Harness filter: a dropdown over the harness registry. Any number of agents
 * fit in the menu, unlike a row of pills. An empty selection means "all".
 */

import { useMemo, useState } from 'react'
import type { HarnessKind } from '@harness-trajectory/core'
import { Menu, Tooltip, icons, type MenuEntry } from '@harness-trajectory/ui'
import { HarnessMark, allHarnessKinds, harnessMeta } from './harnesses.tsx'
import css from './app.module.css'

const { IconChecklistOutline14, IconChevronDownOutline14 } = icons

const ALL_ID = 'all'

export interface HarnessFilterProps {
  /** Selected kinds; empty means every harness. */
  selected: ReadonlySet<HarnessKind>
  onChange: (next: ReadonlySet<HarnessKind>) => void
  /** Session counts per kind, shown beside each entry. */
  counts: ReadonlyMap<HarnessKind, number>
  /** Rail variant: an icon button whose menu opens to the right. */
  compact?: boolean
}

export function summarizeSelection(selected: ReadonlySet<HarnessKind>): string {
  const kinds = allHarnessKinds()
  if (selected.size === 0 || selected.size === kinds.length) return 'All harnesses'
  if (selected.size === 1) {
    const [only] = selected
    return only === undefined ? 'All harnesses' : harnessMeta(only).label
  }
  return `${selected.size} harnesses`
}

export function HarnessFilter({ selected, onChange, counts, compact = false }: HarnessFilterProps) {
  const [open, setOpen] = useState(false)
  const kinds = allHarnessKinds()
  const items = useMemo<readonly MenuEntry[]>(() => [
    { type: 'label', id: 'heading', text: 'Harness' },
    ...kinds.map((kind) => {
      const meta = harnessMeta(kind)
      const count = counts.get(kind) ?? 0
      return {
        id: kind,
        icon: <HarnessMark kind={kind} size={16} />,
        label: (
          <span className={css.filterEntry}>
            <span className={css.filterEntryLabel}>{meta.label}</span>
            <span className={css.filterEntryCount}>{count}</span>
          </span>
        ),
      }
    }),
    { type: 'separator', id: 'sep' },
    { id: ALL_ID, label: 'All harnesses' },
  ], [kinds, counts])
  const selectedIds = selected.size === 0 ? [ALL_ID] : [...selected]
  const onSelect = (id: string) => {
    if (id === ALL_ID) {
      onChange(new Set())
      setOpen(false)
      return
    }
    const next = new Set(selected)
    if (next.has(id as HarnessKind)) next.delete(id as HarnessKind)
    else next.add(id as HarnessKind)
    // Selecting every harness is the same as no filter.
    onChange(next.size === kinds.length ? new Set() : next)
  }
  const summary = summarizeSelection(selected)
  const anchor = compact
    ? (
      <Tooltip label={`Filter: ${summary}`} delayMs={500}>
        <button
          type="button"
          className={css.railKindButton}
          aria-label={`Filter harnesses (${summary})`}
          aria-haspopup="menu"
          aria-expanded={open}
          data-active={selected.size > 0 || undefined}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconChecklistOutline14 size={18} />
        </button>
      </Tooltip>
    )
    : (
      <button
        type="button"
        className={css.filterButton}
        aria-haspopup="menu"
        aria-expanded={open}
        data-active={selected.size > 0 || undefined}
        onClick={() => { setOpen(value => !value) }}
      >
        {selected.size === 1 && [...selected][0] !== undefined && (
          <HarnessMark kind={[...selected][0] as HarnessKind} size={14} className={css.filterMark} />
        )}
        <span className={css.filterLabel}>{summary}</span>
        <IconChevronDownOutline14 className={css.filterChevron} />
      </button>
    )
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      selectedIds={selectedIds}
      onSelect={onSelect}
      anchor={anchor}
      portal
      side={compact ? 'right' : 'bottom'}
      align="start"
      dense
    />
  )
}
