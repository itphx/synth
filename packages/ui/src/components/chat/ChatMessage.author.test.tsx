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
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  // Зритель — Alice.
  useAuthStore.setState({
    user: { id: 'u1', username: 'alice', roles: [] } as never,
    profile: { display_name: 'Alice' } as never,
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
})

describe('ChatMessage: атрибуция автора в MessageHeader', () => {
  it('чужой автор показывается своим именем, а не именем зрителя', async () => {
    const container = await renderChat(makeMessage({ author: 'bob' }))

    expect(container.textContent).toContain('bob')
    expect(container.textContent).not.toContain('Alice')
  })

  it('author = username зрителя → имя из профиля', async () => {
    const container = await renderChat(makeMessage({ author: 'alice' }))

    expect(container.textContent).toContain('Alice')
    expect(container.textContent).not.toContain('alice')
  })

  it('без author → имя из профиля', async () => {
    const container = await renderChat(makeMessage())

    expect(container.textContent).toContain('Alice')
  })

  it('author = local (standalone) → имя из профиля', async () => {
    const container = await renderChat(makeMessage({ author: 'local' }))

    expect(container.textContent).toContain('Alice')
    expect(container.textContent).not.toContain('local')
  })

  it('внешнее событие без author → нейтральная подпись, а не имя зрителя', async () => {
    const container = await renderChat(
      makeMessage({ metadata: { event_id: 'evt_1', source: 'telegram' } }),
    )

    expect(container.textContent).toContain('External sender')
    expect(container.textContent).not.toContain('Alice')
  })

  it('legacy author = User → имя из профиля (сравнение без учёта регистра)', async () => {
    const container = await renderChat(makeMessage({ author: 'User' }))

    expect(container.textContent).toContain('Alice')
    expect(container.textContent).not.toContain('User')
  })
})
