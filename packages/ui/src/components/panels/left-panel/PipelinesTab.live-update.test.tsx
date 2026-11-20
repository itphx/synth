import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

/**
 * Вкладка «Пайплайны» (левая панель): живое обновление состава.
 *
 * Баг: «пайплайн создан/удалён из чата или в другом окне — раскрытый проект
 * показывает старый список пайплайнов до перезагрузки страницы». Событие шины
 * `pipeline.updated` (ADR-101 авторство × ADR-118, инвариант 27) инвалидирует
 * проект (`pipelinesStore.invalidateProject`), а панель обязана дочитать
 * **раскрытые** проекты — и только их: свёрнутый проект тянется при раскрытии.
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
  getProjectsPage: vi.fn(),
  getProjectPipelinesPage: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { PipelinesTab } from './PipelinesTab'
import { usePipelinesStore } from '@/stores/pipelinesStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'
import type { ProjectData, ProjectPipeline } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Проект (DTO UI — snake_case). */
function project(id: string, name: string): ProjectData {
  return {
    id,
    name,
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
  } as unknown as ProjectData
}

/** Сводка пайплайна проекта. */
function pipeline(id: string, name: string, projectId = 'p1'): ProjectPipeline {
  return {
    id,
    name,
    scope: 'project',
    projectId,
    draftVersion: 1,
    hasDraft: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T11:00:00.000Z',
  }
}

/** Страница пайплайнов проекта. */
function pipelinesPage(pipelines: ProjectPipeline[]) {
  return { pipelines, total: pipelines.length, offset: 0, limit: 100, next_offset: null }
}

/** Страница списка проектов (`GET /projects`). */
function projectsPage(projects: ProjectData[]) {
  return { projects, total: projects.length, offset: 0, limit: 100, next_offset: null }
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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProjectsPage.mockResolvedValue(projectsPage([project('p1', 'P1'), project('p2', 'P2')]))
  mocks.getProjectPipelinesPage.mockResolvedValue(
    pipelinesPage([pipeline('pl2', 'Пайплайн из чата')]),
  )

  useProjectsStore.setState({
    projects: [project('p1', 'P1'), project('p2', 'P2')],
    loading: false,
    error: null,
  } as never)
  useAuthStore.setState({
    user: { id: 'u1', username: 'owner', roles: [] } as never,
    deployment: 'standalone',
  } as never)
  // Текущий проект (`p1`) раскрыт панелью; `p2` — свёрнут.
  useUIStore.setState({ selectedProjectId: 'p1', onlyActiveProject: false } as never)

  usePipelinesStore.setState({
    pipelinesByProject: { p1: pipelinesPage([pipeline('pl1', 'Старый пайплайн')]) },
    loadedProjects: new Set<string>(['p1']),
    loadingProjects: new Set<string>(),
    loadingMoreProjects: new Set<string>(),
    runsByPipeline: {},
    runsFilterByPipeline: {},
    loadingMoreRuns: new Set<string>(),
    runDetail: {},
    runError: {},
    runSignal: {},
    loadingOlderEvents: new Set<string>(),
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

describe('PipelinesTab — живое обновление после `pipeline.updated`', () => {
  it('уже загруженный раскрытый проект при монтировании не перезапрашивается', async () => {
    const container = await renderTab()

    expect(mocks.getProjectPipelinesPage).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Старый пайплайн')
  })

  it('инвалидация раскрытого проекта — панель дочитывает его список', async () => {
    await renderTab()

    // Ровно то, что делает `invalidateProject`: проект выпадает из
    // `loadedProjects`, и панель обязана дочитать раскрытый проект сама.
    await act(async () => {
      usePipelinesStore.setState({ loadedProjects: new Set<string>() })
    })

    await vi.waitFor(() => {
      expect(mocks.getProjectPipelinesPage).toHaveBeenCalledWith('p1', { limit: 100 })
    })
    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledTimes(1)
  })

  it('`invalidateProject` раскрытого проекта — новый состав виден в дереве', async () => {
    const container = await renderTab()

    await act(async () => {
      usePipelinesStore.getState().invalidateProject('p1')
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Пайплайн из чата')
    })
    expect(container.textContent).not.toContain('Старый пайплайн')
    // Свёрнутый проект (`p2`) не тянется: он прочитается при раскрытии.
    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledTimes(1)
    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledWith('p1', { limit: 100 })
  })

  it('инвалидация свёрнутого (незагруженного) проекта запросов не даёт', async () => {
    await renderTab()

    await act(async () => {
      usePipelinesStore.getState().invalidateProject('p2')
    })
    await act(async () => {})

    expect(mocks.getProjectPipelinesPage).not.toHaveBeenCalled()
  })
})
