import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { PROJECT_ICONS, PROJECT_COLORS } from '@/lib/projectMeta'
import { EntityIconPicker } from './EntityIconPicker'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function Harness({ onIcon, onColor }: { onIcon: (v: string | null) => void; onColor: (v: string | null) => void }) {
  const [icon, setIcon] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)
  return (
    <EntityIconPicker
      icon={icon}
      color={color}
      onIconChange={(v) => { setIcon(v); onIcon(v) }}
      onColorChange={(v) => { setColor(v); onColor(v) }}
    />
  )
}

async function render(): Promise<{ container: HTMLElement; onIcon: ReturnType<typeof vi.fn>; onColor: ReturnType<typeof vi.fn> }> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const onIcon = vi.fn()
  const onColor = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness onIcon={onIcon} onColor={onColor} />
      </I18nProvider>,
    )
  })
  return { container, onIcon, onColor }
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('EntityIconPicker', () => {
  it('рендерит все ключи реестра иконок и палитры + опции сброса', async () => {
    const { container } = await render()
    expect(container.querySelector('[data-testid="entity-picker"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid^="entity-icon-"]')).toHaveLength(PROJECT_ICONS.length + 1)
    expect(container.querySelectorAll('[data-testid^="entity-color-"]')).toHaveLength(PROJECT_COLORS.length + 1)
  })

  it('клик по иконке отдаёт канонический ключ, по «без иконки» — null', async () => {
    const { container, onIcon } = await render()
    await click(container.querySelector('[data-testid="entity-icon-rocket"]')!)
    expect(onIcon).toHaveBeenLastCalledWith('rocket')
    // Выбранная иконка подсвечивается (border-primary).
    expect(container.querySelector('[data-testid="entity-icon-rocket"]')!.className).toContain('border-primary')

    await click(container.querySelector('[data-testid="entity-icon-none"]')!)
    expect(onIcon).toHaveBeenLastCalledWith(null)
  })

  it('клик по цвету отдаёт ключ палитры, по «без цвета» — null', async () => {
    const { container, onColor } = await render()
    await click(container.querySelector('[data-testid="entity-color-primary"]')!)
    expect(onColor).toHaveBeenLastCalledWith('primary')
    expect(container.querySelector('[data-testid="entity-color-primary"]')!.className).toContain('scale-110')

    await click(container.querySelector('[data-testid="entity-color-none"]')!)
    expect(onColor).toHaveBeenLastCalledWith(null)
  })
})
