import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
// Заглушку ставим до импорта сторов (vi.hoisted выполняется раньше импортов).
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
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import type { MediaPartData, Part } from '@itphx/synth-shared/types'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useAgentsStore } from '@/stores/agentsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'

function imagePart(id: string, name: string): Part {
  const data: MediaPartData = {
    blobPath: `attachments/ab/${id}`,
    sha256: `sha-${id}`,
    mime: 'image/png',
    size: 1024,
    name,
  }
  return { id, type: 'image', data }
}

function makeMessage(partial: Partial<MessageData> = {}): MessageData {
  return {
    index: 0,
    role: 'user',
    content: '[image: shot.png]',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
    author: 'Tool',
    metadata: {
      source: 'tool-attachment',
      tool: 'read_file',
      call_id: 'call_1',
      agent_role: 'fixer',
    },
    parts: [imagePart('p1', 'shot.png')],
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(
  message: MessageData,
  props: Partial<React.ComponentProps<typeof ChatMessage>> = {},
): Promise<HTMLElement> {
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
          sessionId={SESSION}
          onCopy={() => {}}
          onToggle={() => {}}
          onPin={() => {}}
          onDelete={() => {}}
          onRetry={() => {}}
          onDebug={() => {}}
          onFork={() => {}}
          {...props}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

function actionTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.message-actions button')).map(
    (b) => b.getAttribute('title') || '',
  )
}

beforeEach(() => {
  // Зритель — Alice: в блоке вложения её имени быть не должно.
  useAuthStore.setState({
    user: { id: 'u1', username: 'alice', roles: [] } as never,
    profile: { display_name: 'Alice' } as never,
  })
  useAgentsStore.setState({
    agents: [
      {
        id: 'fixer',
        display_name: 'Fixer',
        capabilities: [],
        enabled: true,
        icon: null,
        color: null,
        description: null,
        available: true,
        mode: 'simple',
        agent_mode: null,
        max_steps: null,
        provider: null,
        model: null,
        context_file: null,
      },
    ] as never,
  })
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
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  useAuthStore.setState({ user: null, profile: null } as never)
  useAgentsStore.setState({ agents: [] })
})

describe('ChatMessage: вложение тула — служебный блок (ADR-115)', () => {
  it('рисуется Notice «Agent · Fixer · attachment», а не user-пузырь', async () => {
    const container = await renderChat(makeMessage())

    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group).not.toBeNull()
    expect(group.getAttribute('aria-label')).toBe('Agent · Fixer · attachment')
    // Не правый user-пузырь и не бейдж текущего пользователя.
    expect(container.querySelector('.items-end')).toBeNull()
    expect(container.textContent).not.toContain('Alice')
  })

  it('пустой реестр агентов → подпись по роли', async () => {
    useAgentsStore.setState({ agents: [] })
    const container = await renderChat(makeMessage())

    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group.getAttribute('aria-label')).toBe('Agent · fixer · attachment')
  })

  it('без роли агента → «Agent · attachment»', async () => {
    const container = await renderChat(
      makeMessage({
        metadata: { source: 'tool-attachment', tool: 'read_file', call_id: 'call_1' },
      }),
    )

    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group.getAttribute('aria-label')).toBe('Agent · attachment')
  })

  it('вложения сообщения отрисованы внутри блока', async () => {
    const container = await renderChat(makeMessage())

    const attachments = container.querySelector('[data-testid="message-attachments"]')
    expect(attachments).not.toBeNull()
    const img = container.querySelector('[data-testid="message-attachment-image"] img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/p1?variant=thumb')
  })

  it('полный набор действий как у фонового результата (Copy/Retry/… )', async () => {
    const container = await renderChat(makeMessage())

    const titles = actionTitles(container)
    expect(titles).toContain('Copy')
    expect(titles).toContain('Retry')
    expect(titles.length).toBeGreaterThan(0)
  })

  it('обычное user-сообщение по-прежнему рисуется пузырём', async () => {
    const container = await renderChat(
      makeMessage({
        author: 'alice',
        content: 'Привет',
        metadata: undefined,
        parts: [],
      }),
    )

    expect(container.querySelector('.items-end')).not.toBeNull()
    expect(container.querySelector('[role="group"]')).toBeNull()
    expect(container.textContent).toContain('Alice')
  })
})
