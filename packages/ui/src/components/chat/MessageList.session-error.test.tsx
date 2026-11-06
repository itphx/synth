/**
 * Ошибка **основной** сессии в ленте не показывается (решение владельца
 * 2026-11-06): новые ошибки ядро сообщением не сохраняет (пользователю —
 * плашка `StreamErrorPanel`), а legacy-записи отсекает `isLlmFailureMessage`
 * **до** группировки по ходу — пустой блок хода/разделитель не появляется.
 *
 * Видимыми остаются:
 *  - fallback-ответы ядра с содержательным текстом (`session.output_limit`,
 *    `session.empty_response`) — у них `metadata.status: 'error'`, но это не ошибка;
 *  - частичный ответ после «Стопа»/прерывания (`metadata.interrupted`) — обычный
 *    ответ с бейджем «Прервано».
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

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// MessageList создаёт ResizeObserver, ScrollableOverlay проверяет его наличие.
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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { MessageList } from './MessageList'
import { useUIStore } from '@/stores/useUIStore'
import type { MessageData } from '@/stores/chatStore'

const noopMsg = (_msg: MessageData) => {}
const stableToggleSelect = (_messageId: string, _shiftKey: boolean) => {}

function msg(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-06T00:00:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

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
          turn={null}
          onCopy={noopMsg}
          onToggle={noopMsg}
          onPin={noopMsg}
          onDelete={noopMsg}
          onRetry={noopMsg}
          onDebug={noopMsg}
          onFork={noopMsg}
          onToggleSelect={stableToggleSelect}
        />
      </I18nProvider>,
    )
  })
  return container
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  useUIStore.setState({ chatDensity: 'normal', expandedChatGroup: null, revealedServiceGroups: [] })
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
  useUIStore.setState({ chatDensity: 'normal', expandedChatGroup: null, revealedServiceGroups: [] })
})

describe('MessageList: ошибка основной сессии', () => {
  it('assistant + status:error + router.* не рендерится, пустого блока и разделителя нет', async () => {
    const container = await renderList([
      msg({ id: 'u1', index: 0, ord: 1, role: 'user', content: 'вопрос', turn_id: 't1' }),
      msg({
        id: 'e1',
        index: 1,
        ord: 2,
        role: 'assistant',
        status: 'error',
        turn_id: 't1',
        step_index: 0,
        content: 'raw provider failure',
        metadata: { status: 'error', i18n: { key: 'router.network_error' } },
      }),
    ])

    // Реплика пользователя на месте, ошибки нет — ни текста, ни блока.
    expect(container.textContent).toContain('вопрос')
    expect(container.textContent).not.toContain('raw provider failure')
    expect(container.querySelector('[data-message-id="e1"]')).toBeNull()
    // Скрытый сегмент не оставил «пустого» блока хода или разделителя шагов.
    expect(container.querySelectorAll('[data-testid="turn-block"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-step-divider]')).toHaveLength(0)
  })

  it('legacy-ошибка без статуса шага (metadata.status: error) тоже скрыта', async () => {
    const container = await renderList([
      msg({
        id: 'l1',
        index: 0,
        ord: 1,
        status: null,
        content: 'legacy failure',
        metadata: { status: 'error' },
      }),
    ])

    expect(container.textContent).not.toContain('legacy failure')
    expect(container.querySelector('[data-message-id="l1"]')).toBeNull()
  })

  it('fallback session.output_limit остаётся видимым ответом', async () => {
    const container = await renderList([
      msg({
        id: 'f1',
        index: 0,
        ord: 1,
        role: 'assistant',
        status: 'error',
        content: 'Ответ оборван лимитом вывода',
        metadata: { status: 'error', i18n: { key: 'session.output_limit' } },
      }),
    ])

    expect(container.querySelector('[data-message-id="f1"]')).not.toBeNull()
    expect(container.textContent).toContain('Ответ оборван лимитом вывода')
    expect(container.querySelector('[role="group"]')).toBeNull()
  })

  it('частичный ответ (metadata.interrupted) виден с бейджем «Прервано»', async () => {
    const container = await renderList([
      msg({
        id: 'p1',
        index: 0,
        ord: 1,
        role: 'assistant',
        status: 'error',
        content: 'частичный ответ',
        metadata: { status: 'error', interrupted: true },
      }),
    ])

    expect(container.querySelector('[data-message-id="p1"]')).not.toBeNull()
    expect(container.textContent).toContain('частичный ответ')
    expect(container.textContent).toContain('Прервано')
  })
})
