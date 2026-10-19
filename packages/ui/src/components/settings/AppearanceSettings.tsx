import { useEffect, useMemo, useRef, useState } from 'react'
import { useUIStore } from "../../stores/useUIStore"
import { THEME_PRESETS } from "@/lib/theme/themes"
import type { ThemeMode } from "@/types/theme"
import { useThemeSystem } from "@/contexts/useThemeSystem"
import { useI18n } from "@/lib/i18n"
import { profileService } from '@/lib/api/profileService'
import { applyUiScale, getDefaultUiScale, persistUiScale } from '@/lib/uiScale'
import { SettingsActions, SettingsItem, SettingsPanel, SettingsSection, useSettingsDraft } from '../ui/settings'
import { UiScaleControl } from './UiScaleControl'
import { ThemeModeControl, ThemeControl, LanguageControl } from './appearance-controls'

interface AppearanceDraft {
  themeMode: ThemeMode
  themePresetName: string
  locale: 'ru' | 'en'
  uiScale: number
}

const presetNameFromTheme = (themeId: string): string => {
  if (!themeId) return ''
  return THEME_PRESETS.find((p) => p.id === themeId)?.id ?? ''
}

const DEFAULT_THEME_PRESET_NAME =
  THEME_PRESETS.find((p) => p.id === 'synthesis')?.id ?? 'synthesis'

export const AppearanceSettings = () => {
  const { locale: i18nLocale, setLocale: setI18nLocale, t } = useI18n()
  const {
    themeMode,
    setThemeMode,
    theme,
    setThemePreference,
  } = useThemeSystem()
  const uiScale = useUIStore((s) => s.uiScale)

  const defaultAppearance = useMemo<AppearanceDraft>(() => ({
    themeMode: 'system',
    themePresetName: DEFAULT_THEME_PRESET_NAME,
    locale: 'ru',
    uiScale: getDefaultUiScale(),
  }), [])

  // Снапшот на момент открытия панели — к нему откатывают Cancel и закрытие.
  const [snapshot] = useState<AppearanceDraft>(() => ({
    themeMode,
    themePresetName: presetNameFromTheme(theme),
    locale: i18nLocale === 'en' ? 'en' : 'ru',
    uiScale,
  }))

  // ADR-072 (фидбек): live-preview без персиста. Все визуальные настройки
  // применяются к UI сразу, но в профиль/localStorage попадают только по Save.
  const applyAppearance = (next: AppearanceDraft) => {
    const preset = THEME_PRESETS.find((p) => p.id === next.themePresetName)
    if (preset) {
      const themeId = preset.lightId || preset.darkId
      if (themeId) setThemePreference(themeId)
      // Прямой setState вместо экшена стора: экшены `setTheme*`/`setLocale`
      // сразу пишут в профиль, а preview не должен персистить.
      useUIStore.getState().setAppearancePreview({ theme: preset.id })
    }
    setThemeMode(next.themeMode)
    // Язык применяется через `useI18nStore` (единственный источник истины).
    useUIStore.getState().setAppearancePreview({ themeMode: next.themeMode, uiScale: next.uiScale })
    setI18nLocale(next.locale)
    applyUiScale(next.uiScale)
  }

  const applyRef = useRef(applyAppearance)
  applyRef.current = applyAppearance
  const savedRef = useRef<AppearanceDraft>(snapshot)

  const draft = useSettingsDraft<AppearanceDraft>({
    value: snapshot,
    defaultValue: defaultAppearance,
    onSave: async (next) => {
      const themeId = next.themePresetName
      await profileService.syncThemeModeToProfile(next.themeMode)
      // Кастомная тема может не входить в пресеты — не затираем её пустым значением.
      if (themeId) {
        await profileService.syncThemeToProfile(themeId)
      }
      await profileService.syncLocaleToProfile(next.locale)
      persistUiScale(next.uiScale)
      useUIStore.getState().setAppearancePreview({ uiScale: next.uiScale })
      savedRef.current = next
      return next
    },
  })

  // Размонтирование без Save (= закрытие окна) откатывает live-preview к снапшоту.
  useEffect(() => () => {
    applyRef.current(savedRef.current)
  }, [])

  const current = draft.draft ?? snapshot

  const update = (patch: Partial<AppearanceDraft>) => {
    const next = { ...current, ...patch }
    draft.setDraft(next)
    applyAppearance(next)
  }

  const handleCancel = () => {
    draft.revert()
    applyAppearance(savedRef.current)
  }

  const handleReset = () => {
    draft.resetToDefault()
    applyAppearance(defaultAppearance)
  }

  return (
    <SettingsPanel
      title={t('settings.appearance.title')}
      description={t('settings.appearance.description')}
    >
      <SettingsSection
        id="appearance-theme-mode"
        title={t('settings.appearance.themeMode.label')}
      >
        <SettingsItem>
          <ThemeModeControl
            value={current.themeMode}
            onChange={(mode) => update({ themeMode: mode })}
            ariaLabel={t('settings.appearance.themeMode.label')}
          />
        </SettingsItem>
        <SettingsItem>
          <ThemeControl
            value={current.themePresetName}
            onChange={(name) => update({ themePresetName: name })}
            label={t('settings.appearance.theme.label')}
            ariaLabel={t('settings.appearance.theme.label')}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsSection
        id="appearance-ui-scale"
        title={t('settings.appearance.uiScale.label')}
      >
        <SettingsItem>
          <UiScaleControl
            value={current.uiScale}
            onChange={(value) => update({ uiScale: value })}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsSection
        id="appearance-language"
        title={t('settings.appearance.language.label')}
      >
        <SettingsItem>
          <LanguageControl
            value={current.locale}
            onChange={(locale) => update({ locale })}
            labels={{
              ru: t('common.language.russian'),
              en: t('common.language.english'),
            }}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsActions
        align="start"
        onSave={() => void draft.save()}
        onCancel={handleCancel}
        onReset={handleReset}
        saving={draft.saving}
        saveDisabled={!draft.dirty}
        cancelDisabled={!draft.dirty}
        isDefault={draft.isDefault}
        saveTestId="appearance-save"
        cancelTestId="appearance-cancel"
        resetTestId="appearance-reset"
      />
    </SettingsPanel>
  )
}
