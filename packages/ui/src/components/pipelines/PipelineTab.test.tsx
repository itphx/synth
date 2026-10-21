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
  getProjectPipeline: vi.fn(),
  getProjectPipelines: vi.fn(),
  updateProjectPipeline: vi.fn(),
  publishProjectPipeline: vi.fn(),
  startPipelineRun: vi.fn(),
  deleteProjectPipeline: vi.fn(),
  listPipelineRuns: vi.fn(),
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
import { PipelineTab } from './PipelineTab'
import { useAuthStore } from '@/stores/authStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { usePipelinesStore } from '@/stores/pipelinesStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const TAB: CenterTab = {
  id: 'pipeline-p1-pl1',
  type: 'pipeline',
  title: 'Release',
  data: { projectId: 'p1', pipelineId: 'pl1' },
}

const PROJECT = {
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
  ...PROJECT,
  owner_id: 'u-other',
  members: { u1: 'viewer' },
}

const SPEC = {
  id: 'pl1',
  name: 'Release',
  version: 2,
  status: 'draft' as const,
  mode: 'plan' as const,
  nodes: [{ id: 'step-1', kind: 'agent' as const, title: 'Draft', agent: 'assistant' }],
  exits: [{ kind: 'none' as const }],
}

const DETAIL = {
  pipeline: {
    id: 'pl1',
    name: 'Release',
    description: 'Release pipeline',
    scope: 'project' as const,
    projectId: 'p1',
    draftVersion: 2,
    publishedVersion: 1,
    hasDraft: true,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T11:00:00.000Z',
    draft: SPEC,
  },
  published: {
    pipelineId: 'pl1',
    version: 1,
    spec: { ...SPEC, version: 1, status: 'published' as const },
    publishedAt: '2026-10-20T10:00:00.000Z',
  },
  versions: [
    {
      pipelineId: 'pl1',
      version: 1,
      spec: { ...SPEC, version: 1, status: 'published' as const },
      publishedAt: '2026-10-20T10:00:00.000Z',
    },
  ],
}

const RUN_DONE = {
  id: 'run1',
  pipelineId: 'pl1',
  version: 1,
  status: 'done' as const,
  currentNode: 'step-1',
  startedAt: '2026-10-20T12:00:00.000Z',
}

