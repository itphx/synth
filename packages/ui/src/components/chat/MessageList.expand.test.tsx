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
import { MessageList } from './MessageList'
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
    created_at: '2026-09-19T00:00:00Z',
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

/** Кнопки разворота в порядке DOM. */
function expandButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll('[data-testid="message-expand"]'),
  ) as HTMLButtonElement[]
}

/** Классы пузыря сообщения (первый `div` внутри контейнера сообщения). */
function bubbleOf(container: HTMLElement, messageId: string): HTMLElement {
  const segment = container.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement
  expect(segment).not.toBeNull()
  return segment.querySelector(':scope > div') as HTMLElement
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
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

/** Два assistant-шага одного хода: пузырь рисует контейнер группы. */
function twoStepsSameTurn(): MessageData[] {
  return [
    msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', step_index: 0, content: 'Шаг первый', agent_role: 'fixer' }),
    msg({ id: 'a2', index: 2, ord: 11, turn_id: 't1', step_index: 1, content: 'Шаг второй', agent_role: 'fixer' }),
  ]
}

describe('MessageList: разворот ответа агента на всю ширину', () => {
  it('многошаговый ход: кнопка в шапке разворачивает блок хода и возвращает обратно', async () => {
    const container = await renderList(twoStepsSameTurn())

    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block).not.toBeNull()
    // По умолчанию — 85 % ширины области чата (регресс-охрана).
    expect(block.className).toContain('max-w-[85%]')
    expect(block.className).not.toContain('max-w-full')

    // Одна шапка на блок — одна кнопка разворота.
    const buttons = expandButtons(container)
    expect(buttons).toHaveLength(1)

    await click(buttons[0]!)

    const expandedBlock = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(expandedBlock).toBe(block)
    // Ровно один класс ширины: `max-w-full` без остатка `max-w-[85%]`.
    expect(expandedBlock.className).toContain('max-w-full')
    expect(expandedBlock.className).not.toContain('max-w-[85%]')

    // Повторный клик возвращает прежнюю ширину.
    await click(expandButtons(container)[0]!)
    const collapsedBlock = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(collapsedBlock.className).toContain('max-w-[85%]')
    expect(collapsedBlock.className).not.toContain('max-w-full')
  })

  it('многошаговый ход: кнопка помечает состояние (aria-pressed) и меняет подпись', async () => {
    const container = await renderList(twoStepsSameTurn())

    const button = expandButtons(container)[0]!
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('aria-label')).toBe('Expand to full width')

    await click(button)

    const expandedButton = expandButtons(container)[0]!
    expect(expandedButton.getAttribute('aria-pressed')).toBe('true')
    expect(expandedButton.getAttribute('aria-label')).toBe('Collapse')
  })

  it('одиночный ответ агента: меняется ширина пузыря самого сообщения', async () => {
    const container = await renderList([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', content: 'Один ответ', agent_role: 'fixer' }),
    ])

    // Блок хода не нужен — пузырь рисует само сообщение.
    expect(container.querySelectorAll('[data-testid="turn-block"]')).toHaveLength(0)
    expect(bubbleOf(container, 'a1').className).toContain('max-w-[85%]')

    const buttons = expandButtons(container)
    expect(buttons).toHaveLength(1)

    await click(buttons[0]!)
    const expandedBubble = bubbleOf(container, 'a1')
    expect(expandedBubble.className).toContain('max-w-full')
    expect(expandedBubble.className).not.toContain('max-w-[85%]')

    await click(expandButtons(container)[0]!)
    const collapsedBubble = bubbleOf(container, 'a1')
    expect(collapsedBubble.className).toContain('max-w-[85%]')
    expect(collapsedBubble.className).not.toContain('max-w-full')
  })

  it('user-сообщение: кнопки разворота нет, ширина не меняется', async () => {
    const container = await renderList([
      msg({ id: 'u1', index: 1, ord: 9, role: 'user', turn_id: 't1', content: 'Вопрос' }),
      msg({ id: 'a1', index: 2, ord: 10, turn_id: 't1', content: 'Ответ', agent_role: 'fixer' }),
    ])

    // Единственная кнопка — в шапке ответа агента.
    const buttons = expandButtons(container)
    expect(buttons).toHaveLength(1)
    const userSegment = container.querySelector('[data-message-id="u1"]') as HTMLElement
    expect(userSegment.contains(buttons[0]!)).toBe(false)

    await click(buttons[0]!)
    // Разворот ответа не трогает user-пузырь.
    expect(bubbleOf(container, 'u1').className).toContain('max-w-[85%]')
    expect(bubbleOf(container, 'a1').className).toContain('max-w-full')
  })

  it('состояние не течёт между ходами: развёрнут только первый', async () => {
    const container = await renderList([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', content: 'Ход 1', agent_role: 'fixer' }),
      msg({ id: 'b1', index: 2, ord: 11, turn_id: 't2', content: 'Ход 2', agent_role: 'fixer' }),
    ])

    const buttons = expandButtons(container)
    expect(buttons).toHaveLength(2)

    await click(buttons[0]!)
    expect(bubbleOf(container, 'a1').className).toContain('max-w-full')
    expect(bubbleOf(container, 'b1').className).toContain('max-w-[85%]')
    expect(bubbleOf(container, 'b1').className).not.toContain('max-w-full')
  })

  it('служебные блоки (Notice/фон/планировщик) кнопки разворота не получают', async () => {
    const container = await renderList([
      // Notice-варианты (сводка/отладка) — metaOnly-шапка без кнопки.
      msg({ id: 's1', index: 1, ord: 10, role: 'summary', content: 'Сводка' }),
      msg({ id: 'd1', index: 2, ord: 11, role: 'debug', content: 'Отладка' }),
      // Уведомление о завершении фонового прогона — системный блок.
      msg({
        id: 'b1',
        index: 3,
        ord: 12,
        role: 'user',
        content: 'Итог прогона',
        metadata: { type: 'background_run_result', kind: 'process', state: 'completed', command: 'echo hi' },
      }),
      // Сообщение шедулера — системный блок.
      msg({
        id: 'c1',
        index: 4,
        ord: 13,
        role: 'user',
        content: 'Задание по расписанию',
        metadata: { scheduler: true, schedule_name: 'nightly' },
      }),
    ])

    // Все четыре блока отрисовались…
    expect(container.textContent).toContain('Сводка')
    expect(container.textContent).toContain('Отладка')
    // Фоновый прогон — системный блок с подписью, тело уходит в карточку результата.
    expect(container.textContent).toContain('Background process · echo hi · completed')
    expect(container.textContent).toContain('Задание по расписанию')
    // …и ни у одного нет кнопки разворота.
    expect(expandButtons(container)).toHaveLength(0)
  })
})
