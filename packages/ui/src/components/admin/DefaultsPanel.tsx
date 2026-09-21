import { useEffect, useState } from 'react'
import { api, type UserPreferences } from '@/lib/api/client'
import { useI18n } from '@/lib/i18n'
import { profileService } from '@/lib/api/profileService'
import { confirm } from '@/lib/confirm'
import { THEME_PRESETS } from '@/lib/theme/themes'
import type { ThemeMode } from '@/types/theme'
import {
  UI_SCALE_MOBILE_DEFAULT,
  UI_SCALE_DESKTOP_DEFAULT,
  applyUiScale,
  isMobileScaleDevice,
  normalizeUiScale,
  setServerScaleDefaults,
} from '@/lib/uiScale'
import { UiScaleSlider } from '@/components/settings/UiScaleControl'
import {
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  useSettingsDraft,
} from '@/components/ui/settings'
import {
  ThemeModeControl,
  ThemeControl,
  LanguageControl,
} from '@/components/settings/appearance-controls'

interface DefaultsDraft {
  locale: 'ru' | 'en'
  themeMode: ThemeMode
  theme: string
  uiScaleMobile: number
  uiScaleDesktop: number
}

const themeToPresetName = (theme: string): string =>
  THEME_PRESETS.find((p) => p.name.toLowerCase().replace(/\s+/g, '-') === theme)?.name ?? ''

const presetNameToTheme = (name: string): string => name.toLowerCase().replace(/\s+/g, '-')

const toDraft = (defaults: UserPreferences): DefaultsDraft => ({
  locale: defaults.locale ?? 'ru',
  themeMode: defaults.themeMode ?? 'system',
  theme: defaults.theme ?? 'flexoki',
  uiScaleMobile: normalizeUiScale(defaults.uiScaleMobile ?? UI_SCALE_MOBILE_DEFAULT),
  uiScaleDesktop: normalizeUiScale(defaults.uiScaleDesktop ?? UI_SCALE_DESKTOP_DEFAULT),
})

export const DefaultsPanel = () => {
  const { t } = useI18n()
  const [serverDefaults, setServerDefaults] = useState<DefaultsDraft | null>(null)

  const draft = useSettingsDraft<DefaultsDraft>({
    value: serverDefaults,
    onSave: async (next) => {
      await api.updateDefaults({
        locale: next.locale,
        themeMode: next.themeMode,
        theme: next.theme,
        uiScaleMobile: next.uiScaleMobile,
        uiScaleDesktop: next.uiScaleDesktop,
      })
      setServerScaleDefaults({
        mobile: next.uiScaleMobile,
        desktop: next.uiScaleDesktop,
      })
      setServerDefaults(next)
      return next
    },
  })

  useEffect(() => {
    let alive = true
    void (async () => {
      const defaults = toDraft(await profileService.getDefaults())
      if (alive) setServerDefaults(defaults)
    })()
    return () => {
      alive = false
    }
  }, [])

  const current = draft.draft

  const update = (patch: Partial<DefaultsDraft>) => {
    draft.update(patch)
  }

  const handleMobileScaleChange = (value: number) => {
    update({ uiScaleMobile: value })
    if (isMobileScaleDevice()) {
      applyUiScale(value)
    }
  }

  const handleDesktopScaleChange = (value: number) => {
    update({ uiScaleDesktop: value })
    if (!isMobileScaleDevice()) {
      applyUiScale(value)
    }
  }

  const handleReset = async () => {
    if (!(await confirm({ title: t('admin.defaults.confirmReset'), variant: 'danger' }))) return
    const defaults = toDraft(await profileService.getDefaults())
    setServerDefaults(defaults)
    draft.setDraft(defaults)
    applyUiScale(isMobileScaleDevice() ? defaults.uiScaleMobile : defaults.uiScaleDesktop)
  }

  return (
    <SettingsPanel
      title={t('admin.defaults.title')}
      description={t('admin.defaults.description')}
    >
      {current == null ? (
        <div className="bg-background rounded-xl border p-5 animate-pulse space-y-3">
          <div className="h-4 bg-muted rounded w-48" />
          <div className="h-4 bg-muted rounded w-32" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SettingsSection className="sm:col-span-2" title={t('settings.appearance.themeMode.label')}>
              <ThemeModeControl
                value={current.themeMode}
                onChange={(mode) => update({ themeMode: mode })}
                ariaLabel={t('settings.appearance.themeMode.label')}
              />
              <ThemeControl
                label={t('settings.appearance.theme.label')}
                value={themeToPresetName(current.theme)}
                onChange={(name) => update({ theme: presetNameToTheme(name) })}
                ariaLabel={t('settings.appearance.theme.label')}
              />
            </SettingsSection>

            <SettingsSection title={t('settings.appearance.uiScale.label')}>
              <UiScaleSlider
                label={t('settings.appearance.uiScale.mobile')}
                value={current.uiScaleMobile}
                onChange={handleMobileScaleChange}
              />
              <UiScaleSlider
                label={t('settings.appearance.uiScale.desktop')}
                value={current.uiScaleDesktop}
                onChange={handleDesktopScaleChange}
              />
            </SettingsSection>

            <SettingsSection title={t('settings.appearance.language.label')}>
              <LanguageControl
                value={current.locale}
                onChange={(locale) => update({ locale })}
                labels={{
                  ru: t('admin.defaults.russian'),
                  en: t('admin.defaults.english'),
                }}
              />
            </SettingsSection>
          </div>

          <SettingsActions
            onSave={() => void draft.save()}
            onReset={handleReset}
            saving={draft.saving}
            saveDisabled={!draft.dirty}
            resetDisabled={current == null}
            saveTestId="defaults-save"
            resetTestId="defaults-reset"
          />
        </>
      )}
    </SettingsPanel>
  )
}
