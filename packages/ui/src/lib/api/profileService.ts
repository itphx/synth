import { api, type UserPreferences, type Profile } from '@/lib/api/client'
import { useUIStore } from '@/stores/useUIStore'
import { useI18nStore } from '@/lib/i18n/store'
import { useAuthStore } from '@/stores/authStore'
import { useProvidersStore } from '@/stores/providersStore'
import type { ThemeMode } from '@/lib/theme/themes'
import type { Locale } from '@/lib/i18n'

export const profileService = {
  async getEffectivePreferences(): Promise<UserPreferences | null> {
    try {
      const profile = await api.getProfile()
      useAuthStore.setState({ profile })
      return profile.preferences || null
    } catch (err) {
      console.error('Failed to load preferences from profile:', err)
      return null
    }
  },

  async getProfile(): Promise<Profile | null> {
    try {
      const profile = await api.getProfile()
      useAuthStore.setState({ profile })
      return profile
    } catch (err) {
      console.error('Failed to load profile:', err)
      return null
    }
  },

  async getDefaults(): Promise<UserPreferences> {
    try {
      return await api.getDefaults()
    } catch (err) {
      console.error('Failed to load defaults:', err)
      return {
        locale: 'ru',
        themeMode: 'system',
        theme: 'synthesis',
        uiScaleMobile: null,
        uiScaleDesktop: null,
      }
    }
  },

  applyToUIStore(prefs: UserPreferences): void {
    // Язык — только через `useI18nStore` (единственный источник истины).
    if (prefs.locale) {
      useI18nStore.getState().setLocale(prefs.locale as Locale)
    }
    if (prefs.themeMode) {
      useUIStore.setState({ themeMode: prefs.themeMode as ThemeMode })
    }
    if (prefs.theme) {
      useUIStore.setState({ theme: prefs.theme })
    }
    if (prefs.transportMode) {
      useUIStore.setState({ transportMode: prefs.transportMode })
    }
    if (prefs.intermediateTextDisplay) {
      useUIStore.setState({ intermediateTextDisplay: prefs.intermediateTextDisplay })
    }

    useProvidersStore.getState().loadFavoritesFromProfile(prefs)
  },

  async syncToProfile(key: string, value: unknown): Promise<void> {
    try {
      await api.updatePreferences({ [key]: value })
      const state = useAuthStore.getState()
      if (state.profile) {
        useAuthStore.setState({
          profile: {
            ...state.profile,
            preferences: { ...(state.profile.preferences || {}), [key]: value } as UserPreferences,
          },
        })
      }
    } catch (err) {
      console.error(`Failed to sync ${key} to profile:`, err)
    }
  },

  async syncLocaleToProfile(locale: Locale): Promise<void> {
    await this.syncToProfile('locale', locale)
  },

  async syncThemeModeToProfile(themeMode: ThemeMode): Promise<void> {
    await this.syncToProfile('themeMode', themeMode)
  },

  async syncThemeToProfile(theme: string): Promise<void> {
    await this.syncToProfile('theme', theme)
  },

  async syncTransportModeToProfile(mode: 'auto' | 'ws' | 'sse'): Promise<void> {
    await this.syncToProfile('transportMode', mode)
  },

  async syncIntermediateTextDisplayToProfile(mode: 'inline' | 'bottom'): Promise<void> {
    await this.syncToProfile('intermediateTextDisplay', mode)
  },

  async syncAvatarToProfile(avatar: string | null): Promise<void> {
    await this.syncToProfile('avatar', avatar)
  },

  async resetPreferences(): Promise<UserPreferences | null> {
    try {
      const result = await api.deletePreferences()
      return result.preferences
    } catch (err) {
      console.error('Failed to reset preferences:', err)
      return null
    }
  },

  async initialize(): Promise<void> {
    const prefs = await this.getEffectivePreferences()
    if (prefs) {
      this.applyToUIStore(prefs)
    }
  },
}
