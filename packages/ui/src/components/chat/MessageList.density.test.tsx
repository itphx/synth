/**
 * Компактная плотность ленты (первая ось режимов отображения).
 *
 * У **прошлых** ходов скрыты размышления, промежуточные тексты и карточки
 * инструментов — вместо них одна тихая строка-сводка («N инструментов ·
 * M размышлений»), раскрываемая кликом. Текущий (живой) ход и ход с ошибкой
 * всегда раскрыты. Карточка саб-агента (`task`) — результат прогона — остаётся.
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
import { MessageList } from './MessageList'
import { useUIStore } from '@/stores/useUIStore'
import type { ActiveTurn, MessageData } from '@/stores/chatStore'
import type { Part } from '@itphx/synth-shared/types'

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
    created_at: '2026-11-01T00:00:00Z',
    ...partial,
  }
}

const reasoningPart = (id: string, text: string): Part => ({
  id,
  type: 'reasoning',
  data: { text },
})
const textPart = (id: string, text: string): Part => ({ id, type: 'text', data: { text } })
const toolPart = (id: string, name: string, args: Record<string, unknown> = {}): Part => ({
  id,
  type: 'tool_use',
  data: { name, args, status: 'done' },
})

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
  useUIStore.setState({ chatDensity: 'compact', expandedChatGroup: null, revealedServiceGroups: [] })
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

/**
 * Прошлый ход с «шумом»: размышление, промежуточный текст с блоком кода и
 * карточка инструмента + итоговый текст ответа.
 */
function pastTurnWithNoise(id = 'a1', ord = 10): MessageData {
  return msg({
    id,
    index: ord,
    ord,
    turn_id: 't1',
    step_index: 0,
    role: 'assistant',
    agent_role: 'fixer',
    content: 'Итоговый ответ',
    parts: [
      reasoningPart(`r-${id}`, 'Скрытое размышление'),
      textPart(`msg:text:0-${id}`, 'Итоговый ответ'),
      toolPart(`c-${id}`, 'read_file', { path: 'secret.txt' }),
    ],
    intermediate_text_blocks: [{ text: '```ts\nconst hidden = 1\n```', iteration: 0 }],
  })
}

const summaryOf = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector('[data-testid="service-summary"]') as HTMLButtonElement | null

