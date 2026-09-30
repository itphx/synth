import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function skillsEffective(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 's1',
    skills: [
      { name: 'api-review', description: 'Review API', level: 'system', scope: 'instance', trusted: true, available: true, enabled: true, disabled: false },
      { name: 'db-migration', description: 'Migrations', level: 'project', scope: 'project', trusted: true, available: false, unavailableReason: 'capabilities', enabled: false, disabled: false },
      { name: 'blocked', description: 'Blocked skill', level: 'system', scope: 'instance', trusted: true, available: true, enabled: false, disabled: true, disabledReason: 'system' },
    ],
    enabled: ['api-review'],
    disabled: ['blocked'],
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
  mocks.getSessionMcpEffective.mockResolvedValue({ servers: [], enabled: [], disabled: [], mcpServers: [], mcpDisabledServers: [] })
  mocks.updateSessionMcp.mockResolvedValue({ servers: [], enabled: [], disabled: [], mcpServers: [], mcpDisabledServers: [] })
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
  useSessionsStore.setState({
    sessions: [
      {
        id: 's1',
        name: 'S',
        project_id: null,
        engine: 'synth',
        settings: { model: 'm' },
      },
    ],
  } as never)
  useProvidersStore.setState({ providers: [], models: [], selectedProviderName: null, selectedModelName: null })
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

describe('SessionSettingsTab — скиллы сессии (AD-046 §4.5)', () => {
  it('рендерит список с уровнем/scope, unavailable и причиной system-disable', async () => {
    const container = await renderTab()
    expect(container.querySelector('[data-testid="session-skills-list"]')).not.toBeNull()

    const apiRow = container.querySelector('[data-testid="session-skill-api-review"]')!
    expect(apiRow.textContent).toContain('api-review')
    expect(apiRow.textContent).toContain('instance')
    expect(apiRow.textContent).toContain('system')

    const dbRow = container.querySelector('[data-testid="session-skill-db-migration"]')!
    expect(dbRow.textContent).toContain('Unavailable')

    const blockedRow = container.querySelector('[data-testid="session-skill-blocked"]')!
    const blockedToggle = blockedRow.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(blockedToggle.disabled).toBe(true)
    // Причина блокировки — в раскрываемом контенте.
    expect(blockedRow.textContent).not.toContain('disabled by administrator')
    const blockedCat = blockedRow.querySelector('[data-testid="session-skill-blocked-details-toggle"]') as HTMLButtonElement
    await act(async () => {
      blockedCat.click()
    })
    expect(container.querySelector('[data-testid="session-skill-blocked-details-content"]')!.textContent).toContain('disabled by administrator')
  })

  it('описание скилла скрыто по умолчанию и раскрывается по кату', async () => {
    const container = await renderTab()
    const row = container.querySelector('[data-testid="session-skill-api-review"]')!
    expect(row.textContent).not.toContain('Review API')
    expect(container.querySelector('[data-testid="session-skill-api-review-details-content"]')).toBeNull()

    const toggle = row.querySelector('[data-testid="session-skill-api-review-details-toggle"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      toggle.click()
    })

    const content = container.querySelector('[data-testid="session-skill-api-review-details-content"]')!
    expect(content.textContent).toContain('Review API')
    expect(content.textContent).toContain('enabled in this session')
  })

  it('включение скилла вызывает PUT { name, enabled: true }', async () => {
    const container = await renderTab()
    const row = container.querySelector('[data-testid="session-skill-db-migration"]')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    mocks.updateSessionSkills.mockResolvedValue(skillsEffective({
      skills: [
        { name: 'api-review', description: 'Review API', level: 'system', scope: 'instance', trusted: true, available: true, enabled: true, disabled: false },
        { name: 'db-migration', description: 'Migrations', level: 'session', scope: 'project', trusted: true, available: false, unavailableReason: 'capabilities', enabled: true, disabled: false },
      ],
      enabled: ['api-review', 'db-migration'],
    }))

    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    expect(mocks.updateSessionSkills).toHaveBeenCalledWith('s1', { name: 'db-migration', enabled: true })
    const updated = container.querySelector('[data-testid="session-skill-db-migration"]')!
    expect((updated.querySelector('button[role="switch"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
  })

  it('отключение включённого скилла вызывает PUT { name, enabled: false }', async () => {
    const container = await renderTab()
    const row = container.querySelector('[data-testid="session-skill-api-review"]')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      toggle.click()
    })

    expect(mocks.updateSessionSkills).toHaveBeenCalledWith('s1', { name: 'api-review', enabled: false })
  })

  it('ошибка toggle показывает уведомление', async () => {
    mocks.updateSessionSkills.mockRejectedValue(new Error('boom'))
    const container = await renderTab()
    const row = container.querySelector('[data-testid="session-skill-db-migration"]')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    await act(async () => {})
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
  })
})
