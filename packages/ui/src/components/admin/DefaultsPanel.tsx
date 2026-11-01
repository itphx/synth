import { useEffect, useState } from 'react'
import { api, type UserPreferences } from '@/lib/api/client'
import { useI18n } from '@/lib/i18n'
import { profileService } from '@/lib/api/profileService'
import { confirm } from '@/lib/confirm'
import { THEME_PRESETS } from '@/lib/theme/themes'
import type { ThemeMode } from '@/types/theme'
import { useUIStore, type ChatDensity, type ChatViewMode } from '@/stores/useUIStore'
import {
  CHAT_SCALE_DEFAULT,
  CHAT_SCALE_MIN,
  UI_SCALE_MOBILE_DEFAULT,
  UI_SCALE_DESKTOP_DEFAULT,
  applyServerDefaultChatScale,
  applyUiScale,
  clampChatScale,
  isMobileScaleDevice,
  normalizeUiScale,
  setServerChatScaleDefaults,
  setServerScaleDefaults,
} from '@/lib/uiScale'
import { ChatScaleSlider, UiScaleSlider } from '@/components/settings/UiScaleControl'
import {
  SegmentedControl,
  SettingsActions,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  useSettingsDraft,
  type SegmentedControlOption,
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
  chatViewMode: ChatViewMode
  chatDensity: ChatDensity
  chatScaleMobile: number
  chatScaleDesktop: number
}

const themeToPresetName = (theme: string): string =>
  THEME_PRESETS.find((p) => p.id === theme)?.id ?? ''

