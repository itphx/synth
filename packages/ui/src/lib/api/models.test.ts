import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { modelsApi, groupModelsByProvider, mergeModelGroups } from './models'
import type { ProviderInfo } from './providers'

/**
 * Домен `models` (`lib/api/models.ts`, ADR-095): каталог моделей — **страница**
 * `{models,total,offset,limit,next_offset}` (C1). Ценно — формирование
 * query-параметров (поиск/фильтры/пагинация), нормализация camelCase → snake_case,
 * склейка метаданных провайдера и совместимость со старым ответом `{groups}`.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Провайдер для склейки метаданных. */
function makeProvider(name: string, extra: Partial<ProviderInfo> = {}): ProviderInfo {
  return { name, type: 'openai', icon: '', url: '', model: '', enabled: true, ...extra }
}

describe('modelsApi — страница каталога', () => {
  it('getModelsPage: без параметров — GET /models без query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [], total: 0, offset: 0, limit: 100, next_offset: null }))

    await modelsApi.getModelsPage()

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/models', expect.objectContaining({}))
  })

  it('getModelsPage: поиск/фильтры/пагинация уходят в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [], total: 0, offset: 0, limit: 100, next_offset: null }))

    await modelsApi.getModelsPage({
      search: 'gpt 4o',
      provider: 'itphx',
      modality: 'image',
      enabled: true,
      limit: 500,
      offset: 100,
    })

    const url = fetchMock.mock.calls[0]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('search')).toBe('gpt 4o')
    expect(params.get('provider')).toBe('itphx')
    expect(params.get('modality')).toBe('image')
    expect(params.get('enabled')).toBe('true')
    expect(params.get('limit')).toBe('500')
    expect(params.get('offset')).toBe('100')
  })

  it('getModelsPage: пустые фильтры не попадают в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [], total: 0, offset: 0, limit: 100, next_offset: null }))

    await modelsApi.getModelsPage({ search: '', provider: '', modality: '', enabled: false })

    const url = fetchMock.mock.calls[0]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.has('search')).toBe(false)
    expect(params.has('provider')).toBe(false)
    expect(params.has('modality')).toBe(false)
    // `enabled=false` — осмысленный фильтр («только выключенные»), его шлём.
    expect(params.get('enabled')).toBe('false')
  })

  it('getModelsPage: camelCase-поля нормализуются в snake_case', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        models: [
          { id: 'itphx/m1', name: 'm1', provider: 'itphx', enabled: true, isDefault: false, contextWindow: 1000, inputPrice: 2 },
        ],
        total: 1,
        offset: 0,
        limit: 100,
        next_offset: null,
      }),
    )

    const page = await modelsApi.getModelsPage()

    expect(page.models[0]!.context_window).toBe(1000)
    expect(page.models[0]!.input_price).toBe(2)
    expect((page.models[0] as unknown as Record<string, unknown>).contextWindow).toBeUndefined()
    expect(page.total).toBe(1)
    expect(page.next_offset).toBeNull()
  })

  it('getModelsPage: курсор следующей страницы сохраняется', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ models: [], total: 2095, offset: 100, limit: 100, next_offset: 200 }),
    )

    const page = await modelsApi.getModelsPage({ offset: 100 })

    expect(page.total).toBe(2095)
    expect(page.offset).toBe(100)
    expect(page.limit).toBe(100)
    expect(page.next_offset).toBe(200)
  })

  it('getModelsPage: legacy-ответ {groups} разворачивается в страницу', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        groups: [
          {
            provider: { name: 'itphx', type: 'openai', icon: '', defaultModel: 'm' },
            models: [{ id: 'itphx/m1', name: 'm1', provider: 'itphx', enabled: true, isDefault: false }],
          },
        ],
      }),
    )

    const page = await modelsApi.getModelsPage()

    expect(page.models).toHaveLength(1)
    expect(page.models[0]!.name).toBe('m1')
    expect(page.total).toBe(1)
    expect(page.next_offset).toBeNull()
  })
})

describe('modelsApi — группировка и метаданные провайдера', () => {
  it('getModelGroups: страница + группы с метаданными провайдера', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/v2/models')) {
        return jsonResponse({
          models: [
            { id: 'itphx/m1', name: 'm1', provider: 'itphx', enabled: true, isDefault: false },
            { id: 'itphx/m2', name: 'm2', provider: 'itphx', enabled: true, isDefault: false },
          ],
          total: 2,
          offset: 0,
          limit: 100,
          next_offset: null,
        })
      }
      return jsonResponse({
        providers: [
          { name: 'itphx', type: 'openai', icon: 'it', url: 'https://x', model: 'm1', enabled: true, currency: 'USD' },
        ],
        default_provider: 'itphx',
      })
    })

    const { groups, page } = await modelsApi.getModelGroups()

    expect(page.total).toBe(2)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.provider).toEqual({
      name: 'itphx',
      type: 'openai',
      icon: 'it',
      defaultModel: 'm1',
      currency: 'USD',
    })
    expect(groups[0]!.models.map((m) => m.name)).toEqual(['m1', 'm2'])
  })

  it('getModels: совместимая обёртка — только группы страницы', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/v2/models')) {
        return jsonResponse({
          models: [{ id: 'itphx/m1', name: 'm1', provider: 'itphx', enabled: true, isDefault: false }],
          total: 1,
          offset: 0,
          limit: 100,
          next_offset: null,
        })
      }
      return jsonResponse({ providers: [], default_provider: '' })
    })

    const groups = await modelsApi.getModels()

    expect(groups).toHaveLength(1)
    expect(groups[0]!.models[0]!.name).toBe('m1')
  })

  it('getModelGroups: модель неизвестного провайдера не теряется', () => {
    const groups = groupModelsByProvider(
      [{ id: 'x/m', name: 'm', provider: 'x', enabled: true, isDefault: false }],
      [makeProvider('other')],
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]!.provider.name).toBe('x')
    expect(groups[0]!.models).toHaveLength(1)
  })
})

describe('mergeModelGroups — догрузка страницы', () => {
  it('склеивает группы по провайдеру и модели по id (без дублей)', () => {
    const prev = [
      {
        provider: { name: 'a', type: 'openai', icon: '', defaultModel: '' },
        models: [{ id: 'a/1', name: '1', provider: 'a', enabled: true, isDefault: false }],
      },
    ]
    const next = [
      {
        provider: { name: 'a', type: 'openai', icon: '', defaultModel: '' },
        models: [
          { id: 'a/1', name: '1', provider: 'a', enabled: true, isDefault: false },
          { id: 'a/2', name: '2', provider: 'a', enabled: true, isDefault: false },
        ],
      },
      {
        provider: { name: 'b', type: 'openai', icon: '', defaultModel: '' },
        models: [{ id: 'b/1', name: '1', provider: 'b', enabled: true, isDefault: false }],
      },
    ]

    const merged = mergeModelGroups(prev, next)

    expect(merged).toHaveLength(2)
    expect(merged.find((g) => g.provider.name === 'a')!.models.map((m) => m.id)).toEqual(['a/1', 'a/2'])
    expect(merged.find((g) => g.provider.name === 'b')!.models).toHaveLength(1)
  })
})
