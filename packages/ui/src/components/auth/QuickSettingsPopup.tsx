import { useState, useRef, useEffect } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'
import { useThemeSystem } from '@/contexts/useThemeSystem'
import { useI18n } from '@/lib/i18n'
import { api } from '@/lib/api/client'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { isPwaStandalone } from '@/lib/pwa'
import { useFullscreen } from '@/hooks/useFullscreen'
import { UiScaleControl } from '@/components/settings/UiScaleControl'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface QuickSettingsPopupProps {
  onSettingsClick: () => void
}

export const QuickSettingsPopup = ({ onSettingsClick }: QuickSettingsPopupProps) => {
  const { t, setLocale: setI18nLocale } = useI18n()
  const { user, profile } = useAuthStore()
  const { themeMode, setThemeMode, locale: uiLocale, setLocale: setUILocale, setSettingsDialogOpen, setSettingsPage } = useUIStore()
  const { setThemeMode: setThemeSystemMode } = useThemeSystem()
  const [isOpen, setIsOpen] = useState(false)
  const [locales, setLocales] = useState<Array<{ value: string; label: string }>>([])
  const { isFullscreen, supported: fullscreenSupported, toggle: toggleFullscreen } = useFullscreen()
  const menuRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  if (!user) return null

  const handleLocaleChange = (newLocale: string) => {
    setI18nLocale(newLocale as 'ru' | 'en')
    setUILocale(newLocale as 'ru' | 'en')
  }

  const handleThemeModeChange = (mode: 'system' | 'light' | 'dark') => {
    setThemeMode(mode)
    setThemeSystemMode(mode)
  }

  const themeOptions: Array<{ value: 'system' | 'light' | 'dark'; label: string; title: string }> = [
    { value: 'system', label: t('settings.appearance.themeMode.system'), title: t('settings.appearance.themeMode.system') },
    { value: 'light', label: t('settings.appearance.themeMode.light'), title: t('settings.appearance.themeMode.light') },
    { value: 'dark', label: t('settings.appearance.themeMode.dark'), title: t('settings.appearance.themeMode.dark') },
  ]

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 rounded-lg px-2 py-1.5",
          "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
          "transition-colors"
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

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-border bg-popover shadow-lg z-50">
          <div className="px-3 py-2 border-b border-border/30">
            <p className="text-xs font-medium text-foreground">{profile?.display_name || user.username}</p>
            {user.email && (
              <p className="text-xs text-muted-foreground truncate">{user.email}</p>
            )}
          </div>

          <div className="p-3 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-2">{t('settings.appearance.themeMode.label')}</p>
              <div className="flex gap-1">
                {themeOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleThemeModeChange(opt.value)}
                    title={opt.title}
                    data-compact
                    className={cn(
                      "flex-1 px-2 py-1.5 rounded-md text-base leading-none font-medium transition-colors",
                      themeMode === opt.value
                        ? "bg-interactive-selection text-interactive-selection-foreground"
                        : "bg-interactive-hover text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {opt.value === 'system' ? '●' : opt.value === 'light' ? '◐' : '◑'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-2">{t('settings.appearance.language.label')}</p>
              {locales.length > 2 ? (
                <Select value={uiLocale} onValueChange={handleLocaleChange}>
                  <SelectTrigger className="w-full" aria-label={t('settings.appearance.language.label')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {locales.map((loc) => (
                      <SelectItem key={loc.value} value={loc.value}>{loc.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex gap-1">
                  {locales.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleLocaleChange(opt.value)}
                      data-compact
                      className={cn(
                        "flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors",
                        uiLocale === opt.value
                          ? "bg-interactive-selection text-interactive-selection-foreground"
                          : "bg-interactive-hover text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <UiScaleControl />
          </div>

          <div className="p-1 border-t border-border/30">
            <button
              onClick={() => {
                setIsOpen(false)
                window.location.reload()
              }}
              className={cn(
                "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left",
                "text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground",
                "transition-colors"
              )}
            >
              <Icon name="refresh" className="size-3.5" />
              {t('auth.reloadPage')}
            </button>
            {fullscreenSupported && !isPwaStandalone() && (
              <button
                onClick={() => toggleFullscreen()}
                className={cn(
                  "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left",
                  "text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground",
                  "transition-colors"
                )}
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
              className={cn(
                "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left",
                "text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground",
                "transition-colors"
              )}
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
                className={cn(
                  "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left",
                  "text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground",
                  "transition-colors"
                )}
              >
                <Icon name="admin" className="size-3.5" />
                {t('auth.admin')}
              </button>
            )}
            <button
              onClick={() => {
                setIsOpen(false)
                useAuthStore.getState().logout()
              }}
              className={cn(
                "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left",
                "text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground",
                "transition-colors"
              )}
            >
              <Icon name="logout" className="size-3.5" />
              {t('auth.logout')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}