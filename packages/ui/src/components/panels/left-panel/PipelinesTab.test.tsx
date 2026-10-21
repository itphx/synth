import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore/useAuthStore пишет в localStorage — в Node/vitest его нет.
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
  getProjects: vi.fn(),
  getProjectPipelines: vi.fn(),
  createProjectPipeline: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { PipelinesTab } from './PipelinesTab'
import { useAuthStore } from '@/stores/authStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore } from '@/stores/useUIStore'
import { usePipelinesStore } from '@/stores/pipelinesStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const OWNER_PROJECT = {
  id: 'p1',
  name: 'Proj1',
  owner_id: 'u1',
  members: {},
  description: '',
  current_task: '',
  invariants: '',
  icon: null,
  color: null,
  workspace: '/ws/p1',
  repos: [],
  status_messages: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

const VIEWER_PROJECT = {
  ...OWNER_PROJECT,
  id: 'p2',
  name: 'Proj2',
  owner_id: 'u-other',
  members: { 'u1': 'viewer' },
}

const PIPELINE = {
  id: 'pl1',
  name: 'Release',
  scope: 'project' as const,
  projectId: 'p1',
  draftVersion: 2,
  publishedVersion: 1,
  hasDraft: true,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T11:00:00.000Z',
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
        <PipelinesTab />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

/** Раскрыть проект в дереве (клик по стрелке узла). */
async function expandProject(container: HTMLElement, projectId: string): Promise<void> {
  const row = container.querySelector(`[data-tree-node="pipeline-project:${projectId}"]`) as HTMLElement
  expect(row, `узел проекта ${projectId}`).toBeTruthy()
  const arrow = row.querySelector('span') as HTMLElement
  await act(async () => {
    arrow.click()
  })
  await act(async () => {})
  await act(async () => {})
}

/** Кнопки записи (создание пайплайна) — по заголовку из i18n. */
function createButtons(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('button[title="Create pipeline"]'))
}

beforeEach(() => {
  mocks.getProjects.mockResolvedValue([OWNER_PROJECT])
  mocks.getProjectPipelines.mockResolvedValue([PIPELINE])
  mocks.createProjectPipeline.mockResolvedValue(PIPELINE)
  mocks.confirm.mockResolvedValue(true)

  useAuthStore.setState({
    user: { id: 'u1', username: 'u1', email: null, roles: ['USER'] },
  })
  useUIStore.setState({
    centerTabs: [],
    activeCenterTabId: null,
    onlyActiveProject: false,
    collapsedProjects: new Set(),
  })
  useProjectsStore.setState({ projects: [OWNER_PROJECT] as never, loading: false, error: null })
  usePipelinesStore.setState({
    pipelinesByProject: {},
    loadedProjects: new Set<string>(),
    loadingProjects: new Set<string>(),
    runsByPipeline: {},
    runDetail: {},
    runError: {},
    runSignal: {},
    error: null,
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

describe('PipelinesTab — дерево «проект → пайплайн» (ADR-101, Э7)', () => {
  it('в дереве видны проект и его пайплайны', async () => {
    const container = await renderTab()
    const text = container.textContent ?? ''

    expect(text).toContain('Proj1')
    // до раскрытия список пайплайнов не подгружен и не показан
    expect(container.querySelector('[data-tree-node="pipeline:p1:pl1"]')).toBeNull()

    await expandProject(container, 'p1')

    expect(mocks.getProjectPipelines).toHaveBeenCalledWith('p1')
    const node = container.querySelector('[data-tree-node="pipeline:p1:pl1"]') as HTMLElement
    expect(node).toBeTruthy()
    expect(node.textContent ?? '').toContain('Release')
    // подпись опубликованной версии
    expect(node.textContent ?? '').toContain('Published 1')
  })

  it('клик по пайплайну открывает вкладку «Пайплайн»', async () => {
    const container = await renderTab()
    await expandProject(container, 'p1')

    const node = container.querySelector('[data-tree-node="pipeline:p1:pl1"]') as HTMLElement
    await act(async () => {
      node.click()
    })

    const tabs = useUIStore.getState().centerTabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].type).toBe('pipeline')
    expect(tabs[0].data.projectId).toBe('p1')
    expect(tabs[0].data.pipelineId).toBe('pl1')
  })

  it('пустое состояние проекта — предложение создать пайплайн', async () => {
    mocks.getProjectPipelines.mockResolvedValue([])
    const container = await renderTab()

    await expandProject(container, 'p1')

    expect(container.textContent ?? '').toContain('No pipelines in this project')
    expect(createButtons(container).length).toBeGreaterThan(0)
  })
})

describe('PipelinesTab — права записи (VIEWER только читает)', () => {
  it('VIEWER не видит кнопок записи (создание)', async () => {
    useProjectsStore.setState({ projects: [VIEWER_PROJECT] as never, loading: false, error: null })
    mocks.getProjects.mockResolvedValue([VIEWER_PROJECT])
    mocks.getProjectPipelines.mockResolvedValue([])

    const container = await renderTab()
    expect(container.textContent ?? '').toContain('Proj2')

    // ни в действиях узла, ни в пустом состоянии кнопки создания нет
    expect(createButtons(container)).toHaveLength(0)

    await expandProject(container, 'p2')
    expect(createButtons(container)).toHaveLength(0)
    // пустое состояние проекта показано, но без действия создания
    expect(container.textContent ?? '').toContain('No pipelines in this project')
  })

  it('VIEWER видит пайплайны проекта (чтение доступно)', async () => {
    useProjectsStore.setState({ projects: [VIEWER_PROJECT] as never, loading: false, error: null })
    mocks.getProjects.mockResolvedValue([VIEWER_PROJECT])
    mocks.getProjectPipelines.mockResolvedValue([{ ...PIPELINE, projectId: 'p2' }])

    const container = await renderTab()
    await expandProject(container, 'p2')

    expect(container.querySelector('[data-tree-node="pipeline:p2:pl1"]')).toBeTruthy()
  })

  it('владелец проекта видит кнопку создания', async () => {
    const container = await renderTab()

    expect(createButtons(container).length).toBeGreaterThan(0)
  })

  it('ADMIN (глобальная роль) может писать в чужой проект', async () => {
    useAuthStore.setState({
      user: { id: 'admin', username: 'admin', email: null, roles: ['ADMIN'] },
    })
    useProjectsStore.setState({ projects: [VIEWER_PROJECT] as never, loading: false, error: null })
    mocks.getProjects.mockResolvedValue([VIEWER_PROJECT])

    const container = await renderTab()

    expect(createButtons(container).length).toBeGreaterThan(0)
  })
})
