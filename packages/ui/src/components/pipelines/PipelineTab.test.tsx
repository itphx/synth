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

  // Редактор пайплайна (React Flow) в jsdom: нужен ResizeObserver (замер
  // узлов), getBBox (подпись ребра), DOMMatrixReadOnly (трансформация
  // viewport) и ненулевые offsetWidth/offsetHeight (размеры узлов).
  class ResizeObserverStub {
    private callback: (entries: unknown[], observer: unknown) => void
    constructor(callback: (entries: unknown[], observer: unknown) => void) {
      this.callback = callback
    }
    observe(target: Element): void {
      queueMicrotask(() => {
        this.callback(
          [
            {
              target,
              contentRect: { width: 240, height: 76, top: 0, left: 0, right: 240, bottom: 76 },
            },
          ],
          this,
        )
      })
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
    Object.defineProperty(window.SVGElement.prototype, 'getBBox', {
      value: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      configurable: true,
    })
    class DOMMatrixReadOnlyStub {
      m22 = 1
      constructor() {}
    }
    Object.defineProperty(window, 'DOMMatrixReadOnly', {
      value: DOMMatrixReadOnlyStub,
      configurable: true,
    })
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 240,
    })
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 76,
    })
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

/** Вторая вкладка пайплайна — другой пайплайн того же проекта (переключение вкладок). */
const TAB2: CenterTab = {
  id: 'pipeline-p1-pl2',
  type: 'pipeline',
  title: 'Deploy',
  data: { projectId: 'p1', pipelineId: 'pl2' },
}

/** Деталь второго пайплайна (ничего общего с первым — чтобы «залипание» было видно). */
const DETAIL2 = {
  pipeline: {
    ...DETAIL.pipeline,
    id: 'pl2',
    name: 'Deploy',
    description: 'Deploy pipeline',
    draft: { ...SPEC, id: 'pl2', name: 'Deploy' },
  },
  published: {
    ...DETAIL.published,
    pipelineId: 'pl2',
    spec: { ...SPEC, id: 'pl2', name: 'Deploy', version: 1, status: 'published' as const },
  },
  versions: [],
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
  const { container } = await mountTab(TAB)
  return container
}

/**
 * Монтирует вкладку и даёт возможность перерендерить её с другим `tab` —
 * так проверяется переключение вкладок (смена `projectId`/`pipelineId`).
 */
async function mountTab(initial: CenterTab): Promise<{
  container: HTMLElement
  setTab: (tab: CenterTab) => Promise<void>
}> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  const setTab = async (tab: CenterTab) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <PipelineTab tab={tab} />
        </I18nProvider>,
      )
    })
    await act(async () => {})
    await act(async () => {})
  }
  await setTab(initial)
  return { container, setTab }
}

const action = (container: HTMLElement, name: string): HTMLElement | null =>
  container.querySelector(`[data-action="${name}"]`)

/** Ввод текста в textarea (контролируемый React-инпут — через нативный сеттер). */
async function setTextareaValue(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

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
    // Переключатель режима правки (канвас ↔ JSON) тоже скрыт.
    expect(action(container, 'view-json')).toBeNull()
    expect(action(container, 'view-visual')).toBeNull()
  })
})

