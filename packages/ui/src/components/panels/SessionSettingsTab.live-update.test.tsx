import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

/**
 * Вкладка «Сессия»: живое обновление эффективных MCP- и skill-списков.
 *
 * Баг: «включил скилл/MCP сессии в чате — вкладка настроек показывает старые
 * переключатели до перезагрузки страницы». Списки живут в локальном состоянии
 * компонента, поэтому событие шины должно вызывать перечитывание — и только
 * для **своей** сессии.
 */
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
  getSessionSkills: vi.fn(),
  updateSessionSkills: vi.fn(),
  getSecuritySettings: vi.fn(),
  updateSession: vi.fn(),
  getProviders: vi.fn(),
  getModels: vi.fn(),
  getToolsPolicyInfo: vi.fn(),
  getMcpPolicyInfo: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))
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
import { useMcpStore } from '@/stores/mcpStore'
import { useSkillsStore } from '@/stores/skillsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function skillsEffective() {
  return {
    session_id: 's1',
    skills: [
      {
        name: 'api-review',
        description: 'Review API',
        level: 'system',
        scope: 'instance',
        trusted: true,
        available: true,
        enabled: true,
        disabled: false,
      },
    ],
    enabled: ['api-review'],
    disabled: [],
  }
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: 'S',
    project_id: null,
    settings: { model: 'm' },
    updated_at: '2026-01-01T00:00:00.000Z',
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
  vi.clearAllMocks()
  mocks.getAgents.mockResolvedValue({ agents: [] })
  mocks.getSessionMcpEffective.mockResolvedValue({
    servers: [],
    enabled: [],
    disabled: [],
    mcpServers: [],
    mcpDisabledServers: [],
  })
  mocks.updateSessionMcp.mockResolvedValue({
    servers: [],
    enabled: [],
    disabled: [],
    mcpServers: [],
    mcpDisabledServers: [],
  })
  mocks.getSessionSkills.mockResolvedValue(skillsEffective())
  mocks.updateSessionSkills.mockResolvedValue(skillsEffective())
  mocks.getSecuritySettings.mockResolvedValue({ askTimeoutMs: 30_000 })
  mocks.updateSession.mockResolvedValue({})
  mocks.getProviders.mockResolvedValue({ providers: [], default_provider: null })
  mocks.getModels.mockResolvedValue([])
  mocks.getToolsPolicyInfo.mockResolvedValue({ policy: 'auto', isOverridden: false, defaults: 'auto' })
  mocks.getMcpPolicyInfo.mockResolvedValue({ policy: 'consistency', isOverridden: false, defaults: 'consistency' })

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({ sessions: [session()] } as never)
  useProvidersStore.setState({
    providers: [],
    models: [],
    selectedProviderName: null,
    selectedModelName: null,
  })
  useMcpStore.setState({ revision: 0, projectRevisions: {}, sessionRevisions: {} })
  useSkillsStore.setState({
    skills: null,
    bundles: null,
    settingsDisabled: null,
    revision: 0,
    projectRevisions: {},
    sessionRevisions: {},
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

describe('SessionSettingsTab — событие шины обновляет скоуп своей сессии', () => {
  it('skills.updated своей сессии перечитывает эффективный список скиллов', async () => {
    await renderTab()
    const before = mocks.getSessionSkills.mock.calls.length

    await act(async () => {
      useSkillsStore.getState().applyEvent({ action: 'scope', scope: 'session', sessionId: 's1' })
    })
    await act(async () => {})

    expect(mocks.getSessionSkills.mock.calls.length).toBe(before + 1)
  })

  it('skills.updated чужой сессии список не перечитывает', async () => {
    await renderTab()
    const before = mocks.getSessionSkills.mock.calls.length

    await act(async () => {
      useSkillsStore.getState().applyEvent({ action: 'scope', scope: 'session', sessionId: 's2' })
    })
    await act(async () => {})

    expect(mocks.getSessionSkills.mock.calls.length).toBe(before)
  })

  it('mcp.updated своей сессии перечитывает эффективный список серверов', async () => {
    await renderTab()
    const before = mocks.getSessionMcpEffective.mock.calls.length

    await act(async () => {
      useMcpStore.getState().applyEvent({ scope: 'session', sessionId: 's1' })
    })
    await act(async () => {})

    expect(mocks.getSessionMcpEffective.mock.calls.length).toBe(before + 1)
  })

  it('mcp.updated чужой сессии список не перечитывает', async () => {
    await renderTab()
    const before = mocks.getSessionMcpEffective.mock.calls.length

    await act(async () => {
      useMcpStore.getState().applyEvent({ scope: 'session', sessionId: 's2' })
    })
    await act(async () => {})

    expect(mocks.getSessionMcpEffective.mock.calls.length).toBe(before)
  })

  it('session.updated этой сессии (новый updated_at) перечитывает оба списка', async () => {
    await renderTab()
    const mcpBefore = mocks.getSessionMcpEffective.mock.calls.length
    const skillsBefore = mocks.getSessionSkills.mock.calls.length

    // `transportStore` на `session.updated` патчит сессию в сторе — сервер
    // двигает `updated_at` и при смене MCP/skill-скоупа сессии.
    await act(async () => {
      useSessionsStore.setState({
        sessions: [session({ updated_at: '2026-02-02T00:00:00.000Z' })],
      } as never)
    })
    await act(async () => {})

    expect(mocks.getSessionMcpEffective.mock.calls.length).toBe(mcpBefore + 1)
    expect(mocks.getSessionSkills.mock.calls.length).toBe(skillsBefore + 1)
  })
})
