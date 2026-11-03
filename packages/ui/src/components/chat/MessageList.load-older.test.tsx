/**
 * Пагинация истории ленты: над лентой — кнопка «Загрузить старые»
 * (`GET /sessions/:id/messages?before=…`). Кнопка видна, пока сервер отдаёт
 * более старые сообщения (`has_more`), во время догрузки — disabled.
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
import { MessageList } from './MessageList'
import type { MessageData } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function msg(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    id: 'm1',
    role: 'assistant',
    content: 'ответ',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T00:00:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderList(
  props: {
    messages?: MessageData[]
    hasOlder?: boolean
    onLoadOlder?: () => void | Promise<void>
  } = {},
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <MessageList
          messages={props.messages ?? [msg({})]}
          turn={null}
          retry={null}
          onCopy={() => {}}
          onToggle={() => {}}
          onPin={() => {}}
          onDelete={() => {}}
          onRetry={() => {}}
          onDebug={() => {}}
          onFork={() => {}}
          hasOlder={props.hasOlder}
          onLoadOlder={props.onLoadOlder}
        />
      </I18nProvider>,
    )
  })
  return container
}

function loadOlderButton(container: ParentNode): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-testid="load-older"]')
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
  vi.clearAllMocks()
})

describe('MessageList — кнопка «Загрузить старые»', () => {
  it('кнопки нет, пока сервер не отдал более старых сообщений', async () => {
    const container = await renderList({ hasOlder: false })

    expect(loadOlderButton(container)).toBeNull()
  })

  it('при has_more кнопка видна и зовёт обработчик догрузки', async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(undefined)
    const container = await renderList({ hasOlder: true, onLoadOlder })

    const button = loadOlderButton(container)
    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('Load older messages')

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('во время догрузки кнопка disabled и показывает состояние загрузки', async () => {
    let release: (() => void) | null = null
    const onLoadOlder = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const container = await renderList({ hasOlder: true, onLoadOlder })

    const button = loadOlderButton(container)!
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const busy = loadOlderButton(container)!
    expect(busy.disabled).toBe(true)
    expect(busy.textContent).toContain('Loading')

    await act(async () => {
      release?.()
    })
  })
})
