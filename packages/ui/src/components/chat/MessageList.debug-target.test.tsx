/**
 * ADR-118 §1: кнопка «Отладка» у любого сегмента хода.
 *
 * `debug_data` пишется только в **финальное** сообщение хода, а действия
 * рисуются у последнего сегмента каждой группы. В ходе, разорванном
 * уведомлением (вторая группа с тем же `turn_id`), у первой группы кнопки
 * «Отладка» не было — пользователь считал, что она пропала.
 *
 * `MessageList` вычисляет дебаг-цель хода (последнее assistant-сообщение
 * `turn_id` с непустым `debug_data`) и передаёт её в `ChatMessage`; кнопка
 * открывает дебаг **финала**.
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

async function renderList(
  messages: MessageData[],
  onDebug: (msg: MessageData) => void,
): Promise<HTMLElement> {
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
          onDebug={onDebug}
          onFork={() => {}}
        />
      </I18nProvider>,
    )
  })
  return container
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

/**
 * Ход, разорванный уведомлением о фоновом прогоне:
 * группа 1 — шаг 0, группа 2 (после уведомления) — финал с `debug_data`.
 */
function splitTurn(): { messages: MessageData[]; final: MessageData } {
  const step0 = msg({
    id: 'a-step0',
    index: 1,
    ord: 2,
    turn_id: 't1',
    step_index: 0,
    status: 'completed',
    content: 'Первый шаг',
  })
  const notice = msg({
    id: 'bg-1',
    index: 2,
    ord: 3,
    role: 'user',
    turn_id: null,
    content: '<process ...>',
    metadata: { type: 'background_run_result' },
  })
  const final = msg({
    id: 'a-final',
    index: 3,
    ord: 4,
    turn_id: 't1',
    step_index: 1,
    status: 'completed',
    content: 'Финал',
    debug_data: { prompt: 'x' },
  })
  return {
    messages: [
      msg({ id: 'u1', index: 0, ord: 1, role: 'user', turn_id: 't1', content: 'Вопрос' }),
      step0,
      notice,
      final,
    ],
    final,
  }
}

describe('MessageList: кнопка «Отладка» у сегментов хода', () => {
  it('в разорванном ходе у первой группы тоже есть «Отладка» и она открывает финал', async () => {
    const calls: MessageData[] = []
    const { messages, final } = splitTurn()
    const container = await renderList(messages, (m) => calls.push(m))

    const step0El = container.querySelector('[data-message-id="a-step0"]') as HTMLElement
    expect(step0El).not.toBeNull()
    const debugBtn = step0El.querySelector('button[title="Debug"]') as HTMLButtonElement | null
    expect(debugBtn).not.toBeNull()

    await act(async () => {
      debugBtn!.click()
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('a-final')
    expect(calls[0]).toBe(final)
  })

  it('одиночное сообщение без turn_id открывает собственный дебаг', async () => {
    const calls: MessageData[] = []
    const single = msg({
      id: 'a-single',
      index: 0,
      content: 'Ответ',
      status: 'completed',
      debug_data: { prompt: 'y' },
    })
    const container = await renderList([single], (m) => calls.push(m))

    const debugBtn = container.querySelector(
      '[data-message-id="a-single"] button[title="Debug"]',
    ) as HTMLButtonElement | null
    expect(debugBtn).not.toBeNull()

    await act(async () => {
      debugBtn!.click()
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('a-single')
  })
})
