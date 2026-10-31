/**
 * Новая UX-модель индикатора: точек-индикатора в **теле** ответа больше нет —
 * «идёт» показывают три точки в шапке последнего сегмента хода
 * (`MessageHeader processing`, `data-testid="processing-indicator"`).
 * Live-статистика и «В фон» остаются в конце содержимого сегмента.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

// MessageList создаёт ResizeObserver, ScrollableOverlay проверяет его наличие.
vi.hoisted(() => {
  if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = () => {}
  }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function msg(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    id: 'm1',
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T00:00:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(
  message: MessageData,
  props: { headerProcessing?: boolean; showLivePlaceholder?: boolean } = {},
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatMessage
          message={message}
          headerProcessing={props.headerProcessing}
          showLivePlaceholder={props.showLivePlaceholder}
          onCopy={() => {}}
          onToggle={() => {}}
          onPin={() => {}}
          onDelete={() => {}}
          onRetry={() => {}}
          onDebug={() => {}}
          onFork={() => {}}
        />
      </I18nProvider>,
    )
  })
  return container
}

function follows(before: Element, after: Element): boolean {
  return (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
})

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

describe('ChatMessage: индикатор «идёт» — только в шапке', () => {
  it('живое сообщение с headerProcessing: точки в шапке, в теле точек нет', async () => {
    const container = await renderChat(
      msg({
        id: 'live-1',
        content: 'Часть ответа',
        status: 'streaming',
        agent_role: 'fixer',
        model: 'model-x',
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }),
      { headerProcessing: true },
    )

    const dots = container.querySelector('[data-testid="processing-indicator"]')
    expect(dots).not.toBeNull()
    // Шапка показывает агента/модель и при точках.
    expect(container.textContent).toContain('fixer')
    expect(container.textContent).toContain('model-x')
    // Старого индикатора в теле больше нет.
    expect(container.querySelector('[data-testid="live-indicator"]')).toBeNull()

    // Live-статистика (кнопка-поповер) остаётся после текста.
    const text = container.querySelector('.markdown-content') as HTMLElement
    const statsButton = container.querySelector('button[title="Response stats"]') as HTMLElement
    expect(text).not.toBeNull()
    expect(statsButton).not.toBeNull()
    expect(follows(text, statsButton)).toBe(true)
  })

  it('без headerProcessing у завершённого сообщения — время, точек нет', async () => {
    const container = await renderChat(
      msg({ id: 'done-1', content: 'Готово', status: 'completed', agent_role: 'fixer', model: 'model-x' }),
    )

    expect(container.querySelector('[data-testid="processing-indicator"]')).toBeNull()
    expect(container.querySelector('[data-testid="live-indicator"]')).toBeNull()
    expect(container.textContent).toContain('fixer')
  })

  it('пустой живой сегмент с showLivePlaceholder — шапка с точками, без тела', async () => {
    const container = await renderChat(
      msg({ id: 'empty-1', content: '', parts: [], status: 'streaming', agent_role: 'fixer', model: 'model-x' }),
      { headerProcessing: true, showLivePlaceholder: true },
    )

    expect(container.querySelector('[data-testid="processing-indicator"]')).not.toBeNull()
    expect(container.querySelector('.markdown-content')).toBeNull()
    expect(container.querySelector('button[title="Response stats"]')).toBeNull()
    expect(container.textContent).toContain('fixer')
  })

  it('пустой живой сегмент без showLivePlaceholder не рендерится', async () => {
    const container = await renderChat(
      msg({ id: 'empty-2', content: '', parts: [], status: 'streaming' }),
      { headerProcessing: true },
    )

    expect(container.querySelector('[data-message-id="empty-2"]')).toBeNull()
  })
})
