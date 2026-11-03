import { describe, it, expect, beforeEach, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  getModelGroups: vi.fn(),
  getModels: vi.fn(async () => []),
  getProviders: vi.fn(async () => ({ providers: [], default_provider: '' })),
  updatePreferences: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: apiMock,
  mergeModelGroups: (
    prev: Array<{ provider: { name: string }; models: Array<{ id: string }> }>,
    next: Array<{ provider: { name: string }; models: Array<{ id: string }> }>,
  ) => {
    const byName = new Map(prev.map((g) => [g.provider.name, { ...g, models: [...g.models] }]))
    for (const g of next) {
      const current = byName.get(g.provider.name)
      if (!current) {
        byName.set(g.provider.name, { provider: g.provider, models: [...g.models] })
        continue
      }
      const known = new Set(current.models.map((m) => m.id))
      for (const m of g.models) {
        if (known.has(m.id)) continue
        known.add(m.id)
        current.models.push(m)
      }
    }
    return [...byName.values()]
  },
}))

import { useProvidersStore } from './providersStore'
import type { ModelGroup, ModelInfo } from '@/lib/api/synthApi'

function model(id: string, name: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name,
    provider: 'itphx',
    enabled: true,
    isDefault: false,
    ...extra,
  }
}

function group(models: ModelInfo[]): ModelGroup {
  return {
    provider: { name: 'itphx', type: 'openai', icon: '', defaultModel: '' },
    models,
  }
}

function page(models: ModelInfo[], next: number | null, total = models.length) {
  return {
    groups: models.length > 0 ? [group(models)] : [],
    page: { models, total, offset: 0, limit: 100, next_offset: next },
  }
}

beforeEach(() => {
  useProvidersStore.setState({
    providers: [],
    modelGroups: [],
    models: [],
    modelsTotal: 0,
    modelsNextOffset: null,
    modelsLoading: false,
    modelsError: null,
    modelsQuery: {},
    catalogModels: [],
    catalogLoading: false,
    catalogLoaded: false,
    loading: false,
    error: null,
    selectedProviderName: null,
    selectedModelName: null,
    favorites: [],
    recents: [],
  })
  apiMock.getModelGroups.mockReset()
})

describe('providersStore — постраничный каталог моделей', () => {
  it('loadModels: первая страница — total/nextOffset и только включённые модели', async () => {
    apiMock.getModelGroups.mockResolvedValue(
      page([model('itphx/m1', 'm1'), model('itphx/m2', 'm2', { enabled: false })], 100, 2095),
    )

    await useProvidersStore.getState().loadModels()

    const state = useProvidersStore.getState()
    expect(state.modelsTotal).toBe(2095)
    expect(state.modelsNextOffset).toBe(100)
    // Выключенная модель в список селекторов не попадает.
    expect(state.models.map((m) => m.name)).toEqual(['m1'])
    expect(state.modelGroups[0]!.models).toHaveLength(2)
  })

  it('loadModels: поиск/фильтры уходят на сервер (query)', async () => {
    apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m1', 'm1')], null))

    await useProvidersStore.getState().loadModels({ search: 'm1', provider: 'itphx', enabled: true })

    expect(apiMock.getModelGroups).toHaveBeenCalledWith({
      search: 'm1',
      provider: 'itphx',
      enabled: true,
    })
    expect(useProvidersStore.getState().modelsQuery).toEqual({
      search: 'm1',
      provider: 'itphx',
      enabled: true,
    })
  })

  it('loadModels: ошибка — в modelsError, выбор не сбрасывается', async () => {
    useProvidersStore.setState({ selectedProviderName: 'itphx', selectedModelName: 'm1' })
    apiMock.getModelGroups.mockRejectedValue(new Error('boom'))

    await useProvidersStore.getState().loadModels()

    expect(useProvidersStore.getState().modelsError).toBe('boom')
    expect(useProvidersStore.getState().selectedModelName).toBe('m1')
  })

  it('неполный список (страница) не сбрасывает выбор модели', async () => {
    useProvidersStore.setState({ selectedProviderName: 'itphx', selectedModelName: 'm-off-page' })
    apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m1', 'm1')], 100))

    await useProvidersStore.getState().loadModels()

    // Модели может не быть на странице — выбор всё равно сохраняется.
    expect(useProvidersStore.getState().selectedModelName).toBe('m-off-page')
  })

  it('loadMoreModels: догружает следующую страницу без дублей', async () => {
    apiMock.getModelGroups.mockResolvedValueOnce(page([model('itphx/m1', 'm1')], 100))
    await useProvidersStore.getState().loadModels()

    apiMock.getModelGroups.mockResolvedValueOnce(
      page([model('itphx/m1', 'm1'), model('itphx/m2', 'm2')], null, 2),
    )
    await useProvidersStore.getState().loadMoreModels()

    expect(apiMock.getModelGroups).toHaveBeenLastCalledWith({ offset: 100 })
    const state = useProvidersStore.getState()
    expect(state.models.map((m) => m.name)).toEqual(['m1', 'm2'])
    expect(state.modelsNextOffset).toBeNull()
  })

  it('loadMoreModels: без курсора — запрос не делается', async () => {
    apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m1', 'm1')], null))
    await useProvidersStore.getState().loadModels()
    apiMock.getModelGroups.mockClear()

    await useProvidersStore.getState().loadMoreModels()

    expect(apiMock.getModelGroups).not.toHaveBeenCalled()
  })
})

