/**
 * ADR-118 §5: индикатор «идёт» живёт **у реплики пользователя**, пока ход не
 * дал контента; после первой части ответа — в живом сегменте ответа.
 *
 * Регрессии, которые закрывает набор:
 * - `turn.started` не должен создавать живое сообщение: плашка «обработка»
 *   у реплики видна от отправки до первого чанка (а не исчезает);
 * - пустой живой сегмент (шаг без контента) рисуется только если контент
 *   хода уже был — иначе в нём нет ничего, что показывать;
 * - статус автоповтора (`stream.retry`) виден у реплики, пока нет контента.
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

/** Пустое живое сообщение шага (`step.started` без контента). */
const LIVE_STEP = msg({
  id: 'a-1',
  index: 1,
  ord: 2,
  role: 'assistant',
  turn_id: 't1',
  step_index: 0,
  status: 'streaming',
  content: '',
  parts: [],
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

describe('MessageList: индикатор «идёт» у реплики пользователя', () => {
  it('ход без контента: у реплики плашка «обработка», пустого пузыря-ответа нет', async () => {
    const container = await renderList([USER_REPLY], {
      turnId: 't1',
      status: 'streaming',
      contentStarted: false,
    })

    expect(container.querySelector('[data-testid="processing-indicator"]')).not.toBeNull()
    // Пустого живого сегмента (шаг без контента) нет — точки живут у реплики.
    expect(container.querySelector('[data-testid="live-indicator"]')).toBeNull()
  })

  it('контент хода начался: плашка «обработка» у реплики исчезает', async () => {
    const container = await renderList([USER_REPLY], {
      turnId: 't1',
      status: 'streaming',
      contentStarted: true,
    })

    expect(container.querySelector('[data-testid="processing-indicator"]')).toBeNull()
  })

  it('пустой живой сегмент при contentStarted=true показывает точки в конце блока', async () => {
    const container = await renderList([USER_REPLY, LIVE_STEP], {
      turnId: 't1',
      messageId: 'a-1',
      status: 'streaming',
      contentStarted: true,
    })

    const indicator = container.querySelector('[data-testid="live-indicator"]')
    expect(indicator).not.toBeNull()
    const liveSegment = container.querySelector('[data-message-id="a-1"]') as HTMLElement
    expect(liveSegment).not.toBeNull()
    expect(liveSegment.contains(indicator!)).toBe(true)
  })

  it('пустой живой сегмент при contentStarted=false не рисуется (плашка у реплики)', async () => {
    const container = await renderList([USER_REPLY, LIVE_STEP], {
      turnId: 't1',
      messageId: 'a-1',
      status: 'streaming',
      contentStarted: false,
    })

    expect(container.querySelector('[data-testid="live-indicator"]')).toBeNull()
    expect(container.querySelector('[data-testid="processing-indicator"]')).not.toBeNull()
  })

  it('статус автоповтора — у реплики, пока контент хода не начался', async () => {
    const container = await renderList(
      [USER_REPLY],
      {
        turnId: 't1',
        streamId: 'stream-1',
        status: 'streaming',
        contentStarted: false,
      },
      { streamId: 'stream-1', attempt: 1, maxRetries: 3, retryInMs: 5000 },
    )

    expect(container.textContent).toContain('Retry 1/3 in')
  })

  it('плашка «обработка» — у человеческой реплики, а не у уведомления о фоне', async () => {
    // Уведомление о фоне — role:'user', но рисуется как `Notice` (плашки нет):
    // если бы оно стало кандидатом, индикатор работы хода пропадал бы.
    const container = await renderList(
      [
        USER_REPLY,
        msg({
          id: 'bg-1',
          index: 2,
          ord: 3,
          role: 'user',
          turn_id: null,
          content: '<process ...>',
          metadata: { type: 'background_run_result' },
        }),
      ],
      { turnId: 't1', status: 'streaming', contentStarted: false },
    )

    const badge = container.querySelector('[data-testid="processing-indicator"]')
    expect(badge).not.toBeNull()
    const reply = container.querySelector('[data-message-id="u-1"]') as HTMLElement
    expect(reply).not.toBeNull()
    expect(reply.contains(badge!)).toBe(true)
  })

  it('сообщение шедулера и системная команда — не кандидаты на плашку', async () => {
    const container = await renderList(
      [
        USER_REPLY,
        msg({
          id: 'sch-1',
          index: 2,
          ord: 3,
          role: 'user',
          author: 'Scheduler',
          content: 'расписание',
          metadata: { scheduler: true },
        }),
        msg({
          id: 'cmd-1',
          index: 3,
          ord: 4,
          role: 'user',
          content: '/help',
          metadata: { commandPrompt: true },
        }),
      ],
      { turnId: 't1', status: 'streaming', contentStarted: false },
    )

    const badge = container.querySelector('[data-testid="processing-indicator"]')
    expect(badge).not.toBeNull()
    const reply = container.querySelector('[data-message-id="u-1"]') as HTMLElement
    expect(reply.contains(badge!)).toBe(true)
  })
})
