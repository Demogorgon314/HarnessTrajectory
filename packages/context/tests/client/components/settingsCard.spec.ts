// SettingsPopover (src/client/components/settingsCard.tsx) rendered with real
// React against the real DICT_EN strings; the select rows open the REAL Menu
// primitive (portaled into document.body) and pick through it.
//
// PORT NOTE — dsh-context shipped these rows as an accordion card inside the
// harness's Settings page, driven by an injected `useContextSettings` hook and
// the "Open in Settings" expand request. This port puts the same rows in a
// gear popover on the Context tab and reads the `ContextSettings` face
// directly, so the accordion/jump specs are replaced by the popover's own
// open/close behaviour. The `defaultPlacement` row is gone with the sidebar
// placement: five select rows became four.

import { createElement as h } from 'react'
import assert from '../helpers/assert.ts'
import { beforeEach, describe, test } from 'vitest'
import { makeSettingsPopover } from '../../../src/client/components/settingsCard'
import { createContextSettings, type ContextSettings } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { click, keydown, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const SettingsPopover = makeSettingsPopover(kit)

let keyCounter = 0
function freshSettings(): ContextSettings {
  keyCounter++
  return createContextSettings(`test.popover.${keyCounter}`)
}

/** Menu items portaled into document.body while a select is open. */
function menuItems(): HTMLElement[] {
  return queryAll(document.body, '[role="menu"] [role="menuitem"]')
}

beforeEach(() => {
  localStorage.clear()
})

describe('SettingsPopover', () => {
  test('the gear opens and closes the popover', async () => {
    const m = await mount(h(SettingsPopover, { settings: freshSettings() }))
    const gear = query(m.container, '.lc-settings-gear')
    assert.equal(gear.getAttribute('aria-expanded'), 'false')
    assert.equal(gear.getAttribute('aria-label'), DICT_EN['settings.open'])
    assert.equal(queryAll(m.container, '.lc-settings-pop').length, 0)

    await click(gear)
    assert.equal(gear.getAttribute('aria-expanded'), 'true')
    const pop = query(m.container, '.lc-settings-pop')
    assert.equal(pop.getAttribute('role'), 'dialog')
    assert.ok(text(pop).includes(DICT_EN['settings.title']!))
    assert.ok(text(pop).includes(DICT_EN['settings.desc']!))
    // Four rows: trend granularity, trend mode, tool sort, file sort.
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 4)

    await click(gear)
    assert.equal(queryAll(m.container, '.lc-settings-pop').length, 0)
    await m.unmount()
  })

  test('Escape closes the popover', async () => {
    const m = await mount(h(SettingsPopover, { settings: freshSettings() }))
    await click(query(m.container, '.lc-settings-gear'))
    assert.equal(queryAll(m.container, '.lc-settings-pop').length, 1)
    await keydown('Escape')
    assert.equal(queryAll(m.container, '.lc-settings-pop').length, 0)
    await m.unmount()
  })

  test('an outside click closes the popover; a click inside keeps it open', async () => {
    const m = await mount(h(SettingsPopover, { settings: freshSettings() }))
    await click(query(m.container, '.lc-settings-gear'))
    const pop = query(m.container, '.lc-settings-pop')
    pop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    assert.equal(queryAll(m.container, '.lc-settings-pop').length, 1)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    // The listener runs outside React's batching; a re-render settles it.
    await m.update(h(SettingsPopover, { settings: freshSettings() }))
    assert.equal(queryAll(m.container, '.lc-settings-pop').length, 0)
    await m.unmount()
  })

  test('picks through the real portaled Menu and persists every field', async () => {
    const settings = freshSettings()
    const m = await mount(h(SettingsPopover, { settings }))
    await click(query(m.container, '.lc-settings-gear'))

    const selects = queryAll(m.container, '.lc-settings-select')
    assert.deepEqual(selects.map(s => s.textContent), [
      DICT_EN['gran.step'], DICT_EN['gran.total'], DICT_EN['tool.sort.count'], DICT_EN['files.sort.count'],
    ])

    // Row 1: trend granularity → Turn.
    await click(selects[0]!)
    const granItems = menuItems()
    assert.deepEqual(granItems.map(i => i.textContent), [DICT_EN['gran.step'], DICT_EN['gran.turn']])
    await click(granItems[1]!)
    assert.equal(settings.defaultGranularity(), 'turn')
    assert.equal(menuItems().length, 0, 'the list closes on a pick')

    // Row 2: trend mode → Delta.
    await click(queryAll(m.container, '.lc-settings-select')[1]!)
    await click(menuItems()[1]!)
    assert.equal(settings.defaultTrendMode(), 'delta')

    // Row 3: tool sort → By size.
    await click(queryAll(m.container, '.lc-settings-select')[2]!)
    await click(menuItems()[0]!)
    assert.equal(settings.defaultToolSort(), 'size')

    // Row 4: file sort → By path.
    await click(queryAll(m.container, '.lc-settings-select')[3]!)
    await click(menuItems()[2]!)
    assert.equal(settings.defaultFileSort(), 'path')

    // The rows re-render on the store's own notification.
    assert.deepEqual(queryAll(m.container, '.lc-settings-select').map(s => s.textContent), [
      DICT_EN['gran.turn'], DICT_EN['gran.delta'], DICT_EN['tool.sort.size'], DICT_EN['files.sort.path'],
    ])
    await m.unmount()
  })

  test('Menu onClose (Escape) closes an open select without picking', async () => {
    const settings = freshSettings()
    const m = await mount(h(SettingsPopover, { settings }))
    await click(query(m.container, '.lc-settings-gear'))
    await click(queryAll(m.container, '.lc-settings-select')[0]!)
    assert.ok(menuItems().length > 0)
    await keydown('Escape', document.body)
    assert.equal(menuItems().length, 0)
    assert.equal(settings.defaultGranularity(), 'step')
    await m.unmount()
  })

  test('a read-only store disables the selects and shows the note', async () => {
    const settings = freshSettings()
    // The snapshot must be reference-stable (useSyncExternalStore re-renders
    // on every new identity), so the read-only cut is computed once.
    const frozen = { ...settings.store.getSnapshot(), writable: false }
    const readOnly: ContextSettings = {
      ...settings,
      store: { subscribe: settings.store.subscribe, getSnapshot: () => frozen },
    }
    const m = await mount(h(SettingsPopover, { settings: readOnly }))
    await click(query(m.container, '.lc-settings-gear'))
    assert.ok(text(m.container).includes(DICT_EN['settings.readOnly']!))
    assert.ok(queryAll(m.container, '.lc-settings-select').every(s => (s as HTMLButtonElement).disabled))
    await m.unmount()
  })
})