const RUN_WAITING = {
  id: 'run2',
  pipelineId: 'pl1',
  version: 2,
  status: 'awaiting_human' as const,
  currentNode: 'gate',
  startedAt: '2026-10-20T13:00:00.000Z',
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
        <PipelineTab tab={TAB} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

const action = (container: HTMLElement, name: string): HTMLElement | null =>
  container.querySelector(`[data-action="${name}"]`)

beforeEach(() => {
  mocks.getProjectPipeline.mockResolvedValue(DETAIL)
  mocks.getProjectPipelines.mockResolvedValue([DETAIL.pipeline])
  mocks.updateProjectPipeline.mockResolvedValue(DETAIL.pipeline)
  mocks.publishProjectPipeline.mockResolvedValue({ pipeline: DETAIL.pipeline, published: DETAIL.published })
  mocks.startPipelineRun.mockResolvedValue({ id: 'run9', pipelineId: 'pl1', version: 1, status: 'pending' })
  mocks.deleteProjectPipeline.mockResolvedValue(undefined)
  mocks.listPipelineRuns.mockResolvedValue([RUN_DONE, RUN_WAITING])
  mocks.confirm.mockResolvedValue(true)

  useAuthStore.setState({
    user: { id: 'u1', username: 'u1', email: null, roles: ['USER'] },
  })
  useUIStore.setState({ centerTabs: [TAB], activeCenterTabId: TAB.id })
  useProjectsStore.setState({ projects: [PROJECT] as never, loading: false, error: null })
  usePipelinesStore.setState({
    pipelinesByProject: {},
    loadedProjects: new Set<string>(),
    loadingProjects: new Set<string>(),
    runsByPipeline: {},
    runDetail: {},
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

describe('PipelineTab — права на действия (ADR-101, Э7)', () => {
  it('владелец проекта видит действия записи', async () => {
    const container = await renderTab()

    expect(action(container, 'save-draft')).toBeTruthy()
    expect(action(container, 'publish')).toBeTruthy()
    expect(action(container, 'start-run')).toBeTruthy()
    expect(action(container, 'delete')).toBeTruthy()
  })

  it('VIEWER не видит ни одного действия записи', async () => {
    useProjectsStore.setState({ projects: [VIEWER_PROJECT] as never, loading: false, error: null })

    const container = await renderTab()

    expect(container.textContent ?? '').toContain('Release')
    expect(action(container, 'save-draft')).toBeNull()
    expect(action(container, 'publish')).toBeNull()
    expect(action(container, 'start-run')).toBeNull()
    expect(action(container, 'delete')).toBeNull()
    // режим правки JSON тоже скрыт
    expect(container.textContent ?? '').not.toContain('JSON')
  })
})

describe('PipelineTab — список прогонов и фильтр по статусу', () => {
  it('прогоны выводятся списком со статусом и версией', async () => {
    usePipelinesStore.setState({ runsByPipeline: { pl1: [RUN_DONE, RUN_WAITING] } })
    const container = await renderTab()
    const text = container.textContent ?? ''

    expect(text).toContain('done')
    expect(text).toContain('awaiting_human')
    expect(text).toContain('Version 1')
    expect(text).toContain('Version 2')
    expect(text).toContain('step-1')
    expect(text).toContain('gate')
  })

  it('без прогонов — пустое состояние', async () => {
    mocks.listPipelineRuns.mockResolvedValue([])
    usePipelinesStore.setState({ runsByPipeline: { pl1: [] } })
    const container = await renderTab()

    expect(container.textContent ?? '').toContain('No runs yet')
  })

  it('смена фильтра статуса перезапрашивает прогоны с фильтром', async () => {
    const container = await renderTab()
    expect(mocks.listPipelineRuns).toHaveBeenCalledWith('p1', 'pl1', undefined)

    const select = container.querySelector('select') as HTMLSelectElement
    expect(select).toBeTruthy()

    await act(async () => {
      select.value = 'awaiting_human'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.listPipelineRuns).toHaveBeenCalledWith('p1', 'pl1', { status: 'awaiting_human' })
  })
})

describe('PipelineTab — действия', () => {
  it('публикация: тост «Version published» (ключ pipelines.publishDone)', async () => {
    const container = await renderTab()

    const publish = action(container, 'publish') as HTMLButtonElement
    await act(async () => {
      publish.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.publishProjectPipeline).toHaveBeenCalledWith('p1', 'pl1')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Version published', type: 'success' }),
    )
  })

  it('запуск прогона открывает вкладку прогона', async () => {
    const container = await renderTab()

    const start = action(container, 'start-run') as HTMLButtonElement
    await act(async () => {
      start.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.startPipelineRun).toHaveBeenCalledWith('p1', 'pl1', { trigger: { kind: 'manual' } })
    const tabs = useUIStore.getState().centerTabs
    expect(tabs.some((t) => t.type === 'pipeline-run' && t.data.runId === 'run9')).toBe(true)
  })

  it('сохранение черновика уходит в PUT с текущей спецификацией', async () => {
    const container = await renderTab()

    const save = action(container, 'save-draft') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.updateProjectPipeline).toHaveBeenCalledWith('p1', 'pl1', {
      name: 'Release',
      description: 'Release pipeline',
      spec: SPEC,
    })
  })

  it('удаление — после подтверждения закрывает вкладку', async () => {
    const container = await renderTab()

    const del = action(container, 'delete') as HTMLButtonElement
    await act(async () => {
      del.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.deleteProjectPipeline).toHaveBeenCalledWith('p1', 'pl1')
    expect(useUIStore.getState().centerTabs.some((t) => t.id === TAB.id)).toBe(false)
  })
})
