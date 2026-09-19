import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
// Заглушку ставим до импорта стора (vi.hoisted выполняется раньше импортов).
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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: 'Ответ ассистента',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
    usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
    metadata: { duration_ms: 2000, status: 'completed' },
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(message: MessageData): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatMessage
          message={message}
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

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  useChatStore.setState({ debugModalSessionId: null, debugModalMessageIndex: null })
})

describe('ChatMessage: статистика (единый поповер)', () => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })

  it('инлайн-строки нет, кнопка статистики — в ряду кнопок', async () => {
    const container = await renderChat(makeMessage({}))
    // Поповер закрыт — статистика не рендерится инлайном.
    expect(container.querySelector('[data-testid="message-stats"]')).toBeNull()
    const trigger = container.querySelector('button[title="Response stats"]')
    expect(trigger).not.toBeNull()
    expect(container.querySelector('.message-actions')!.contains(trigger!)).toBe(true)
  })

  it('по клику открывается popover со статистикой одной строкой', async () => {
    const container = await renderChat(makeMessage({}))
    const trigger = container.querySelector('button[title="Response stats"]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const stats = document.querySelector('[data-testid="message-stats"]')
    expect(stats).not.toBeNull()
    // Единый рендер — одна строка без переноса с разделителями.
    expect(stats!.className).toContain('flex-nowrap')
    expect(stats!.className).toContain('whitespace-nowrap')
    expect(stats!.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
  })

  it('кнопка статистики подсвечивается, пока открыт popover', async () => {
    const container = await renderChat(makeMessage({}))
    const trigger = container.querySelector('button[title="Response stats"]') as HTMLButtonElement
    expect(trigger.className).not.toContain('text-primary')
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const opened = container.querySelector('button[title="Response stats"]') as HTMLButtonElement
    expect(opened.className).toContain('text-primary')
    expect(opened.className).toContain('bg-primary/10')
  })

  it('«Отладка» подсвечивается для открытого сообщения активной сессии', async () => {
    useUIStore.setState({
      centerTabs: [{ id: 'chat-s1', type: 'chat', title: 'S1', data: { sessionId: 's1' } }],
      activeCenterTabId: 'chat-s1',
    })
    useChatStore.setState({ debugModalSessionId: 's1', debugModalMessageIndex: 0 })
    const container = await renderChat(makeMessage({ index: 0, debug_data: { prompt: 'x' } }))
    const btn = container.querySelector('button[title="Debug"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.className).toContain('text-primary')
  })

  it('«Отладка» не подсвечивается для другого сообщения', async () => {
    useUIStore.setState({
      centerTabs: [{ id: 'chat-s1', type: 'chat', title: 'S1', data: { sessionId: 's1' } }],
      activeCenterTabId: 'chat-s1',
    })
    useChatStore.setState({ debugModalSessionId: 's1', debugModalMessageIndex: 1 })
    const container = await renderChat(makeMessage({ index: 0, debug_data: { prompt: 'x' } }))
    const btn = container.querySelector('button[title="Debug"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.className).not.toContain('text-primary')
  })

  it('«Отладка» не подсвечивается для другой сессии', async () => {
    useUIStore.setState({
      centerTabs: [{ id: 'chat-s1', type: 'chat', title: 'S1', data: { sessionId: 's1' } }],
      activeCenterTabId: 'chat-s1',
    })
    useChatStore.setState({ debugModalSessionId: 'other', debugModalMessageIndex: 0 })
    const container = await renderChat(makeMessage({ index: 0, debug_data: { prompt: 'x' } }))
    const btn = container.querySelector('button[title="Debug"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.className).not.toContain('text-primary')
  })
})
