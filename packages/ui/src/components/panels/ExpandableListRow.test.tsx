import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// jsdom не даёт matchMedia → useDevice вернул бы desktop; управляем зоной вручную.
const device = vi.hoisted(() => ({ type: 'desktop' as 'desktop' | 'phone' | 'tablet' }))

vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: device.type, isTouch: device.type !== 'desktop' }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ExpandableListRow, RowBadge } from './ExpandableListRow'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: React.ReactNode): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>)
  })
  return container
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

describe('ExpandableListRow — общий примитив строки', () => {
  it('без details не рендерит кнопку ката и контент', async () => {
    const container = await render(<ExpandableListRow testId="row" name="alpha" />)
    const row = container.querySelector('[data-testid="row"]')!
    expect(row.textContent).toContain('alpha')
    expect(row.querySelector('button')).toBeNull()
    expect(container.querySelector('[data-testid="row-details-toggle"]')).toBeNull()
    expect(container.querySelector('[data-testid="row-details-content"]')).toBeNull()
  })

  it('с details: aria-expanded=false → клик → true и контент виден, повторный клик сворачивает', async () => {
    const container = await render(
      <ExpandableListRow
        testId="row"
        name="beta"
        badges={<RowBadge tone="primary">sys</RowBadge>}
        details="secret"
      />,
    )
    const row = container.querySelector('[data-testid="row"]')!
    expect(row.textContent).toContain('sys')
    const toggle = container.querySelector('[data-testid="row-details-toggle"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="row-details-content"]')).toBeNull()

    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="row-details-content"]')!.textContent).toContain('secret')

    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="row-details-content"]')).toBeNull()
  })

  it('detailsTestId переопределяет testid кнопки ката', async () => {
    const container = await render(
      <ExpandableListRow testId="row" name="gamma" details="d" detailsTestId="custom-toggle" />,
    )
    expect(container.querySelector('[data-testid="custom-toggle"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="row-details-toggle"]')).toBeNull()
  })
})

describe('ExpandableListRow — раскладка (desktop / phone)', () => {
  afterEach(() => {
    device.type = 'desktop'
  })

  it('десктоп: одна строка (inline), имя, aside и шеврон на одном уровне', async () => {
    const container = await render(
      <ExpandableListRow testId="row" name="alpha" aside={<button type="button">t</button>} details="d" />,
    )
    const row = container.querySelector('[data-testid="row"]')!
    expect(row.getAttribute('data-layout')).toBe('inline')
    // Три прямых потомка: имя, aside, шеврон.
    expect(row.children).toHaveLength(3)
  })

  it('телефон: две строки (stacked) — имя+бейджи с шевроном, aside справа во второй', async () => {
    device.type = 'phone'
    const container = await render(
      <ExpandableListRow
        testId="row"
        name="alpha"
        badges={<RowBadge tone="primary">sys</RowBadge>}
        aside={<button type="button">t</button>}
        details="d"
      />,
    )
    const row = container.querySelector('[data-testid="row"]')!
    expect(row.getAttribute('data-layout')).toBe('stacked')
    // Две строки: имя сверху, aside снизу.
    expect(row.children).toHaveLength(2)
    const [nameRow, asideRow] = [...row.children] as HTMLElement[]
    expect(nameRow!.textContent).toContain('alpha')
    expect(nameRow!.textContent).toContain('sys')
    // Шеврон — в первой строке (у правого края).
    expect(nameRow!.querySelector('[data-testid="row-details-toggle"]')).not.toBeNull()
    // Управление — во второй строке, выровнено вправо.
    expect(asideRow!.textContent).toContain('t')
    expect(asideRow!.className).toContain('justify-end')
  })
})
