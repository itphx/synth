import { useEffect, useState } from 'react'
import { api } from '@/lib/api/client'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { profileService } from '@/lib/api/profileService'
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
  SettingsCard,
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

export const DefaultsPanel = () => {
  const { t } = useI18n()
  const [draft, setDraft] = useState<DefaultsDraft>({
    locale: 'ru',
    themeMode: 'system',
    theme: 'flexoki',
    uiScaleMobile: UI_SCALE_MOBILE_DEFAULT,
    uiScaleDesktop: UI_SCALE_DESKTOP_DEFAULT,
  })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const defaults = await profileService.getDefaults()
      if (!alive) return
      setDraft({
        locale: defaults.locale ?? 'ru',
        themeMode: defaults.themeMode ?? 'system',
        theme: defaults.theme ?? 'flexoki',
        uiScaleMobile: normalizeUiScale(defaults.uiScaleMobile ?? UI_SCALE_MOBILE_DEFAULT),
        uiScaleDesktop: normalizeUiScale(defaults.uiScaleDesktop ?? UI_SCALE_DESKTOP_DEFAULT),
      })
    })()
    return () => {
      alive = false
    }
  }, [])

  const handleMobileScaleChange = (value: number) => {
    setDraft((prev) => ({ ...prev, uiScaleMobile: value }))
    if (isMobileScaleDevice()) {
      applyUiScale(value)
    }
  }

  const handleDesktopScaleChange = (value: number) => {
    setDraft((prev) => ({ ...prev, uiScaleDesktop: value }))
    if (!isMobileScaleDevice()) {
      applyUiScale(value)
    }
  }

  const handleSave = async () => {
    try {
      await api.updateDefaults({
        locale: draft.locale,
        themeMode: draft.themeMode,
        theme: draft.theme,
        uiScaleMobile: draft.uiScaleMobile,
        uiScaleDesktop: draft.uiScaleDesktop,
      })
      setServerScaleDefaults({
        mobile: draft.uiScaleMobile,
        desktop: draft.uiScaleDesktop,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <header className="max-w-2xl">
        <h2 className="text-lg font-semibold mb-1">{t('admin.defaults.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('admin.defaults.description')}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsCard className="sm:col-span-2" title={t('settings.appearance.themeMode.label')}>
          <ThemeModeControl
            value={draft.themeMode}
            onChange={(mode) => setDraft((prev) => ({ ...prev, themeMode: mode }))}
            ariaLabel={t('settings.appearance.themeMode.label')}
          />
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t('settings.appearance.theme.label')}
            </label>
            <ThemeControl
              value={themeToPresetName(draft.theme)}
              onChange={(name) => setDraft((prev) => ({ ...prev, theme: presetNameToTheme(name) }))}
              ariaLabel={t('settings.appearance.theme.label')}
            />
          </div>
        </SettingsCard>

        <SettingsCard title={t('settings.appearance.uiScale.label')}>
          <UiScaleSlider
            label={t('settings.appearance.uiScale.mobile')}
            value={draft.uiScaleMobile}
            onChange={handleMobileScaleChange}
          />
          <UiScaleSlider
            label={t('settings.appearance.uiScale.desktop')}
            value={draft.uiScaleDesktop}
            onChange={handleDesktopScaleChange}
          />
        </SettingsCard>

        <SettingsCard title={t('settings.appearance.language.label')}>
          <LanguageControl
            value={draft.locale}
            onChange={(locale) => setDraft((prev) => ({ ...prev, locale }))}
            labels={{
              ru: t('admin.defaults.russian'),
              en: t('admin.defaults.english'),
            }}
          />
        </SettingsCard>
      </div>

      <div className="border-t border-border pt-4">
        <button
          onClick={handleSave}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Icon name="check" className="size-4" />
          {saved ? t('admin.defaults.saved') : t('admin.defaults.save')}
        </button>
      </div>
    </div>
  )
}
