/**
 * Новая UX-модель индикатора: заголовок «агент · модель · время» есть у
 * **каждой** assistant-группы хода — включая вторую группу после `Notice`
 * (уведомление о фоновом прогоне). Пока ход идёт, у **последнего**
 * assistant-сегмента хода вместо времени — три точки (`processing-indicator`);
 * у остальных сегментов — время.
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
import { MessageList, groupMessagesByTurn } from './MessageList'
import type { ActiveTurn, MessageData } from '@/stores/chatStore'

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

/** То же форматирование, что в `MessageHeader` — иначе часовой пояс теста «плывёт». */
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderList(
  messages: MessageData[],
  turn?: ActiveTurn | null,
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

function turnWithUserReply(): MessageData[] {
  return [
    msg({ id: 'u1', index: 1, ord: 1, role: 'user', turn_id: 't1', content: 'Вопрос' }),
    msg({
      id: 'a1', index: 2, ord: 2, turn_id: 't1', step_index: 0,
      content: 'Ответ', agent_role: 'fixer', model: 'model-x',
    }),
  ]
}

/** Ход, разорванный уведомлением о фоновом прогоне (вторая группа — после Notice). */
function turnSplitByNotice(): MessageData[] {
  return [
    msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', step_index: 0, content: 'Первый сегмент', agent_role: 'fixer', model: 'model-x' }),
    msg({
      id: 'notice', index: 2, ord: 11, role: 'user', turn_id: 't1',
      content: 'Фоновый процесс завершён',
      metadata: { type: 'background_run_result' },
    }),
    msg({ id: 'a2', index: 3, ord: 12, turn_id: 't1', step_index: 1, content: 'Второй сегмент', agent_role: 'fixer', model: 'model-x' }),
  ]
}

describe('MessageList: группировка по ходу (ADR-118 §1)', () => {
  it('уведомление о фоне разбивает ход на группы с одинаковым turn_id', () => {
    const groups = groupMessagesByTurn(turnSplitByNotice())
    expect(groups.map((g) => g.turnId)).toEqual(['t1', 't1', 't1'])
  })

  it('разные turn_id — разные группы', () => {
    const groups = groupMessagesByTurn([
      msg({ id: 'a1', index: 1, ord: 1, turn_id: 't1' }),
      msg({ id: 'a2', index: 2, ord: 2, turn_id: 't2' }),
    ])
    expect(groups.map((g) => g.turnId)).toEqual(['t1', 't2'])
  })
})

describe('MessageList: шапка у каждого визуального блока', () => {
  it('шапка есть у ответа после user-реплики (агент и модель видны)', async () => {
    const container = await renderList(turnWithUserReply())

    expect(container.textContent).toContain('fixer')
    expect(container.textContent).toContain('model-x')
  })

  it('ход «реплика → ответ → notice → продолжение»: шапка у каждой assistant-группы', async () => {
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

    const container = await renderList(messages)
    // Шапка каждой assistant-группы: агент и модель — по два раза.
    expect((container.textContent?.match(/fixer/g) ?? []).length).toBe(2)
    expect((container.textContent?.match(/model-x/g) ?? []).length).toBe(2)
    expect(container.textContent).toContain('Первый сегмент')
    expect(container.textContent).toContain('Второй сегмент')
  })
})

describe('MessageList: точки в шапке блока активного хода', () => {
  it('два сегмента, ход идёт: ровно одна шапка с точками, времени нет', async () => {
    const t1 = '2026-10-30T00:00:00Z'
    const t2 = '2026-10-30T00:05:00Z'
    const container = await renderList(
      [
        msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', step_index: 0, content: 'Первый', agent_role: 'fixer', model: 'model-x', created_at: t1 }),
        msg({ id: 'a2', index: 2, ord: 11, turn_id: 't1', step_index: 1, content: 'Второй', agent_role: 'fixer', model: 'model-x', created_at: t2 }),
      ],
      { turnId: 't1', status: 'streaming', contentStarted: true },
    )

    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    const first = container.querySelector('[data-message-id="a1"]') as HTMLElement
    const last = container.querySelector('[data-message-id="a2"]') as HTMLElement
    expect(block).not.toBeNull()
    expect(last).not.toBeNull()

    // Ровно одна шапка на блок — у первого сегмента, с точками вместо времени.
    expect((block.textContent?.match(/fixer/g) ?? []).length).toBe(1)
    expect(first.querySelector('[data-testid="processing-indicator"]')).not.toBeNull()
    expect(first.textContent).not.toContain(timeOf(t1))
    // Второй сегмент шапки не имеет.
    expect(last.textContent).not.toContain('model-x')
    expect(last.querySelector('[data-testid="processing-indicator"]')).toBeNull()
  })

  it('три сегмента: шапка ровно одна (у первого), точек в блоке — одна', async () => {
    const container = await renderList(
      [
        msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', step_index: 0, content: 'Shell #0', agent_role: 'fixer', model: 'model-x' }),
        msg({ id: 'a2', index: 2, ord: 11, turn_id: 't1', step_index: 1, content: 'Shell #0', agent_role: 'fixer', model: 'model-x' }),
        msg({ id: 'a3', index: 3, ord: 12, turn_id: 't1', step_index: 2, content: 'Финальный текст', agent_role: 'fixer', model: 'model-x' }),
      ],
      { turnId: 't1', status: 'streaming', contentStarted: true },
    )

    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect((block.textContent?.match(/fixer/g) ?? []).length).toBe(1)
    expect((block.textContent?.match(/model-x/g) ?? []).length).toBe(1)
    expect(block.querySelectorAll('[data-testid="processing-indicator"]')).toHaveLength(1)
  })

  it('два хода: время у завершённого блока, точки — у активного', async () => {
    const container = await renderList(
      [
        msg({ id: 'u1', index: 0, ord: 1, role: 'user', turn_id: 't1', content: 'первый' }),
        msg({ id: 'a1', index: 1, ord: 2, turn_id: 't1', step_index: 0, status: 'completed', content: 'Готово 1', agent_role: 'fixer', model: 'model-x' }),
        msg({ id: 'u2', index: 2, ord: 3, role: 'user', turn_id: 't2', content: 'второй' }),
        msg({ id: 'a2', index: 3, ord: 4, turn_id: 't2', step_index: 0, content: 'Готово 2', agent_role: 'fixer', model: 'model-x' }),
      ],
      { turnId: 't2', status: 'streaming', contentStarted: true },
    )

    const prev = container.querySelector('[data-message-id="a1"]') as HTMLElement
    const active = container.querySelector('[data-message-id="a2"]') as HTMLElement
    expect(prev).not.toBeNull()
    expect(active).not.toBeNull()
    expect(prev.querySelector('[data-testid="processing-indicator"]')).toBeNull()
    expect(prev.textContent).toContain(timeOf('2026-10-30T00:00:00Z'))
    expect(active.querySelector('[data-testid="processing-indicator"]')).not.toBeNull()
  })

  it('шаг completed, ход активен (идут инструменты): точки в шапке блока', async () => {
    const container = await renderList(
      [
        msg({ id: 'u1', index: 0, ord: 1, role: 'user', turn_id: 't1', content: 'запусти' }),
        msg({ id: 'a1', index: 1, ord: 2, turn_id: 't1', step_index: 0, status: 'completed', content: 'Запускаю', agent_role: 'fixer', model: 'model-x' }),
      ],
      { turnId: 't1', status: 'streaming', contentStarted: true, toolsRunning: true },
    )

    const segment = container.querySelector('[data-message-id="a1"]') as HTMLElement
    expect(segment.querySelector('[data-testid="processing-indicator"]')).not.toBeNull()
  })

  it('после завершения хода точки исчезают — у блока время', async () => {
    const container = await renderList(
      [
        msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', status: 'completed', content: 'Готово', agent_role: 'fixer', model: 'model-x' }),
      ],
      { turnId: 't1', status: 'completed' },
    )

    const segment = container.querySelector('[data-message-id="a1"]') as HTMLElement
    expect(segment.querySelector('[data-testid="processing-indicator"]')).toBeNull()
    expect(segment.textContent).toContain(timeOf('2026-10-30T00:00:00Z'))
  })

  it('пустой первый сегмент группы: только шапка с точками, без тела', async () => {
    const container = await renderList(
      [
        msg({ id: 'u1', index: 0, ord: 1, role: 'user', turn_id: 't1', content: 'запусти' }),
        msg({ id: 'a1', index: 1, ord: 2, turn_id: 't1', step_index: 0, status: 'streaming', content: '', parts: [], agent_role: 'fixer', model: 'model-x' }),
      ],
      { turnId: 't1', status: 'streaming', contentStarted: true },
    )

    const empty = container.querySelector('[data-message-id="a1"]') as HTMLElement
    expect(empty).not.toBeNull()
    expect(empty.querySelector('[data-testid="processing-indicator"]')).not.toBeNull()
    expect(empty.querySelector('.markdown-content')).toBeNull()
    expect(empty.querySelector('button[title="Response stats"]')).toBeNull()
    expect(empty.textContent).toContain('fixer')
    expect(empty.textContent).toContain('model-x')
  })

  it('пустой не-первый сегмент: не рендерится, точки — в шапке блока', async () => {
    const container = await renderList(
      [
        msg({ id: 'u1', index: 0, ord: 1, role: 'user', turn_id: 't1', content: 'запусти' }),
        msg({ id: 'a0', index: 1, ord: 2, turn_id: 't1', step_index: 0, status: 'completed', content: 'Первый шаг', agent_role: 'fixer', model: 'model-x' }),
        msg({ id: 'a1', index: 2, ord: 3, turn_id: 't1', step_index: 1, status: 'streaming', content: '', parts: [], agent_role: 'fixer', model: 'model-x' }),
      ],
      { turnId: 't1', status: 'streaming', contentStarted: true },
    )

    expect(container.querySelector('[data-message-id="a1"]')).toBeNull()
    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block.querySelectorAll('[data-testid="processing-indicator"]')).toHaveLength(1)
    expect((block.textContent?.match(/fixer/g) ?? []).length).toBe(1)
  })
})
