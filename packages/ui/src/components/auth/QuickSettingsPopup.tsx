import { useState, useEffect } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'
import { useThemeSystem } from '@/contexts/useThemeSystem'
import { useI18n } from '@/lib/i18n'
import { api } from '@/lib/api/client'
import { profileService } from '@/lib/api/profileService'
import { Icon } from '@/components/icon/Icon'
import type { IconName } from '@/components/icon/icons'
import { cn } from '@/lib/utils'
import { isPwaStandalone } from '@/lib/pwa'
import { useFullscreen } from '@/hooks/useFullscreen'
import { UiScaleControl } from '@/components/settings/UiScaleControl'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SegmentedControl } from '@/components/ui/settings'

interface QuickSettingsPopupProps {
  onSettingsClick: () => void
}

export const QuickSettingsPopup = ({ onSettingsClick }: QuickSettingsPopupProps) => {
  const { t, locale: uiLocale, setLocale: setI18nLocale } = useI18n()
  const user = useAuthStore(s => s.user)
  const profile = useAuthStore(s => s.profile)
  const themeMode = useUIStore(s => s.themeMode)
  const setThemeMode = useUIStore(s => s.setThemeMode)
  const setSettingsDialogOpen = useUIStore(s => s.setSettingsDialogOpen)
  const setSettingsPage = useUIStore(s => s.setSettingsPage)
  const { setThemeMode: setThemeSystemMode } = useThemeSystem()
  const [isOpen, setIsOpen] = useState(false)
  const [locales, setLocales] = useState<Array<{ value: string; label: string }>>([])
  const { isFullscreen, supported: fullscreenSupported, toggle: toggleFullscreen } = useFullscreen()

  useEffect(() => {
    const loadLocales = async () => {
      try {
        const data = await api.getLocales()
        setLocales(data.locales.map(loc => ({
          value: loc.code,
          label: loc.code === 'ru' ? t('common.language.russian') : t('common.language.english'),
        })))
      } catch {
        setLocales([
          { value: 'ru', label: t('common.language.russian') },
          { value: 'en', label: t('common.language.english') },
        ])
      }
    }
    loadLocales()
  }, [t])

  if (!user) return null

  const handleLocaleChange = (newLocale: string) => {
    // Единственный источник истины — `useI18nStore`; профиль синхронизируем явно.
    setI18nLocale(newLocale as 'ru' | 'en')
    void profileService.syncLocaleToProfile(newLocale as 'ru' | 'en')
  }

  const handleThemeModeChange = (mode: 'system' | 'light' | 'dark') => {
    setThemeMode(mode)
    setThemeSystemMode(mode)
  }

  const themeOptions: Array<{ value: 'system' | 'light' | 'dark'; label: string; icon: IconName }> = [
    { value: 'system', label: t('settings.appearance.themeMode.system'), icon: 'computer' },
    { value: 'light', label: t('settings.appearance.themeMode.light'), icon: 'sun' },
    { value: 'dark', label: t('settings.appearance.themeMode.dark'), icon: 'moon' },
  ]

  const actionItemClass = cn(
    'w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-left',
    'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
    'transition-colors'
  )

  const settingRowClass = 'flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5'

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-2 rounded-lg px-2 py-1.5',
            'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
            'transition-colors'
          )}
        >
          <div className="size-5 rounded-full bg-interactive-selection flex items-center justify-center overflow-hidden">
            {profile?.preferences?.avatar ? (
              <img
                src={profile.preferences.avatar}
                alt={user.username}
                className="size-full object-cover"
              />
            ) : (
              <span className="text-xs font-medium text-interactive-selection-foreground">
                {user.username.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <Icon name={isOpen ? 'arrow-up-s' : 'arrow-down-s'} className="size-4" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={4} className="w-72 p-0">
        <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border/40">
          <div className="size-8 shrink-0 rounded-full bg-interactive-selection flex items-center justify-center overflow-hidden">
            {profile?.preferences?.avatar ? (
              <img
                src={profile.preferences.avatar}
                alt={user.username}
                className="size-full object-cover"
              />
            ) : (
              <span className="text-xs font-medium text-interactive-selection-foreground">
                {user.username.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground truncate">{profile?.display_name || user.username}</p>
            {user.email && (
              <p className="text-xs text-muted-foreground truncate">{user.email}</p>
            )}
          </div>
        </div>

        <div className="p-1.5 space-y-0.5">
          <div className={settingRowClass}>
            <span className="text-xs text-muted-foreground">{t('settings.appearance.themeMode.label')}</span>
            <SegmentedControl
              value={themeMode}
              options={themeOptions}
              onChange={handleThemeModeChange}
              ariaLabel={t('settings.appearance.themeMode.label')}
            />
          </div>

          <div className={settingRowClass}>
            <span className="text-xs text-muted-foreground">{t('settings.appearance.language.label')}</span>
            {locales.length > 2 ? (
              <Select value={uiLocale} onValueChange={handleLocaleChange}>
                <SelectTrigger className="w-32" aria-label={t('settings.appearance.language.label')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((loc) => (
                    <SelectItem key={loc.value} value={loc.value}>{loc.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <SegmentedControl
                value={uiLocale}
                options={locales}
                onChange={handleLocaleChange}
                ariaLabel={t('settings.appearance.language.label')}
              />
            )}
          </div>

          <div className="rounded-lg px-2.5 py-1.5">
            <UiScaleControl stacked={false} fluid />
          </div>
        </div>

        <div className="p-1.5 border-t border-border/40">
          <button
            onClick={() => {
              setIsOpen(false)
              window.location.reload()
            }}
            className={actionItemClass}
          >
            <Icon name="refresh" className="size-3.5" />
            {t('auth.reloadPage')}
          </button>
          {fullscreenSupported && !isPwaStandalone() && (
            <button
              onClick={() => toggleFullscreen()}
              className={actionItemClass}
            >
              <Icon name={isFullscreen ? 'fullscreen-exit' : 'fullscreen'} className="size-3.5" />
              {isFullscreen ? t('auth.exitFullscreen') : t('auth.fullscreen')}
            </button>
          )}
          <button
            onClick={() => {
              onSettingsClick()
              setIsOpen(false)
            }}
            className={actionItemClass}
          >
            <Icon name="settings" className="size-3.5" />
            {t('auth.openSettings')}
          </button>
          {user?.roles?.includes('ADMIN') && (
            <button
              onClick={() => {
                setSettingsPage('dashboard')
                setSettingsDialogOpen(true)
                setIsOpen(false)
              }}
              className={actionItemClass}
            >
              <Icon name="admin" className="size-3.5" />
              {t('auth.admin')}
            </button>
          )}
          <div className="mt-1 pt-1 border-t border-border/40">
            <button
              onClick={() => {
                setIsOpen(false)
                useAuthStore.getState().logout()
              }}
              className={actionItemClass}
            >
              <Icon name="logout" className="size-3.5" />
              {t('auth.logout')}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}