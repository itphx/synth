/**
 * ADR-118 §1/§5: индикатор идущего хода (три точки), live-статистика и
 * «В фон» живут **в конце** содержимого сегмента.
 *
 * Ход склеен в один блок (`turn-block`), живой сегмент — последний. Если
 * индикатор стоит над содержимым сегмента, он визуально попадает в
 * середину ответа (между предыдущим сегментом и текущим) — это и был дефект.
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
import { MessageList } from './MessageList'
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

async function renderList(messages: MessageData[]): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <MessageList
          messages={messages}
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

/** true — `after` идёт в DOM после `before`. */
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

describe('ChatMessage: индикатор идущего хода — в конце содержимого', () => {
  it('одиночное живое сообщение: точки и live-статистика идут после текста', async () => {
    const container = await renderChat(msg({
      id: 'live-1',
      content: 'Часть ответа',
      status: 'streaming',
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    }))

    const indicator = container.querySelector('[data-testid="live-indicator"]')
    expect(indicator).not.toBeNull()
    const text = container.querySelector('.markdown-content')
    expect(text).not.toBeNull()
    expect(follows(text!, indicator!)).toBe(true)

    // Live-строка (статистика) — тоже после содержимого: это соседняя
    // строка индикатора (поповер со статистикой открывается по кнопке).
    const liveRow = indicator!.nextElementSibling as HTMLElement
    expect(liveRow).not.toBeNull()
    expect(liveRow.querySelector('button[title="Response stats"]')).not.toBeNull()
    expect(follows(text!, liveRow)).toBe(true)
  })

  it('склеенный блок хода: точки — в конце блока, а не между сегментами', async () => {
    const container = await renderList([
      msg({ id: 'a1', index: 0, ord: 10, turn_id: 't1', step_index: 0, content: 'Первый шаг' }),
      msg({
        id: 'a2', index: 1, ord: 11, turn_id: 't1', step_index: 1,
        content: 'Второй шаг', status: 'streaming',
      }),
    ])

    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block).not.toBeNull()

    const indicator = block.querySelector('[data-testid="live-indicator"]')
    expect(indicator).not.toBeNull()
    // Индикатор принадлежит последнему (живому) сегменту.
    const liveSegment = block.querySelector('[data-message-id="a2"]') as HTMLElement
    expect(liveSegment.contains(indicator!)).toBe(true)

    const firstText = block.querySelector('[data-message-id="a1"] .markdown-content') as HTMLElement
    const lastText = liveSegment.querySelector('.markdown-content') as HTMLElement
    expect(firstText).not.toBeNull()
    expect(lastText).not.toBeNull()

    // Точки стоят после текста обоих сегментов — то есть в конце блока.
    expect(follows(firstText, indicator!)).toBe(true)
    expect(follows(lastText, indicator!)).toBe(true)
  })

  it('мёртвое сообщение: индикатора нет', async () => {
    const container = await renderChat(msg({ id: 'dead-1', content: 'Готово', status: 'completed' }))
    expect(container.querySelector('[data-testid="live-indicator"]')).toBeNull()
    expect(container.querySelector('[data-testid="live-stats"]')).toBeNull()
  })
})
