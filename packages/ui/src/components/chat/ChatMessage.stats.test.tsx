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

// Управляемый мок устройства: desktop (fine pointer) / mobile (touch).
const device = vi.hoisted(() => ({ isTouch: false }))
vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({
    deviceType: device.isTouch ? 'phone' : 'desktop',
    isTouch: device.isTouch,
  }),
}))

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

describe('ChatMessage: статистика desktop/mobile', () => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })

  it('desktop: строка статистики видна всегда, кнопки статистики нет', async () => {
    device.isTouch = false
    const container = await renderChat(makeMessage({}))
    expect(container.querySelector('[data-testid="message-stats"]')).not.toBeNull()
    expect(container.querySelector('button[title="Response stats"]')).toBeNull()
  })

  it('mobile: инлайн-строки нет, кнопка статистики есть', async () => {
    device.isTouch = true
    const container = await renderChat(makeMessage({}))
    // Инлайн не рендерится (popover-контент закрыт и порталится только при открытии).
    expect(container.querySelector('[data-testid="message-stats"]')).toBeNull()
    expect(container.querySelector('button[title="Response stats"]')).not.toBeNull()
  })

  it('mobile: по клику открывается popover со статистикой', async () => {
    device.isTouch = true
    const container = await renderChat(makeMessage({}))
    const trigger = container.querySelector('button[title="Response stats"]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const stats = document.querySelector('[data-testid="message-stats"]')
    expect(stats).not.toBeNull()
    // Popover-вариант — одна строка без переноса с разделителями.
    expect(stats!.className).toContain('flex-nowrap')
    expect(stats!.className).toContain('whitespace-nowrap')
    expect(stats!.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
  })

  it('mobile: кнопка статистики подсвечивается, пока открыт popover', async () => {
    device.isTouch = true
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
    device.isTouch = false
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
    device.isTouch = false
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
    device.isTouch = false
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
