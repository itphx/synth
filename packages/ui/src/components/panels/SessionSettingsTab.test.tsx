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

const mocks = vi.hoisted(() => ({
  getAgents: vi.fn(),
  getSessionMcpEffective: vi.fn(),
  updateSessionMcp: vi.fn(),
  getSecuritySettings: vi.fn(),
  updateSession: vi.fn(),
  clearSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getProviders: vi.fn(),
  getModels: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: vi.fn() }),
}))
vi.mock('../chat/ModelSelector', () => ({
  ModelSelector: () => React.createElement('div', { 'data-testid': 'model-selector' }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SessionSettingsTab } from './SessionSettingsTab'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function effective(overrides: Record<string, unknown> = {}) {
  return {
    servers: [
      {
        name: 'sys',
        level: 'system',
        enabled: true,
        status: 'connected',
        origin: 'instance',
        trust: 'builtin',
        author: null,
        tools: [],
      },
      {
        name: 'proj',
        level: 'project',
        enabled: true,
        status: 'connected',
        origin: 'user',
        trust: 'community',
        author: { userId: 'u9', username: 'alice' },
        tools: [],
      },
    ],
    enabled: ['sys', 'proj'],
    disabled: [],
    mcpServers: ['sys', 'proj'],
    mcpDisabledServers: [],
    ...overrides,
  }
}

async function renderTab(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <SessionSettingsTab />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.getAgents.mockResolvedValue({ agents: [] })
  mocks.getSessionMcpEffective.mockResolvedValue(effective())
  mocks.updateSessionMcp.mockResolvedValue(effective())
  mocks.getSecuritySettings.mockResolvedValue({ askTimeoutMs: 30_000 })
  mocks.updateSession.mockResolvedValue({})
  mocks.getProviders.mockResolvedValue({ providers: [], default_provider: null })
  mocks.getModels.mockResolvedValue([])

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [
      {
        id: 's1',
        name: 'S',
        project_id: null,
        engine: 'synth',
        settings: { model: 'm', mcpServers: ['sys', 'proj'], mcpDisabledServers: [] },
      },
    ],
  } as never)
  useProvidersStore.setState({
    providers: [],
    models: [],
    selectedProviderName: null,
    selectedModelName: null,
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
  vi.clearAllMocks()
})

describe('SessionSettingsTab — MCP-скоуп сессии (AD-071 §2.4)', () => {
  it('показывает уровень, статус и причину отключения', async () => {
    mocks.getSessionMcpEffective.mockResolvedValue(effective({
      servers: [
        { name: 'sys', level: 'system', enabled: true, status: 'connected', origin: 'instance', trust: 'builtin', tools: [] },
        {
          name: 'proj',
          level: 'project',
          enabled: false,
          reason: 'session_optout',
          status: 'disabled',
          origin: 'user',
          trust: 'community',
          tools: [],
        },
      ],
      enabled: ['sys'],
      disabled: ['proj'],
    }))
    const container = await renderTab()

    const sysRow = container.querySelector('[data-testid="session-mcp-sys"]')!
    expect(sysRow.textContent).toContain('system')
    expect(sysRow.textContent).toContain('connected')

    const projRow = container.querySelector('[data-testid="session-mcp-proj"]')!
    expect(projRow.textContent).toContain('project')
    expect(projRow.textContent).toContain('disabled')
    expect(projRow.textContent).toContain('session opt-out')
  })

  it('opt-out системного сервера вызывает PUT с { name, enabled: false }', async () => {
    const container = await renderTab()
    const row = container.querySelector('[data-testid="session-mcp-sys"]')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    mocks.updateSessionMcp.mockResolvedValue(effective({
      servers: [
        { name: 'sys', level: 'system', enabled: false, reason: 'session_optout', status: 'disabled', origin: 'instance', trust: 'builtin', tools: [] },
        { name: 'proj', level: 'project', enabled: true, status: 'connected', origin: 'user', trust: 'community', tools: [] },
      ],
      enabled: ['proj'],
      disabled: ['sys'],
      mcpServers: ['proj'],
      mcpDisabledServers: ['sys'],
    }))

    await act(async () => {
      toggle.click()
    })

    expect(mocks.updateSessionMcp).toHaveBeenCalledWith('s1', { name: 'sys', enabled: false })
    // Эффективный список перечитан с сервера.
    const updatedRow = container.querySelector('[data-testid="session-mcp-sys"]')!
    expect(updatedRow.textContent).toContain('session opt-out')
  })

  it('включение отключённого сервера вызывает PUT с { name, enabled: true }', async () => {
    mocks.getSessionMcpEffective.mockResolvedValue(effective({
      servers: [
        { name: 'sys', level: 'system', enabled: true, status: 'connected', origin: 'instance', trust: 'builtin', tools: [] },
        { name: 'proj', level: 'project', enabled: false, reason: 'not_default', status: 'disabled', origin: 'user', trust: 'community', tools: [] },
      ],
      enabled: ['sys'],
      disabled: ['proj'],
    }))
    const container = await renderTab()
    const row = container.querySelector('[data-testid="session-mcp-proj"]')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      toggle.click()
    })

    expect(mocks.updateSessionMcp).toHaveBeenCalledWith('s1', { name: 'proj', enabled: true })
  })
})
