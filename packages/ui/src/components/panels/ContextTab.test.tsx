import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getOptimization: vi.fn(),
  getSessionMcpEffective: vi.fn(),
  updateSessionMcp: vi.fn(),
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

const SYS_SERVER = {
  name: 'sys', level: 'system' as const, enabled: true, connected: true, status: 'connected' as const,
  origin: 'instance' as const, trust: 'builtin' as const, author: null, tools: ['echo'],
  chars: 100, estTokens: 25, ratio: 4,
  toolDetails: [{ name: 'echo', chars: 100, estTokens: 25, ratio: 4 }],
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
  mocks.getSessionMcpEffective.mockResolvedValue({
    servers: [SYS_SERVER],
    enabled: ['sys'],
    disabled: [],
    mcpServers: [],
    mcpDisabledServers: [],
  })
  mocks.updateSessionMcp.mockResolvedValue({
    servers: [{ ...SYS_SERVER, enabled: false, connected: false, status: 'disabled', reason: 'session_optout' }],
    enabled: [],
    disabled: ['sys'],
    mcpServers: [],
    mcpDisabledServers: ['sys'],
  })

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

describe('ContextTab — MCP-серверы сессии (AD-071 §2.4/§2.6)', () => {
  it('рендерит таблицу MCP: сервер, уровень, статус, тулы и оценку токенов', async () => {
    const container = await renderContext()
    const list = container.querySelector('[data-testid="context-mcp-list"]')
    expect(list).not.toBeNull()

    const row = container.querySelector('[data-testid="context-mcp-sys"]')!
    expect(row.textContent).toContain('sys')
    expect(row.textContent).toContain('system')
    expect(row.textContent).toContain('connected')
    expect(row.textContent).toContain('~25')

    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('переключатель вызывает PUT /sessions/:id/mcp и обновляет состояние', async () => {
    const container = await renderContext()
    const toggle = container.querySelector('[data-testid="context-mcp-sys"] button[role="switch"]') as HTMLButtonElement

    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    expect(mocks.updateSessionMcp).toHaveBeenCalledWith('s1', { name: 'sys', enabled: false })
    const row = container.querySelector('[data-testid="context-mcp-sys"]')!
    expect(row.textContent).toContain('disabled')
    expect(row.textContent).toContain('session opt-out')
    expect((row.querySelector('button[role="switch"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('false')
  })
})
