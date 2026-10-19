import React from 'react'
import { THEME_PRESETS } from '@/lib/theme/themes'
import type { ThemeMode } from '@/types/theme'
import { useI18n } from '@/lib/i18n'
import { SelectContent, SelectItem } from '@/components/ui/select'
import { SegmentedControl, SelectField, type SegmentedControlOption } from '@/components/ui/settings'

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
  label?: string
  ariaLabel?: string
  tooltip?: string
}> = ({ value, onChange, label, ariaLabel, tooltip }) => (
  <SelectField
    label={label}
    value={value}
    onValueChange={onChange}
    ariaLabel={ariaLabel}
    tooltip={tooltip}
    items={THEME_PRESETS.map((preset) => ({ value: preset.id, label: preset.name }))}
  >
    <SelectContent>
      {THEME_PRESETS.map((preset) => (
        <SelectItem key={preset.id} value={preset.id}>
          {preset.name}
        </SelectItem>
      ))}
    </SelectContent>
  </SelectField>
)

export const LanguageControl: React.FC<{
  value: 'ru' | 'en'
  onChange: (locale: 'ru' | 'en') => void
  labels: Record<'ru' | 'en', string>
  label?: string
}> = ({ value, onChange, labels, label }) => (
  <SelectField label={label} value={value} onValueChange={(next) => onChange(next as 'ru' | 'en')}>
    <SelectContent>
      {(['ru', 'en'] as const).map((locale) => (
        <SelectItem key={locale} value={locale}>
          {labels[locale]}
        </SelectItem>
      ))}
    </SelectContent>
  </SelectField>
)
