/**
 * Починка разорванной цепочки вызовов инструментов (`metadata.repaired`).
 *
 * Ядро ставит `metadata.repaired === 'orphan_tool_calls'` и `disabled: true`
 * на assistant-шаг, у которого вызовы инструментов остались без результатов:
 * шаг **исключён из контекста**, но пользователь видел его целиком — это не
 * «Прервано» и не ошибка. UI показывает нейтральную подпись «Шаг не отправлен
 * модели» с подсказкой-причиной.
 *
 * Проверяем:
 *   • `repaired` + `disabled` → подпись есть, «Прервано» — нет;
 *   • реальное прерывание (`interrupted`) → «Прервано» остаётся, подписи нет;
 *   • оба маркера → приоритет у реального прерывания («Прервано»);
 *   • `disabled` без маркеров → подписи нет (и текста «Шаг не отправлен модели»).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPAIRED = 'Шаг не отправлен модели'
const INTERRUPTED = 'Прервано'

/** Минимальный MessageData-каркас. */
function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-17T00:00:00Z',
    ...partial,
  }
}

function ChatMessageEl(message: MessageData): React.ReactElement {
  return (
    <I18nProvider>
      <ChatMessage
        message={message}
        onCopy={() => {}}
        onToggle={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onRetry={() => {}}
        onDebug={() => {}}
        onFork={() => {}}
      />
    </I18nProvider>
  )
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(message: MessageData): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(ChatMessageEl(message))
  })
  return container
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

describe('ChatMessage: шаг, исключённый починкой цепочки инструментов', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('repaired + disabled → нейтральная подпись, «Прервано» нет', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'шаг с вызовами инструментов',
        disabled: true,
        metadata: { status: 'completed', repaired: 'orphan_tool_calls' },
      }),
    )

    expect(container.textContent).toContain('шаг с вызовами инструментов')
    expect(container.textContent).toContain(REPAIRED)
    expect(container.textContent).not.toContain(INTERRUPTED)
    // Подсказка-причина (title) есть — текст подписи смысл не заменяет.
    const badge = container.querySelector('[data-testid="message-repaired-badge"]')
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('title')).toContain('остались без результатов')
  })

  it('подпись не попадает под disabled-стилизацию пузыря (не зачёркнута/не приглушена)', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'шаг с вызовами инструментов',
        disabled: true,
        metadata: { repaired: 'orphan_tool_calls' },
      }),
    )

    const badge = container.querySelector('[data-testid="message-repaired-badge"]')
    expect(badge).not.toBeNull()
    // `opacity-50 line-through` у пузыря погасили бы контраст подписи ниже нормы.
    expect(badge?.closest('[data-bubble]')).toBeNull()
    // Сам текст шага при этом остаётся «выключенным» (исключён из контекста).
    expect(container.querySelector('[data-bubble]')?.className).toContain('line-through')
  })

  it('реальное прерывание → «Прервано» остаётся, подписи о починке нет', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'частичный ответ',
        disabled: true,
        metadata: { status: 'interrupted', interrupted: true },
      }),
    )

    expect(container.textContent).toContain(INTERRUPTED)
    expect(container.textContent).not.toContain(REPAIRED)
    expect(container.querySelector('[data-testid="message-repaired-badge"]')).toBeNull()
  })

  it('оба маркера → приоритет у реального прерывания', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'частичный ответ',
        disabled: true,
        metadata: { status: 'interrupted', repaired: 'orphan_tool_calls' },
      }),
    )

    expect(container.textContent).toContain(INTERRUPTED)
    expect(container.textContent).not.toContain(REPAIRED)
  })

  it('disabled без маркеров → подписи нет', async () => {
    const container = await renderChat(
      makeMessage({ content: 'выключенный ответ', disabled: true }),
    )

    expect(container.textContent).toContain('выключенный ответ')
    expect(container.textContent).not.toContain(REPAIRED)
    expect(container.textContent).not.toContain(INTERRUPTED)
  })

  it('repaired без disabled → подписи нет (шаг в контексте)', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'обычный шаг',
        metadata: { repaired: 'orphan_tool_calls' },
      }),
    )

    expect(container.textContent).not.toContain(REPAIRED)
  })
})