const toDraft = (defaults: UserPreferences): DefaultsDraft => ({
  locale: defaults.locale ?? 'ru',
  themeMode: defaults.themeMode ?? 'system',
  theme: defaults.theme ?? 'synthesis',
  uiScaleMobile: normalizeUiScale(defaults.uiScaleMobile ?? UI_SCALE_MOBILE_DEFAULT),
  uiScaleDesktop: normalizeUiScale(defaults.uiScaleDesktop ?? UI_SCALE_DESKTOP_DEFAULT),
  chatViewMode: defaults.chatViewMode === 'feed' ? 'feed' : 'detailed',
  chatDensity: defaults.chatDensity === 'compact' ? 'compact' : 'normal',
  // У чат-скейла свой диапазон 0.75…1.5 (мобильный минимум 0.85 — на клиенте).
  chatScaleMobile: clampChatScale(defaults.chatScaleMobile ?? CHAT_SCALE_DEFAULT),
  chatScaleDesktop: clampChatScale(defaults.chatScaleDesktop ?? CHAT_SCALE_DEFAULT),
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
        chatViewMode: next.chatViewMode,
        chatDensity: next.chatDensity,
        chatScaleMobile: next.chatScaleMobile,
        chatScaleDesktop: next.chatScaleDesktop,
      })
      setServerScaleDefaults({
        mobile: next.uiScaleMobile,
        desktop: next.uiScaleDesktop,
      })
      // Новые умолчания сразу учитываются текущей сессией: масштаб чата и режим
      // отображения применяются только тем, у кого нет личного выбора.
      setServerChatScaleDefaults({
        mobile: next.chatScaleMobile,
        desktop: next.chatScaleDesktop,
      })
      applyServerDefaultChatScale()
      useUIStore.getState().setServerChatDisplayDefaults({
        viewMode: next.chatViewMode,
        density: next.chatDensity,
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

  const handleChatScaleMobileChange = (value: number) => {
    update({ chatScaleMobile: clampChatScale(value) })
  }

  const handleChatScaleDesktopChange = (value: number) => {
    update({ chatScaleDesktop: clampChatScale(value) })
  }

  const chatViewModeOptions: SegmentedControlOption<ChatViewMode>[] = [
    { value: 'detailed', label: t('chatSettings.viewModeDetailed') },
    { value: 'feed', label: t('chatSettings.viewModeFeed') },
  ]
  const chatDensityOptions: SegmentedControlOption<ChatDensity>[] = [
    { value: 'normal', label: t('chatSettings.densityNormal') },
    { value: 'compact', label: t('chatSettings.densityCompact') },
  ]

  const handleReset = async () => {
    if (!(await confirm({ title: t('admin.defaults.confirmReset'), variant: 'danger' }))) return
    const defaults = toDraft(await profileService.getDefaults())
    setServerDefaults(defaults)
    draft.setDraft(defaults)
    applyUiScale(isMobileScaleDevice() ? defaults.uiScaleMobile : defaults.uiScaleDesktop)
    setServerChatScaleDefaults({
      mobile: defaults.chatScaleMobile,
      desktop: defaults.chatScaleDesktop,
    })
    applyServerDefaultChatScale()
    useUIStore.getState().setServerChatDisplayDefaults({
      viewMode: defaults.chatViewMode,
      density: defaults.chatDensity,
    })
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
            <SettingsSection
              id="defaults-theme-mode"
              className="sm:col-span-2"
              title={t('settings.appearance.themeMode.label')}
              tooltip={t('settings.help.defaults.section.defaults-theme-mode')}
            >
              <ThemeModeControl
                value={current.themeMode}
                onChange={(mode) => update({ themeMode: mode })}
                ariaLabel={t('settings.appearance.themeMode.label')}
              />
              <ThemeControl
                label={t('settings.appearance.theme.label')}
                value={themeToPresetName(current.theme)}
                onChange={(name) => update({ theme: name })}
                ariaLabel={t('settings.appearance.theme.label')}
                tooltip={t('settings.help.defaults.theme')}
              />
            </SettingsSection>

            <SettingsSection
              id="defaults-ui-scale"
              title={t('settings.appearance.uiScale.label')}
              tooltip={t('settings.help.defaults.section.defaults-ui-scale')}
            >
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

            <SettingsSection
              id="defaults-chat-display"
              title={t('chatSettings.display.label')}
              tooltip={t('settings.help.defaults.section.defaults-chat-display')}
            >
              <SettingsRow
                label={t('chatSettings.viewMode')}
                control={
                  <SegmentedControl<ChatViewMode>
                    value={current.chatViewMode}
                    options={chatViewModeOptions}
                    onChange={(value) => update({ chatViewMode: value })}
                    ariaLabel={t('chatSettings.viewMode')}
                  />
                }
              />
              <SettingsRow
                label={t('chatSettings.density')}
                control={
                  <SegmentedControl<ChatDensity>
                    value={current.chatDensity}
                    options={chatDensityOptions}
                    onChange={(value) => update({ chatDensity: value })}
                    ariaLabel={t('chatSettings.density')}
                  />
                }
              />
            </SettingsSection>

            <SettingsSection
              id="defaults-chat-scale"
              title={t('chatSettings.chatScale.label')}
              tooltip={t('settings.help.defaults.section.defaults-chat-scale')}
            >
              {/* Диапазон чат-скейла — 0.75…1.5 (не путать с 0.5…1.2 у uiScale). */}
              <ChatScaleSlider
                label={t('chatSettings.chatScale.mobile')}
                value={current.chatScaleMobile}
                min={CHAT_SCALE_MIN}
                onChange={handleChatScaleMobileChange}
              />
              <ChatScaleSlider
                label={t('chatSettings.chatScale.desktop')}
                value={current.chatScaleDesktop}
                min={CHAT_SCALE_MIN}
                onChange={handleChatScaleDesktopChange}
              />
            </SettingsSection>

            <SettingsSection
              id="defaults-language"
              title={t('settings.appearance.language.label')}
              tooltip={t('settings.help.defaults.section.defaults-language')}
            >
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
            onCancel={() => draft.revert()}
            onReset={handleReset}
            saving={draft.saving}
            saveDisabled={!draft.dirty}
            cancelDisabled={!draft.dirty}
            resetDisabled={current == null}
            saveTestId="defaults-save"
            cancelTestId="defaults-cancel"
            resetTestId="defaults-reset"
          />
        </>
      )}
    </SettingsPanel>
  )
}
