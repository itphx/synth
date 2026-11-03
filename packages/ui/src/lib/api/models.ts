// models: домен API v2 (ADR-095) — объект `modelsApi` и его DTO.

import type { ProviderGroupInfo, ProviderInfo } from './providers'
import { providersApi } from './providers'
import { BASE_URL, fetchJSON } from './base'
import { normalizeModelInfo } from './modelNormalize'
import type { ModelCompatibility } from './compatibility'

export interface ModelInfo {
  id: string
  name: string
  provider: string
  description?: string
  enabled: boolean
  isDefault: boolean
  context_window?: number
  context_source?: string
  max_tokens?: number
  input_price?: number
  output_price?: number
  cache_read_price?: number
  cache_write_price?: number
  /** Валюта цен модели; отсутствует → валюта провайдера → USD. */
  currency?: string
  /**
   * Слой совместимости модели (переопределения эвристик). `undefined`/`null` —
   * все поля «авто»; тип — `lib/api/compatibility` (общий с провайдерами).
   */
  compatibility?: ModelCompatibility | null
  /**
   * ADR-115: модальности входа модели (`text`/`image`/`pdf`/`audio`/`video`).
   * Сервер отдаёт поле в `GET /models` и молча отбрасывает вложения, тип которых
   * модель не принимает; отсутствие поля — «неизвестно», ограничений не накладываем.
   */
  modalities?: string[]
}

export interface ModelGroup {
  provider: ProviderGroupInfo
  models: ModelInfo[]
}

/**
 * Страница каталога моделей (`GET /api/v2/models`).
 *
 * Каталог постраничный: массив моделей больше не возвращается «целиком» —
 * полный список собирается постранично (`next_offset`).
 */
export interface ModelsPage {
  /** Модели текущей страницы. */
  models: ModelInfo[]
  /** Всего моделей после фильтров. */
  total: number
  /** Смещение текущей страницы. */
  offset: number
  /** Размер страницы. */
  limit: number
  /** Курсор следующей страницы; `null` — страница последняя. */
  next_offset: number | null
}

/**
 * Параметры выборки каталога моделей. Поиск и фильтры — **на сервере**:
 * клиент не тянет весь каталог (тысячи моделей) ради фильтрации.
 */
export interface ModelsQuery {
  /** Подстрока по id/имени/провайдеру (без учёта регистра). */
  search?: string
  /** Точное имя провайдера. */
  provider?: string
  /** Модальность входа модели (`text`/`image`/`pdf`/`audio`/`video`). */
  modality?: string
  /** `true` — только включённые, `false` — только выключенные. */
  enabled?: boolean
  /** Размер страницы (1..500; по умолчанию 100). */
  limit?: number
  /** Смещение страницы (с 0). */
  offset?: number
}

/** Размер страницы каталога по умолчанию (совпадает с серверным). */
export const MODELS_PAGE_LIMIT = 100

/** Группы моделей + страница каталога (одним ответом). */
export interface ModelGroupsPage {
  groups: ModelGroup[]
  page: ModelsPage
}

/** Сырой ответ `GET /api/v2/models` (поля в camelCase). */
interface RawModelsResponse {
  models?: Array<Record<string, unknown>>
  total?: number
  offset?: number
  limit?: number
  next_offset?: number | null
  /** Legacy-формат старого ядра: группы моделей без пагинации. */
  groups?: Array<{ provider?: Partial<ProviderGroupInfo>; models?: Array<Record<string, unknown>> }>
}

/** Метаданные провайдера из `GET /providers` → группа каталога моделей. */
function toProviderGroup(p: ProviderInfo): ProviderGroupInfo {
  return {
    name: p.name,
    type: p.type,
    icon: p.icon,
    defaultModel: p.model ?? '',
    currency: p.currency,
    // Провайдер отключён администратором — модели этой группы не предлагаются
    // в списках выбора (данные каталога при этом остаются полными).
    enabled: p.enabled !== false,
  }
}

/**
 * Группирует модели по провайдеру. Метаданные провайдера (`type`/`icon`/
 * `currency`/`defaultModel`) раньше приходили в поле `groups` ответа
 * `GET /models`; теперь список моделей — плоская страница без метаданных,
 * поэтому они берутся из `GET /providers` и склеиваются здесь.
 */
