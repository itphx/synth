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
        data-can-edit={String(props.canEdit)}
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
    entries: [],
    total: 0,
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

describe('ProjectTab — инварианты (PROP-054)', () => {
  it('инварианты отрендерены как Markdown (не plain-текст)', async () => {
    const project = { ...PROJECT, invariants: '# Правило\n\n- не ломать API' }
    mocks.getProject.mockResolvedValue(project)
    useProjectsStore.setState({ projects: [project] as never })

    const container = await renderTab()

    const preview = container.querySelector('[data-testid="project-invariants-preview"]')!
    expect(preview).toBeTruthy()
    // Полный markdown-рендер: заголовок became <h1>, список — <ul>.
    expect(preview.querySelector('h1')?.textContent).toBe('Правило')
    expect(preview.querySelector('ul li')?.textContent).toBe('не ломать API')
  })

  it('секция инвариантов идёт сразу под планом', async () => {
    const container = await renderTab()
    const html = container.innerHTML
    const planIndex = html.indexOf(enDict['sessionTab.plan.title'])
    const invariantsIndex = html.indexOf(enDict['projectTab.invariants.title'])
    expect(planIndex).toBeGreaterThanOrEqual(0)
    expect(invariantsIndex).toBeGreaterThan(planIndex)
  })

  it('кнопка «Редактировать» открывает модальное окно на вкладке инвариантов', async () => {
    const project = { ...PROJECT, invariants: 'правило' }
    mocks.getProject.mockResolvedValue(project)
    useProjectsStore.setState({ projects: [project] as never })

    const container = await renderTab()
    await clickEl(container.querySelector('[data-testid="project-invariants-edit"]'))

    const last = mocks.workModalProps[mocks.workModalProps.length - 1]
    expect(last.open).toBe(true)
    expect(last.initialTab).toBe('invariants')
    expect(last.canEdit).toBe(true)
  })

  it('пустые инварианты: состояние «не заданы» и кнопка «Добавить»', async () => {
    const container = await renderTab()

    expect(container.textContent).toContain(enDict['work.invariants.empty'])
    const add = container.querySelector('[data-testid="project-invariants-edit"]')!
    expect(add.textContent).toBe(enDict['work.invariants.add'])
  })

  it('VIEWER не видит кнопки правки инвариантов', async () => {
    useAuthStore.setState({
      user: { id: 'u2', username: 'viewer', roles: [] },
      deployment: null,
    } as never)
    const project = { ...PROJECT, invariants: 'правило', members: { u1: 'owner', u2: 'viewer' } }
    mocks.getProject.mockResolvedValue(project)
    useProjectsStore.setState({ projects: [project] as never })

    const container = await renderTab()

    expect(container.querySelector('[data-testid="project-invariants-edit"]')).toBeNull()
    // Превью инвариантов VIEWER видит (это чтение).
    expect(container.querySelector('[data-testid="project-invariants-preview"]')).not.toBeNull()
  })
})
