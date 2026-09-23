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

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT = {
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
  log: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

function projectSkills(overrides: Record<string, unknown> = {}) {
  return {
    project_id: 'p1',
    skills: [
      { name: 'api-review', description: 'Review API', level: 'project', scope: 'project', trusted: true, available: true, enabled: false, disabled: false },
    ],
    enabled: ['api-review'],
    defaultOn: [],
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
  mocks.getProject.mockResolvedValue(PROJECT)
  mocks.getProjectMcp.mockResolvedValue({ enabled: ['srvB'], defaultOn: [], knownServers: ['srvB'] })
  mocks.updateProjectMcp.mockResolvedValue({ enabled: ['srvB'], defaultOn: [], knownServers: ['srvB'] })
  mocks.getMcpRegistry.mockResolvedValue({ entries: [{ name: 'srvB', origin: 'user', trust: 'community', config: { type: 'http', url: 'http://y' } }] })
  mocks.getProjectSkills.mockResolvedValue(projectSkills())
  mocks.updateProjectSkills.mockResolvedValue(projectSkills({ defaultOn: ['api-review'] }))
  mocks.updateProject.mockResolvedValue(PROJECT)

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', engine: 'synth', settings: { model: 'm' } }],
  } as never)
  useProjectsStore.setState({ projects: [PROJECT] as never })
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] } as never })
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

describe('ProjectTab — проектный скоуп скиллов (AD-046 §4.5)', () => {
  it('owner видит два тумблера: «Доступен» и «Включён по умолчанию»', async () => {
    const container = await renderTab()
    const row = container.querySelector('[data-testid="project-skill-api-review"]')!
    const toggles = row.querySelectorAll('button[role="switch"]')
    expect(toggles).toHaveLength(2)
    expect((toggles[0] as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
    expect((toggles[1] as HTMLButtonElement).getAttribute('aria-checked')).toBe('false')
  })

  it('defaultOn → PUT /projects/:id/skills с enabled и defaultOn', async () => {
    const container = await renderTab()
    const row = container.querySelector('[data-testid="project-skill-api-review"]')!
    const defaultToggle = row.querySelectorAll('button[role="switch"]')[1] as HTMLButtonElement

    await act(async () => {
      defaultToggle.click()
    })
    await act(async () => {})

    expect(mocks.updateProjectSkills).toHaveBeenCalledWith('p1', {
      enabled: ['api-review'],
      defaultOn: ['api-review'],
    })
    const updated = container.querySelector('[data-testid="project-skill-api-review"]')!
    expect((updated.querySelectorAll('button[role="switch"]')[1] as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
  })

  it('снятие «Доступен» убирает скилл из enabled и defaultOn', async () => {
    mocks.getProjectSkills.mockResolvedValue(projectSkills({ enabled: ['api-review'], defaultOn: ['api-review'] }))
    const container = await renderTab()
    const row = container.querySelector('[data-testid="project-skill-api-review"]')!
    const availableToggle = row.querySelectorAll('button[role="switch"]')[0] as HTMLButtonElement
    expect(availableToggle.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      availableToggle.click()
    })

    expect(mocks.updateProjectSkills).toHaveBeenCalledWith('p1', { enabled: [], defaultOn: [] })
  })

  it('403 показывается аккуратным уведомлением', async () => {
    mocks.updateProjectSkills.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    const container = await renderTab()
    const row = container.querySelector('[data-testid="project-skill-api-review"]')!
    const defaultToggle = row.querySelectorAll('button[role="switch"]')[1] as HTMLButtonElement
    await act(async () => {
      defaultToggle.click()
    })
    await act(async () => {})

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Insufficient permissions'), type: 'error' }),
    )
  })

  it('не-менеджер не видит блок и не запрашивает скиллы', async () => {
    useAuthStore.setState({ user: { id: 'u2', username: 'viewer', roles: [] } as never })
    mocks.getProject.mockResolvedValue({ ...PROJECT, members: { u1: 'owner', u2: 'viewer' } })
    const container = await renderTab()
    expect(container.querySelector('[data-testid="project-skills-list"]')).toBeNull()
    expect(mocks.getProjectSkills).not.toHaveBeenCalled()
  })
})
