import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { StreamErrorPanel } from './StreamErrorPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderPanel(errorType: string, error: string, onRetry?: () => void): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <StreamErrorPanel error={error} errorType={errorType} onRetry={onRetry} />
      </I18nProvider>,
    )
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

describe('StreamErrorPanel (B6: плашка финальной ошибки над полем ввода)', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('recoverable-ошибка (server_error) → текст + кнопка «Повторить»', async () => {
    const container = await renderPanel('server_error', 'Provider exploded', () => {})
    expect(container.textContent).toContain('Обработка остановлена: ошибка провайдера')
    expect(container.textContent).toContain('Provider exploded')
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Повторить',
    )
    expect(btn).toBeDefined()
  })

  it('context_length → локализованный текст, БЕЗ кнопки «Повторить»', async () => {
    const container = await renderPanel('context_length', 'ctx exceeded', () => {})
    expect(container.textContent).toContain('Контекстное окно модели превышено')
    expect(container.textContent).not.toContain('ctx exceeded')
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Повторить',
    )
    expect(btn).toBeUndefined()
  })

  it('auth → локализованный текст про API-ключ, БЕЗ кнопки «Повторить»', async () => {
    const container = await renderPanel('auth', 'invalid key', () => {})
    expect(container.textContent).toContain('Ошибка аутентификации провайдера')
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Повторить',
    )
    expect(btn).toBeUndefined()
  })

  it('клик по «Повторить» вызывает onRetry', async () => {
    let clicked = false
    const container = await renderPanel('rate_limit', '429', () => { clicked = true })
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Повторить',
    )
    expect(btn).toBeDefined()
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clicked).toBe(true)
  })

  it('без onRetry кнопка не показывается даже для recoverable', async () => {
    const container = await renderPanel('network', 'conn refused')
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Повторить',
    )
    expect(btn).toBeUndefined()
  })
})
