/**
 * Вид ленты чата (вторая ось режимов отображения, ортогональна плотности).
 *
 * `feed` — ответ агента рисуется плоской прозой: пузыря (фон/рамка/радиус/
 * внутренние отступы) у него нет, служебные карточки (размышления, вызовы
 * инструментов, саб-агенты) становятся плоскими строками. Пузырь пользователя
 * остаётся. Вид задаётся **CSS** по атрибутам `data-view-mode` (колонка чата),
 * `data-role`/`data-bubble` (сообщение) и `data-card="service"` (карточка),
 * поэтому классы компонентов не меняются — проверяем сами маркеры.
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

/** Сообщение агента, в котором есть и размышление, и карточка инструмента. */
function assistantWithNoise(id = 'a1', ord = 10): MessageData {
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
      reasoningPart(`r-${id}`, 'Размышление'),
      textPart(`msg:text:0-${id}`, 'Итоговый ответ'),
      toolPart(`c-${id}`, 'read_file', { path: 'secret.txt' }),
    ],
  })
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({
    chatViewMode: 'detailed',
    chatDensity: 'normal',
    expandedChatGroup: null,
    revealedServiceGroups: [],
  })
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
  useUIStore.setState({
    chatViewMode: 'detailed',
    chatDensity: 'normal',
    expandedChatGroup: null,
    revealedServiceGroups: [],
  })
})

const chatColumn = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('.chat-column')

describe('MessageList: вид ленты «feed»', () => {
  it('колонка чата помечена data-view-mode="feed"', async () => {
    useUIStore.setState({ chatViewMode: 'feed' })
    const container = await renderList([assistantWithNoise()])

    expect(chatColumn(container)?.getAttribute('data-view-mode')).toBe('feed')
    // Плотность — соседняя ось, атрибут присутствует всегда.
    expect(chatColumn(container)?.getAttribute('data-density')).toBe('normal')
  })

  it('ответ агента: контейнер с data-role="assistant" и внутренний пузырь', async () => {
    useUIStore.setState({ chatViewMode: 'feed' })
    const container = await renderList([assistantWithNoise()])

    const assistant = container.querySelector('[data-role="assistant"]') as HTMLElement | null
    expect(assistant).not.toBeNull()
    const bubble = assistant!.querySelector('[data-bubble]') as HTMLElement | null
    expect(bubble).not.toBeNull()

    // Классы пузыря не менялись — «лента» задаётся только CSS по атрибутам.
    expect(bubble!.className).toContain('bg-card')
    expect(bubble!.className).toContain('rounded-lg')
  })

  it('пузырь пользователя не участвует в правилах ленты', async () => {
    useUIStore.setState({ chatViewMode: 'feed' })
    const container = await renderList([
      msg({ id: 'u1', index: 1, ord: 1, role: 'user', content: 'Привет' }),
      assistantWithNoise(),
    ])

    const user = container.querySelector('[data-role="user"]') as HTMLElement | null
    expect(user).not.toBeNull()
    const bubble = user!.querySelector('[data-bubble]') as HTMLElement | null
    expect(bubble).not.toBeNull()
    // CSS-правило ленты требует предка `[data-role='assistant']` — у реплики его нет.
    expect(bubble!.closest("[data-role='assistant']")).toBeNull()
    expect(bubble!.className).toContain('bg-primary/10')
  })

  it('подробный вид: колонка помечена data-view-mode="detailed"', async () => {
    const container = await renderList([assistantWithNoise()])
    expect(chatColumn(container)?.getAttribute('data-view-mode')).toBe('detailed')
  })

  it('служебные карточки несут data-card="service"', async () => {
    const container = await renderList([assistantWithNoise()])

    // Размышление и карточка инструмента — обе помечены.
    expect(container.querySelectorAll("[data-card='service']").length).toBeGreaterThanOrEqual(2)
    const toolToggle = container.querySelector('[data-tool-call-toggle]') as HTMLElement | null
    expect(toolToggle).not.toBeNull()
    expect(toolToggle!.closest("[data-card='service']")).not.toBeNull()
    const reasoningToggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reasoning'),
    )
    expect(reasoningToggle).toBeTruthy()
    expect(reasoningToggle!.closest("[data-card='service']")).not.toBeNull()
  })

  it('feed + compact: сводка прошлого хода на месте, скрытые карточки — нет', async () => {
    useUIStore.setState({ chatViewMode: 'feed', chatDensity: 'compact' })
    const container = await renderList([assistantWithNoise()])

    expect(chatColumn(container)?.getAttribute('data-view-mode')).toBe('feed')
    expect(chatColumn(container)?.getAttribute('data-density')).toBe('compact')
    expect(container.querySelector('[data-testid="service-summary"]')).not.toBeNull()
    // Карточки инструментов и размышлений скрыты сводкой.
    expect(container.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(0)
    expect(container.querySelectorAll("[data-card='service']")).toHaveLength(0)
    expect(container.textContent).toContain('Итоговый ответ')
  })

  it('feed + compact: раскрытая сводка показывает карточки в плоском оформлении', async () => {
    useUIStore.setState({ chatViewMode: 'feed', chatDensity: 'compact' })
    const container = await renderList([assistantWithNoise()])

    await act(async () => {
      ;(container.querySelector('[data-testid="service-summary"]') as HTMLButtonElement).click()
    })

    expect(container.querySelectorAll('[data-tool-call-toggle]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll("[data-card='service']").length).toBeGreaterThan(0)
  })
})
