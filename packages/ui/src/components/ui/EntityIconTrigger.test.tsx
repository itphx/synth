import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// Пикер живёт в Popover: раскрываем содержимое, чтобы проверить колбэки без портала.
vi.mock('@/components/ui/popover', async () => {
  const ReactMod = await import('react')
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children)
  return { Popover: Passthrough, PopoverTrigger: Passthrough, PopoverContent: Passthrough }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { EntityIconTrigger, type EntityIconTriggerProps } from './EntityIconTrigger'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(overrides: Partial<EntityIconTriggerProps> = {}): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const props: EntityIconTriggerProps = {
    icon: null,
    color: null,
    onIconChange: vi.fn(),
    onColorChange: vi.fn(),
    fallbackIcon: 'folder-3',
    testId: 'entity-icon-color-trigger',
    label: 'Icon & color',
    ...overrides,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <EntityIconTrigger {...props} />
      </I18nProvider>,
    )
  })
  return container
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
  vi.clearAllMocks()
})

describe('EntityIconTrigger', () => {
  it('рендерит кнопку-триггер с подписью и раскрывает пикер', async () => {
    const container = await render()
    const trigger = container.querySelector('[data-testid="entity-icon-color-trigger"]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.getAttribute('aria-label')).toBe('Icon & color')
    expect(trigger.getAttribute('title')).toBe('Icon & color')
    expect(container.querySelector('[data-testid="entity-picker"]')).not.toBeNull()
  })

  it('клик по иконке и цвету отдаёт канонические ключи колбэками', async () => {
    const onIconChange = vi.fn()
    const onColorChange = vi.fn()
    const container = await render({ onIconChange, onColorChange })

    await click(container.querySelector('[data-testid="entity-icon-rocket"]')!)
    expect(onIconChange).toHaveBeenLastCalledWith('rocket')

    await click(container.querySelector('[data-testid="entity-color-primary"]')!)
    expect(onColorChange).toHaveBeenLastCalledWith('primary')

    await click(container.querySelector('[data-testid="entity-icon-none"]')!)
    expect(onIconChange).toHaveBeenLastCalledWith(null)
  })

  it('disabled прокидывается в кнопки пикера', async () => {
    const container = await render({ disabled: true })
    const iconButton = container.querySelector('[data-testid="entity-icon-rocket"]') as HTMLButtonElement
    const colorButton = container.querySelector('[data-testid="entity-color-primary"]') as HTMLButtonElement
    expect(iconButton.disabled).toBe(true)
    expect(colorButton.disabled).toBe(true)
  })
})
