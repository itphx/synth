import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useStableItemKeys } from '@/hooks/useStableItemKeys'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import { SettingsField } from '../SettingsField'

export type ListFieldVariant = 'list' | 'chips'

export interface ListFieldProps {
  label: string
  description?: string
  /** AD-089: подсказка-иконка (ⓘ) рядом с лейблом. */
  tooltip?: string
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  addLabel?: string
  removeLabel?: string
  /** `list` — редактируемые строки, `chips` — чипы с удалением. */
  variant?: ListFieldVariant
  /** Текст пустого состояния. */
  emptyText?: string
}

const INPUT_CLASSES =
  'flex-1 min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * AD-072: унификация редакторов списка строк (`StringListEditor`, чипы, паттерны).
 * Не переполняет контейнер: `min-w-0`/`flex-wrap`, кнопки `shrink-0`.
 */
export function ListField({
  label,
  description,
  tooltip,
  values,
  onChange,
  placeholder,
  addLabel,
  removeLabel,
  variant = 'list',
  emptyText,
}: ListFieldProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const itemKeys = useStableItemKeys(values.length)

  const resolvedAdd = addLabel ?? t('common.add')
  const resolvedRemove = removeLabel ?? t('common.delete')
  const resolvedEmpty = emptyText ?? t('common.empty')

  const add = () => {
    const trimmed = draft.trim()
    if (!trimmed || values.includes(trimmed)) return
    onChange([...values, trimmed])
    setDraft('')
  }

  const addRow = () => {
    onChange([...values, ''])
  }

  const removeAt = (index: number) => {
    onChange(values.filter((_, i) => i !== index))
  }

  const updateAt = (index: number, next: string) => {
    onChange(values.map((value, i) => (i === index ? next : value)))
  }

  return (
    <SettingsField label={label} description={description} tooltip={tooltip}>
      <div className="flex flex-col gap-2 min-w-0">
        {values.length === 0 && (
          <p className="text-xs text-muted-foreground min-w-0">{resolvedEmpty}</p>
        )}

        {variant === 'list' ? (
          <div className="flex flex-col gap-1.5 min-w-0">
            {values.map((value, index) => (
              <div key={itemKeys[index]} className="flex items-center gap-2 min-w-0">
                <input
                  type="text"
                  value={value}
                  onChange={(e) => updateAt(index, e.target.value)}
                  className={cn(INPUT_CLASSES, 'font-mono')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => removeAt(index)}
                >
                  {resolvedRemove}
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 self-start"
              onClick={addRow}
            >
              {resolvedAdd}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5 min-w-0">
            {values.map((value, index) => (
              <span
                key={itemKeys[index]}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-interactive-hover px-2 py-0.5 text-xs text-foreground"
              >
                <span className="min-w-0 truncate">{value}</span>
                <button
                  type="button"
                  aria-label={`${resolvedRemove} ${value}`}
                  onClick={() => removeAt(index)}
                  className="shrink-0 rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {variant === 'chips' && (
          <div className="min-w-0 flex flex-wrap gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
              placeholder={placeholder}
              className={INPUT_CLASSES}
            />
            <Button variant="outline" size="sm" className="shrink-0" onClick={add}>
              {resolvedAdd}
            </Button>
          </div>
        )}
      </div>
    </SettingsField>
  )
}
