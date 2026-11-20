import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

/**
 * Вкладка «Проект»: живое обновление проектных MCP- и skill-скоупов.
 *
 * Баг: «переключил MCP/скилл проекта в другой вкладке — панель показывает
 * старые тумблеры до перезагрузки страницы». Компонент держит скоупы в
 * локальном состоянии, поэтому событие шины (`mcp.updated`/`skills.updated` со
 * `scope: 'project'`, а также `project.updated`) обязано вызывать перечитывание
 * — но только для **своего** проекта.
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
  getProject: vi.fn(),
  getProjectMcp: vi.fn(),
  updateProjectMcp: vi.fn(),
  getMcpRegistry: vi.fn(),
  getProjectSkills: vi.fn(),
  updateProjectSkills: vi.fn(),
  updateProject: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProjectTab } from './ProjectTab'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'
import { useMcpStore } from '@/stores/mcpStore'
import { useSkillsStore } from '@/stores/skillsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'P',
    owner_id: 'u1',
    members: { u1: 'owner' },
    description: '',
    current_task: '',
    invariants: '',
    icon: null,
    color: null,
    workspace: null,
    repos: null,
    status_messages: [],
    plan: null,
    created_at: '',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function projectSkills() {
  return {
    project_id: 'p1',
    skills: [
      {
        name: 'api-review',
        description: 'Review API',
        level: 'project',
        scope: 'project',
        trusted: true,
        available: true,
        enabled: false,
        disabled: false,
      },
    ],
    enabled: ['api-review'],
    defaultOn: [],
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
        <ProjectTab />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProject.mockResolvedValue(project())
  mocks.getProjectMcp.mockResolvedValue({ enabled: ['srvB'], defaultOn: [], knownServers: ['srvB'] })
  mocks.updateProjectMcp.mockResolvedValue({ enabled: ['srvB'], defaultOn: [], knownServers: ['srvB'] })
  mocks.getMcpRegistry.mockResolvedValue({ entries: [{ name: 'srvB' }] })
  mocks.getProjectSkills.mockResolvedValue(projectSkills())
  mocks.updateProjectSkills.mockResolvedValue(projectSkills())
  mocks.updateProject.mockResolvedValue(project())

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: { model: 'm' } }],
  } as never)
  useProjectsStore.setState({ projects: [project()] as never })
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] } as never })
  // Сторы событий — в исходное состояние.
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

describe('ProjectTab — событие шины обновляет скоуп своего проекта', () => {
  it('skills.updated своего проекта перечитывает проектный скоуп скиллов', async () => {
    await renderTab()
    const before = mocks.getProjectSkills.mock.calls.length

    await act(async () => {
      useSkillsStore.getState().applyEvent({ action: 'scope', scope: 'project', projectId: 'p1' })
    })
    await act(async () => {})

    expect(mocks.getProjectSkills.mock.calls.length).toBe(before + 1)
  })

  it('skills.updated чужого проекта скоуп не перечитывает', async () => {
    await renderTab()
    const before = mocks.getProjectSkills.mock.calls.length

    await act(async () => {
      useSkillsStore.getState().applyEvent({ action: 'scope', scope: 'project', projectId: 'p2' })
    })
    await act(async () => {})

    expect(mocks.getProjectSkills.mock.calls.length).toBe(before)
  })

  it('mcp.updated своего проекта перечитывает MCP-скоуп и реестр', async () => {
    await renderTab()
    const mcpBefore = mocks.getProjectMcp.mock.calls.length

    await act(async () => {
      useMcpStore.getState().applyEvent({ scope: 'project', projectId: 'p1' })
    })
    await act(async () => {})

    expect(mocks.getProjectMcp.mock.calls.length).toBe(mcpBefore + 1)
  })

  it('mcp.updated чужого проекта MCP-скоуп не перечитывает', async () => {
    await renderTab()
    const mcpBefore = mocks.getProjectMcp.mock.calls.length

    await act(async () => {
      useMcpStore.getState().applyEvent({ scope: 'project', projectId: 'p2' })
    })
    await act(async () => {})

    expect(mocks.getProjectMcp.mock.calls.length).toBe(mcpBefore)
  })

  it('project.updated своего проекта (новый updated_at) перечитывает оба скоупа', async () => {
    await renderTab()
    const mcpBefore = mocks.getProjectMcp.mock.calls.length
    const skillsBefore = mocks.getProjectSkills.mock.calls.length

    // `transportStore` на `project.updated` перечитывает деталь проекта и кладёт
    // свежую запись в `projectsStore` — сервер двигает `updated_at` и при смене
    // скоупа. Здесь воспроизводим ровно этот эффект.
    await act(async () => {
      useProjectsStore.setState({ projects: [project({ updated_at: '2026-02-02T00:00:00.000Z' })] } as never)
    })
    await act(async () => {})

    expect(mocks.getProjectMcp.mock.calls.length).toBe(mcpBefore + 1)
    expect(mocks.getProjectSkills.mock.calls.length).toBe(skillsBefore + 1)
  })

  it('project.updated чужого проекта (чужой id) не трогает скоупы этой панели', async () => {
    await renderTab()
    const mcpBefore = mocks.getProjectMcp.mock.calls.length
    const skillsBefore = mocks.getProjectSkills.mock.calls.length

    await act(async () => {
      useProjectsStore.setState({
        projects: [
          project(),
          project({ id: 'p2', name: 'P2', updated_at: '2026-04-04T00:00:00.000Z' }),
        ],
      } as never)
    })
    await act(async () => {})

    expect(mocks.getProjectMcp.mock.calls.length).toBe(mcpBefore)
    expect(mocks.getProjectSkills.mock.calls.length).toBe(skillsBefore)
  })
})