describe('PipelineTab — переключение вкладок (нет stale-состояния)', () => {
  it('до ответа по новому пайплайну содержимое прошлого не показывается', async () => {
    const { container, setTab } = await mountTab(TAB)
    expect(container.textContent ?? '').toContain('Release')

    // Ответ по второму пайплайну отложен — «залипания» быть не должно.
    let resolveSecond: ((value: unknown) => void) | null = null
    mocks.getProjectPipeline.mockImplementation((_projectId: string, pipelineId: string) => {
      if (pipelineId === 'pl2') {
        return new Promise((resolve) => {
          resolveSecond = resolve
        })
      }
      return Promise.resolve(DETAIL)
    })

    await setTab(TAB2)

    const loading = container.textContent ?? ''
    expect(loading).not.toContain('Release')
    expect(loading).toContain('Loading')

    await act(async () => {
      resolveSecond?.(DETAIL2)
    })
    await act(async () => {})

    const loaded = container.textContent ?? ''
    expect(loaded).toContain('Deploy')
    expect(loaded).not.toContain('Release')
  })

  it('при 404 по новому пайплайну показывается ошибка, а не содержимое прошлого', async () => {
    const { container, setTab } = await mountTab(TAB)
    expect(container.textContent ?? '').toContain('Release')

    mocks.getProjectPipeline.mockRejectedValue(new Error('HTTP 404: pipeline not found'))
    await setTab(TAB2)

    const text = container.textContent ?? ''
    expect(text).not.toContain('Release')
    expect(text).toContain('HTTP 404')
  })

  it('после успешной перезагрузки показывается содержимое текущего пайплайна', async () => {
    const { container, setTab } = await mountTab(TAB)

    mocks.getProjectPipeline.mockImplementation((_projectId: string, pipelineId: string) =>
      Promise.resolve(pipelineId === 'pl2' ? DETAIL2 : DETAIL),
    )
    await setTab(TAB2)

    const text = container.textContent ?? ''
    expect(text).toContain('Deploy')
    expect(text).not.toContain('Release')
  })

  it('после ошибки кнопка «Обновить» перечитывает пайплайн', async () => {
    const { container, setTab } = await mountTab(TAB)

    mocks.getProjectPipeline.mockRejectedValueOnce(new Error('HTTP 404: pipeline not found'))
    await setTab(TAB2)
    expect(container.textContent ?? '').toContain('HTTP 404')

    mocks.getProjectPipeline.mockResolvedValue(DETAIL2)
    const refresh = container.querySelector('button') as HTMLButtonElement
    await act(async () => {
      refresh.click()
    })
    await act(async () => {})
    await act(async () => {})

    const text = container.textContent ?? ''
    expect(text).toContain('Deploy')
    expect(text).not.toContain('HTTP 404')
  })

  it('без pipelineId показывается «не найдено», а не вечная загрузка', async () => {
    const { container } = await mountTab({
      id: 'pipeline-p1-empty',
      type: 'pipeline',
      title: '—',
      data: { projectId: 'p1' },
    })

    const text = container.textContent ?? ''
    expect(text).not.toContain('Loading')
    expect(text).toContain('Pipeline not found')
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

  it('JSON-режим: очищенный `id` (серверное поле) не блокирует сохранение', async () => {
    const container = await renderTab()

    // Переключение на JSON-режим правки черновика.
    await act(async () => {
      ;(action(container, 'view-json') as HTMLButtonElement).click()
    })
    await act(async () => {})

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea, 'поле JSON-режима').toBeTruthy()
    const spec = JSON.parse(textarea.value)
    delete spec.id
    await setTextareaValue(textarea, JSON.stringify(spec, null, 2))

    await act(async () => {
      ;(action(container, 'save-draft') as HTMLButtonElement).click()
    })
    await act(async () => {})
    await act(async () => {})

    // UI не добавляет собственных требований к серверным полям — запрос уходит.
    expect(mocks.updateProjectPipeline).toHaveBeenCalledTimes(1)
    const body = mocks.updateProjectPipeline.mock.calls[0][2] as { spec: Record<string, unknown> }
    expect(body.spec).not.toHaveProperty('id')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['pipelines.draftSaved'], type: 'success' }),
    )
  })

  it('JSON-режим: невалидная спецификация на сервер не уходит', async () => {
    const container = await renderTab()

    await act(async () => {
      ;(action(container, 'view-json') as HTMLButtonElement).click()
    })
    await act(async () => {})

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const spec = JSON.parse(textarea.value)
    spec.nodes = []
    await setTextareaValue(textarea, JSON.stringify(spec, null, 2))

    await act(async () => {
      ;(action(container, 'save-draft') as HTMLButtonElement).click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.updateProjectPipeline).not.toHaveBeenCalled()
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['pipelines.saveBlocked'], type: 'error' }),
    )
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