describe('MessageList: компактная плотность ленты', () => {
  it('прошлый ход скрывает размышления и карточки инструментов, оставляя текст и сводку', async () => {
    const container = await renderList([pastTurnWithNoise()])

    // Карточек инструментов и размышлений нет, блок кода из промежуточного
    // текста тоже скрыт.
    expect(container.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Reasoning')
    expect(container.querySelectorAll('.md-code')).toHaveLength(0)

    // Текст ответа на месте.
    expect(container.textContent).toContain('Итоговый ответ')

    const summary = summaryOf(container)
    expect(summary).not.toBeNull()
    expect(summary!.getAttribute('aria-expanded')).toBe('false')
    expect(summary!.textContent).toContain('1 tool')
    expect(summary!.textContent).toContain('1 reasoning step')
  })

  it('клик по сводке раскрывает содержимое, повторный — снова скрывает', async () => {
    const container = await renderList([pastTurnWithNoise()])

    await act(async () => {
      summaryOf(container)!.click()
    })
    let summary = summaryOf(container)!
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(summary.textContent).toContain('Hide')
    expect(container.querySelectorAll('[data-tool-call-toggle]').length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Reasoning')
    expect(container.querySelectorAll('.md-code').length).toBeGreaterThan(0)

    await act(async () => {
      summary.click()
    })
    summary = summaryOf(container)!
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(0)
    expect(container.textContent).toContain('Итоговый ответ')
  })

  it('живой ход всегда раскрыт: сводки нет, карточки инструментов на месте', async () => {
    const turn: ActiveTurn = { turnId: 't1', status: 'streaming' }
    const container = await renderList([pastTurnWithNoise()], turn)

    expect(summaryOf(container)).toBeNull()
    expect(container.querySelectorAll('[data-tool-call-toggle]').length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Reasoning')
  })

  it('ход с fallback-ответом (session.output_limit) раскрыт: сводки нет, содержимое на месте', async () => {
    const container = await renderList([
      msg({
        ...pastTurnWithNoise(),
        status: 'error',
        metadata: { status: 'error', i18n: { key: 'session.output_limit' } },
      }),
    ])

    expect(summaryOf(container)).toBeNull()
    expect(container.querySelectorAll('[data-tool-call-toggle]').length).toBeGreaterThan(0)
  })

  it('терминальная ошибка основной сессии (router.*) в ленту не попадает — сводки и блока нет', async () => {
    const container = await renderList([
      msg({
        ...pastTurnWithNoise(),
        status: 'error',
        metadata: { status: 'error', i18n: { key: 'router.network_error' } },
      }),
    ])

    expect(summaryOf(container)).toBeNull()
    expect(container.querySelector('[data-message-id="a1"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="turn-block"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(0)
  })

  it('обычная плотность не меняет прежнее поведение', async () => {
    useUIStore.setState({ chatDensity: 'normal' })
    const container = await renderList([pastTurnWithNoise()])

    expect(summaryOf(container)).toBeNull()
    expect(container.querySelectorAll('[data-tool-call-toggle]').length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Reasoning')
    expect(container.textContent).toContain('Итоговый ответ')
  })

  it('счётчики суммируются по turn_id, даже если уведомление делит ход на две группы', async () => {
    const container = await renderList([
      msg({
        id: 'a1',
        index: 1,
        ord: 10,
        turn_id: 't1',
        step_index: 0,
        role: 'assistant',
        agent_role: 'fixer',
        content: 'Шаг первый',
        parts: [textPart('msg:text:0-a1', 'Шаг первый'), toolPart('c1', 'read_file')],
      }),
      msg({
        id: 'n1',
        index: 2,
        ord: 11,
        role: 'user',
        turn_id: null,
        content: 'Фоновый процесс завершён',
        metadata: { type: 'background_run_result', state: 'completed' },
      }),
      msg({
        id: 'a2',
        index: 3,
        ord: 12,
        turn_id: 't1',
        step_index: 1,
        role: 'assistant',
        agent_role: 'fixer',
        content: 'Шаг второй',
        parts: [
          textPart('msg:text:0-a2', 'Шаг второй'),
          toolPart('c2', 'write_file'),
          reasoningPart('r2', 'Размышление второго шага'),
        ],
      }),
    ])

    const summaries = container.querySelectorAll('[data-testid="service-summary"]')
    expect(summaries).toHaveLength(2)
    // Счётчики считаются по `turn_id`: у обеих групп — суммарные числа хода.
    for (const summary of Array.from(summaries) as HTMLButtonElement[]) {
      expect(summary.textContent).toContain('2 tools')
      expect(summary.textContent).toContain('1 reasoning step')
    }
    // Обе группы хода свёрнуты — карточек инструментов в сегментах хода нет
    // (карточка в системном блоке уведомления о фоне — не шаг хода).
    for (const id of ['a1', 'a2']) {
      const segment = container.querySelector(`[data-message-id="${id}"]`) as HTMLElement
      expect(segment.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(0)
    }

    // Раскрытие адресуется группе (`group.key`): первая группа раскрылась,
    // вторая осталась свёрнутой.
    const firstSummary = container
      .querySelector('[data-message-id="a1"] [data-testid="service-summary"]') as HTMLButtonElement
    await act(async () => {
      firstSummary.click()
    })
    const firstSegment = container.querySelector('[data-message-id="a1"]') as HTMLElement
    const secondSegment = container.querySelector('[data-message-id="a2"]') as HTMLElement
    expect(firstSegment.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(1)
    expect(secondSegment.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(0)
  })

  it('блок хода из нескольких шагов: одна сводка, содержимое скрыто у всех сегментов', async () => {
    const container = await renderList([
      msg({
        id: 'a1',
        index: 1,
        ord: 10,
        turn_id: 't1',
        step_index: 0,
        role: 'assistant',
        agent_role: 'fixer',
        content: 'Шаг первый',
        parts: [textPart('msg:text:0-a1', 'Шаг первый'), toolPart('c1', 'read_file')],
      }),
      msg({
        id: 'a2',
        index: 2,
        ord: 11,
        turn_id: 't1',
        step_index: 1,
        role: 'assistant',
        agent_role: 'fixer',
        content: 'Шаг второй',
        parts: [textPart('msg:text:0-a2', 'Шаг второй'), toolPart('c2', 'write_file')],
      }),
    ])

    expect(container.querySelectorAll('[data-testid="turn-block"]')).toHaveLength(1)
    // Сводка — одна на блок (у последнего сегмента).
    expect(container.querySelectorAll('[data-testid="service-summary"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(0)
    // Тексты шагов на месте.
    expect(container.textContent).toContain('Шаг первый')
    expect(container.textContent).toContain('Шаг второй')

    await act(async () => {
      summaryOf(container)!.click()
    })
    // Раскрытие снимает сворачивание со всех сегментов блока.
    expect(container.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(2)
  })

  it('свёрнутый прошлый ход не оставляет разделителей шагов, после раскрытия они возвращаются', async () => {
    const container = await renderList([
      msg({
        id: 'a1',
        index: 1,
        ord: 10,
        turn_id: 't1',
        step_index: 0,
        role: 'assistant',
        agent_role: 'fixer',
        content: 'Шаг первый',
        parts: [textPart('msg:text:0-a1', 'Шаг первый'), toolPart('c1', 'read_file')],
      }),
      msg({
        id: 'a2',
        index: 2,
        ord: 11,
        turn_id: 't1',
        step_index: 1,
        role: 'assistant',
        agent_role: 'fixer',
        content: 'Шаг второй',
        parts: [textPart('msg:text:0-a2', 'Шаг второй'), toolPart('c2', 'write_file')],
      }),
    ])

    // Группа — один блок хода, но содержимое шагов свёрнуто: пустых
    // разделителей между сегментами остаться не должно.
    expect(container.querySelectorAll('[data-testid="turn-block"]')).toHaveLength(1)
    expect(summaryOf(container)!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-step-divider]')).toHaveLength(0)

    await act(async () => {
      summaryOf(container)!.click()
    })
    // Раскрытие сводки возвращает разделители (и содержимое шагов).
    expect(summaryOf(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('[data-step-divider]').length).toBeGreaterThan(0)
  })

  it('живой ход в компакте не сворачивается — разделители шагов на месте', async () => {
    const turn: ActiveTurn = { turnId: 't1', status: 'streaming' }
    const container = await renderList(
      [
        msg({
          id: 'a1',
          index: 1,
          ord: 10,
          turn_id: 't1',
          step_index: 0,
          role: 'assistant',
          agent_role: 'fixer',
          content: 'Шаг первый',
          parts: [textPart('msg:text:0-a1', 'Шаг первый'), toolPart('c1', 'read_file')],
        }),
        msg({
          id: 'a2',
          index: 2,
          ord: 11,
          turn_id: 't1',
          step_index: 1,
          role: 'assistant',
          agent_role: 'fixer',
          content: 'Шаг второй',
          parts: [textPart('msg:text:0-a2', 'Шаг второй'), toolPart('c2', 'write_file')],
        }),
      ],
      turn,
    )

    expect(summaryOf(container)).toBeNull()
    expect(container.querySelectorAll('[data-step-divider]').length).toBeGreaterThan(0)
  })

  it('карточка саб-агента (task) остаётся видимой в компактном режиме', async () => {    const container = await renderList([
      msg({
        id: 'a1',
        index: 1,
        ord: 10,
        turn_id: 't1',
        role: 'assistant',
        agent_role: 'fixer',
        content: 'Ответ после саб-агента',
        parts: [
          textPart('msg:text:0', 'Ответ после саб-агента'),
          {
            id: 'sa1',
            type: 'tool_use',
            data: {
              name: 'task',
              args: { prompt: 'Проверь', description: 'Проверка' },
              status: 'done',
              result: {
                content: 'готово',
                metadata: { final_content: 'готово', description: 'Проверка' },
              },
            },
          },
          toolPart('c1', 'read_file'),
        ],
      }),
    ])

    // Карточка саб-агента осталась (результат прогона), обычная карточка — нет.
    expect(container.textContent).toContain('Subagent')
    expect(container.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(0)
    // Строка-сводка на месте: инструментов и размышлений в ходе хватает.
    expect(summaryOf(container)).not.toBeNull()
  })
})

describe('MessageList: персист раскрытой сводки', () => {
  it('сводка раскрыта, если её ключ уже в сторе (имитация перезагрузки)', async () => {
    // Ключ группы прошлого хода (`groupMessagesByTurn`): `turn:t1:a1`.
    useUIStore.setState({ revealedServiceGroups: ['turn:t1:a1'] })

    const container = await renderList([pastTurnWithNoise()])

    const summary = summaryOf(container)!
    expect(summary).not.toBeNull()
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    // Содержимое шагов раскрыто вместе со сводкой.
    expect(container.querySelectorAll('[data-tool-call-toggle]').length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Reasoning')
  })
})
