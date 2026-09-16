import React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { THEME_PRESETS } from '@/lib/theme/themes'
import type { ThemeMode } from '@/types/theme'
import { useI18n } from '@/lib/i18n'
import { SegmentedControl, type SegmentedControlOption } from './settings-layout'

export { SettingsCard } from './settings-layout'

export const ThemeModeControl: React.FC<{
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
  disabled?: boolean
  ariaLabel?: string
}> = ({ value, onChange, disabled, ariaLabel }) => {
  const { t } = useI18n()
  const options: SegmentedControlOption<ThemeMode>[] = [
    { value: 'system', label: t('settings.appearance.themeMode.system') },
    { value: 'light', label: t('settings.appearance.themeMode.light') },
    { value: 'dark', label: t('settings.appearance.themeMode.dark') },
  ]

  return (
    <SegmentedControl<ThemeMode>
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={ariaLabel ?? t('settings.appearance.themeMode.label')}
      disabled={disabled}
    />
  )
}

export const ThemeControl: React.FC<{
  value: string
  onChange: (presetName: string) => void
  ariaLabel?: string
}> = ({ value, onChange, ariaLabel }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger className="w-full" aria-label={ariaLabel}>
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
)

export const LanguageControl: React.FC<{
  value: 'ru' | 'en'
  onChange: (locale: 'ru' | 'en') => void
  labels: Record<'ru' | 'en', string>
}> = ({ value, onChange, labels }) => (
  <Select value={value} onValueChange={(next) => onChange(next as 'ru' | 'en')}>
    <SelectTrigger className="w-full">
      <SelectValue>{labels[value]}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      {(['ru', 'en'] as const).map((locale) => (
        <SelectItem key={locale} value={locale}>
          {labels[locale]}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
)
