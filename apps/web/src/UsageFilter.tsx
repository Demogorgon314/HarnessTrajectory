import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Menu, icons } from '@harness-trajectory/ui'
import css from './usage.module.css'

interface UsageFilterOption {
  id: string
  label: string
  icon?: ReactNode
}

/** Single-choice usage filter using the shared, keyboard-navigable menu. */
export function UsageFilter({ label, value, options, onChange }: {
  label: string
  value: string
  options: readonly UsageFilterOption[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const selected = options.find(option => option.id === value) ?? options[0]
  const close = () => { setOpen(false); trigger.current?.focus() }
  useEffect(() => {
    if (!open) return
    // Dismiss the chooser before the dialog, even if focus moved outside
    // the portaled menu while streamed options were arriving.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open])
  return <span className={css.filter}>
    <Menu open={open} onClose={() => { setOpen(false) }}
      items={options} selectedId={value}
      onSelect={id => { onChange(id); close() }}
      portal autoFocus dense className={css.filterMenu}
      anchor={<button ref={trigger} type="button" className={css.filterTrigger}
        aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}>
        {selected?.icon}
        <span title={selected?.label}>{selected?.label}</span>
        <icons.IconChevronDownOutline14 />
      </button>} />
  </span>
}
