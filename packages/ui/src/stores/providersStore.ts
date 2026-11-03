import { create } from 'zustand'
import {
  synthApi,
  mergeModelGroups,
  type ProviderInfo,
  type ModelInfo,
  type ModelGroup,
  type ModelsQuery,
} from '@/lib/api/synthApi'
import { api, type UserPreferences } from '@/lib/api/client'

interface ProvidersStore {
  providers: ProviderInfo[]
  modelGroups: ModelGroup[]
  models: ModelInfo[]
  /** Всего моделей в каталоге (после фильтров) — из последней страницы. */
  modelsTotal: number
  /** Курсор следующей страницы каталога; `null` — страница последняя. */
  modelsNextOffset: number | null
  /** Каталог моделей грузится (первая страница/поиск/догрузка). */
  modelsLoading: boolean
  /** Ошибка загрузки каталога моделей. */
  modelsError: string | null
  /** Последний применённый запрос каталога (поиск/фильтры) — для «Показать ещё». */
  modelsQuery: ModelsQuery
  loading: boolean
  error: string | null
  selectedProviderName: string | null
  selectedModelName: string | null
  favorites: string[]
  recents: string[]

  loadProviders: () => Promise<void>
  /** Загрузить страницу каталога моделей (поиск/фильтры — на сервере). */
  loadModels: (query?: ModelsQuery) => Promise<void>
  /** Догрузить следующую страницу каталога (кнопка «Показать ещё»). */
  loadMoreModels: () => Promise<void>
  /** Перечитать провайдеров и модели одним заходом (после мутаций каталога). */
  refreshCatalog: () => Promise<void>
  /** Применить свежий список провайдеров; выбор провайдера — только если он стал невалиден. */
  applyProviders: (providers: ProviderInfo[]) => void
  /**
   * Применить свежие группы моделей; выбор модели — только если он стал невалиден.
   * `authoritative: false` — список неполный (страница/поиск): выбор не проверяем,
   * модель может лежать на другой странице каталога.
   */
  applyModelGroups: (groups: ModelGroup[], opts?: { authoritative?: boolean }) => void
  /** Догрузить модели выбранной пары, если её нет в загруженной странице. */
  ensureSelectedModelVisible: () => Promise<void>
  /**
   * Точечно догрузить модель по ссылке (`provider/model` или имя): каталог
   * постраничный, нужная модель может быть не на загруженной странице.
   * Возвращает найденную модель (или `null`).
   */
  ensureModelLoaded: (modelRef: string) => Promise<ModelInfo | null>
  setSelectedProvider: (name: string | null) => void
  setSelectedModel: (name: string | null) => void
  toggleFavorite: (model: ModelInfo) => void
  addRecent: (model: ModelInfo) => void
  loadFavoritesFromProfile: (prefs: UserPreferences | undefined) => void
}

/**
 * Выбор провайдера при обновлении каталога (только когда текущий невалиден/пуст):
 * провайдер с непустым `model` → первый enabled → первый.
 */
function pickProvider(providers: ProviderInfo[]): string | null {
  if (providers.length === 0) return null
  const preferred =
    providers.find((p) => !!p.model)
    ?? providers.find((p) => p.enabled !== false)
    ?? providers[0]
  return preferred?.name ?? null
}

