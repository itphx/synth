import { useState } from 'react'
import { useUIStore } from "../../stores/useUIStore"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { THEME_PRESETS } from "@/lib/theme/themes"
import type { ThemeMode } from "@/types/theme"
import { useThemeSystem } from "@/contexts/useThemeSystem"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { profileService } from '@/lib/api/profileService'
import { ConfirmDialog } from '../ui/confirm-dialog'

const THEME_MODE_OPTIONS: { value: ThemeMode; labelKey: string }[] = [
  { value: "system", labelKey: 'settings.appearance.themeMode.system' },
  { value: "light", labelKey: 'settings.appearance.themeMode.light' },
  { value: "dark", labelKey: 'settings.appearance.themeMode.dark' },
]

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

  const handleLocaleChange = (value: string) => {
    const locale = value as 'en' | 'ru'
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

  const getLocaleName = (loc: 'en' | 'ru') => {
    return loc === 'ru' ? t('common.language.russian') : t('common.language.english')
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold mb-1">{t('settings.appearance.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.appearance.description')}</p>
      </div>

      {/* Theme mode */}
      <div className="space-y-3">
        <label className="text-sm font-medium">{t('settings.appearance.themeMode.label')}</label>
        <div className="flex gap-2" role="radiogroup" aria-label={t('settings.appearance.themeMode.label')}>
          {THEME_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              role="radio"
              aria-checked={themeMode === option.value}
              onClick={() => handleThemeModeChange(option.value)}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                themeMode === option.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
              )}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Theme selector */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('settings.appearance.theme.label')}</label>
        <Select value={currentPresetName} onValueChange={handleThemeChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEME_PRESETS.map((preset) => (
              <SelectItem key={preset.name} value={preset.name}>
                {preset.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Language */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('settings.appearance.language.label')}</label>
        <Select value={i18nLocale} onValueChange={handleLocaleChange}>
          <SelectTrigger className="w-full">
            <SelectValue>{getLocaleName(i18nLocale)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(['en', 'ru'] as const).map((loc) => (
              <SelectItem key={loc} value={loc}>
                {getLocaleName(loc)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Reset button */}
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

      {/* Reset confirmation dialog */}
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