describe('providersStore — выбранная модель вне первой страницы', () => {
  it('ensureSelectedModelVisible: точечный поиск и добавление модели в список', async () => {
    useProvidersStore.setState({ selectedProviderName: 'itphx', selectedModelName: 'm-off-page' })
    apiMock.getModelGroups.mockResolvedValueOnce(page([model('itphx/m1', 'm1')], 100))

    await useProvidersStore.getState().loadModels()

    // Вторая выборка — точечный поиск по имени выбранной модели.
    apiMock.getModelGroups.mockResolvedValueOnce(
      page([model('itphx/m-off-page', 'm-off-page')], null),
    )
    await useProvidersStore.getState().ensureSelectedModelVisible()

    expect(apiMock.getModelGroups).toHaveBeenLastCalledWith({
      search: 'm-off-page',
      provider: 'itphx',
      limit: 5,
    })
    expect(useProvidersStore.getState().models.map((m) => m.name)).toContain('m-off-page')
  })

  it('ensureSelectedModelVisible: модель в списке — лишнего запроса нет', async () => {
    useProvidersStore.setState({ selectedProviderName: 'itphx', selectedModelName: 'm1' })
    apiMock.getModelGroups.mockResolvedValueOnce(page([model('itphx/m1', 'm1')], null))

    await useProvidersStore.getState().loadModels()
    apiMock.getModelGroups.mockClear()

    await useProvidersStore.getState().ensureSelectedModelVisible()

    expect(apiMock.getModelGroups).not.toHaveBeenCalled()
  })
})

describe('providersStore — полный каталог для селекторов (T6)', () => {
  it('loadCatalogModels: обходит страницы, фильтрует disabled и дедуплицирует', async () => {
    apiMock.getModelGroups
      .mockResolvedValueOnce(page([model('itphx/m1', 'm1'), model('itphx/m2', 'm2', { enabled: false })], 500, 3))
      .mockResolvedValueOnce(page([model('itphx/m3', 'm3'), model('itphx/m1', 'm1')], null, 3))

    await useProvidersStore.getState().loadCatalogModels()

    const state = useProvidersStore.getState()
    expect(state.catalogLoaded).toBe(true)
    expect(state.catalogModels.map((m) => m.name)).toEqual(['m1', 'm3'])
    expect(apiMock.getModelGroups).toHaveBeenNthCalledWith(1, { limit: 500, offset: 0 })
    expect(apiMock.getModelGroups).toHaveBeenNthCalledWith(2, { limit: 500, offset: 500 })
  })

  it('loadCatalogModels: повторный вызов — no-op', async () => {
    apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m1', 'm1')], null))
    await useProvidersStore.getState().loadCatalogModels()
    apiMock.getModelGroups.mockClear()

    await useProvidersStore.getState().loadCatalogModels()

    expect(apiMock.getModelGroups).not.toHaveBeenCalled()
  })

  it('loadCatalogModels: ошибка — modelsError, каталог не помечен загруженным', async () => {
    apiMock.getModelGroups.mockRejectedValue(new Error('boom'))

    await useProvidersStore.getState().loadCatalogModels()

    const state = useProvidersStore.getState()
    expect(state.catalogLoaded).toBe(false)
    expect(state.modelsError).toContain('boom')
  })
})

describe('providersStore — догрузка конкретной модели', () => {
  it('ensureModelLoaded: точечный поиск по ссылке provider/model', async () => {
    apiMock.getModelGroups.mockResolvedValue(
      page([model('itphx/m-off-page', 'm-off-page')], null),
    )

    const found = await useProvidersStore.getState().ensureModelLoaded('itphx/m-off-page')

    expect(apiMock.getModelGroups).toHaveBeenCalledWith({
      search: 'm-off-page',
      provider: 'itphx',
      limit: 5,
    })
    expect(found?.name).toBe('m-off-page')
    expect(useProvidersStore.getState().models.map((m) => m.name)).toContain('m-off-page')
  })

  it('ensureModelLoaded: уже загруженная модель — без запроса', async () => {
    apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m1', 'm1')], null))
    await useProvidersStore.getState().loadModels()
    apiMock.getModelGroups.mockClear()

    const found = await useProvidersStore.getState().ensureModelLoaded('itphx/m1')

    expect(found?.name).toBe('m1')
    expect(apiMock.getModelGroups).not.toHaveBeenCalled()
  })
})
