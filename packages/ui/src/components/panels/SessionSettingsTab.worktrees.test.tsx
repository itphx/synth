import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — мок для детерминизма.
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
  getProject: vi.fn(),
  listWorktrees: vi.fn(),
  bindWorktree: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('../chat/ModelSelector', () => ({
  ModelSelector: () => React.createElement('div', { 'data-testid': 'model-selector' }),
}))
// Пикер живёт в Popover: для теста логики сохранения раскрываем содержимое.
vi.mock('@/components/ui/popover', async () => {
  const ReactMod = await import('react')
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children)
  return { Popover: Passthrough, PopoverTrigger: Passthrough, PopoverContent: Passthrough }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SessionSettingsTab } from './SessionSettingsTab'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useEntityEditStore } from '@/stores/entityEditStore'
import { useWorktreesStore } from '@/stores/worktreesStore'
import type { WorktreeSummary } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT = { id: 'p1', name: 'P', owner_id: 'u1', members: { u1: 'owner' } }

function makeWorktree(id: string, overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    id,
    projectId: 'p1',
    directory: `/ws/.worktrees/p1/${id}`,
    branch: 'feature/x',
    name: id,
    strategy: 'git',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as WorktreeSummary
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
  await act(async () => {})
  return container
}

/** Сменить значение нативного select (native setter + change event). */
const selectValue = async (el: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})
}

beforeEach(() => {
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
  mocks.getSessionSkills.mockResolvedValue({
    session_id: 's1',
    skills: [],
    enabled: [],
    disabled: [],
  })
  mocks.updateSessionSkills.mockResolvedValue({
    session_id: 's1',
    skills: [],
    enabled: [],
    disabled: [],
  })
  mocks.getSecuritySettings.mockResolvedValue({ askTimeoutMs: 30_000 })
  mocks.updateSession.mockImplementation(async (_id: string, data: { settings: Record<string, unknown> }) => ({
    id: 's1',
    name: 'S',
    project_id: 'p1',
    settings: data.settings,
  }))
  mocks.getProviders.mockResolvedValue({ providers: [], default_provider: null })
  mocks.getModels.mockResolvedValue([])
  mocks.getToolsPolicyInfo.mockResolvedValue({ policy: 'auto', isOverridden: false, defaults: 'auto' })
  mocks.getMcpPolicyInfo.mockResolvedValue({ policy: 'consistency', isOverridden: false, defaults: 'consistency' })
  mocks.getProject.mockResolvedValue(PROJECT)
  mocks.listWorktrees.mockResolvedValue([
    makeWorktree('w1', { name: 'feature-x', branch: 'feature/x' }),
  ])
  mocks.bindWorktree.mockResolvedValue({
    id: 's1',
    name: 'S',
    project_id: 'p1',
    settings: {},
    worktree: {
      worktree_id: 'w1',
      project_id: 'p1',
      repo_path: null,
      directory: '/ws/.worktrees/p1/w1',
      branch: 'feature/x',
    },
  })

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [
      {
        id: 's1',
        name: 'S',
        project_id: 'p1',
        settings: { model: 'm' },
      },
    ],
  } as never)
  useProjectsStore.setState({ projects: [PROJECT] as never })
  useProvidersStore.setState({
    providers: [],
    models: [],
    selectedProviderName: null,
    selectedModelName: null,
  })
  useEntityEditStore.setState({ target: null })
  useWorktreesStore.setState({ byProject: {}, loadingByProject: {}, error: null })
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

describe('SessionSettingsTab — селектор рабочего каталога (ADR-114 §9)', () => {
  it('без проекта селектора нет — показан пустой блок', async () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', name: 'S', project_id: null, settings: { model: 'm' } }],
    } as never)

    const container = await renderTab()

    expect(container.querySelector('[data-testid="session-worktrees"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-worktrees-empty"]')).not.toBeNull()
  })

  it('селектор перечисляет worktree' + "'ы проекта и каталог проекта", async () => {
    const container = await renderTab()

    const select = container.querySelector('[data-testid="session-worktree-select"]') as HTMLSelectElement
    expect(select).toBeTruthy()
    const options = [...select.options].map((o) => o.textContent)
    expect(options[0]).toBe(enDict['worktrees.session.projectDir'])
    expect(options.some((o) => o?.includes('feature-x'))).toBe(true)
  })

  it('выбор worktree' + "'а привязывает сессию (bind с id)", async () => {
    const container = await renderTab()

    const select = container.querySelector('[data-testid="session-worktree-select"]') as HTMLSelectElement
    await selectValue(select, 'w1')

    expect(mocks.bindWorktree).toHaveBeenCalledWith('s1', 'w1')
  })

  it('выбор «каталога проекта» снимает привязку (bind с null)', async () => {
    const container = await renderTab()

    const select = container.querySelector('[data-testid="session-worktree-select"]') as HTMLSelectElement
    await selectValue(select, '')

    expect(mocks.bindWorktree).toHaveBeenCalledWith('s1', null)
  })

  it('у сессии без привязки выбран «каталог проекта»', async () => {
    const container = await renderTab()

    const select = container.querySelector('[data-testid="session-worktree-select"]') as HTMLSelectElement
    expect(select.value).toBe('')
  })

  it('инвентарь проекта без worktree' + "'ов — сообщение о пустоте", async () => {
    mocks.listWorktrees.mockResolvedValue([])

    const container = await renderTab()

    expect(container.querySelector('[data-testid="session-worktrees-empty"]')).not.toBeNull()
  })
})
