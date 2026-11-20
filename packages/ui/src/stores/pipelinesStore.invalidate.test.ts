/**
 * `pipelinesStore.invalidateProject` — реакция на событие шины
 * `pipeline.updated` (ADR-101 авторство × ADR-118, инвариант 27).
 *
 * Баг: «создал/удалил пайплайн из чата или в другом окне — вкладка
 * „Пайплайны“ показывает старый состав, пока не перезагрузишь страницу».
 * Событие приходит в каналы сессий проекта, поэтому инвалидируется **только**
 * затронутый проект: `projectId` убирается из `loadedProjects` (иначе guard в
 * `loadProjectPipelines` навсегда считал бы страницу актуальной), и открытый
 * список перечитывается с `force` — курсор `next_offset` сбрасывается.
 *
 * Незагруженный (не раскрытый) проект запросов не делает: когда его раскроют,
 * `loadProjectPipelines` прочитает свежее сам.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) захватывает localStorage при импорте useUIStore, а Node/vitest
// без --localstorage-file его не даёт — ставим заглушку до импорта стора.
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
  getProjectPipelinesPage: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { usePipelinesStore } from './pipelinesStore'
import type { ProjectPipeline } from '@/lib/api/synthApi'

/** Сводка пайплайна проекта (`GET /projects/:id/pipelines`). */
function pipeline(id: string): ProjectPipeline {
  return {
    id,
    name: id,
    scope: 'project',
    projectId: 'p1',
    draftVersion: 1,
    hasDraft: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T11:00:00.000Z',
  }
}

/** Страница пайплайнов проекта. */
function pipelinesPage(pipelines: ProjectPipeline[], nextOffset: number | null = null) {
  return { pipelines, total: pipelines.length, offset: 0, limit: 100, next_offset: nextOffset }
}

/** Загруженный проект в состоянии стора. */
function loadedState(projects: Record<string, ProjectPipeline[]>, loaded: string[]) {
  return {
    pipelinesByProject: Object.fromEntries(
      Object.entries(projects).map(([projectId, pipelines]) => [projectId, pipelinesPage(pipelines)]),
    ),
    loadedProjects: new Set<string>(loaded),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  usePipelinesStore.setState({
    pipelinesByProject: {},
    loadedProjects: new Set<string>(),
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

describe('pipelinesStore.invalidateProject — инвалидация одного проекта', () => {
  it('убирает только затронутый проект из `loadedProjects`', () => {
    usePipelinesStore.setState(loadedState({ p1: [pipeline('pl1')], p2: [pipeline('pl2')] }, ['p1', 'p2']))
    mocks.getProjectPipelinesPage.mockResolvedValue(pipelinesPage([pipeline('pl1')]))

    usePipelinesStore.getState().invalidateProject('p1')

    const state = usePipelinesStore.getState()
    // `p1` инвалидирован (перечитывание уже запущено, ответа ещё нет),
    // `p2` — не тронут.
    expect(state.loadedProjects.has('p1')).toBe(false)
    expect(state.loadedProjects.has('p2')).toBe(true)
    // Страница другого проекта не изменилась.
    expect(state.pipelinesByProject.p2?.pipelines.map((p) => p.id)).toEqual(['pl2'])
  })

  it('загруженный проект перечитывается с `force` (первая страница заново)', async () => {
    usePipelinesStore.setState(loadedState({ p1: [pipeline('pl1')] }, ['p1']))
    mocks.getProjectPipelinesPage.mockResolvedValue(pipelinesPage([pipeline('pl1'), pipeline('pl2')]))

    usePipelinesStore.getState().invalidateProject('p1')

    await vi.waitFor(() => {
      expect(usePipelinesStore.getState().pipelinesByProject.p1?.pipelines.map((p) => p.id)).toEqual(
        ['pl1', 'pl2'],
      )
    })
    // Guard `loadedProjects` обойдён (`force`), запрошена первая страница.
    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledTimes(1)
    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledWith('p1', { limit: 100 })
    // После перечитывания проект снова считается загруженным.
    expect(usePipelinesStore.getState().loadedProjects.has('p1')).toBe(true)
  })

  it('незагруженный проект запросов не делает и состояние не меняет', () => {
    usePipelinesStore.setState(loadedState({ p1: [pipeline('pl1')] }, ['p1']))

    usePipelinesStore.getState().invalidateProject('p2')

    expect(mocks.getProjectPipelinesPage).not.toHaveBeenCalled()
    expect([...usePipelinesStore.getState().loadedProjects]).toEqual(['p1'])
  })

  it('инвалидация чужого проекта не перечитывает загруженный', () => {
    usePipelinesStore.setState(loadedState({ p1: [pipeline('pl1')], p2: [pipeline('pl2')] }, ['p1', 'p2']))
    mocks.getProjectPipelinesPage.mockResolvedValue(pipelinesPage([pipeline('pl2')]))

    usePipelinesStore.getState().invalidateProject('p2')

    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledTimes(1)
    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledWith('p2', { limit: 100 })
    // Загруженная страница `p1` не инвалидирована и не перезапрошена.
    expect(usePipelinesStore.getState().loadedProjects.has('p1')).toBe(true)
    expect(usePipelinesStore.getState().pipelinesByProject.p1?.pipelines.map((p) => p.id)).toEqual([
      'pl1',
    ])
  })

  it('повторная инвалидация до завершения перечитывания не плодит запросов', async () => {
    usePipelinesStore.setState(loadedState({ p1: [pipeline('pl1')] }, ['p1']))
    let resolvePage: (page: ReturnType<typeof pipelinesPage>) => void = () => {}
    mocks.getProjectPipelinesPage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve
        }),
    )

    usePipelinesStore.getState().invalidateProject('p1')
    // Проект уже вне `loadedProjects`, а загрузка идёт: второй сигнал — no-op.
    usePipelinesStore.getState().invalidateProject('p1')
    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledTimes(1)

    resolvePage(pipelinesPage([pipeline('pl1')]))
    await vi.waitFor(() => {
      expect(usePipelinesStore.getState().loadingProjects.size).toBe(0)
    })
    expect(mocks.getProjectPipelinesPage).toHaveBeenCalledTimes(1)
  })

  it('ошибка перечитывания не оставляет проект «загруженным» (guard не врёт)', async () => {
    usePipelinesStore.setState(loadedState({ p1: [pipeline('pl1')] }, ['p1']))
    mocks.getProjectPipelinesPage.mockRejectedValue(new Error('сеть недоступна'))

    usePipelinesStore.getState().invalidateProject('p1')

    await vi.waitFor(() => {
      expect(usePipelinesStore.getState().error).toBe('сеть недоступна')
    })
    // Страница не подтверждена сервером — при следующем раскрытии будет запрос.
    expect(usePipelinesStore.getState().loadedProjects.has('p1')).toBe(false)
    expect(usePipelinesStore.getState().loadingProjects.size).toBe(0)
  })
})
