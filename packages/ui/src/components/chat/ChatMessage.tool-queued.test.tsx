/**
 * Карта состояний шага: третий статус вызова (`queued`) не теряется при сборке
 * `liveToolCalls`/`getSubagentData` в `ChatMessage` (ADR-118, addendum
 * MESSAGE_FLOW §8.2).
 *
 * Вызов, который ещё не стартовал (стоит за барьером, ждёт подтверждения или
 * медленного соседа по батчу), обязан остаться в ходе — со своей карточкой,
 * нейтральной подписью «ожидает запуска» и без индикатора работы. `task`-вызов
 * в этом состоянии — карточка саб-агента без кнопки «В фон» (прогон не начат).
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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ChatMessage } from './ChatMessage'
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
    created_at: '2026-11-18T00:00:00Z',
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

/** Шаг хода: обычный вызов и `task`-вызов, оба ещё не стартовали. */
function queuedStep(): MessageData {
  return msg({
    id: 'm-step',
    turn_id: 't1',
    step_index: 0,
    status: 'streaming',
    parts: [
      { id: 'msg:text:0', type: 'text', data: 'Запускаю.' },
      {
        id: 'call-read',
        type: 'tool_use',
        data: { name: 'read_file', args: { path: 'a.ts' }, status: 'queued', iteration: 0 },
      },
      {
        id: 'call-task',
        type: 'tool_use',
        data: {
          name: 'task',
          args: { prompt: 'прочитай файл', subagent_type: 'explore' },
          status: 'queued',
          iteration: 0,
        },
      },
    ],
  })
}

beforeEach(() => {
  resetChatStore()
  useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => root.unmount())
    container.remove()
  }
})

describe('ChatMessage: `queued`-вызовы шага не теряются', () => {
  it('карточки обоих вызовов в ленте, обычный — с подписью «ожидает запуска»', async () => {
    const container = await renderChat(queuedStep())

    const statuses = Array.from(container.querySelectorAll('[data-tool-status]'))
      .map((el) => el.getAttribute('data-tool-status'))
    // Обычный вызов не потерян и остался `queued`; `task` — карточка саб-агента.
    expect(statuses).toContain('queued')
    expect(container.querySelector('[data-testid="tool-call-queued"]')?.textContent)
      .toBe('ожидает запуска')
    expect(container.textContent ?? '').toContain('Сабагент')
    // Ни одной пульсации: ни один вызов ещё не стартовал.
    expect(container.querySelector('.animate-tool-pulse')).toBeNull()
    // Кнопки «В фон» нет — прогон не начат.
    expect(container.querySelector('[data-testid="tool-call-background"]')).toBeNull()
  })

  it('свёрнутый (компакт) шаг со скрытыми вызовами не меняет поведение', async () => {
    const container = await renderChat(queuedStep())

    // Строка-сводка появляется только при `onToggleService`/`serviceKey` —
    // здесь её нет, значит вызовы показаны как раньше (без потерь).
    expect(container.querySelector('[data-testid="service-summary"]')).toBeNull()
    expect(container.querySelectorAll('[data-tool-status]').length).toBeGreaterThan(0)
  })
})
