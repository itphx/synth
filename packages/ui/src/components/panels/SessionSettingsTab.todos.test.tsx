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
  getProject: vi.fn(),
  listWorktrees: vi.fn(),
  bindWorktree: vi.fn(),
  createSessionTodo: vi.fn(),
  updateSessionTodo: vi.fn(),
  deleteSessionTodo: vi.fn(),
  clearSessionTodos: vi.fn(),
  notify: vi.fn(),
  workModalProps: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn().mockResolvedValue(true) }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('../chat/ModelSelector', () => ({
  ModelSelector: () => React.createElement('div', { 'data-testid': 'model-selector' }),
}))
vi.mock('@/components/ui/popover', async () => {
  const ReactMod = await import('react')
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children)
  return { Popover: Passthrough, PopoverTrigger: Passthrough, PopoverContent: Passthrough }
})
vi.mock('./work/WorkModal', () => ({
  WorkModal: (props: Record<string, unknown>) => {
    mocks.workModalProps.push(props)
    return (
      <div
        data-testid="work-modal-mock"
        data-open={String(props.open)}
        data-tab={String(props.initialTab)}
        data-can-edit-todos={String(props.canEditTodos)}
      />
    )
  },
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SessionSettingsTab } from './SessionSettingsTab'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'
import { useEntityEditStore } from '@/stores/entityEditStore'
import { useWorktreesStore } from '@/stores/worktreesStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT = {
  id: 'p1',
  name: 'P',
  owner_id: 'u1',
  members: { u1: 'owner' },
  plan: {
    version: 1,
    updatedAt: '2026-11-01T00:00:00.000Z',
    columns: [{ id: 'c1', name: 'Backlog', order: 0 }],
    items: [
      {
        id: 'pi1',
        title: 'Пункт плана',
        columnId: 'c1',
        priority: 'high' as const,
        order: 0,
        dependsOn: [],
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  },
}

const TODOS = [
  { id: 't1', content: 'Первая задача', status: 'pending' as const, priority: 'high' as const },
  { id: 't2', content: 'В работе', status: 'in_progress' as const, priority: 'medium' as const },
  { id: 't3', content: 'Готово', status: 'completed' as const, priority: 'low' as const },
  { id: 't4', content: 'Связана с планом', status: 'pending' as const, priority: 'low' as const, planItemId: 'pi1' },
]

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

const clickEl = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

const setTextAreaValue = async (el: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
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
  mocks.getSessionSkills.mockResolvedValue({ session_id: 's1', skills: [], enabled: [], disabled: [] })
  mocks.updateSessionSkills.mockResolvedValue({ session_id: 's1', skills: [], enabled: [], disabled: [] })
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
  mocks.listWorktrees.mockResolvedValue([])
  mocks.bindWorktree.mockResolvedValue({ id: 's1', name: 'S', project_id: 'p1', settings: {} })
  mocks.createSessionTodo.mockResolvedValue({ todos: TODOS })
  mocks.updateSessionTodo.mockResolvedValue({ todos: TODOS })
  mocks.deleteSessionTodo.mockResolvedValue({ todos: TODOS })
  mocks.clearSessionTodos.mockResolvedValue({ todos: [] })

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
        owner_id: 'u1',
        settings: { model: 'm' },
        todos: TODOS,
      },
    ],
  } as never)
  useProjectsStore.setState({ projects: [PROJECT] as never })
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] }, deployment: null } as never)
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
  mocks.workModalProps.length = 0
})

