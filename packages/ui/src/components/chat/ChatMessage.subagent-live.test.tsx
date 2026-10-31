/**
 * Живой саб-агент в основной сессии (ADR-111/ADR-118).
 *
 * Репорт: у **фонового** саб-агента шаги видны в основной сессии, а у
 * **синхронного** — нет: пока блокирующий `task` выполняется, результата
 * (`result.metadata`) ещё нет, и карточка рисовалась обычным тулом без шагов.
 *
 * Прогресс синхронного саб-агента приходит в родительскую сессию
 * (`subagent.progress` → `subagentReasoningBlocks`/`subagentIntermediateTextBlocks`
 * в данных части, `tool_call.*` с `parent_call_id` → вызовы ребёнка). Карточка
 * должна строиться из этих данных.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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
import { useChatStore, type LivePart, type MessageData } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const MESSAGE = 'm1'

function liveToolPart(
  id: string,
  data: Record<string, unknown>,
): LivePart {
  return { id, type: 'tool_use', text: '', data }
}

function msg(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    id: MESSAGE,
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-31T00:00:00Z',
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

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useChatStore.setState({ partsBySession: {}, turnBySession: {} })
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

describe('ChatMessage: живой синхронный саб-агент показывает шаги', () => {
  it('без result.metadata карточка строится из живого прогресса и вызовов ребёнка', async () => {
    useChatStore.setState({
      partsBySession: {
        [SESSION]: {
          [MESSAGE]: {
            call_task: liveToolPart('call_task', {
              name: 'task',
              args: { prompt: 'PROMPT-LIVE', subagent_type: 'general' },
              status: 'running',
              startedAt: '2026-10-31T00:00:01Z',
              iteration: 0,
              subagentReasoningBlocks: [{ text: 'REASONING-LIVE', iteration: 0 }],
              subagentIntermediateTextBlocks: [{ text: 'TEXT-LIVE', iteration: 0 }],
            }),
            call_child: liveToolPart('call_child', {
              name: 'execute_shell',
              args: { command: 'sleep 20 && echo ok' },
              status: 'done',
              result: { content: 'ok' },
              startedAt: '2026-10-31T00:00:02Z',
              completedAt: '2026-10-31T00:00:22Z',
              iteration: 0,
              parentCallId: 'call_task',
            }),
          },
        },
      },
    })

    const container = await renderChat(msg({ status: 'streaming' }))

    // Это карточка саб-агента, а не обычный вызов инструмента.
    expect(container.textContent).toContain('Subagent: general')
    expect(container.textContent).not.toContain('Shell')

    // Раскрываем карточку.
    const header = container.querySelector('[aria-expanded]') as HTMLElement
    expect(header).not.toBeNull()
    await act(async () => {
      header.click()
    })

    const text = container.textContent || ''
    expect(text).toContain('PROMPT-LIVE')
    // Размышления саб-агента (заголовок сворачиваемого блока) и
    // промежуточный текст.
    expect(text).toContain('Reasoning')
    expect(text).toContain('TEXT-LIVE')
    // Шаг ребёнка (Shell) внутри карточки, не отдельной карточкой.
    expect(text).toContain('Shell')
    expect(text).toContain('20.0s')
    expect(container.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(1)
  })
})
