import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getOptimization: vi.fn(),
  notify: vi.fn(),
}))

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

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ContextTab } from './ContextTab'
import { useUIStore } from '@/stores/useUIStore'
import { useChatStore } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const OPTIMIZATION = {
  context_optimization: 'none',
  sliding_window_mode: 'messages',
  sliding_window_message_limit: 10,
  sliding_window_token_threshold: 80,
  summarization_trigger_mode: 'messages',
  summarize_after_n: 10,
  summarize_token_threshold: 50,
  summarization_head_messages: 2,
  summarization_tail_messages: 3,
}

async function renderContext(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ContextTab />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.getOptimization.mockResolvedValue(OPTIMIZATION)

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useChatStore.setState({ stickyNotesBySession: {}, streamFinishTickBySession: {} })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
})

describe('ContextTab — базовая отрисовка', () => {
  it('рендерит блоки оптимизации контекста и не содержит MCP-таблицы', async () => {
    const container = await renderContext()
    expect(container.querySelector('[data-testid="context-mcp-list"]')).toBeNull()
    expect(container.textContent).toContain(enDict['rightPanel.context.optimization.sticky_notes'])
    expect(container.textContent).toContain(enDict['rightPanel.context.optimization.sliding_window'])
    expect(container.textContent).toContain(enDict['rightPanel.context.optimization.summarization'])
  })
})
