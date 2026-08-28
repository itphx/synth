import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'

// Клиентский рендер (createRoot): renderToString не подходит — zustand
// useSyncExternalStore в SSR читает getInitialState (enDict), а не текущий стейт.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Минимальный MessageData-каркас. */
function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'info',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-08-28T00:00:00Z',
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

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
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

describe('ChatMessage: ветка рендера metadata.i18n', () => {
  beforeAll(() => {
    // Локаль ru: как initializeLocale() после чтения localStorage synth-ui.i18n.v1.
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('info-сообщение с metadata.i18n (ключ есть) → русский перевод', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'info',
        content: 'File written: /tmp/a.ts (10 lines, 512 bytes)',
        metadata: {
          i18n: { key: 'fs.file_written', params: { path: '/tmp/a.ts', lines: '10', bytes: '512' } },
        },
      }),
    )
    expect(container.textContent).toContain('Файл записан: /tmp/a.ts (10 строк, 512 байт)')
    expect(container.textContent).not.toContain('File written')
  })

  it('info-сообщение без metadata.i18n → content (en) без изменений', async () => {
    const container = await renderChat(
      makeMessage({ role: 'info', content: 'Could not complete the request' }),
    )
    expect(container.textContent).toContain('Could not complete the request')
  })

  it('ключа нет в словаре → content (не сам ключ)', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'info',
        content: 'English fallback content',
        metadata: { i18n: { key: 'no.such.key' } },
      }),
    )
    expect(container.textContent).toContain('English fallback content')
    expect(container.textContent).not.toContain('no.such.key')
  })

  it('assistant-сообщение с metadata.i18n (micro) → перевод', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: 'Hi! How can I help you?',
        metadata: { i18n: { key: 'micro.greeting' } },
      }),
    )
    expect(container.textContent).toContain('Привет! Чем могу помочь?')
  })

  it('assistant-сообщение без metadata.i18n → content без изменений', async () => {
    const container = await renderChat(
      makeMessage({ role: 'assistant', content: 'Модель отвечает своим языком' }),
    )
    expect(container.textContent).toContain('Модель отвечает своим языком')
  })

  it('tool_result с metadata.i18n → перевод в ToolCallPart (после раскрытия)', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            name: 'write_file',
            args: { path: '/tmp/a.ts' },
            iteration: 0,
            result: {
              content: 'File written: /tmp/a.ts (10 lines, 512 bytes)',
              metadata: {
                i18n: { key: 'fs.file_written', params: { path: '/tmp/a.ts', lines: '10', bytes: '512' } },
              },
            },
          },
        ],
      }),
    )
    // Раскрыть карточку тула (первая кнопка — заголовок ToolCallPart).
    const toggle = container.querySelector('button')
    expect(toggle).not.toBeNull()
    await click(toggle!)
    // Переключиться на вкладку «Результат».
    const resultTab = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Результат',
    )
    expect(resultTab).toBeDefined()
    await click(resultTab!)
    expect(container.textContent).toContain('Файл записан: /tmp/a.ts (10 строк, 512 байт)')
  })

  it('tool_result без metadata.i18n → content без изменений', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            name: 'execute_shell',
            args: { command: 'ls' },
            iteration: 0,
            result: { content: 'raw shell output' },
          },
        ],
      }),
    )
    const toggle = container.querySelector('button')
    expect(toggle).not.toBeNull()
    await click(toggle!)
    const resultTab = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Результат',
    )
    expect(resultTab).toBeDefined()
    await click(resultTab!)
    expect(container.textContent).toContain('raw shell output')
  })
})
