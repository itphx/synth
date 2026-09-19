import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MessageActions } from './MessageActions'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function makeActions(overrides: Partial<React.ComponentProps<typeof MessageActions>> = {}) {
  return (
    <I18nProvider>
      <MessageActions
        messageIndex={0}
        role="assistant"
        disabled={false}
        pinned={false}
        canRetry={false}
        hasDebug
        onCopy={() => {}}
        onToggle={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onRetry={() => {}}
        onDebug={() => {}}
        onFork={() => {}}
        {...overrides}
      />
    </I18nProvider>
  )
}

async function renderActions(overrides: Partial<React.ComponentProps<typeof MessageActions>> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(makeActions(overrides))
  })
  return container
}

function getButton(container: HTMLElement, title: string): HTMLButtonElement {
  const btn = container.querySelector(`button[title="${title}"]`)
  expect(btn, `кнопка "${title}" должна существовать`).not.toBeNull()
  return btn as HTMLButtonElement
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

describe('MessageActions: активное состояние кнопок', () => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })

  it('«Отладка» подсвечивается при debugActive', async () => {
    const container = await renderActions({ debugActive: true })
    const btn = getButton(container, 'Debug')
    expect(btn.className).toContain('text-primary')
    expect(btn.className).toContain('bg-primary/10')
  })

  it('«Отладка» не подсвечивается без debugActive', async () => {
    const container = await renderActions({ debugActive: false })
    const btn = getButton(container, 'Debug')
    expect(btn.className).not.toContain('text-primary')
    expect(btn.className).not.toContain('bg-primary/10')
  })

  it('статистика: кнопка в ряду, поповер открывается и подсвечивает кнопку', async () => {
    const container = await renderActions({
      hasStats: true,
      statsContent: <div data-testid="stats-body">stats</div>,
    })
    const trigger = getButton(container, 'Response stats')
    expect(container.querySelector('.message-actions')!.contains(trigger)).toBe(true)
    // Инлайн-строки нет, поповер закрыт.
    expect(container.querySelector('[data-testid="stats-body"]')).toBeNull()
    expect(trigger.className).not.toContain('text-primary')

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const opened = getButton(container, 'Response stats')
    expect(opened.className).toContain('text-primary')
    expect(opened.className).toContain('bg-primary/10')
    const body = document.querySelector('[data-testid="stats-body"]')
    expect(body).not.toBeNull()
    // Поповер: выравнивание по левому краю кнопки, сторона top, минимальная
    // высота как у блока выбора режима сессии (34px); при сабагентах — 2 строки.
    const popoverContent = body!.parentElement as HTMLElement
    expect(popoverContent.getAttribute('data-align')).toBe('start')
    expect(popoverContent.getAttribute('data-side')).toBe('top')
    expect(popoverContent.className).toContain('min-h-[34px]')
    expect(popoverContent.className).toContain('items-center')

    await act(async () => {
      opened.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const closed = getButton(container, 'Response stats')
    expect(closed.className).not.toContain('text-primary')
  })

  it('без статистики кнопки нет', async () => {
    const container = await renderActions({
      hasStats: false,
      statsContent: <div data-testid="stats-body">stats</div>,
    })
    expect(container.querySelector('button[title="Response stats"]')).toBeNull()
    expect(container.querySelector('[data-testid="stats-body"]')).toBeNull()
  })
})
