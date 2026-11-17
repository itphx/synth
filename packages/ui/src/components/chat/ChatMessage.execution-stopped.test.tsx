/**
 * PROP-143: durable-запись причины остановки хода (`execution_stopped`).
 *
 * Контракт ядра: `role:'user'`, `author:'System'`,
 * `metadata.type='execution_stopped'`, `metadata.reason` + `error_type` /
 * `retryable` / `attempts` / `model`; `content` — конверт
 * `<execution_stopped …>…</execution_stopped>`.
 *
 * В ленте это системный блок (`Notice variant="error"`), а не реплика
 * человека: подпись по причине, тело — сырой текст провайдера, конверт
 * скрыт; attempts/retryable — в тултипе.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'

function stopMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    id: 'm-stop',
    role: 'user',
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

beforeEach(() => {
  useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
})

afterEach(() => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    act(() => root.unmount())
    container.remove()
  }
})

describe('PROP-143: сообщение execution_stopped', () => {
  it('ошибка провайдера: подпись по причине, тело из конверта, тултип с попытками', async () => {
    const container = await renderChat(
      stopMessage({
        content:
          '<execution_stopped reason="provider_error" error_type="rate_limit" retryable="true" attempts="3">\n'
          + '429 Too Many Requests: rate limit exceeded\n'
          + '</execution_stopped>',
        author: 'System',
        metadata: {
          type: 'execution_stopped',
          reason: 'provider_error',
          error_type: 'rate_limit',
          retryable: true,
          attempts: 3,
          model: 'gpt-x',
        },
      }),
    )

    const text = container.textContent ?? ''
    expect(text).toContain('Остановлено: ошибка провайдера')
    expect(text).toContain('gpt-x')
    expect(text).toContain('429 Too Many Requests')
    // Конверт модели в чате не показывается.
    expect(text).not.toContain('<execution_stopped')

    const titled = container.querySelector('[title]') as HTMLElement | null
    const titles = Array.from(container.querySelectorAll('[title]'))
      .map((el) => el.getAttribute('title') ?? '')
      .join(' ')
    expect(titles).toContain('попыток: 3')
    expect(titles).toContain('да')
    expect(titled).not.toBeNull()
  })

  it('лимит шагов без тела: блок рендерится, тело пустое', async () => {
    const container = await renderChat(
      stopMessage({
        content:
          '<execution_stopped reason="steps_limit" limit="15">\n'
          + 'Execution stopped at the step limit (15)\n'
          + '</execution_stopped>',
        author: 'System',
        metadata: { type: 'execution_stopped', reason: 'steps_limit' },
      }),
    )

    const text = container.textContent ?? ''
    expect(text).toContain('Остановлено: лимит шагов')
    expect(text).toContain('Execution stopped at the step limit (15)')
    expect(text).not.toContain('<execution_stopped')
  })

  it('неизвестная причина деградирует на «внутренняя ошибка»', async () => {
    const container = await renderChat(
      stopMessage({
        content: '<execution_stopped reason="weird">\nboom\n</execution_stopped>',
        author: 'System',
        metadata: { type: 'execution_stopped', reason: 'weird' },
      }),
    )
    expect(container.textContent ?? '').toContain('Остановлено: внутренняя ошибка')
  })
})
