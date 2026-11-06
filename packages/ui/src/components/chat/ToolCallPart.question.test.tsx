/**
 * Карточка тула `question` (ADR-112 × ADR-118 §1).
 *
 * Проверяем: карточка узнаваема (имя/иконка), после раскрытия в «Результате»
 * видны читаемые пары «вопрос → ответ» (label по `options[].value`; `multiple` —
 * через запятую; неизвестное значение — как есть), и карточка строится из DTO
 * `tool_calls` без live-частей (сценарий reload).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ToolCallPart } from './ToolCallPart'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import { getToolDisplayName, getToolIcon } from '@/lib/toolIcons'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const QUESTIONS = [
  {
    header: 'Модуль',
    question: 'С какого модуля начинаем?',
    options: [
      { value: 'qdevice', label: 'QDevice' },
      { value: 'other', label: 'Другое' },
    ],
  },
  {
    header: 'Объём',
    question: 'Что включить?',
    multiple: true,
    options: [
      { value: 'api', label: 'API' },
      { value: 'ui', label: 'UI' },
    ],
  },
]

const RESULT = {
  content: 'The user answered the questions',
  metadata: {
    answers: [['qdevice'], ['api', 'ui']],
  },
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(el: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(el)
  })
  return container
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-06T00:00:00Z',
    ...partial,
  }
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

describe('ToolCallPart: карточка question', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('иконка и имя тула узнаваемы', () => {
    expect(getToolIcon('question')).toBe('question')
    expect(getToolDisplayName('question')).toBe('Question')
  })

  it('в результате — пары «вопрос → ответ» (label, multiple через запятую)', async () => {
    const container = await render(
      <I18nProvider>
        <ToolCallPart
          toolCall={{ name: 'question', args: { questions: QUESTIONS }, result: RESULT, status: 'done' }}
        />
      </I18nProvider>,
    )
    expect(container.textContent).toContain('Question')
    await click(container.querySelector('[data-tool-call-toggle]') as HTMLElement)
    // Вкладка «Результат» открыта по умолчанию (ответы — главное).
    expect(container.textContent).toContain('С какого модуля начинаем?')
    expect(container.textContent).toContain('QDevice')
    expect(container.textContent).toContain('API, UI')
    expect(container.textContent).not.toContain('The user answered the questions')
  })

  it('неизвестное значение показывается как есть; аргументы доступны вкладкой', async () => {
    const container = await render(
      <I18nProvider>
        <ToolCallPart
          toolCall={{
            name: 'question',
            args: { questions: [{ question: 'Свой вариант?', header: 'Ответ', options: [] }] },
            result: { content: 'ok', metadata: { answers: [['custom']] } },
            status: 'done',
          }}
        />
      </I18nProvider>,
    )
    expect(container.textContent).toContain('Question')
    await click(container.querySelector('[data-tool-call-toggle]') as HTMLElement)
    expect(container.textContent).toContain('custom')
    const argsTab = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Аргументы'))
    expect(argsTab).toBeDefined()
    await click(argsTab as HTMLElement)
    expect(container.textContent).toContain('Свой вариант?')
  })

  it('карточка восстанавливается из DTO tool_calls (reload, без live-частей)', async () => {
    const message = makeMessage({
      parts: [{ id: 'msg:text:0', type: 'text', data: '' }],
      tool_calls: [{
        id: 'call_q',
        name: 'question',
        args: { questions: QUESTIONS },
        result: RESULT,
        iteration: 13,
      }],
    })
    const container = await render(
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
      </I18nProvider>,
    )
    const toggle = container.querySelector('[data-tool-call-toggle]') as HTMLElement | null
    expect(toggle).not.toBeNull()
    expect(toggle!.textContent).toContain('Question')
    await click(toggle!)
    expect(container.textContent).toContain('С какого модуля начинаем?')
    expect(container.textContent).toContain('QDevice')
  })
})
