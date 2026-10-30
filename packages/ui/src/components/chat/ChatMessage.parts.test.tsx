/**
 * ADR-118 §1/§5: рендер сообщения по частям.
 *
 * Проверяем инварианты блока хода:
 * - текст сообщения рисуется **ровно один раз** (один `.markdown-content`);
 * - текст прошлого шага не повторяется в следующем сегменте (финальное
 *   сообщение хода несёт накопленные `intermediate_text_blocks`);
 * - live-части используются **только во время шага** (`status: 'streaming'`).
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
import { ChatMessage } from './ChatMessage'
import { MessageList } from './MessageList'
import { useChatStore } from '@/stores/chatStore'
import { resetChatStore } from '@/stores/testUtils'
import type { MessageData } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'

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

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(message: MessageData): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatMessage
          message={message}
          sessionId={SESSION}
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
          sessionId={SESSION}
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

/** Тексты всех markdown-блоков элемента. */
function markdowns(root: Element): string[] {
  return [...root.querySelectorAll('.markdown-content')].map((el) => (el.textContent ?? '').trim())
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  resetChatStore()
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

describe('ChatMessage: текст рисуется один раз (ADR-118 §5)', () => {
  it('финальное сообщение: один markdown-блок, даже если промежуточный текст совпадает', async () => {
    const container = await renderChat(msg({
      id: 'final-1',
      status: 'completed',
      content: 'Итог хода',
      parts: [{ id: 'msg:text:0', type: 'text', data: 'Итог хода' }],
      metadata: { intermediate_text_blocks: [{ text: 'Итог хода', iteration: 0 }] },
    }))

    expect(markdowns(container)).toEqual(['Итог хода'])
  })

  it('блок хода: текст первого шага не появляется в следующем сегменте', async () => {
    const container = await renderList([
      msg({
        id: 'step-0',
        index: 0,
        ord: 10,
        turn_id: 't1',
        step_index: 0,
        status: 'completed',
        content: 'Запускаю команду.',
        parts: [{ id: 'msg:text:0', type: 'text', data: 'Запускаю команду.' }],
        // Сырой вызов провайдера — карточкой не рисуется (имени в форме UI нет).
        tool_calls: [{
          id: 'call_00_1',
          type: 'function',
          index: 0,
          function: { name: 'execute_shell', arguments: '{"command":"sleep 30"}' },
        }],
      }),
      msg({
        id: 'step-1',
        index: 1,
        ord: 11,
        turn_id: 't1',
        step_index: 1,
        status: 'completed',
        content: 'Команда выполнена.',
        parts: [{ id: 'msg:text:0', type: 'text', data: 'Команда выполнена.' }],
        // Финальное сообщение хода несёт накопленные по ходу вызовы и
        // промежуточные тексты прошлых шагов.
        tool_calls: [{
          id: 'call_00_1',
          name: 'execute_shell',
          args: { command: 'sleep 30' },
          result: { content: '(empty output)' },
          iteration: 0,
        }],
        metadata: { intermediate_text_blocks: [{ text: 'Запускаю команду.', iteration: 0 }] },
      }),
    ])

    const block = container.querySelector('[data-testid="turn-block"]') as HTMLElement
    expect(block).not.toBeNull()

    // Во втором сегменте — только его собственный текст.
    const second = block.querySelector('[data-message-id="step-1"]') as HTMLElement
    expect(markdowns(second)).toEqual(['Команда выполнена.'])

    // Текст первого шага в блоке хода — один раз.
    const text = (block.textContent ?? '').match(/Запускаю команду\./g) ?? []
    expect(text).toHaveLength(1)

    // Карточка вызова инструмента — одна (в финальном сообщении, с результатом).
    expect(block.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(1)
  })
})

describe('ChatMessage: live-части — только во время шага (ADR-118 §5)', () => {
  it('живое сообщение рисует live-части', async () => {
    useChatStore.getState().upsertPart(SESSION, 'live-1', 'msg:text:0', {
      id: 'msg:text:0',
      type: 'text',
      text: 'Живой текст шага',
    })

    const container = await renderChat(msg({ id: 'live-1', status: 'streaming' }))

    expect(markdowns(container)).toEqual(['Живой текст шага'])
  })

  it('финальное сообщение не использует live-части — источник истины — DTO', async () => {
    useChatStore.getState().upsertPart(SESSION, 'done-1', 'msg:text:0', {
      id: 'msg:text:0',
      type: 'text',
      text: 'Живой текст шага',
    })

    const container = await renderChat(msg({
      id: 'done-1',
      status: 'completed',
      content: 'Текст из истории',
      parts: [{ id: 'msg:text:0', type: 'text', data: 'Текст из истории' }],
    }))

    expect(markdowns(container)).toEqual(['Текст из истории'])
  })
})
