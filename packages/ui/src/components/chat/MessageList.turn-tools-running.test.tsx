/**
 * Строка активности хода: при `toolsRunning` текст — «Выполняется инструмент…»
 * (`chat.turn.runningTool`), иначе прежнее «Выполняется…» (`chat.turn.working`).
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
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { MessageList } from './MessageList'
import type { ActiveTurn, MessageData } from '@/stores/chatStore'

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

/** Завершённый ответ шага — контент есть, живой части нет (идёт инструмент). */
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
  turn: ActiveTurn | null,
  locale: 'en' | 'ru' = 'en',
): Promise<HTMLElement> {
  useI18nStore.setState({
    locale,
    dictionary: locale === 'ru' ? ruDict : enDict,
    loadingLocale: null,
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <MessageList
          messages={messages}
          turn={turn}
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

describe('MessageList: строка активности — выполнение инструмента', () => {
  it('toolsRunning → «Running a tool…» и маркер data-tools-running', async () => {
    const container = await renderList([USER_REPLY, ANSWER], {
      turnId: 't1',
      status: 'streaming',
      contentStarted: true,
      toolsRunning: true,
    })

    const row = container.querySelector('[data-testid="turn-activity"]')
    expect(row).not.toBeNull()
    expect(row!.getAttribute('data-tools-running')).toBe('true')
    expect(row!.textContent).toContain('Running a tool')
    expect(row!.textContent).not.toContain('Working')
  })

  it('toolsRunning без контента хода — строка всё равно показывается', async () => {
    const container = await renderList([USER_REPLY], {
      turnId: 't1',
      status: 'streaming',
      contentStarted: false,
      toolsRunning: true,
    })

    expect(container.querySelector('[data-testid="turn-activity"]')).not.toBeNull()
    expect(container.textContent).toContain('Running a tool')
  })

  it('без toolsRunning — прежний текст «Working…»', async () => {
    const container = await renderList([USER_REPLY, ANSWER], {
      turnId: 't1',
      status: 'streaming',
      contentStarted: true,
    })

    const row = container.querySelector('[data-testid="turn-activity"]')
    expect(row!.textContent).toContain('Working')
    expect(row!.getAttribute('data-tools-running')).toBeNull()
  })

  it('ru-локаль: «Выполняется инструмент…»', async () => {
    const container = await renderList([USER_REPLY, ANSWER], {
      turnId: 't1',
      status: 'streaming',
      contentStarted: true,
      toolsRunning: true,
    }, 'ru')

    expect(container.textContent).toContain('Выполняется инструмент')
  })

  it('ход завершён — строки нет даже с toolsRunning', async () => {
    const container = await renderList([USER_REPLY, ANSWER], {
      turnId: 't1',
      status: 'completed',
      contentStarted: true,
      toolsRunning: true,
    })

    expect(container.querySelector('[data-testid="turn-activity"]')).toBeNull()
  })
})
