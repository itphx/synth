/**
 * Новая UX-модель индикатора: отдельной строки активности хода
 * (`turn-activity`, «Выполняется…»/«Выполняется инструмент…») больше нет —
 * «идёт» показывают точки в шапке последнего сегмента хода, а автоповтор
 * (`RetryStatus`) живёт **внизу ответа** у последнего сегмента (не у реплики).
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

const USER_REPLY = msg({ id: 'u-1', index: 0, ord: 1, role: 'user', turn_id: 't1', content: 'сделай' })

/** Завершённый ответ хода — контент есть, живого сегмента нет. */
const ANSWER = msg({
  id: 'a-1',
  index: 1,
  ord: 2,
  role: 'assistant',
  turn_id: 't1',
  step_index: 0,
  status: 'completed',
  content: 'Готово',
  agent_role: 'fixer',
  model: 'model-x',
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

describe('MessageList: строки активности хода больше нет', () => {
  it('контент хода был, живого сегмента нет — turn-activity отсутствует, точки в шапке', async () => {
    const container = await renderList([USER_REPLY, ANSWER], {
      turnId: 't1',
      status: 'streaming',
      contentStarted: true,
    })

    expect(container.querySelector('[data-testid="turn-activity"]')).toBeNull()
    // Прежние тексты строки активности не рендерятся.
    expect(container.textContent).not.toContain('Working')
    expect(container.textContent).not.toContain('Running a tool')

    const segment = container.querySelector('[data-message-id="a-1"]') as HTMLElement
    expect(segment.querySelector('[data-testid="processing-indicator"]')).not.toBeNull()
  })

  it('ход завершён — точек в шапке нет', async () => {
    const container = await renderList([USER_REPLY, ANSWER], {
      turnId: 't1',
      status: 'completed',
      contentStarted: true,
    })

    expect(container.querySelector('[data-testid="turn-activity"]')).toBeNull()
    expect(container.querySelector('[data-testid="processing-indicator"]')).toBeNull()
  })

  it('пустой live-сегмент не первым — не рендерится, точки в шапке блока', async () => {
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
      toolsRunning: true,
    })

    // Пустой не-первый сегмент не рисуется вовсе (шапку блока не дублирует).
    expect(container.querySelector('[data-message-id="a-empty"]')).toBeNull()
    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block.querySelectorAll('[data-testid="processing-indicator"]')).toHaveLength(1)
  })
})

describe('MessageList: автоповтор внизу последнего сегмента', () => {
  it('retry активного хода — плашка внизу ответа, не у реплики', async () => {
    const container = await renderList(
      [USER_REPLY, ANSWER],
      { turnId: 't1', streamId: 's-1', status: 'streaming', contentStarted: true },
      { streamId: 's-1', attempt: 2, maxRetries: 3, retryInMs: 5000 },
    )

    const segment = container.querySelector('[data-message-id="a-1"]') as HTMLElement
    expect(segment.textContent).toContain('Retry 2/3 in')
    expect(segment.querySelector('button[title="Retry now"]')).not.toBeNull()
    expect(segment.querySelector('button[title="Cancel"]')).not.toBeNull()

    // У реплики пользователя плашки нет.
    const reply = container.querySelector('[data-message-id="u-1"]') as HTMLElement
    expect(reply.textContent).not.toContain('Retry 2/3 in')
    expect(reply.querySelector('button[title="Retry now"]')).toBeNull()
  })

  it('retry другого стрима не показывается', async () => {
    const container = await renderList(
      [USER_REPLY, ANSWER],
      { turnId: 't1', streamId: 's-1', status: 'streaming', contentStarted: true },
      { streamId: 's-2', attempt: 1, maxRetries: 3, retryInMs: 5000 },
    )

    expect(container.textContent).not.toContain('Retry 1/3 in')
  })

  it('плашка повтора стоит после контента ответа', async () => {
    const container = await renderList(
      [USER_REPLY, ANSWER],
      { turnId: 't1', streamId: 's-1', status: 'streaming', contentStarted: true },
      { streamId: 's-1', attempt: 1, maxRetries: 3, retryInMs: 5000 },
    )

    const segment = container.querySelector('[data-message-id="a-1"]') as HTMLElement
    const text = segment.querySelector('.markdown-content') as HTMLElement
    const plate = Array.from(segment.querySelectorAll('span')).find((el) =>
      el.textContent?.includes('Retry 1/3 in'),
    ) as HTMLElement | undefined
    expect(text).not.toBeNull()
    expect(plate).toBeDefined()
    expect(
      (text.compareDocumentPosition(plate!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true)
  })
})
