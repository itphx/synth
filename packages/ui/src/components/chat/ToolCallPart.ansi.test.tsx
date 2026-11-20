// ToolCallPart: результат инструмента с ANSI-последовательностями.
//
// `execute_shell` исполняется в PTY с `TERM=xterm-256color`, поэтому его вывод
// (и вывод `terminal_*`) приходит с SGR-кодами. Раньше такой результат
// рендерился в `<pre>` как есть — пользователь видел `□[32m`. Здесь проверяем,
// что сырой текст результата идёт через `AnsiText` (цвета включены), а
// специализированные ветки (diff, пары «вопрос → ответ») не тронуты.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ToolCallPart } from './ToolCallPart'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(
  toolCall: Record<string, unknown>,
  props: Partial<React.ComponentProps<typeof ToolCallPart>> = {},
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ToolCallPart toolCall={toolCall as never} {...props} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  // Карточка раскрывается кликом по заголовку — только тогда рендерится тело.
  const toggle = container.querySelector('[data-tool-call-toggle="1"]') as HTMLElement | null
  if (toggle) {
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  return container
}

/** Завершённый вызов `execute_shell` с заданным результатом. */
function shellCall(content: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'execute_shell',
    args: { command: 'npm test' },
    callId: 'call-1',
    iteration: 0,
    status: 'done',
    startedAt: '2026-11-18T00:00:00Z',
    completedAt: '2026-11-18T00:00:02Z',
    result: { content },
    ...extra,
  }
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => root.unmount())
    container.remove()
  }
})

describe('ToolCallPart: ANSI в результате инструмента', () => {
  it('вывод shell раскрашен, ESC в тексте отсутствует', async () => {
    const container = await render(
      shellCall('\u001b[32mPASS\u001b[0m a.test.ts\n\u001b[90m1 passed\u001b[39m\n'),
      { resultFirst: true },
    )

    const result = container.querySelector('[data-testid="tool-call-result-text"]') as HTMLElement
    expect(result).not.toBeNull()
    expect(result.textContent).toContain('PASS a.test.ts')
    expect(result.textContent).toContain('1 passed')
    expect(result.textContent).not.toContain('\u001b')
    expect(result.querySelector('.text-ansi-green')).not.toBeNull()
    expect(result.querySelector('.text-ansi-bright-black')).not.toBeNull()
  })

  it('truecolor-вывод идёт инлайновым стилем', async () => {
    const container = await render(shellCall('\u001b[38;2;18;52;86mtrue\u001b[0m\n'), {
      resultFirst: true,
    })

    const spans = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="tool-call-result-text"] span'),
    ).filter((span) => span.style.color !== '')
    expect(spans[0]?.style.color).toBe('rgb(18, 52, 86)')
  })

  it('ошибочный результат тоже без ESC и с раскраской', async () => {
    const container = await render(
      shellCall('\u001b[31mError\u001b[0m: код 1\n', { result: { content: '\u001b[31mError\u001b[0m: код 1\n', isError: true } }),
      { resultFirst: true },
    )

    const result = container.querySelector('[data-testid="tool-call-result-text"]') as HTMLElement
    expect(result.textContent).toContain('Error: код 1')
    expect(result.textContent).not.toContain('\u001b')
    expect(result.querySelector('.text-ansi-red')).not.toBeNull()
  })

  it('аргументы (JSON) рендерятся по-прежнему без ANSI-обработки', async () => {
    const container = await render(shellCall('ok\n'), { resultFirst: false })

    const args = container.querySelector('pre')
    expect(args, 'аргументы не отрендерились').not.toBeNull()
    expect(args?.textContent ?? '').toContain('"command": "npm test"')
  })
})
