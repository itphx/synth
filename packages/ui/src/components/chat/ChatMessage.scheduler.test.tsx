import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
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
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'user',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(
  message: MessageData,
  props: Partial<React.ComponentProps<typeof ChatMessage>> = {},
): Promise<HTMLElement> {
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
          {...props}
        />
      </I18nProvider>,
    )
  })
  return container
}

function actionTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.message-actions button')).map(
    (b) => b.getAttribute('title') || '',
  )
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
  useAuthStore.setState({ user: null, profile: null } as never)
})

describe('ChatMessage: сообщения планировщика (ADR-051)', () => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })

  beforeEach(() => {
    // Текущий залогиненный пользователь — чтобы убедиться, что в scheduler-блоке
    // не рисуется userBadge с его именем.
    useAuthStore.setState({
      user: { id: 'u1', username: 'alice', roles: [] } as never,
      profile: { display_name: 'Alice' } as never,
    })
  })

  it('scheduler с schedule_name → Notice «Scheduler · <name>», тело = текст задания, без user-пузыря', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'Run nightly report',
        metadata: { source: 'cron', scheduler: true, schedule_id: 's1', schedule_name: 'Nightly' },
      }),
    )
    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group).not.toBeNull()
    expect(group.getAttribute('aria-label')).toBe('Scheduler · Nightly')
    expect(container.textContent).toContain('Run nightly report')
    // Не рисуем правый user-пузырь и userBadge текущего пользователя.
    expect(container.querySelector('.items-end')).toBeNull()
    expect(container.textContent).not.toContain('Alice')
  })

  it('scheduler без schedule_name → просто «Scheduler»', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'Task body',
        metadata: { source: 'cron', scheduler: true, schedule_id: 's1' },
      }),
    )
    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group.getAttribute('aria-label')).toBe('Scheduler')
    expect(container.textContent).toContain('Task body')
    expect(container.textContent).not.toContain('Alice')
  })

  it('scheduler → полный набор действий как у user-сообщения', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'Run nightly report',
        metadata: { scheduler: true, schedule_name: 'Nightly' },
      }),
    )
    const titles = actionTitles(container)
    expect(titles).toContain('Copy')
    expect(titles).toContain('Create branch')
    expect(titles).toContain('Retry')
    expect(titles).toContain('Pin')
    expect(titles).toContain('Delete')
    // Дублирующей кнопки копирования нет (копия — из Notice).
    expect(titles.filter((t) => t === 'Copy')).toHaveLength(1)
  })

  it('scheduler в selectionMode → чекбокс выбора сохранён', async () => {
    const container = await renderChat(
      makeMessage({
        content: 'Task body',
        metadata: { scheduler: true, schedule_name: 'Nightly' },
      }),
      { selectionMode: true, isSelected: true },
    )
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox).not.toBeNull()
    expect(checkbox.checked).toBe(true)
    expect(container.querySelector('[role="group"]')).not.toBeNull()
  })

  it('обычное user-сообщение без scheduler → user-пузырь и userBadge сохранены', async () => {
    const container = await renderChat(makeMessage({ content: 'Hello' }))
    expect(container.querySelector('.items-end')).not.toBeNull()
    expect(container.textContent).toContain('Alice')
    expect(container.querySelector('[role="group"]')).toBeNull()
  })
})
