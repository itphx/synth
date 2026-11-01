import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { ComposerBanner } from './ComposerBanner'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(element)
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

describe('ComposerBanner — переиспользуемая плашка над композером', () => {
  it('error: red destructive-палитра, заголовок/подпись/действие', async () => {
    const container = await render(
      <ComposerBanner
        variant="error"
        title="Ошибка провайдера"
        action={<button type="button">Повторить</button>}
        testId="banner-error"
      >
        <span>сырой текст</span>
      </ComposerBanner>,
    )

    const banner = container.querySelector('[data-testid="banner-error"]') as HTMLElement
    expect(banner).not.toBeNull()
    expect(banner.dataset.variant).toBe('error')
    expect(banner.className).toContain('border-destructive/20')
    expect(banner.className).toContain('bg-destructive/5')
    // Базовая геометрия — как у плашки ошибки хода.
    expect(banner.className).toContain('mx-auto')
    expect(banner.className).toContain('w-4/5')
    expect(banner.className).toContain('rounded-lg')
    expect(banner.textContent).toContain('Ошибка провайдера')
    expect(banner.textContent).toContain('сырой текст')
    expect(banner.textContent).toContain('Повторить')
  })

  it('warning: жёлтая палитра токена темы (без hex в компоненте)', async () => {
    const container = await render(
      <ComposerBanner variant="warning" title="Контекст заполнен" testId="banner-warning" />,
    )
    const banner = container.querySelector('[data-testid="banner-warning"]') as HTMLElement
    expect(banner.dataset.variant).toBe('warning')
    expect(banner.className).toContain('border-status-notice/40')
    expect(banner.className).toContain('bg-status-notice/10')
    // Никаких литеральных цветов в разметке.
    expect(banner.className).not.toMatch(/#[0-9a-f]{3,8}/i)
  })

  it('сворачиваемый блок: по умолчанию свёрнут, раскрывается по клику', async () => {
    const container = await render(
      <ComposerBanner
        variant="warning"
        title="Заголовок"
        testId="banner-details"
        details={{
          summary: 'Что делать',
          content: <ul><li>пункт один</li></ul>,
        }}
      />,
    )

    const banner = container.querySelector('[data-testid="banner-details"]') as HTMLElement
    const toggle = banner.querySelector('[data-testid="banner-details-details"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(banner.textContent).toContain('Что делать')
    expect(banner.textContent).not.toContain('пункт один')

    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(banner.textContent).toContain('пункт один')
  })
})
