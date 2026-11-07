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
  getWorkspaceRoot: vi.fn(),
  getProjectLogPage: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
  workModalProps: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
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
      />
    )
  },
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProjectTab } from './ProjectTab'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'
import { useEntityEditStore } from '@/stores/entityEditStore'
import { useProjectLogStore } from '@/stores/projectLogStore'

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
  plan: null,
  created_at: '',
  updated_at: '',
}

function entry(id: string, text: string) {
  return {
    id,
    text,
    created_at: '2026-11-01T00:00:00.000Z',
    session_id: 's1',
    author: 'leader',
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

const clickEl = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

beforeEach(() => {
  mocks.getProject.mockResolvedValue(PROJECT)
  mocks.getProjectMcp.mockResolvedValue({ enabled: [], defaultOn: [], knownServers: [] })
  mocks.updateProjectMcp.mockResolvedValue({ enabled: [], defaultOn: [], knownServers: [] })
  mocks.getMcpRegistry.mockResolvedValue({ entries: [] })
  mocks.getProjectSkills.mockResolvedValue({ project_id: 'p1', skills: [], enabled: [], defaultOn: [] })
  mocks.updateProjectSkills.mockResolvedValue({ project_id: 'p1', skills: [], enabled: [], defaultOn: [] })
  mocks.updateProject.mockResolvedValue(PROJECT)
  mocks.getWorkspaceRoot.mockResolvedValue({ root: '/ws', entries: [] })
  mocks.getProjectLogPage.mockResolvedValue({
    entries: [entry('e1', 'Первая запись'), entry('e2', 'Вторая запись')],
    total: 2,
    offset: 0,
    limit: 50,
    next_offset: null,
  })
  mocks.confirm.mockResolvedValue(true)

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: { model: 'm' } }],
  } as never)
  useProjectsStore.setState({ projects: [PROJECT] as never })
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] }, deployment: null } as never)
  useEntityEditStore.setState({ target: null })
  useProjectLogStore.setState({ byProject: {} })
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

describe('ProjectTab — журнал проекта страницей (PROP-054)', () => {
  it('журнал читается страницей GET /projects/:id/log, а не из детали проекта', async () => {
    const container = await renderTab()

    expect(mocks.getProjectLogPage).toHaveBeenCalledWith('p1', { limit: 50, offset: 0 })
    expect(container.querySelector('[data-testid="project-journal"]')).not.toBeNull()
  })

  it('показываются записи страницы (автор + текст)', async () => {
    const container = await renderTab()

    const row = container.querySelector('[data-testid="project-journal-entry-e1"]')!
    expect(row).toBeTruthy()
    expect(row.textContent).toContain('leader')
    expect(row.textContent).toContain('Первая запись')
  })

  it('показываются не больше 5 последних записей', async () => {
    mocks.getProjectLogPage.mockResolvedValue({
      entries: Array.from({ length: 9 }, (_, i) => entry(`e${i + 1}`, `Запись ${i + 1}`)),
      total: 9,
      offset: 0,
      limit: 50,
      next_offset: null,
    })

    const container = await renderTab()

    expect(container.querySelector('[data-testid="project-journal-entry-e5"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="project-journal-entry-e6"]')).toBeNull()
  })

  it('кнопка «все записи» открывает модальное окно на вкладке журнала', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="project-journal-all"]'))

    const last = mocks.workModalProps[mocks.workModalProps.length - 1]
    expect(last.open).toBe(true)
    expect(last.initialTab).toBe('journal')
    expect(last.projectId).toBe('p1')
  })

  it('событие project.updated (kind=log) перечитывает страницу журнала', async () => {
    await renderTab()
    expect(mocks.getProjectLogPage).toHaveBeenCalledTimes(1)

    useProjectLogStore.getState().applyEvent('project.updated', { project_id: 'p1', kind: 'log' })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.getProjectLogPage).toHaveBeenCalledTimes(2)
  })

  it('пустой журнал показывает пустое состояние', async () => {
    mocks.getProjectLogPage.mockResolvedValue({
      entries: [],
      total: 0,
      offset: 0,
      limit: 50,
      next_offset: null,
    })

    const container = await renderTab()
    expect(container.textContent).toContain(enDict['work.journal.empty'])
  })
})
