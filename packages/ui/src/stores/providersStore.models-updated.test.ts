import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `models.updated` (каталог провайдеров/моделей изменился).
 *
 * Баг: «модель, добавленная/удалённая/сделанная дефолтной в другом клиенте,
 * не появляется в селекте модели чата». Причина — полный каталог для селекторов
 * (`catalogModels`) грузится лениво **один раз** и защищён guard'ом
 * `catalogLoaded`; событие должно снимать этот guard и перечитывать каталог.
 */
const apiMock = vi.hoisted(() => ({
  getModelGroups: vi.fn(),
  getProviders: vi.fn(),
  getModels: vi.fn(async () => []),
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
import type { ModelGroup, ModelInfo, ProviderInfo } from '@/lib/api/synthApi'

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

function page(models: ModelInfo[], next: number | null = null) {
  return {
    groups: models.length > 0 ? [group(models)] : [],
    page: { models, total: models.length, offset: 0, limit: 500, next_offset: next },
  }
}

function provider(name: string): ProviderInfo {
  return { name, type: 'openai', icon: '', url: '', model: '', enabled: true }
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
    revision: 0,
  })
  apiMock.getModelGroups.mockReset()
  apiMock.getProviders.mockReset()
  apiMock.getProviders.mockResolvedValue({ providers: [provider('itphx')], default_provider: 'itphx' })
})

describe('providersStore.applyEvent (событие шины `models.updated`)', () => {
  it('поднимает revision и сбрасывает guard catalogLoaded', async () => {
    useProvidersStore.setState({ catalogLoaded: true, catalogModels: [model('itphx/m1', 'm1')] })
    apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m1', 'm1')]))

    useProvidersStore.getState().applyEvent()

    // revision — сигнал компонентам с собственным списком (панели админки).
    expect(useProvidersStore.getState().revision).toBe(1)
    // Guard снят сразу: следующий запрос каталога (в т.ч. открытие дропдауна)
    // больше не считает снимок актуальным.
    expect(useProvidersStore.getState().catalogLoaded).toBe(false)
  })

  it('перечитывает полный каталог: новая модель появляется без перезагрузки', async () => {
    useProvidersStore.setState({ catalogLoaded: true, catalogModels: [model('itphx/m1', 'm1')] })
    apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m1', 'm1')]))
    await useProvidersStore.getState().loadCatalogModels()
    expect(useProvidersStore.getState().catalogModels.map((m) => m.name)).toEqual(['m1'])

    // Модель добавили в другом клиенте (или тулом из чата) — событие шины.
    apiMock.getModelGroups.mockResolvedValue(
      page([model('itphx/m1', 'm1'), model('itphx/m2', 'm2')]),
    )
    useProvidersStore.getState().applyEvent()

    await vi.waitFor(() => {
      expect(useProvidersStore.getState().catalogModels.map((m) => m.name)).toEqual(['m1', 'm2'])
    })
    expect(useProvidersStore.getState().catalogLoaded).toBe(true)
  })

  it('если каталог ещё не загружен — за каталогом не ходит (ленивая загрузка)', async () => {
    useProvidersStore.getState().applyEvent()

    expect(useProvidersStore.getState().revision).toBe(1)
    expect(apiMock.getModelGroups).not.toHaveBeenCalled()
  })

  it('перечитывает провайдеров, только если список уже загружен', async () => {
    useProvidersStore.getState().applyEvent()
    expect(apiMock.getProviders).not.toHaveBeenCalled()

    useProvidersStore.setState({ providers: [provider('itphx')] })
    apiMock.getProviders.mockResolvedValue({
      providers: [provider('itphx'), provider('other')],
      default_provider: 'itphx',
    })
    useProvidersStore.getState().applyEvent()

    await vi.waitFor(() => {
      expect(useProvidersStore.getState().providers.map((p) => p.name)).toEqual(['itphx', 'other'])
    })
    expect(useProvidersStore.getState().revision).toBe(2)
  })

  it('перечитывает группы моделей, только если они уже загружены', async () => {
    apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m2', 'm2')]))
    useProvidersStore.getState().applyEvent()
    expect(apiMock.getModelGroups).not.toHaveBeenCalled()

    useProvidersStore.setState({ modelGroups: [group([model('itphx/m1', 'm1')])] })
    apiMock.getModelGroups.mockResolvedValue(page([model('itphx/m1', 'm1'), model('itphx/m2', 'm2')]))
    useProvidersStore.getState().applyEvent()

    await vi.waitFor(() => {
      expect(useProvidersStore.getState().models.map((m) => m.name)).toEqual(['m1', 'm2'])
    })
  })

  it('каждое событие увеличивает revision', () => {
    useProvidersStore.getState().applyEvent()
    useProvidersStore.getState().applyEvent()

    expect(useProvidersStore.getState().revision).toBe(2)
  })

  it('событие во время идущей загрузки каталога не теряется', async () => {
    let releaseFirst: (value: ReturnType<typeof page>) => void = () => {}
    apiMock.getModelGroups.mockReturnValueOnce(
      new Promise<ReturnType<typeof page>>((resolve) => { releaseFirst = resolve }),
    )
    // Заход после события вернёт уже обновлённый каталог (модель m2 добавлена).
    apiMock.getModelGroups.mockResolvedValue(
      page([model('itphx/m1', 'm1'), model('itphx/m2', 'm2')]),
    )

    const first = useProvidersStore.getState().loadCatalogModels()
    // Событие пришло, пока выборка ещё не вернулась: её снимок прочитан до
    // события, поэтому после неё каталог должен перечитаться.
    useProvidersStore.getState().applyEvent()
    releaseFirst(page([model('itphx/m1', 'm1')]))
    await first

    await vi.waitFor(() => {
      expect(useProvidersStore.getState().catalogModels.map((m) => m.name)).toEqual(['m1', 'm2'])
    })
  })
})
