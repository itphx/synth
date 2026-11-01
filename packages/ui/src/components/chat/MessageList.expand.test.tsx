import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame
}

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
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

/** Развёрнутая панель ответа (заменяет ленту). */
function expandedPane(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="message-expanded"]') as HTMLElement | null
}

/** Скролл-контейнер ленты: пока панель открыта — его нет. */
function ribbon(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.chat-scroll-container') as HTMLElement | null
}

/** Классы пузыря сообщения (первый `div` внутри контейнера сообщения). */
function bubbleOf(root: HTMLElement, messageId: string): HTMLElement {
  const segment = root.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement
  expect(segment).not.toBeNull()
  return segment.querySelector(':scope > div') as HTMLElement
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
}

async function pressEscape(target: EventTarget): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  // Развёрнутая панель теперь персистится в сторе — сбрасываем между тестами.
  useUIStore.setState({ expandedChatGroup: null, revealedServiceGroups: [] })
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

/** Три assistant-шага одного хода: блок хода, ряд действий — у последнего сегмента. */
function threeStepsSameTurn(): MessageData[] {
  return [
    msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', step_index: 0, content: 'Шаг первый', agent_role: 'fixer' }),
    msg({ id: 'a2', index: 2, ord: 11, turn_id: 't1', step_index: 1, content: 'Шаг второй', agent_role: 'fixer' }),
    msg({ id: 'a3', index: 3, ord: 12, turn_id: 't1', step_index: 2, content: 'Шаг третий', agent_role: 'fixer' }),
  ]
}

/** Два разных хода — по одной assistant-реплике. */
function twoTurns(): MessageData[] {
  return [
    msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', content: 'Ход 1', agent_role: 'fixer' }),
    msg({ id: 'b1', index: 2, ord: 11, turn_id: 't2', content: 'Ход 2', agent_role: 'fixer' }),
  ]
}

