import { useState } from 'react'
import { useUIStore } from "../../stores/useUIStore"
import { THEME_PRESETS } from "@/lib/theme/themes"
import type { ThemeMode } from "@/types/theme"
import { useThemeSystem } from "@/contexts/useThemeSystem"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { profileService } from '@/lib/api/profileService'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { UiScaleControl } from './UiScaleControl'
import { SettingsCard, ThemeModeControl, ThemeControl, LanguageControl } from './appearance-controls'

export const AppearanceSettings = () => {
  const { setLocale: setUILocale, setThemeMode: setUIThemeMode } = useUIStore()
  const { t, locale: i18nLocale, setLocale: setI18nLocale } = useI18n()
  const {
    themeMode,
    setThemeMode,
    theme,
    setThemePreference,
  } = useThemeSystem()
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  const handleLocaleChange = (locale: 'ru' | 'en') => {
    setI18nLocale(locale)
    setUILocale(locale)
  }

  const handleThemeModeChange = (mode: ThemeMode) => {
    if (mode === themeMode) return
    setThemeMode(mode)
    setUIThemeMode(mode)
  }

  const handleThemeChange = (name: string) => {
    const preset = THEME_PRESETS.find((p) => p.name === name)
    if (!preset) return

    const themeId = preset.lightId || preset.darkId
    if (themeId) {
      setThemePreference(themeId)
      const normalized = preset.name.toLowerCase().replace(/\s+/g, '-')
      useUIStore.getState().setTheme(normalized)
    }
  }

  const handleResetToDefaults = async () => {
    setIsResetting(true)
    try {
      const prefs = await profileService.resetPreferences()
      if (prefs) {
        if (prefs.themeMode) {
          setThemeMode(prefs.themeMode)
          setUIThemeMode(prefs.themeMode)
        }
        if (prefs.theme) {
          setThemePreference(prefs.theme)
        }
        if (prefs.locale) {
          setI18nLocale(prefs.locale)
          setUILocale(prefs.locale)
        }
      }
      setShowResetConfirm(false)
    } finally {
      setIsResetting(false)
    }
  }

  const getCurrentPresetName = (): string => {
    if (!theme) return ''
    return THEME_PRESETS.find(
      (p) => p.name.toLowerCase().replace(/\s+/g, '-') === theme
    )?.name ?? ''
  }

  const currentPresetName = getCurrentPresetName()

  return (
    <div className="space-y-6">
      <header className="max-w-2xl">
        <h2 className="text-lg font-semibold mb-1">{t('settings.appearance.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.appearance.description')}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsCard className="sm:col-span-2" title={t('settings.appearance.themeMode.label')}>
          <ThemeModeControl
            value={themeMode}
            onChange={handleThemeModeChange}
            ariaLabel={t('settings.appearance.themeMode.label')}
          />
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t('settings.appearance.theme.label')}
            </label>
            <ThemeControl
              value={currentPresetName}
              onChange={handleThemeChange}
              ariaLabel={t('settings.appearance.theme.label')}
            />
          </div>
        </SettingsCard>

        <SettingsCard title={t('settings.appearance.uiScale.label')}>
          <UiScaleControl />
        </SettingsCard>

        <SettingsCard title={t('settings.appearance.language.label')}>
          <LanguageControl
            value={i18nLocale}
            onChange={handleLocaleChange}
            labels={{
              ru: t('common.language.russian'),
              en: t('common.language.english'),
            }}
          />
        </SettingsCard>
      </div>

      <div className="border-t border-border pt-4">
        <button
          onClick={() => setShowResetConfirm(true)}
          className={cn(
            "px-4 py-2 rounded-lg text-sm font-medium",
            "text-muted-foreground hover:bg-interactive-hover",
            "transition-colors"
          )}
        >
          {t('auth.resetVisualSettings')}
        </button>
      </div>

      <ConfirmDialog
        open={showResetConfirm}
        onOpenChange={setShowResetConfirm}
        title={t('auth.resetVisualSettings')}
        message={t('auth.resetConfirm')}
        confirmLabel={isResetting ? t('common.loading') : t('auth.resetVisualSettings')}
        variant="warning"
        icon="alert"
        onConfirm={handleResetToDefaults}
      />
    </div>
  )
}
