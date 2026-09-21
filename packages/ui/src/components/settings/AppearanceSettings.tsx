import { useState } from 'react'
import { useUIStore } from "../../stores/useUIStore"
import { THEME_PRESETS } from "@/lib/theme/themes"
import type { ThemeMode } from "@/types/theme"
import { useThemeSystem } from "@/contexts/useThemeSystem"
import { useI18n } from "@/lib/i18n"
import { profileService } from '@/lib/api/profileService'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { SettingsActions, SettingsPanel, SettingsSection } from '../ui/settings'
import { UiScaleControl } from './UiScaleControl'
import { ThemeModeControl, ThemeControl, LanguageControl } from './appearance-controls'

export const AppearanceSettings = () => {
  const setUILocale = useUIStore(s => s.setLocale)
  const setUIThemeMode = useUIStore(s => s.setThemeMode)
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
    <>
      <SettingsPanel
        title={t('settings.appearance.title')}
        description={t('settings.appearance.description')}
        footer={
          <SettingsActions
            align="start"
            onReset={() => setShowResetConfirm(true)}
            resetLabel={t('auth.resetVisualSettings')}
            resetDisabled={isResetting}
            resetTestId="appearance-reset"
          />
        }
      >
        <SettingsSection title={t('settings.appearance.themeMode.label')}>
          <ThemeModeControl
            value={themeMode}
            onChange={handleThemeModeChange}
            ariaLabel={t('settings.appearance.themeMode.label')}
          />
          <ThemeControl
            value={currentPresetName}
            onChange={handleThemeChange}
            label={t('settings.appearance.theme.label')}
            ariaLabel={t('settings.appearance.theme.label')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.appearance.uiScale.label')}>
          <UiScaleControl />
        </SettingsSection>

        <SettingsSection title={t('settings.appearance.language.label')}>
          <LanguageControl
            value={i18nLocale}
            onChange={handleLocaleChange}
            labels={{
              ru: t('common.language.russian'),
              en: t('common.language.english'),
            }}
          />
        </SettingsSection>
      </SettingsPanel>

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
    </>
  )
}
