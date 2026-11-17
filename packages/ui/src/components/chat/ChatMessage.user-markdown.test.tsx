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

// Аудит раскрытия секрета уходит в API — в тесте сеть не поднимаем.
vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return { ...actual, synthApi: { ...actual.synthApi, auditRevealed: vi.fn(async () => {}) } }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useAgentsStore } from '@/stores/agentsStore'
import type { AgentInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeAgent(id: string, color: string | null = '--status-error'): AgentInfo {
  return {
    id,
    display_name: id,
    capabilities: [],
    enabled: true,
    icon: null,
    color,
    description: null,
    available: true,
    mode: 'simple',
    agent_mode: null,
    max_steps: null,
    provider: null,
    model: null,
    context_file: null,
    is_builtin: true,
    is_overridden: false,
  } as AgentInfo
}

const AGENTS: AgentInfo[] = [makeAgent('fixer'), makeAgent('security-auditor', '--palette-3')]

function makeMessage(partial: Partial<MessageData> = {}): MessageData {
  return {
    index: 0,
    role: 'user',
    content: 'Привет',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(message: MessageData): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
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
  await act(async () => {})
  return container
}

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 'u1', username: 'alice', roles: [] } as never,
    profile: { display_name: 'Alice' } as never,
  })
  useAgentsStore.setState({ agents: AGENTS })
  // По умолчанию разметка включена (дефолт настройки).
  useUIStore.setState({ userMessageMarkdown: 'markdown' })
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
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null, userMessageMarkdown: 'markdown' })
  useAuthStore.setState({ user: null, profile: null } as never)
  useAgentsStore.setState({ agents: [] })
})

describe('ChatMessage: сообщение пользователя в markdown-режиме', () => {
  it('markdown-разметка разбирается: жирный, блок кода, список', async () => {
    const container = await renderChat(
      makeMessage({ content: '**жирный**\n\n```ts\nconst a = 1\n```\n\n- пункт один\n- пункт два' }),
    )

    expect(container.querySelector('strong')?.textContent).toBe('жирный')
    expect(container.querySelector('.md-code')).not.toBeNull()
    expect(container.querySelectorAll('li').length).toBe(2)
  })

  it('сырой HTML остаётся текстом: тега в DOM нет, видно как набрано', async () => {
    const container = await renderChat(makeMessage({ content: 'проверка <b>x</b> конец' }))

    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<b>x</b>')
  })

  it('плейсхолдер секрета рендерится маркером, а не текстом', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'ключ ⟦SYNTH_SECRET_1⟧ конец',
        metadata: { secrets: { '⟦SYNTH_SECRET_1⟧': 'super-secret' } },
      }),
    )

    const marker = container.querySelector('.synth-secret-ph')
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('data-ph')).toBe('⟦SYNTH_SECRET_1⟧')
    expect(container.textContent).not.toContain('super-secret')
  })

  it('@-упоминание агента подсвечивается цветом агента', async () => {
    const container = await renderChat(makeMessage({ content: '@fixer почини' }))

    const mention = container.querySelector('[data-mention="fixer"]') as HTMLElement | null
    expect(mention).not.toBeNull()
    expect(mention!.textContent).toBe('@fixer')
    expect(mention!.style.color).not.toBe('')
  })

  it('id агента с дефисом тоже распознаётся', async () => {
    const container = await renderChat(makeMessage({ content: '@security-auditor проверь' }))

    const mention = container.querySelector('[data-mention="security-auditor"]') as HTMLElement | null
    expect(mention).not.toBeNull()
    expect(mention!.textContent).toBe('@security-auditor')
    expect(mention!.style.color).not.toBe('')
  })

  it('пустой реестр агентов — упоминание остаётся обычным текстом', async () => {
    useAgentsStore.setState({ agents: [] })
    const container = await renderChat(makeMessage({ content: '@fixer почини' }))

    expect(container.querySelector('[data-mention]')).toBeNull()
    expect(container.textContent).toContain('@fixer')
  })
})

describe('ChatMessage: сообщение пользователя в plain-режиме', () => {
  it('текст как набран: без разметки, прежний <p>', async () => {
    useUIStore.setState({ userMessageMarkdown: 'plain' })
    const container = await renderChat(makeMessage({ content: '**жирный**' }))

    expect(container.querySelector('strong')).toBeNull()
    const paragraph = container.querySelector('p.text-sm.whitespace-pre-wrap')
    expect(paragraph).not.toBeNull()
    expect(paragraph!.textContent).toBe('**жирный**')
  })

  it('plain-режим: @-упоминание всё равно подсвечивается', async () => {
    useUIStore.setState({ userMessageMarkdown: 'plain' })
    const container = await renderChat(makeMessage({ content: '@fixer почини' }))

    expect(container.querySelector('[data-mention="fixer"]')).not.toBeNull()
  })
})

describe('ChatMessage: ответ агента', () => {
  it('@-упоминание в ответе агента тоже подсвечивается', async () => {
    const container = await renderChat(
      makeMessage({ role: 'assistant', content: 'обработал @fixer' }),
    )

    const mention = container.querySelector('[data-mention="fixer"]') as HTMLElement | null
    expect(mention).not.toBeNull()
    expect(mention!.style.color).not.toBe('')
  })
})