describe('SessionSettingsTab — ToDo (PROP-054)', () => {
  it('пункты сгруппированы по статусам, у групп счётчики', async () => {
    const container = await renderTab()

    const pending = container.querySelector('[data-testid="session-todos-group-pending"]')!
    expect(pending.querySelector('[data-testid="session-todos-group-pending-count"]')!.textContent).toBe('(2)')
    const inProgress = container.querySelector('[data-testid="session-todos-group-in_progress"]')!
    expect(inProgress.querySelector('[data-testid="session-todos-group-in_progress-count"]')!.textContent).toBe('(1)')
  })

  it('выполненные свёрнуты по умолчанию', async () => {
    const container = await renderTab()

    const completed = container.querySelector('[data-testid="session-todos-group-completed"]')!
    expect(completed.getAttribute('data-collapsed')).toBe('true')
    expect(container.querySelector('[data-testid="session-todos-item-t3"]')).toBeNull()
  })

  it('связь planItemId показывается названием пункта плана', async () => {
    const container = await renderTab()

    const link = container.querySelector('[data-testid="session-todos-item-t4-plan"]')!
    expect(link).toBeTruthy()
    expect(link.textContent).toContain('Пункт плана')
  })

  it('переход по связи открывает модальное окно с доской проекта', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="session-todos-item-t4-plan"]'))

    const last = mocks.workModalProps[mocks.workModalProps.length - 1]
    expect(last.open).toBe(true)
    expect(last.initialTab).toBe('board')
  })

  it('«+ пункт» создаёт пункт ToDo', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="session-todos-add"]'))
    const textarea = container.querySelector('[data-testid="session-todos-add-textarea"]') as HTMLTextAreaElement
    expect(textarea).toBeTruthy()
    await setTextAreaValue(textarea, 'Новая задача')
    await clickEl(container.querySelector('[data-testid="session-todos-add-submit"]'))

    expect(mocks.createSessionTodo).toHaveBeenCalledWith('s1', {
      content: 'Новая задача',
      status: 'pending',
    })
  })

  it('«очистить выполненные» вызывает clearSessionTodos', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="session-todos-clear"]'))

    expect(mocks.clearSessionTodos).toHaveBeenCalledWith('s1', { statuses: ['completed', 'cancelled'] })
  })

  it('удаление пункта вызывает deleteSessionTodo', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="session-todos-item-t1-delete"]'))

    expect(mocks.deleteSessionTodo).toHaveBeenCalledWith('s1', 't1')
  })

  it('inline-правка текста вызывает updateSessionTodo', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="session-todos-item-t1-edit"]'))
    const textarea = container.querySelector('[data-testid="session-todos-item-t1-textarea"]') as HTMLTextAreaElement
    expect(textarea).toBeTruthy()
    await setTextAreaValue(textarea, 'Изменённая задача')
    await clickEl(container.querySelector('[data-testid="session-todos-item-t1-submit"]'))

    expect(mocks.updateSessionTodo).toHaveBeenCalledWith('s1', 't1', { content: 'Изменённая задача' })
  })

  it('чужой пользователь (VIEWER в проекте) не видит кнопок правки', async () => {
    useAuthStore.setState({
      user: { id: 'u2', username: 'viewer', roles: [] },
      deployment: null,
    } as never)
    useProjectsStore.setState({
      projects: [{ ...PROJECT, members: { u1: 'owner', u2: 'viewer' } }],
    } as never)

    const container = await renderTab()

    expect(container.querySelector('[data-testid="session-todos-add"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-todos-item-t1-delete"]')).toBeNull()
    const last = mocks.workModalProps[mocks.workModalProps.length - 1]
    expect(last.canEditTodos).toBe(false)
  })

  it('участник проекта с ролью EDITOR может править ToDo', async () => {
    useAuthStore.setState({
      user: { id: 'u2', username: 'editor', roles: [] },
      deployment: null,
    } as never)
    useProjectsStore.setState({
      projects: [{ ...PROJECT, members: { u1: 'owner', u2: 'editor' } }],
    } as never)

    const container = await renderTab()

    expect(container.querySelector('[data-testid="session-todos-add"]')).not.toBeNull()
  })

  it('ADMIN может править ToDo независимо от проекта', async () => {
    useAuthStore.setState({
      user: { id: 'u3', username: 'admin', roles: ['ADMIN'] },
      deployment: null,
    } as never)

    const container = await renderTab()

    expect(container.querySelector('[data-testid="session-todos-add"]')).not.toBeNull()
  })

  it('пустой список ToDo показывает пустое состояние', async () => {
    useSessionsStore.setState({
      sessions: [
        { id: 's1', name: 'S', project_id: 'p1', owner_id: 'u1', settings: { model: 'm' }, todos: [] },
      ],
    } as never)

    const container = await renderTab()

    expect(container.textContent).toContain(enDict['sessionTab.todos.empty'])
  })
})
