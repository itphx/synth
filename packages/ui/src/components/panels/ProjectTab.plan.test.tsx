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
  getProject: vi.fn(),
  getProjectMcp: vi.fn(),
  updateProjectMcp: vi.fn(),
  getMcpRegistry: vi.fn(),
  getProjectSkills: vi.fn(),
  updateProjectSkills: vi.fn(),
  updateProject: vi.fn(),
  getWorkspaceRoot: vi.fn(),
  getProjectLogPage: vi.fn(),
  createProjectPlanItem: vi.fn(),
  deleteProjectPlanItem: vi.fn(),
  createProjectPlanColumn: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
  /** Последние пропы модального рабочего окна (мок компонента). */
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
// Модальное рабочее окно проверяется отдельно (WorkModal.test.tsx) — здесь
// интересует только факт открытия и вкладка.
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

function makeItem(id: string, columnId: string, order: number, title = `Пункт ${id}`) {
  return {
    id,
    title,
    columnId,
    priority: 'medium' as const,
    order,
    dependsOn: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
}

const PLAN = {
  version: 3,
  updatedAt: '2026-11-01T00:00:00.000Z',
  columns: [
    { id: 'c1', name: 'Backlog', order: 0 },
    { id: 'c2', name: 'Doing', order: 1, wipLimit: 3 },
  ],
  items: [
    makeItem('i1', 'c1', 0),
    makeItem('i2', 'c1', 1),
    makeItem('i3', 'c1', 2),
    makeItem('i4', 'c1', 3),
    makeItem('i5', 'c1', 4),
    makeItem('i6', 'c1', 5),
    makeItem('i7', 'c1', 6),
    makeItem('d1', 'c2', 0, 'В работе'),
  ],
}

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
  plan: PLAN,
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

const setInputValue = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
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
  mocks.createProjectPlanItem.mockResolvedValue({ plan: PLAN })
  mocks.deleteProjectPlanItem.mockResolvedValue({ plan: PLAN })
  mocks.createProjectPlanColumn.mockResolvedValue({ plan: PLAN })
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

describe('ProjectTab — компактный план (PROP-054)', () => {
  it('план рисуется группами по колонкам со счётчиками', async () => {
    const container = await renderTab()

    const backlog = container.querySelector('[data-testid="plan-summary-group-c1"]')!
    expect(backlog).toBeTruthy()
    expect(backlog.querySelector('[data-testid="plan-summary-group-c1-title"]')!.textContent).toBe('Backlog')
    expect(backlog.querySelector('[data-testid="plan-summary-group-c1-count"]')!.textContent).toBe('(7)')

    const doing = container.querySelector('[data-testid="plan-summary-group-c2"]')!
    expect(doing.querySelector('[data-testid="plan-summary-group-c2-count"]')!.textContent).toBe('(1)')
  })

  it('сводка показывает число пунктов и пунктов «в работе»', async () => {
    const container = await renderTab()
    const summary = container.querySelector('[data-testid="plan-summary-summary"]')!.textContent!
    expect(summary).toContain('8')
    expect(summary).toContain('1')
  })

  it('WIP-индикатор колонки показывается как current/limit', async () => {
    const container = await renderTab()
    const wip = container.querySelector('[data-testid="plan-summary-group-c2-wip"]')!
    expect(wip.textContent).toBe('1/3')
    // У колонки без WIP-лимита индикатора нет.
    expect(container.querySelector('[data-testid="plan-summary-group-c1-wip"]')).toBeNull()
  })

  it('показываются первые 5 пунктов, остальные — по кнопке «показать ещё»', async () => {
    const container = await renderTab()

    expect(container.querySelector('[data-testid="plan-summary-item-i5"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="plan-summary-item-i6"]')).toBeNull()

    const more = container.querySelector('[data-testid="plan-summary-group-c1-more"]')!
    expect(more.textContent).toContain('2')
    await clickEl(more)

    expect(container.querySelector('[data-testid="plan-summary-item-i6"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="plan-summary-item-i7"]')).not.toBeNull()
  })

  it('фиксированного max-h-48 в панели плана нет', async () => {
    const container = await renderTab()
    expect(container.innerHTML).not.toContain('max-h-48')
  })

  it('пустой план: состояние «плана нет» и кнопка создания', async () => {
    mocks.getProject.mockResolvedValue({ ...PROJECT, plan: null })
    useProjectsStore.setState({ projects: [{ ...PROJECT, plan: null }] as never })

    const container = await renderTab()
    expect(container.textContent).toContain(enDict['sessionTab.plan.empty'])

    const create = container.querySelector('[data-testid="plan-summary-create"]')!
    expect(create).toBeTruthy()
    await clickEl(create)
    expect(mocks.createProjectPlanColumn).toHaveBeenCalled()
  })

  it('«+ пункт» создаёт пункт в колонке', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="plan-summary-group-c1-add"]'))
    const input = container.querySelector('[data-testid="plan-summary-add-input"]') as HTMLInputElement
    expect(input).toBeTruthy()
    await setInputValue(input, 'Новый пункт')
    await clickEl(container.querySelector('[data-testid="plan-summary-add-submit"]'))

    expect(mocks.createProjectPlanItem).toHaveBeenCalledWith('p1', {
      title: 'Новый пункт',
      columnId: 'c1',
    })
  })

  it('кнопка «Доска» открывает модальное окно на вкладке доски', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="plan-summary-board"]'))

    const last = mocks.workModalProps[mocks.workModalProps.length - 1]
    expect(last.open).toBe(true)
    expect(last.initialTab).toBe('board')
    expect(last.projectId).toBe('p1')
  })

  it('VIEWER не видит кнопок правки плана', async () => {
    useAuthStore.setState({
      user: { id: 'u2', username: 'viewer', roles: [] },
      deployment: null,
    } as never)
    mocks.getProject.mockResolvedValue({ ...PROJECT, members: { u1: 'owner', u2: 'viewer' } })
  useProjectsStore.setState({ projects: [{ ...PROJECT, members: { u1: 'owner', u2: 'viewer' } }] as never })

    const container = await renderTab()

    expect(container.querySelector('[data-testid="plan-summary-group-c1-add"]')).toBeNull()
    expect(container.querySelector('[data-testid="plan-summary-item-i1-delete"]')).toBeNull()
    const last = mocks.workModalProps[mocks.workModalProps.length - 1]
    expect(last.canEdit).toBe(false)
  })

  it('удаление пункта плана — с подтверждением', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="plan-summary-item-i1-delete"]'))
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteProjectPlanItem).toHaveBeenCalledWith('p1', 'i1')
  })
})
