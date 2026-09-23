import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
// Заглушку ставим до импорта стора (vi.hoisted выполняется раньше импортов).
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
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: 'Ответ ассистента',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
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

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
})

describe('ChatMessage: системные команды (AD-046 §7.1)', () => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })

  it('ответ команды → нейтральный блок, без бейджа агента/статистики, только «Копировать»', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: 'HELP TEXT',
        model: 'command',
        provider: 'command',
        agent_role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        metadata: { command: true, commandName: 'help', commandArgs: '' },
      }),
    )
    expect(container.textContent).toContain('/help')
    expect(container.textContent).toContain('HELP TEXT')
    // Статистики нет, несмотря на usage/model.
    expect(container.querySelector('button[title="Response stats"]')).toBeNull()
    // Прочих действий agent-ветки нет.
    for (const title of ['Debug', 'Pin', 'Delete', 'Create branch', 'Disable']) {
      expect(container.querySelector(`button[title="${title}"]`)).toBeNull()
    }
    // Ровно одно действие — «Копировать».
    const actions = container.querySelector('.message-actions')
    expect(actions).not.toBeNull()
    const buttons = actions!.querySelectorAll('button')
    expect(buttons.length).toBe(1)
    expect(buttons[0]!.getAttribute('title')).toBe('Copy')
  })

  it('аргументы команды выводятся в шапке', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: 'OUT',
        metadata: { command: true, commandName: 'skill', commandArgs: 'foo bar' },
      }),
    )
    expect(container.textContent).toContain('> /skill foo bar')
  })

  it('/summary-нотис тоже в командном стиле', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: 'Not enough active messages to summarize',
        model: 'command',
        provider: 'command',
        agent_role: 'assistant',
        metadata: { command: true, commandName: 'summary', commandArgs: '' },
      }),
    )
    expect(container.textContent).toContain('/summary')
    expect(container.textContent).toContain('Not enough active messages to summarize')
    expect(container.querySelector('button[title="Response stats"]')).toBeNull()
  })

  it('/summary-нотис с metadata.i18n локализуется (ru)', async () => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
    try {
      const container = await renderChat(
        makeMessage({
          role: 'assistant',
          content: 'Not enough active messages to summarize',
          metadata: {
            command: true,
            commandName: 'summary',
            commandArgs: '',
            i18n: { key: 'command.summary_unavailable' },
          },
        }),
      )
      expect(container.textContent).toContain('Недостаточно активных сообщений для суммаризации')
      expect(container.textContent).not.toContain('Not enough active')
    } finally {
      useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
    }
  })

  it('старое command-сообщение без commandName не падает и рендерит блок', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: 'OLD OUTPUT',
        metadata: { command: true },
      }),
    )
    expect(container.textContent).toContain('OLD OUTPUT')
    expect(container.querySelector('button[title="Response stats"]')).toBeNull()
  })

  it('metadata.command-объект (template/skill/bundle) не превращает ответ в командный блок', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: 'Обычный ответ агента',
        model: 'gpt-x',
        agent_role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        metadata: { command: { name: 'plan', kind: 'template', args: '' }, duration_ms: 10 },
      }),
    )
    expect(container.textContent).toContain('Обычный ответ агента')
    expect(container.textContent).not.toContain('> /plan')
    // Agent-ветка: статистика доступна.
    expect(container.querySelector('button[title="Response stats"]')).not.toBeNull()
  })
})
