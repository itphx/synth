/**
 * Строка активности хода в конце ленты («как часы»).
 *
 * Контент хода уже был, но живого assistant-сегмента нет — лента выглядела
 * пустой: во время инструментов, после reload и в паузах между шагами.
 * Строка — компактная, не пузырь и без действий; при завершении хода исчезает.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
    clear: () => { data.clear() },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

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
import type { ActiveTurn, MessageData, StreamRetry } from '@/stores/chatStore'

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

const USER_REPLY = msg({ id: 'u-1', index: 0, ord: 1, role: 'user', content: 'сделай' })

/** Завершённый ответ хода — контент есть, живой части нет. */
const ANSWER = msg({
  id: 'a-1',
  index: 1,
  ord: 2,
  role: 'assistant',
  turn_id: 't1',
  step_index: 0,
  status: 'completed',
  content: 'Готово',
})

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderList(
  messages: MessageData[],
  turn?: ActiveTurn | null,
  retry?: StreamRetry | null,
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
          turn={turn ?? null}
          retry={retry ?? null}
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

describe('MessageList: строка активности хода', () => {
  it('контент хода был, живого сегмента нет — строка в конце ленты', async () => {
    const container = await renderList([USER_REPLY, ANSWER], {
      turnId: 't1',
      status: 'streaming',
      contentStarted: true,
    })

    const row = container.querySelector('[data-testid="turn-activity"]')
    expect(row).not.toBeNull()
    expect(row!.querySelector('[data-testid="live-indicator"]')).not.toBeNull()
    expect(container.textContent).toContain('Working')
  })

  it('контента хода ещё нет — строка не показывается', async () => {
    const container = await renderList([USER_REPLY], {
      turnId: 't1',
      status: 'streaming',
      contentStarted: false,
    })

    expect(container.querySelector('[data-testid="turn-activity"]')).toBeNull()
  })

  it('живой assistant-сегмент есть — строка не дублирует его индикатор', async () => {
    const live = msg({
      id: 'a-live',
      index: 1,
      ord: 2,
      role: 'assistant',
      turn_id: 't1',
      step_index: 1,
      status: 'streaming',
      content: 'Продолжение',
    })
    const container = await renderList([USER_REPLY, ANSWER, live], {
      turnId: 't1',
      messageId: 'a-live',
      status: 'streaming',
      contentStarted: true,
    })

    expect(container.querySelector('[data-testid="turn-activity"]')).toBeNull()
    expect(container.querySelector('[data-testid="live-indicator"]')).not.toBeNull()
  })

  it('ход завершён — строка скрыта', async () => {
    const container = await renderList([USER_REPLY, ANSWER], {
      turnId: 't1',
      status: 'completed',
      contentStarted: true,
    })

    expect(container.querySelector('[data-testid="turn-activity"]')).toBeNull()
  })

  it('пустой streaming-сегмент не рендерится и не скрывает строку', async () => {
    const emptyLive = msg({
      id: 'a-empty',
      index: 2,
      ord: 3,
      role: 'assistant',
      turn_id: 't1',
      step_index: 1,
      status: 'streaming',
      content: '',
      parts: [],
    })
    const container = await renderList([USER_REPLY, ANSWER, emptyLive], {
      turnId: 't1',
      messageId: 'a-empty',
      status: 'streaming',
      contentStarted: true,
    })

    // Пустой сегмент в ленте отсутствует (нет точек в середине блока)…
    expect(container.querySelector('[data-message-id="a-empty"]')).toBeNull()
    // …а индикатор хода виден строкой внизу.
    expect(container.querySelector('[data-testid="turn-activity"]')).not.toBeNull()
  })

  it('retry активного хода виден в строке активности (пауза между шагами)', async () => {
    const container = await renderList(
      [USER_REPLY, ANSWER],
      { turnId: 't1', streamId: 's-1', status: 'streaming', contentStarted: true },
      { streamId: 's-1', attempt: 2, maxRetries: 3, retryInMs: 5000 },
    )

    const row = container.querySelector('[data-testid="turn-activity"]')
    expect(row).not.toBeNull()
    expect(row!.getAttribute('data-retrying')).toBe('true')
    expect(row!.textContent).toContain('Retry 2/3 in')
  })

  it('retry другого стрима в строке активности не показывается', async () => {
    const container = await renderList(
      [USER_REPLY, ANSWER],
      { turnId: 't1', streamId: 's-1', status: 'streaming', contentStarted: true },
      { streamId: 's-2', attempt: 1, maxRetries: 3, retryInMs: 5000 },
    )

    const row = container.querySelector('[data-testid="turn-activity"]')
    expect(row).not.toBeNull()
    expect(row!.getAttribute('data-retrying')).toBeNull()
    expect(row!.textContent).toContain('Working')
  })
})
