import { create } from 'zustand'
import { synthApi, type ProviderInfo, type ModelInfo } from '@/lib/api/synthApi'
import { api, type UserPreferences } from '@/lib/api/client'

interface ProvidersStore {
  providers: ProviderInfo[]
  models: ModelInfo[]
  loading: boolean
  error: string | null
  selectedProviderName: string | null
  selectedModelName: string | null
  favorites: string[]
  recents: string[]

  loadProviders: () => Promise<void>
  loadModels: () => Promise<void>
  setSelectedProvider: (name: string | null) => void
  setSelectedModel: (name: string | null) => void
  toggleFavorite: (model: ModelInfo) => void
  addRecent: (model: ModelInfo) => void
  loadFavoritesFromProfile: (prefs: UserPreferences | undefined) => void
}

export const useProvidersStore = create<ProvidersStore>((set, get) => ({
  providers: [],
  models: [],
  loading: false,
  error: null,
  selectedProviderName: null,
  selectedModelName: null,
  favorites: [],
  recents: [],

  loadProviders: async () => {
    set({ loading: true, error: null })
    try {
      const { providers, default_provider } = await synthApi.getProviders()
      set({ providers, loading: false })
      if (providers.length > 0 && !get().selectedProviderName) {
        const defaultProvider = providers.find((p) => p.name === default_provider)
        const providerName = defaultProvider?.name || providers[0].name
        set({ selectedProviderName: providerName })
        const provider = providers.find((p) => p.name === providerName)
        if (provider?.model && !get().selectedModelName) {
          set({ selectedModelName: provider.model })
        }
      }
    } catch {
      set({ loading: false })
    }
  },

  loadModels: async () => {
    try {
      const { models, default_model } = await synthApi.getModels()
      set({ models })
      if (!get().selectedModelName && default_model) {
        set({ selectedModelName: default_model })
      }
    } catch {
      // ignore
    }
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