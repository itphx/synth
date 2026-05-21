import { useEffect, useState } from 'react'
import { api } from '@/lib/api/client'
import { useUIStore } from '@/stores/useUIStore'
import { Icon } from '@/components/icon/Icon'

const THEME_OPTIONS = [
  { value: 'flexoki', label: 'Flexoki' },
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'solarized-dark', label: 'Solarized Dark' },
  { value: 'solarized-light', label: 'Solarized Light' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'catppuccin-latte', label: 'Catppuccin Latte' },
  { value: 'catppuccin-frappe', label: 'Catppuccin Frappe' },
  { value: 'catppuccin-macchiato', label: 'Catppuccin Macchiato' },
  { value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { value: 'github-dark', label: 'GitHub Dark' },
  { value: 'github-light', label: 'GitHub Light' },
]

export const DefaultsPanel = () => {
  const { theme, setTheme, themeMode, setThemeMode, locale, setLocale } = useUIStore()
  const [saved, setSaved] = useState(false)

  const handleSave = async () => {
    try {
      await api.updateDefaults({ locale, themeMode, theme })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-lg font-semibold">Настройки по умолчанию</h3>
        <p className="text-muted-foreground text-sm mt-1">
          Применяются к новым пользователям. Существующих не затрагивают.
        </p>
      </div>

      <div className="bg-background rounded-xl border p-5 space-y-4">
        <div>
          <label className="text-sm font-medium">Язык</label>
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as 'ru' | 'en')}
            className="w-full mt-1 px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </div>

        <div>
          <label className="text-sm font-medium">Режим темы</label>
          <select
            value={themeMode}
            onChange={(e) => setThemeMode(e.target.value as 'system' | 'light' | 'dark')}
            className="w-full mt-1 px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="system">Системная</option>
            <option value="light">Светлая</option>
            <option value="dark">Тёмная</option>
          </select>
        </div>

        <div>
          <label className="text-sm font-medium">Тема</label>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            className="w-full mt-1 px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {THEME_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <button
          onClick={handleSave}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700"
        >
          <Icon name="check" className="size-4" />
          {saved ? 'Сохранено' : 'Сохранить'}
        </button>
      </div>
    </div>
  )
}
