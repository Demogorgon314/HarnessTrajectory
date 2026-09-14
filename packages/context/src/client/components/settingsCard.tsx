/**
 * The Context dashboard's display preferences.
 *
 * dsh-context shipped these rows as a card in the harness's Settings →
 * Plugins page; this viewer has no settings page, so the SAME rows live in a
 * popover behind a gear button at the top right of the Context tab. The rows
 * (`PrefRow`, the `Menu`-anchored select) are unchanged — only the container
 * moved, and the `defaultPlacement` row is gone with the sidebar placement.
 *
 * Vendored from dsh-context (Apache-2.0, see ../../NOTICE).
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { icons, Menu } from '@harness-trajectory/ui'
import type { ContextSettings, SettingsField, SettingsState } from '../settings'
import type { ViewKit } from '../viewkit'
import { useEscapeClose } from './escapeClose'

const { IconChevronDownOutline14, IconSettingsOutline16 } = icons

interface PrefRowProps {
  label: string
  value: string
  options: ReadonlyArray<{ id: string; label: string }>
  disabled: boolean
  onPick: (id: string) => void
}

function PrefRow(props: PrefRowProps): ReactElement {
  const [open, setOpen] = useState(false)
  const active = props.options.find(o => o.id === props.value)?.label ?? props.value
  return (
    <div className="lc-settings-row">
      <span className="lc-settings-label">{props.label}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={props.options}
        selectedId={props.value}
        onSelect={(id) => { setOpen(false); props.onPick(id) }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className="lc-settings-select hover:enabled:bg-(--dsw-alias-interactive-bg-hover) disabled:opacity-50 disabled:cursor-default"
            disabled={props.disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(v => !v) }}
          >
            {active}
            <IconChevronDownOutline14 />
          </button>
        )}
      />
    </div>
  )
}

export interface SettingsPopoverProps {
  settings: ContextSettings
}

export function makeSettingsPopover(kit: ViewKit): (props: SettingsPopoverProps) => ReactElement {
  const { t } = kit
  return function SettingsPopover(props: SettingsPopoverProps): ReactElement {
    const settings = props.settings
    const [open, setOpen] = useState(false)
    const hostRef = useRef<HTMLDivElement | null>(null)
    const state: SettingsState = useSyncExternalStore(settings.store.subscribe, settings.store.getSnapshot)
    useEscapeClose(open, () => { setOpen(false) })
    // Outside-click close: capture-phase pointerdown on the document, so a
    // click landing on a portalled select list (outside this subtree) closes
    // nothing while a click anywhere else does.
    useEffect(() => {
      if (!open) return undefined
      const onDown = (ev: MouseEvent): void => {
        const host = hostRef.current
        const target = ev.target
        if (host === null || !(target instanceof Node)) return
        if (host.contains(target)) return
        // A portalled Menu list lives at the document root; its own outside
        // handler closes it, and closing this popover under it would strand
        // the pick.
        if (target instanceof Element && target.closest('[data-context-settings-list]') !== null) return
        setOpen(false)
      }
      document.addEventListener('mousedown', onDown, true)
      return () => { document.removeEventListener('mousedown', onDown, true) }
    }, [open])

    const disabled = state.status !== 'ready' || !state.writable
    const set = (field: SettingsField, value: string): void => { settings.set(field, value) }
    return (
      <div className="lc-settings-host" ref={hostRef}>
        <button
          type="button"
          className={'lc-settings-gear hover:bg-(--dsw-alias-interactive-bg-hover)' + (open ? ' lc-settings-gear-on' : '')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('settings.open')}
          title={t('settings.open')}
          onClick={() => { setOpen(v => !v) }}
        >
          <IconSettingsOutline16 size={15} />
        </button>
        {open
          ? (
            <div className="lc-settings-pop" role="dialog" aria-label={t('settings.title')} data-context-settings-list>
              <div className="lc-settings-headtext lc-settings-pop-head">
                <span className="lc-settings-name">{t('settings.title')}</span>
                <span className="lc-settings-desc">{t('settings.desc')}</span>
              </div>
              <div className="lc-settings-body">
                {!state.writable && state.status === 'ready'
                  ? <p className="lc-settings-note" role="status">{t('settings.readOnly')}</p>
                  : null}
                <PrefRow
                  label={t('settings.gran')}
                  value={state.granularity}
                  disabled={disabled}
                  options={[
                    { id: 'step', label: t('gran.step') },
                    { id: 'turn', label: t('gran.turn') },
                  ]}
                  onPick={(id) => { set('defaultGranularity', id) }}
                />
                <PrefRow
                  label={t('settings.mode')}
                  value={state.mode}
                  disabled={disabled}
                  options={[
                    { id: 'total', label: t('gran.total') },
                    { id: 'delta', label: t('gran.delta') },
                  ]}
                  onPick={(id) => { set('defaultTrendMode', id) }}
                />
                <PrefRow
                  label={t('settings.toolSort')}
                  value={state.toolSort}
                  disabled={disabled}
                  options={[
                    { id: 'size', label: t('tool.sort.size') },
                    { id: 'count', label: t('tool.sort.count') },
                    { id: 'name', label: t('tool.sort.name') },
                  ]}
                  onPick={(id) => { set('defaultToolSort', id) }}
                />
                <PrefRow
                  label={t('settings.fileSort')}
                  value={state.fileSort}
                  disabled={disabled}
                  options={[
                    { id: 'count', label: t('files.sort.count') },
                    { id: 'latest', label: t('files.sort.latest') },
                    { id: 'path', label: t('files.sort.path') },
                  ]}
                  onPick={(id) => { set('defaultFileSort', id) }}
                />
              </div>
            </div>
          )
          : null}
      </div>
    )
  }
}