export const useProvidersStore = create<ProvidersStore>((set, get) => ({
  providers: [],
  modelGroups: [],
  models: [],
  modelsTotal: 0,
  modelsNextOffset: null,
  modelsLoading: false,
  modelsError: null,
  modelsQuery: {},
  loading: false,
  error: null,
  selectedProviderName: null,
  selectedModelName: null,
  favorites: [],
  recents: [],

  applyProviders: (providers) => {
    set({ providers })
    const current = get().selectedProviderName
    if (current && providers.some((p) => p.name === current)) return
    set({ selectedProviderName: pickProvider(providers) })
  },

  applyModelGroups: (groups, opts) => {
    const allModels: ModelInfo[] = []
    let defaultModel: ModelInfo | undefined
    for (const g of groups) {
      for (const m of g.models) {
        if (!m.enabled) continue
        allModels.push(m)
        if (m.isDefault && !defaultModel) defaultModel = m
      }
    }
    set({ modelGroups: groups, models: allModels })

    const { selectedModelName, selectedProviderName } = get()

    // Выбора ещё нет — берём дефолтную модель (или первую модель провайдера).
    if (!selectedModelName) {
      const providerModel = selectedProviderName
        ? allModels.find((m) => m.provider === selectedProviderName)
        : undefined
      const next = defaultModel ?? providerModel ?? allModels[0]
      set(
        next
          ? { selectedModelName: next.name, selectedProviderName: next.provider }
          : { selectedModelName: null },
      )
      return
    }

    // Список неполный (страница каталога/поиск) — модель может лежать на другой
    // странице, поэтому выбор не проверяем и не сбрасываем.
    if (opts?.authoritative === false) return

    // Существующий валидный выбор не перезаписываем (модель может быть задана сессией).
    // Валидность — в паре с провайдером: одинаковое имя модели у разных провайдеров
    // не делает текущую пару корректной.
    const selectionValid = allModels.some(
      (m) =>
        m.name === selectedModelName &&
        (!selectedProviderName || m.provider === selectedProviderName),
    )
    if (selectionValid) return

    const providerModel = selectedProviderName
      ? allModels.find((m) => m.provider === selectedProviderName)
      : undefined
    const next = defaultModel ?? providerModel ?? allModels[0]
    // Пара выставляется целиком: иначе провайдер остаётся прежним, а модель — из
    // другого провайдера, и отправка уйдёт с неверной парой.
    set(
      next
        ? { selectedModelName: next.name, selectedProviderName: next.provider }
        : { selectedModelName: null },
    )
  },

  loadProviders: async () => {
    set({ loading: true, error: null })
    try {
      const { providers } = await synthApi.getProviders()
      set({ loading: false })
      get().applyProviders(providers)
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Ошибка загрузки провайдеров' })
    }
  },

  loadModels: async (query) => {
    const effective = query ?? get().modelsQuery
    set({ modelsLoading: true, modelsError: null })
    try {
      const { groups, page } = await synthApi.getModelGroups(effective)
      set({
        modelsQuery: effective,
        modelsTotal: page.total,
        modelsNextOffset: page.next_offset,
        modelsLoading: false,
      })
      // Список — страница каталога, поэтому выбор модели по нему не проверяем.
      get().applyModelGroups(groups, { authoritative: false })
      await get().ensureSelectedModelVisible()
    } catch (e) {
      set({
        modelsLoading: false,
        modelsError: e instanceof Error ? e.message : 'Ошибка загрузки моделей',
      })
    }
  },

  loadMoreModels: async () => {
    const { modelsQuery, modelsNextOffset, modelsLoading } = get()
    if (modelsNextOffset === null || modelsLoading) return
    set({ modelsLoading: true })
    try {
      const { groups, page } = await synthApi.getModelGroups({
        ...modelsQuery,
        offset: modelsNextOffset,
      })
      set({ modelsNextOffset: page.next_offset, modelsLoading: false })
      // Догружаем страницу в уже загруженные группы (по id моделей — без дублей).
      get().applyModelGroups(mergeModelGroups(get().modelGroups, groups), { authoritative: false })
    } catch (e) {
      set({
        modelsLoading: false,
        modelsError: e instanceof Error ? e.message : 'Ошибка загрузки моделей',
      })
    }
  },

  ensureModelLoaded: async (modelRef) => {
    if (!modelRef) return null
    const { modelGroups } = get()
    const known = modelGroups
      .flatMap((g) => g.models)
      .find((m) => m.id === modelRef || m.name === modelRef)
    if (known) return known

    // Ссылка может быть `provider/model` (в имени модели тоже бывает «/» —
    // например `routerai/google/gemini-…`), поэтому провайдера отделяем по
    // первой косой черте, а имя ищем целиком.
    const slash = modelRef.indexOf('/')
    const provider = slash > 0 ? modelRef.slice(0, slash) : undefined
    const name = slash > 0 ? modelRef.slice(slash + 1) : modelRef
    try {
      const { page } = await synthApi.getModelGroups({
        search: name,
        provider,
        limit: 5,
      })
      const model = page.models.find(
        (m) => m.id === modelRef || (m.name === name && (!provider || m.provider === provider)),
      )
      if (!model) return null
      const groups = [...get().modelGroups]
      const group = groups.find((g) => g.provider.name === model.provider)
      if (group) {
        if (!group.models.some((m) => m.id === model.id)) group.models.push(model)
      } else {
        groups.push({
          provider: { name: model.provider, type: '', icon: '', defaultModel: '' },
          models: [model],
        })
      }
      get().applyModelGroups(groups, { authoritative: false })
      return model
    } catch {
      return null
    }
  },

  ensureSelectedModelVisible: async () => {
    const { selectedModelName, selectedProviderName, modelGroups } = get()
    if (!selectedModelName) return
    const present = modelGroups.some((g) =>
      g.models.some(
        (m) =>
          m.name === selectedModelName &&
          (!selectedProviderName || m.provider === selectedProviderName),
      ),
    )
    if (present) return
    try {
      // Точечный запрос по имени: модель могла оказаться не на первой странице.
      const { page } = await synthApi.getModelGroups({
        search: selectedModelName,
        provider: selectedProviderName ?? undefined,
        limit: 5,
      })
      const found = page.models.find(
        (m) =>
          m.name === selectedModelName &&
          (!selectedProviderName || m.provider === selectedProviderName),
      )
      if (!found) return
      const groups = [...get().modelGroups]
      const group = groups.find((g) => g.provider.name === found.provider)
      if (group) {
        if (!group.models.some((m) => m.id === found.id)) group.models.push(found)
      } else {
        groups.push({
          provider: { name: found.provider, type: '', icon: '', defaultModel: '' },
          models: [found],
        })
      }
      get().applyModelGroups(groups, { authoritative: false })
    } catch {
      // Модель не нашлась — выбор остаётся как есть (список пуст, выбор виден в шапке).
    }
  },

  refreshCatalog: async () => {
    await Promise.all([get().loadProviders(), get().loadModels()])
  },

  setSelectedProvider: (name) => set({ selectedProviderName: name }),

  setSelectedModel: (name) => set({ selectedModelName: name }),

  toggleFavorite: (model) => {
    const key = `${model.provider}:${model.name}`
    const { favorites } = get()
    const newFavorites = favorites.includes(key)
      ? favorites.filter((f) => f !== key)
      : [...favorites, key]
    set({ favorites: newFavorites })
    api.updatePreferences({ favoriteModels: newFavorites }).catch(() => {})
  },

  addRecent: (model) => {
    const key = `${model.provider}:${model.name}`
    const { recents } = get()
    const filtered = recents.filter((r) => r !== key)
    const newRecents = [key, ...filtered].slice(0, 5)
    set({ recents: newRecents })
    api.updatePreferences({ recentModels: newRecents }).catch(() => {})
  },

  loadFavoritesFromProfile: (prefs) => {
    if (!prefs) return
    if (Array.isArray(prefs.favoriteModels) && prefs.favoriteModels.length > 0) {
      set({ favorites: prefs.favoriteModels })
    }
    if (Array.isArray(prefs.recentModels) && prefs.recentModels.length > 0) {
      set({ recents: prefs.recentModels })
    }
  },
}))
