/**
 * ADR-118 §1: заголовок хода («агент · модель · время») рисуется **только**
 * у первого сегмента хода.
 *
 * Ход может быть разорван вставленной user-репликой — в т.ч. уведомлением о
 * фоновом прогоне (`metadata.type === 'background_run_result'`): тогда лента
 * показывает две группы одного хода, и вторая не должна повторять шапку.
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
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MessageList, groupMessagesByTurn, isTurnContinuation } from './MessageList'
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
    created_at: '2026-10-30T00:00:00Z',
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
 * Обычный ход: реплика пользователя несёт **тот же** `turn_id`, что и ответ
 * (ADR-118 §1). Первая assistant-группа хода идёт сразу после user-группы —
 * шапка («агент · модель · время») должна быть у неё, а не считаться повтором.
 */
function turnWithUserReply(): MessageData[] {
  return [
    msg({ id: 'u1', index: 1, ord: 1, role: 'user', turn_id: 't1', content: 'Вопрос' }),
    msg({
      id: 'a1', index: 2, ord: 2, turn_id: 't1', step_index: 0,
      content: 'Ответ', agent_role: 'fixer', model: 'model-x',
    }),
  ]
}

/** Ход, разорванный уведомлением о фоновом прогоне. */
function turnSplitByNotice(): MessageData[] {
  return [
    msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', step_index: 0, content: 'Первый сегмент', agent_role: 'fixer' }),
    msg({
      id: 'notice', index: 2, ord: 11, role: 'user', turn_id: 't1',
      content: 'Фоновый процесс завершён',
      metadata: { type: 'background_run_result' },
    }),
    msg({ id: 'a2', index: 3, ord: 12, turn_id: 't1', step_index: 1, content: 'Второй сегмент', agent_role: 'fixer' }),
  ]
}

describe('MessageList: шапка хода — только у первого сегмента (ADR-118 §1)', () => {
  it('уведомление о фоне разбивает ход на группы с одинаковым turn_id', () => {
    const groups = groupMessagesByTurn(turnSplitByNotice())
    expect(groups.map((g) => g.turnId)).toEqual(['t1', 't1', 't1'])
    // Вторая assistant-группа — продолжение хода.
    expect(isTurnContinuation(groups, 2)).toBe(true)
    // User-группа (уведомление) — не продолжение.
    expect(isTurnContinuation(groups, 1)).toBe(false)
  })

  it('группы разных ходов — не продолжения', () => {
    const groups = groupMessagesByTurn([
      msg({ id: 'a1', index: 1, ord: 1, turn_id: 't1' }),
      msg({ id: 'a2', index: 2, ord: 2, turn_id: 't2' }),
    ])
    expect(isTurnContinuation(groups, 1)).toBe(false)
  })

  it('первая assistant-группа после user-реплики — не продолжение', () => {
    const groups = groupMessagesByTurn(turnWithUserReply())
    // user-группа (свой `turn_id` хода) не делает ответ продолжением.
    expect(isTurnContinuation(groups, 1)).toBe(false)
  })

  it('шапка есть у ответа после user-реплики (агент и модель видны)', async () => {
    const container = await renderList(turnWithUserReply())

    // Шапка ответа: агент + модель.
    expect(container.textContent).toContain('fixer')
    expect(container.textContent).toContain('model-x')
  })

  it('шапки нет у ответа, если предыдущая assistant-группа — другой ход', async () => {
    const container = await renderList([
      msg({ id: 'a1', index: 1, ord: 1, turn_id: 't1', content: 'Первый', agent_role: 'fixer', model: 'model-x' }),
      msg({ id: 'a2', index: 2, ord: 2, turn_id: 't2', content: 'Второй', agent_role: 'tester', model: 'model-y' }),
    ])

    // Оба хода — со своей шапкой.
    expect(container.textContent).toContain('fixer')
    expect(container.textContent).toContain('tester')
    expect(container.textContent).toContain('model-x')
    expect(container.textContent).toContain('model-y')
  })

  it('шапка агента рисуется один раз — у первого сегмента хода', async () => {
    const container = await renderList(turnSplitByNotice())

    // Бейдж агента в шапке MessageHeader рисуется по `agent_role`.
    const occurrences = (container.textContent?.match(/fixer/g) ?? []).length
    expect(occurrences).toBe(1)
    // Текст обоих сегментов на месте.
    expect(container.textContent).toContain('Первый сегмент')
    expect(container.textContent).toContain('Второй сегмент')
  })

  it('ход «реплика → ответ → notice → продолжение»: шапка ровно у первого ответа', async () => {
    const messages: MessageData[] = [
      msg({ id: 'u1', index: 1, ord: 1, role: 'user', turn_id: 't1', content: 'Вопрос' }),
      msg({ id: 'a1', index: 2, ord: 2, turn_id: 't1', step_index: 0, agent_role: 'fixer', model: 'model-x', content: 'Первый сегмент' }),
      msg({
        id: 'notice', index: 3, ord: 3, role: 'user', turn_id: 't1',
        content: 'Фоновый процесс завершён',
        metadata: { type: 'background_run_result' },
      }),
      msg({ id: 'a2', index: 4, ord: 4, turn_id: 't1', step_index: 1, agent_role: 'fixer', model: 'model-x', content: 'Второй сегмент' }),
    ]

    const groups = groupMessagesByTurn(messages)
    // Первый ответ (после реплики пользователя) — с шапкой, второй — продолжение.
    expect(isTurnContinuation(groups, 1)).toBe(false)
    expect(isTurnContinuation(groups, 3)).toBe(true)

    const container = await renderList(messages)
    expect((container.textContent?.match(/fixer/g) ?? []).length).toBe(1)
    expect((container.textContent?.match(/model-x/g) ?? []).length).toBe(1)
    expect(container.textContent).toContain('Первый сегмент')
    expect(container.textContent).toContain('Второй сегмент')
  })
})
