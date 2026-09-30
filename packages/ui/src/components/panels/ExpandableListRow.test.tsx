import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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
