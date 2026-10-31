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

    // Между шагами — разделитель, а не отдельная карточка.
    expect(block.querySelectorAll('.border-t').length).toBeGreaterThanOrEqual(1)
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