export function groupModelsByProvider(models: ModelInfo[], providers: ProviderInfo[]): ModelGroup[] {
  const byName = new Map<string, ModelGroup>()
  for (const p of providers) {
    byName.set(p.name, { provider: toProviderGroup(p), models: [] })
  }
  for (const m of models) {
    let group = byName.get(m.provider)
    if (!group) {
      // Провайдер не найден в каталоге (например, удалённая модель в гибриде) —
      // группа синтетическая, чтобы модель не потерялась.
      group = { provider: { name: m.provider, type: '', icon: '', defaultModel: '' }, models: [] }
      byName.set(m.provider, group)
    }
    group.models.push(m)
  }
  return [...byName.values()].filter((g) => g.models.length > 0)
}

/**
 * Склейка групп моделей (догрузка следующей страницы): группы по провайдеру,
 * модели — по id (дублей не будет).
 */
export function mergeModelGroups(prev: ModelGroup[], next: ModelGroup[]): ModelGroup[] {
  const byName = new Map(prev.map((g) => [g.provider.name, { ...g, models: [...g.models] }]))
  for (const g of next) {
    const current = byName.get(g.provider.name)
    if (!current) {
      byName.set(g.provider.name, { provider: g.provider, models: [...g.models] })
      continue
    }
    current.provider = g.provider
    const known = new Set(current.models.map((m) => m.id))
    for (const m of g.models) {
      if (known.has(m.id)) continue
      known.add(m.id)
      current.models.push(m)
    }
  }
  return [...byName.values()]
}

export const modelsApi = {
  /** Страница каталога моделей (`GET /api/v2/models`). */
  async getModelsPage(query?: ModelsQuery): Promise<ModelsPage> {
    const params = new URLSearchParams()
    if (query?.search) params.set('search', query.search)
    if (query?.provider) params.set('provider', query.provider)
    if (query?.modality) params.set('modality', query.modality)
    if (query?.enabled !== undefined) params.set('enabled', String(query.enabled))
    if (query?.limit) params.set('limit', String(query.limit))
    if (query?.offset) params.set('offset', String(query.offset))
    const qs = params.toString()
    const data = await fetchJSON<RawModelsResponse>(`${BASE_URL}/models${qs ? `?${qs}` : ''}`)

    const rawModels = Array.isArray(data.models)
      ? data.models
      : // Legacy-ядро: ответ без пагинации (`groups`) — разворачиваем в страницу.
        (data.groups ?? []).flatMap((g) => g.models ?? [])
    const models = rawModels.map((m) => normalizeModelInfo(m) as unknown as ModelInfo)

    return {
      models,
      total: data.total ?? models.length,
      offset: data.offset ?? 0,
      limit: data.limit ?? MODELS_PAGE_LIMIT,
      next_offset: data.next_offset ?? null,
    }
  },

  /**
   * Страница каталога + сгруппированные модели с метаданными провайдера.
   * Провайдеры читаются отдельным запросом (`GET /providers`) — в ответе
   * `GET /models` их больше нет.
   */
  async getModelGroups(query?: ModelsQuery): Promise<ModelGroupsPage> {
    const [page, providersRes] = await Promise.all([
      modelsApi.getModelsPage(query),
      providersApi.getProviders().catch(() => ({ providers: [] as ProviderInfo[], default_provider: '' })),
    ])
    return { groups: groupModelsByProvider(page.models, providersRes.providers), page }
  },

  /** Группы моделей страницы (совместимость: прежний `groups`-формат). */
  async getModels(query?: ModelsQuery): Promise<ModelGroup[]> {
    const { groups } = await modelsApi.getModelGroups(query)
    return groups
  },

  // Модели (admin)
  async fetchModels(providerName?: string): Promise<{
    fetched: number
    new: number
    enriched: number
    priced?: number
    limited?: number
    errors?: string[]
  }> {
    const params = providerName ? `?provider=${encodeURIComponent(providerName)}` : ''
    return fetchJSON(`${BASE_URL}/models/fetch${params}`, { method: 'POST' })
  },

  async saveModel(data: Record<string, unknown>): Promise<ModelInfo> {
    return fetchJSON<ModelInfo>(`${BASE_URL}/models`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async deleteModel(modelId: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/models/${encodeURIComponent(modelId)}`, {
      method: 'DELETE',
    })
  },
}