describe('MessageList: разворот ответа агента', () => {
  it('клик по кнопке в шапке открывает панель: она заменяет ленту', async () => {
    const container = await renderList(twoStepsSameTurn())

    // По умолчанию — лента, панели нет, блок хода обычной ширины.
    expect(ribbon(container)).not.toBeNull()
    expect(expandedPane(container)).toBeNull()
    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block).not.toBeNull()
    expect(block.className).toContain('max-w-[85%]')

    // Одна шапка на блок — одна кнопка разворота.
    const buttons = expandButtons(container)
    expect(buttons).toHaveLength(1)
    await click(buttons[0]!)

    const pane = expandedPane(container)
    expect(pane).not.toBeNull()
    expect(pane!.textContent).toContain('Шаг первый')
    expect(pane!.textContent).toContain('Шаг второй')
    // Ленты больше нет: панель её заменяет, а не накрывает копией.
    expect(ribbon(container)).toBeNull()
    expect(container.querySelectorAll('.chat-scroll-container')).toHaveLength(0)
    // Внутри панели — развёрнутый блок хода (на всю ширину).
    const paneBlock = pane!.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(paneBlock).not.toBeNull()
    expect(paneBlock.className).toContain('max-w-full')
    expect(paneBlock.className).not.toContain('max-w-[85%]')
  })

  it('повторный клик по кнопке внутри панели закрывает её и возвращает ленту', async () => {
    const container = await renderList(twoStepsSameTurn())

    await click(expandButtons(container)[0]!)
    const pane = expandedPane(container)!
    // В панели ровно одна кнопка разворота — та же, что в шапке ответа.
    const paneButtons = Array.from(
      pane.querySelectorAll('[data-testid="message-expand"]'),
    ) as HTMLButtonElement[]
    expect(paneButtons).toHaveLength(1)

    await click(paneButtons[0]!)

    expect(expandedPane(container)).toBeNull()
    expect(ribbon(container)).not.toBeNull()
    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block).not.toBeNull()
    expect(block.className).toContain('max-w-[85%]')
    expect(block.className).not.toContain('max-w-full')
  })

  it('одиночный ответ агента: панель открывается, пузырь развёрнут', async () => {
    const container = await renderList([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', content: 'Один ответ', agent_role: 'fixer' }),
    ])

    expect(container.querySelectorAll('[data-testid="turn-block"]')).toHaveLength(0)
    expect(bubbleOf(container, 'a1').className).toContain('max-w-[85%]')

    await click(expandButtons(container)[0]!)

    const pane = expandedPane(container)
    expect(pane).not.toBeNull()
    expect(pane!.textContent).toContain('Один ответ')
    expect(bubbleOf(pane!, 'a1').className).toContain('max-w-full')

    await click(expandButtons(container)[0]!)
    expect(expandedPane(container)).toBeNull()
    expect(bubbleOf(container, 'a1').className).toContain('max-w-[85%]')
  })

  it('панель одиночного ответа: контейнер сообщения — прямой ребёнок `.chat-column`', async () => {
    const container = await renderList([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', content: 'Один ответ', agent_role: 'fixer' }),
    ])
    await click(expandButtons(container)[0]!)

    const pane = expandedPane(container)!
    const column = pane.querySelector('.chat-column') as HTMLElement
    const segment = pane.querySelector('[data-message-id="a1"]') as HTMLElement
    // Цепочка растяжения — `styles/index.css`: `.chat-column > *` → `[data-bubble]`.
    // Значит контейнер сообщения обязан быть **прямым** ребёнком колонки, а пузырь —
    // прямым ребёнком контейнера.
    expect(segment.parentElement).toBe(column)
    const bubble = segment.querySelector(':scope > [data-bubble]') as HTMLElement
    expect(bubble).not.toBeNull()
  })

  it('панель блока хода: последний сегмент — прямой ребёнок `turn-block` и владелец ряда действий', async () => {
    const container = await renderList(threeStepsSameTurn())
    await click(expandButtons(container)[0]!)

    const pane = expandedPane(container)!
    const block = pane.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block).not.toBeNull()
    const segments = Array.from(
      block.querySelectorAll(':scope > [data-message-id]'),
    ) as HTMLElement[]
    expect(segments.map((el) => el.getAttribute('data-message-id'))).toEqual(['a1', 'a2', 'a3'])
    // Цепочка растяжения блока хода — `turn-block > [data-message-id]:last-child`
    // (CSS `styles/index.css`): растягивается ровно последний сегмент — у него ряд
    // действий, и свободное место панели доходит до его пузыря.
    expect(block.lastElementChild).toBe(segments[2])
    for (const segment of segments) {
      expect(segment.querySelector(':scope > [data-bubble]')).not.toBeNull()
    }
    // Ряд действий один — у последнего сегмента; у первых его нет.
    const actions = pane.querySelectorAll('.message-actions')
    expect(actions).toHaveLength(1)
    expect(segments[2]!.contains(actions[0]!)).toBe(true)
    expect(segments[0]!.contains(actions[0]!)).toBe(false)
  })

  it('кнопка помечает состояние (aria-pressed) и меняет подпись', async () => {
    const container = await renderList(twoStepsSameTurn())

    const button = expandButtons(container)[0]!
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('aria-label')).toBe('Expand')

    await click(button)

    const expandedButton = expandButtons(container)[0]!
    expect(expandedButton.getAttribute('aria-pressed')).toBe('true')
    expect(expandedButton.getAttribute('aria-label')).toBe('Collapse')

    await click(expandedButton)
    expect(expandButtons(container)[0]!.getAttribute('aria-pressed')).toBe('false')
  })

  it('Esc закрывает панель', async () => {
    const container = await renderList(twoStepsSameTurn())

    await click(expandButtons(container)[0]!)
    expect(expandedPane(container)).not.toBeNull()

    await pressEscape(document)

    expect(expandedPane(container)).toBeNull()
    expect(ribbon(container)).not.toBeNull()
  })

  it('Esc не закрывает панель, когда фокус в поле ввода внутри неё', async () => {
    const container = await renderList(twoStepsSameTurn())

    await click(expandButtons(container)[0]!)
    const pane = expandedPane(container)!

    // Внутри ответа полей ввода нет — добавляем элемент искусственно: важно
    // ровно то, что `Esc` из `textarea` панель не перехватывает.
    const textarea = document.createElement('textarea')
    pane.appendChild(textarea)
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    await pressEscape(textarea)
    expect(expandedPane(container)).not.toBeNull()

    // Убираем поле — тот же `Esc` из документа панель закрывает (контроль).
    textarea.remove()
    await pressEscape(document)
    expect(expandedPane(container)).toBeNull()
  })

  it('user-сообщение: кнопки разворота нет, панель не открывается', async () => {
    const container = await renderList([
      msg({ id: 'u1', index: 1, ord: 9, role: 'user', turn_id: 't1', content: 'Вопрос' }),
      msg({ id: 'a1', index: 2, ord: 10, turn_id: 't1', content: 'Ответ', agent_role: 'fixer' }),
    ])

    // Единственная кнопка — в шапке ответа агента.
    const buttons = expandButtons(container)
    expect(buttons).toHaveLength(1)
    const userSegment = container.querySelector('[data-message-id="u1"]') as HTMLElement
    expect(userSegment.contains(buttons[0]!)).toBe(false)

    // Разворот ответа не открывает панель для user-реплики.
    await click(buttons[0]!)
    const pane = expandedPane(container)!
    expect(pane.querySelector('[data-message-id="u1"]')).toBeNull()
    expect(pane.textContent).toContain('Ответ')
  })

  it('панель показывает только выбранный ход (второй ход в DOM панели отсутствует)', async () => {
    const container = await renderList(twoTurns())

    const buttons = expandButtons(container)
    expect(buttons).toHaveLength(2)

    await click(buttons[0]!)

    const pane = expandedPane(container)!
    expect(pane.textContent).toContain('Ход 1')
    expect(pane.textContent).not.toContain('Ход 2')
    expect(pane.querySelector('[data-message-id="b1"]')).toBeNull()
    expect(pane.querySelector('[data-message-id="a1"]')).not.toBeNull()
    // Снаружи панели ленты тоже нет — второй ход не остаётся «второй копией».
    expect(container.querySelector('[data-message-id="b1"]')).toBeNull()
  })

  it('состояние не течёт: после закрытия первого открывается второй', async () => {
    const container = await renderList(twoTurns())

    await click(expandButtons(container)[0]!)
    expect(expandedPane(container)!.textContent).toContain('Ход 1')
    await click(expandButtons(container)[0]!)
    expect(expandedPane(container)).toBeNull()

    await click(expandButtons(container)[1]!)

    const pane = expandedPane(container)!
    expect(pane.textContent).toContain('Ход 2')
    expect(pane.textContent).not.toContain('Ход 1')
    expect(pane.querySelector('[data-message-id="a1"]')).toBeNull()
  })

  it('разворот другой группы заменяет текущую панель', async () => {
    const container = await renderList(twoTurns())

    await click(expandButtons(container)[0]!)
    // Внутри панели кнопок столько же, сколько ответов в панели (один).
    const paneButton = expandedPane(container)!.querySelector(
      '[data-testid="message-expand"]',
    ) as HTMLButtonElement
    await click(paneButton)
    expect(expandedPane(container)).toBeNull()

    await click(expandButtons(container)[1]!)
    expect(expandedPane(container)!.textContent).toContain('Ход 2')
    // Панель одна: второй панели в DOM нет.
    expect(container.querySelectorAll('[data-testid="message-expanded"]')).toHaveLength(1)
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

describe('MessageList: развёрнутая панель — ряд действий у нижнего края (CSS)', () => {
  // jsdom не считает flex-раскладку, поэтому прижатие кнопок проверяем по CSS:
  // пузырь в панели — `display:flex; flex-direction:column`, и `margin-top:auto`
  // у ряда действий отправляет его вниз (см. `styles/index.css`).
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../styles/index.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')

  /** Тела правил, в списке селекторов которых есть ровно `selector`. */
  function ruleBodies(selector: string): string[] {
    const bodies: string[] = []
    for (const chunk of css.split('}')) {
      const open = chunk.lastIndexOf('{')
      if (open < 0) continue
      const selectors = chunk.slice(0, open).split(',').map((s) => s.trim())
      if (selectors.includes(selector)) bodies.push(chunk.slice(open + 1))
    }
    return bodies
  }

  it('в блоке `.message-expanded-pane` есть `.message-actions { margin-top: auto }`', () => {
    const bodies = ruleBodies('.message-expanded-pane .message-actions')
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.join('\n')).toMatch(/margin-top:\s*auto/)
  })

  it('цепочка растяжения покрывает одиночное сообщение: `.chat-column > *` и `[data-bubble]`', () => {
    const columnChild = ruleBodies('.message-expanded-pane .chat-column > *').join('\n')
    expect(columnChild).toMatch(/flex:\s*1 0 auto/)

    const bubble = ruleBodies('.message-expanded-pane .chat-column [data-bubble]').join('\n')
    expect(bubble).toMatch(/display:\s*flex/)
    expect(bubble).toMatch(/flex-direction:\s*column/)
    expect(bubble).toMatch(/flex:\s*1 0 auto/)
    expect(bubble).toMatch(/align-self:\s*stretch/)
  })

  it('цепочка растяжения покрывает блок хода: последний сегмент `turn-block` растёт', () => {
    // У многошагового хода `[data-message-id]` — не прямой ребёнок `.chat-column`,
    // правило `> *` его не достаёт; растягивается последний сегмент блока.
    const bodies = ruleBodies(
      ".message-expanded-pane .chat-column [data-testid='turn-block'] > [data-message-id]:last-child",
    )
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.join('\n')).toMatch(/flex:\s*1 0 auto/)
  })
})


describe('MessageList: персист развёрнутой панели', () => {
  it('панель открыта сразу, если ключ уже в сторе (имитация перезагрузки)', async () => {
    // Ключ группы двух шагов одного хода (`groupMessagesByTurn`).
    useUIStore.setState({ expandedChatGroup: 'turn:t1:a1' })

    const container = await renderList(twoStepsSameTurn())

    const pane = expandedPane(container)
    expect(pane).not.toBeNull()
    expect(pane!.textContent).toContain('Шаг первый')
    expect(pane!.textContent).toContain('Шаг второй')
    // Ленты нет — панель её заменяет, как при обычном развороте.
    expect(ribbon(container)).toBeNull()
    expect(useUIStore.getState().expandedChatGroup).toBe('turn:t1:a1')
  })

  it('prune закрывает панель, когда ход исчез из ленты', async () => {
    // Сохранённый ключ несуществующей группы — эффект prune снимает разворот.
    useUIStore.setState({ expandedChatGroup: 'turn:gone:a1' })

    const container = await renderList(twoStepsSameTurn())

    expect(expandedPane(container)).toBeNull()
    expect(ribbon(container)).not.toBeNull()
    expect(useUIStore.getState().expandedChatGroup).toBeNull()
  })
})
