/**
 * PROP-143: durable-запись причины остановки хода (`execution_stopped`).
 *
 * Контракт ядра: `role:'user'`, `author:'System'`,
 * `metadata.type='execution_stopped'`, `metadata.reason` + `error_type` /
 * `retryable` / `attempts` / `model` / `report_delivered`; `content` — конверт
 * `<execution_stopped …>…</execution_stopped>`.
 *
 * В ленте это системный блок (`Notice`), а не реплика человека: подпись и тон —
 * по таблице причин (`lib/stopReason.ts`), тело конверта — только у
 * `provider_error` (там настоящий текст провайдера); у остальных причин это
 * машинный EN-текст движка и он не показывается. Модель хода в подписи не
 * дублируется — она в **правой части** блока (`Notice` → `meta`) рядом с
 * временем (бейдж модели в `MessageHeader` для `role:'user'` не рисуется).
 * attempts/retryable — в тултипе.
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

/** Классы блока `Notice` (тон причины). */
function boxClass(container: HTMLElement): string {
  return container.querySelector('[role="group"]')?.className ?? ''
}

/**
 * Модель хода в правой части блока (`Notice` → `meta`), `null` — не выведена.
 *
 * Проверяем именно правую часть шапки: элемент должен лежать в `role="group"`
 * вне подписи (модель больше не дублируется в тексте остановки).
 */
function metaModel(container: HTMLElement): string | null {
  const el = container.querySelector('[role="group"] [data-testid="execution-stopped-model"]')
  return el?.textContent ?? null
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
  it('ошибка провайдера: красный тон, тело провайдера показано, тултип с попытками', async () => {
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
    // Тело — настоящий текст провайдера: он нужен.
    expect(text).toContain('429 Too Many Requests')
    // Конверт модели в чате не показывается.
    expect(text).not.toContain('<execution_stopped')
    // Модель хода видна в правой части блока, но в подписи не дублируется.
    expect(metaModel(container)).toBe('gpt-x')
    const label = container.querySelector('[role="group"] span[title]')?.textContent ?? ''
    expect(label).not.toContain('gpt-x')
    // Сбой — красный блок.
    expect(boxClass(container)).toContain('bg-destructive/10')

    const titles = Array.from(container.querySelectorAll('[title]'))
      .map((el) => el.getAttribute('title') ?? '')
      .join(' ')
    expect(titles).toContain('попыток: 3')
    expect(titles).toContain('да')
  })

  it('лимит шагов с отчётом (report_delivered: true): янтарный тон, тела нет, модель в правой части', async () => {
    const container = await renderChat(
      stopMessage({
        content:
          '<execution_stopped reason="steps_limit" limit="15">\n'
          + 'Execution stopped at the step limit (15)\n'
          + '</execution_stopped>',
        author: 'System',
        metadata: {
          type: 'execution_stopped',
          reason: 'steps_limit',
          report_delivered: true,
          model: 'gpt-x',
        },
      }),
    )

    const text = container.textContent ?? ''
    expect(text).toContain('Завершено с ограничением: лимит шагов (отчёт получен)')
    // Штатная финализация больше не выглядит сбоем.
    expect(text).not.toContain('Остановлено')
    // Машинный EN-текст тела движка не показывается.
    expect(text).not.toContain('Execution stopped at the step limit')
    // Модель хода — в правой части блока.
    expect(metaModel(container)).toBe('gpt-x')
    expect(boxClass(container)).toContain('bg-status-warning/5')
    expect(boxClass(container)).not.toContain('bg-destructive')
  })

  it('лимит шагов без поля report_delivered: «отчёта нет», тела нет, модели нет', async () => {
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
    expect(text).toContain('Остановлено: лимит шагов (отчёта нет)')
    expect(text).not.toContain('Execution stopped at the step limit')
    // `metadata.model` нет — правая часть блока пуста от модели.
    expect(metaModel(container)).toBeNull()
    // Тон остаётся янтарным: причина-ограничитель — не сбой.
    expect(boxClass(container)).toContain('bg-status-warning/5')
  })

  it('лимит шагов с report_delivered: false — как без поля', async () => {
    const container = await renderChat(
      stopMessage({
        content: '<execution_stopped reason="steps_limit">\nreport missing\n</execution_stopped>',
        author: 'System',
        metadata: {
          type: 'execution_stopped',
          reason: 'steps_limit',
          report_delivered: false,
        },
      }),
    )

    const text = container.textContent ?? ''
    expect(text).toContain('Остановлено: лимит шагов (отчёта нет)')
    expect(text).not.toContain('report missing')
  })

  it('output_limit больше не «внутренняя ошибка»: подпись-ограничение, тела нет', async () => {
    const container = await renderChat(
      stopMessage({
        content:
          '<execution_stopped reason="output_limit">\n'
          + 'Response truncated by the output limit\n'
          + '</execution_stopped>',
        author: 'System',
        metadata: { type: 'execution_stopped', reason: 'output_limit' },
      }),
    )

    const text = container.textContent ?? ''
    expect(text).toContain('Завершено с ограничением: лимит вывода')
    expect(text).not.toContain('внутренняя ошибка')
    expect(text).not.toContain('Response truncated by the output limit')
    expect(boxClass(container)).toContain('bg-status-warning/5')
  })

  it('остановка пользователем: нейтральный блок «Прервано»', async () => {
    const container = await renderChat(
      stopMessage({
        content:
          '<execution_stopped reason="stopped_by_user">\nrun stopped by the user\n</execution_stopped>',
        author: 'System',
        metadata: { type: 'execution_stopped', reason: 'stopped_by_user' },
      }),
    )

    const text = container.textContent ?? ''
    expect(text).toContain('Прервано: остановлено пользователем')
    expect(text).not.toContain('run stopped by the user')
    // Нейтральный тон — служебный info-блок, не красный.
    expect(boxClass(container)).toContain('bg-surface-inset')
    expect(boxClass(container)).not.toContain('bg-destructive')
  })

  it('неизвестная причина деградирует на «внутренняя ошибка» и не показывает тело', async () => {
    const container = await renderChat(
      stopMessage({
        content: '<execution_stopped reason="weird">\nboom\n</execution_stopped>',
        author: 'System',
        metadata: { type: 'execution_stopped', reason: 'weird' },
      }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Остановлено: внутренняя ошибка')
    expect(text).not.toContain('boom')
  })
})
