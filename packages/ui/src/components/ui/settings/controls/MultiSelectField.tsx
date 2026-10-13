import React from 'react'

import { cn } from '@/lib/utils'

import { SettingsField } from '../SettingsField'

export interface MultiSelectOption {
  value: string
  label: React.ReactNode
}

export interface MultiSelectFieldProps {
  label?: string
  description?: string
  /** AD-089: подсказка-иконка (ⓘ) рядом с лейблом. */
  tooltip?: string
  error?: string
  /** Текущее подмножество выбранных значений. */
  values: string[]
  options: MultiSelectOption[]
  onChange: (next: string[]) => void
  disabled?: boolean
  /** Префикс `data-testid` опций: `<prefix>-<value>` (не буквенно-цифровые → `-`). */
  testIdPrefix?: string
  /** Текст, показываемый, когда ничего не выбрано (плюс к самим чипам). */
  emptyText?: string
  /** Дополнительные классы контейнера `SettingsField`. */
  containerClassName?: string
}

/** Значение опции → безопасный фрагмент `data-testid` (`events:*` → `events-all`). */
function safeId(value: string): string {
  return value.replace(/:/g, '-').replace(/\*/g, 'all')
}

/**
 * AD-052/AD-072: мульти-выбор из фиксированного набора — чипы-переключатели.
 * Порядок выбранных значений нормализуется по порядку `options` (детерминированный
 * payload). Пригоден для ролей, scopes и проектной проекции service-ключа.
 */
export function MultiSelectField({
  label,
  description,
  tooltip,
  error,
  values,
  options,
  onChange,
  disabled,
  testIdPrefix,
  emptyText,
  containerClassName,
}: MultiSelectFieldProps) {
  const selected = new Set(values)

  const toggle = (value: string) => {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange(options.filter((option) => next.has(option.value)).map((option) => option.value))
  }

  return (
    <SettingsField
      label={label}
      description={description}
      error={error}
      tooltip={tooltip}
      className={containerClassName}
    >
      {values.length === 0 && emptyText && (
        <p className="text-xs text-muted-foreground min-w-0 break-words">{emptyText}</p>
      )}
      <div className="flex flex-wrap gap-1.5 min-w-0" role="group" aria-label={label}>
        {options.map((option) => {
          const active = selected.has(option.value)
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => toggle(option.value)}
              data-testid={testIdPrefix ? `${testIdPrefix}-${safeId(option.value)}` : undefined}
              className={cn(
                'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
              )}
            >
              <span className="min-w-0 truncate">{option.label}</span>
            </button>
          )
        })}
      </div>
    </SettingsField>
  )
}
