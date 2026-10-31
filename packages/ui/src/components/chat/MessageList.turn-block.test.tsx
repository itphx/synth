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

interface RenderOpts {
  onPinTurn?: (segments: MessageData[]) => void
  onPin?: (msg: MessageData) => void
}

async function renderList(messages: MessageData[], opts: RenderOpts = {}): Promise<HTMLElement> {
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
          onPin={opts.onPin ?? noopMsg}
          onPinTurn={opts.onPinTurn}
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

/** Два assistant-шага одного хода: каждый сам по себе — «сообщение». */
function twoStepsSameTurn(): MessageData[] {
  return [
    msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', step_index: 0, content: 'Шаг первый', agent_role: 'fixer' }),
    msg({ id: 'a2', index: 2, ord: 11, turn_id: 't1', step_index: 1, content: 'Шаг второй', agent_role: 'fixer' }),
  ]
}

/** Три assistant-шага одного хода — две границы внутри блока. */
function threeStepsSameTurn(): MessageData[] {
  return [
    msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', step_index: 0, content: 'Шаг первый', agent_role: 'fixer' }),
    msg({ id: 'a2', index: 2, ord: 11, turn_id: 't1', step_index: 1, content: 'Шаг второй', agent_role: 'fixer' }),
    msg({ id: 'a3', index: 3, ord: 12, turn_id: 't1', step_index: 2, content: 'Шаг третий', agent_role: 'fixer' }),
  ]
}

describe('MessageList: ход как один блок (ADR-118 §1)', () => {
  it('группа из двух шагов — один контейнер-пузырь, сегменты без своих пузырей', async () => {
    const container = await renderList(twoStepsSameTurn())

    const blocks = container.querySelectorAll('[data-testid="turn-block"]')
    expect(blocks).toHaveLength(1)
    const block = blocks[0] as HTMLElement
    // «Пузырные» классы — на контейнере группы.
    expect(block.className).toContain('bg-card')
    expect(block.className).toContain('rounded-lg')
    expect(block.className).toContain('border-border/50')
    expect(block.className).toContain('max-w-[85%]')

    const segments = block.querySelectorAll('[data-message-id]')
    expect(Array.from(segments).map((el) => el.getAttribute('data-message-id'))).toEqual(['a1', 'a2'])
    // Своих «пузырей» у сегментов нет: внутри блока нет элементов с фоном/рамкой.
    expect(block.querySelectorAll('.bg-card')).toHaveLength(0)
    for (const segment of Array.from(segments)) {
      const bubble = segment.querySelector(':scope > div') as HTMLElement
      expect(bubble.className).not.toContain('rounded-lg')
      expect(bubble.className).not.toContain('px-4')
    }

    // Между шагами — разделитель, а не отдельная карточка. Маркер
    // `data-step-divider` — шов для CSS-правила (`styles/index.css`): отступ
    // между шагами даёт только разделитель, нижний отступ последнего блока
    // предыдущего сегмента снят (иначе зазор 16px против 8px внутри шага).
    expect(block.querySelectorAll('[data-step-divider]').length).toBeGreaterThanOrEqual(1)
    expect(block.querySelectorAll('.border-t').length).toBeGreaterThanOrEqual(1)
  })

  it('внешний отступ блока хода — прозрачный контейнер py-3 (ритм ленты 24px)', async () => {
    const container = await renderList(twoStepsSameTurn())
    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block).not.toBeNull()

    // Карточка хода лежит в прозрачном контейнере с вертикальным отступом
    // 12px сверху и снизу (итого 24px между разными сообщениями).
    const wrapper = block.parentElement as HTMLElement
    expect(wrapper).not.toBeNull()
    expect(wrapper.className.split(' ')).toContain('py-3')
    // Отступ — **padding** измеряемого элемента (виртуализация), не margin:
    // margin мог бы не попасть в измеренную высоту и расшатал бы скролл.
    expect(wrapper.className).not.toMatch(/(^|\s)m[bt]-/)
    // Внутренний `py-3` карточки (padding внутри пузыря) — на месте.
    expect(block.className.split(' ')).toContain('py-3')
  })

  it('разделитель — отдельный сиблиг сегмента, а не его обёртка', async () => {
    const container = await renderList(threeStepsSameTurn())
    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block).not.toBeNull()

    // Разделителей ровно «сегменты − 1».
    const dividers = Array.from(block.querySelectorAll(':scope > [data-step-divider]'))
    expect(dividers).toHaveLength(2)

    // Разделитель — пустой элемент: сегмент не вложен в него.
    for (const divider of dividers) {
      expect(divider.children).toHaveLength(0)
      expect(divider.textContent?.trim() ?? '').toBe('')
    }

    // Каждый не последний сегмент стоит непосредственно перед разделителем —
    // на этом матчится структурное CSS-правило (`styles/index.css`):
    // «прямой потомок блока хода, который не разделитель и не последний».
    const children = Array.from(block.children)
    const expectedSegments = ['a1', 'a2', 'a3']
    dividers.forEach((divider, i) => {
      const idx = children.indexOf(divider)
      expect(idx).toBeGreaterThan(0)
      const before = children[idx - 1] as HTMLElement
      expect(before.getAttribute('data-message-id')).toBe(expectedSegments[i])
    })
    // Последний сегмент — последний потомок блока (его нижний отступ
    // правило не трогает).
    const last = children[children.length - 1] as HTMLElement
    expect(last.getAttribute('data-message-id')).toBe('a3')

    // Селектор правила матчится на каждом не последнем сегменте.
    const segmentSelector =
      "[data-testid='turn-block'] > div:not([data-step-divider]):not(:last-child)"
    const ruleSelector = `${segmentSelector} > div:last-child > *:last-child`
    for (const id of ['a1', 'a2']) {
      const segment = block.querySelector(`[data-message-id="${id}"]`) as HTMLElement
      expect(segment.matches(segmentSelector)).toBe(true)
      // …и сам блок, чей нижний отступ правило снимает, — тоже.
      const bubble = segment.querySelector(':scope > div:last-child') as HTMLElement
      const lastElement = bubble.lastElementChild as HTMLElement
      expect(lastElement).not.toBeNull()
      expect(lastElement.matches(ruleSelector)).toBe(true)
    }
    // …а на последнем сегменте правило не матчится.
    const lastSegment = block.querySelector('[data-message-id="a3"]') as HTMLElement
    expect(lastSegment.matches(segmentSelector)).toBe(false)
  })

  it('заголовок агента — один на блок (у первого сегмента)', async () => {
    const container = await renderList(twoStepsSameTurn())
    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement

    // Бейдж агента в шапке MessageHeader рисуется по `agent_role`.
    const occurrences = (block.textContent?.match(/fixer/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('действия — один раз, у последнего сегмента; pin пинит весь ход', async () => {
    const pinned: MessageData[][] = []
    const container = await renderList(twoStepsSameTurn(), { onPinTurn: (segments) => pinned.push(segments) })

    const actions = container.querySelectorAll('.message-actions')
    expect(actions).toHaveLength(1)

    const lastSegment = container.querySelector('[data-message-id="a2"]') as HTMLElement
    expect(lastSegment.contains(actions[0]!)).toBe(true)
    // У первого сегмента ряда действий нет.
    const firstSegment = container.querySelector('[data-message-id="a1"]') as HTMLElement
    expect(firstSegment.querySelector('.message-actions')).toBeNull()

    const pinButton = (actions[0] as HTMLElement).querySelector('button[title="Pin"]') as HTMLButtonElement
    expect(pinButton).not.toBeNull()
    await act(async () => {
      pinButton.click()
    })
    expect(pinned).toHaveLength(1)
    expect(pinned[0]!.map((m) => m.id)).toEqual(['a1', 'a2'])
  })

  it('группа из одного сегмента рисует пузырь как раньше', async () => {
    const container = await renderList([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', content: 'Ответ', agent_role: 'fixer' }),
    ])

    expect(container.querySelectorAll('[data-testid="turn-block"]')).toHaveLength(0)
    const segments = container.querySelectorAll('[data-message-id]')
    expect(segments).toHaveLength(1)
    expect(container.querySelectorAll('.bg-card')).toHaveLength(1)
    expect(container.querySelectorAll('.message-actions')).toHaveLength(1)
  })

  it('user-реплика не попадает в блок хода', async () => {
    const container = await renderList([
      msg({ id: 'u1', index: 1, ord: 9, role: 'user', turn_id: 't1', content: 'Вопрос' }),
      ...twoStepsSameTurn(),
    ])

    // Сегменты хода после user-реплики — свой блок, user — вне его.
    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block).not.toBeNull()
    expect(block.querySelector('[data-message-id="u1"]')).toBeNull()
    const userSegment = container.querySelector('[data-message-id="u1"]') as HTMLElement
    expect(userSegment.querySelector(':scope > div')?.className).toContain('bg-primary/10')
    expect(container.querySelectorAll('.bg-card')).toHaveLength(1) // только блок хода
  })

  it('два разных turn_id — два блока, каждый со своими действиями', async () => {
    const container = await renderList([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', content: 'Ход 1' }),
      msg({ id: 'a2', index: 2, ord: 11, turn_id: 't2', content: 'Ход 2' }),
    ])

    expect(container.querySelectorAll('[data-testid="turn-block"]')).toHaveLength(0)
    const segments = container.querySelectorAll('[data-message-id]')
    expect(segments).toHaveLength(2)
    expect(container.querySelectorAll('.bg-card')).toHaveLength(2)
    expect(container.querySelectorAll('.message-actions')).toHaveLength(2)
  })

  it('служебное сообщение в группе не склеивается в блок-пузырь', async () => {
    const container = await renderList([
      msg({ id: 'a1', index: 1, ord: 10, turn_id: 't1', content: 'Шаг' }),
      msg({ id: 'e1', index: 2, ord: 11, turn_id: 't1', role: 'error', content: 'Ошибка' }),
    ])

    expect(container.querySelectorAll('[data-testid="turn-block"]')).toHaveLength(0)
  })
})
