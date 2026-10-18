import { create } from 'zustand'
import { synthApi, type ProviderInfo, type ModelInfo, type ModelGroup } from '@/lib/api/synthApi'
import { api, type UserPreferences } from '@/lib/api/client'

interface ProvidersStore {
  providers: ProviderInfo[]
  modelGroups: ModelGroup[]
  models: ModelInfo[]
  loading: boolean
  error: string | null
  selectedProviderName: string | null
  selectedModelName: string | null
  favorites: string[]
  recents: string[]

  loadProviders: () => Promise<void>
  loadModels: () => Promise<void>
  /** Перечитать провайдеров и модели одним заходом (после мутаций каталога). */
  refreshCatalog: () => Promise<void>
  /** Применить свежий список провайдеров; выбор провайдера — только если он стал невалиден. */
  applyProviders: (providers: ProviderInfo[], defaultProvider?: string) => void
  /** Применить свежие группы моделей; выбор модели — только если он стал невалиден. */
  applyModelGroups: (groups: ModelGroup[]) => void
  setSelectedProvider: (name: string | null) => void
  setSelectedModel: (name: string | null) => void
  toggleFavorite: (model: ModelInfo) => void
  addRecent: (model: ModelInfo) => void
  loadFavoritesFromProfile: (prefs: UserPreferences | undefined) => void
}

/**
 * Выбор провайдера при обновлении каталога (только когда текущий невалиден/пуст):
 * провайдер из пары default-model → провайдер с непустым `model` → первый enabled → первый.
 */
function pickProvider(providers: ProviderInfo[], defaultProvider?: string): string | null {
  if (providers.length === 0) return null
  const preferred =
    (defaultProvider ? providers.find((p) => p.name === defaultProvider) : undefined)
    ?? providers.find((p) => !!p.model)
    ?? providers.find((p) => p.enabled !== false)
    ?? providers[0]
  return preferred?.name ?? null
}

export const useProvidersStore = create<ProvidersStore>((set, get) => ({
  providers: [],
  modelGroups: [],
  models: [],
  loading: false,
  error: null,
  selectedProviderName: null,
  selectedModelName: null,
  favorites: [],
  recents: [],

  applyProviders: (providers, defaultProvider) => {
    set({ providers })
    const current = get().selectedProviderName
    if (current && providers.some((p) => p.name === current)) return
    set({ selectedProviderName: pickProvider(providers, defaultProvider) })
  },

  applyModelGroups: (groups) => {
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

    // Существующий валидный выбор не перезаписываем (модель может быть задана сессией).
    // Валидность — в паре с провайдером: одинаковое имя модели у разных провайдеров
    // не делает текущую пару корректной.
    const { selectedModelName, selectedProviderName } = get()
    const selectionValid =
      !!selectedModelName &&
      allModels.some(
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
      const { providers, default_provider } = await synthApi.getProviders()
      set({ loading: false })
      get().applyProviders(providers, default_provider)
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Ошибка загрузки провайдеров' })
    }
  },

  loadModels: async () => {
    try {
      const groups = await synthApi.getModels()
      get().applyModelGroups(groups)
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Ошибка загрузки моделей' })
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
