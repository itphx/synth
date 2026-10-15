import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useStableItemKeys } from '@/hooks/useStableItemKeys'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import { SettingsField } from '../SettingsField'

export interface KeyValueFieldProps {
  label: string
  description?: string
  /** ADR-089: подсказка-иконка (ⓘ) рядом с лейблом. */
  tooltip?: string
  /** Пары ключ→значение; порядок строк — как в `Object.entries`. */
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
  removeLabel?: string
  /** Текст пустого состояния. */
  emptyText?: string
  keyAriaLabel?: string
  valueAriaLabel?: string
  /** `data-testid` контейнера строк (для тестов и e2e). */
  testId?: string
}

interface KeyValuePair {
  k: string
  v: string
}

const INPUT_CLASSES =
  'flex-1 min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

const toPairs = (value: Record<string, string>): KeyValuePair[] =>
  Object.entries(value).map(([k, v]) => ({ k, v }))

const toObject = (pairs: KeyValuePair[]): Record<string, string> =>
  Object.fromEntries(pairs.map((pair) => [pair.k, pair.v]))

/** Сравнение по парам (порядок значим) — отличает внешнее изменение от нашей же эмиссии. */
const samePairs = (value: Record<string, string>, prev: Record<string, string>): boolean => {
  const a = Object.entries(value)
  const b = Object.entries(prev)
  return a.length === b.length && a.every(([k, v], i) => k === b[i][0] && v === b[i][1])
}

/**
 * ADR-072: редактор пар ключ→значение (`Record<string, string>`, напр. `identityMap`).
 *
 * Строки держатся локальным массивом пар: так порядок сохраняется, а «пустой»/
 * дублирующийся ключ не схлопывает строку прямо во время ввода (наружу уходит
 * объект, где при дубле ключа побеждает последнее значение). Локальный массив
 * пересобирается из `value` только при внешнем изменении — не на эхо нашей же
 * эмиссии, иначе дубли ключей терялись бы на каждом вводе.
 */
export function KeyValueField({
  label,
  description,
  tooltip,
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  removeLabel,
  emptyText,
  keyAriaLabel,
  valueAriaLabel,
  testId,
}: KeyValueFieldProps) {
  const { t } = useI18n()
  const [pairs, setPairs] = useState<KeyValuePair[]>(() => toPairs(value))
  const emittedRef = useRef<Record<string, string>>(value)
  const itemKeys = useStableItemKeys(pairs.length)

  const resolvedAdd = addLabel ?? t('common.add')
  const resolvedRemove = removeLabel ?? t('common.delete')
  const resolvedEmpty = emptyText ?? t('common.empty')
  const resolvedKeyAria = keyAriaLabel ?? t('common.key')
  const resolvedValueAria = valueAriaLabel ?? t('common.value')

  useEffect(() => {
    if (samePairs(value, emittedRef.current)) return
    emittedRef.current = value
    setPairs(toPairs(value))
  }, [value])

  const commit = (next: KeyValuePair[]) => {
    setPairs(next)
    const obj = toObject(next)
    emittedRef.current = obj
    onChange(obj)
  }

  const addRow = () => {
    commit([...pairs, { k: '', v: '' }])
  }

  const removeAt = (index: number) => {
    commit(pairs.filter((_, i) => i !== index))
  }

  const updateAt = (index: number, patch: Partial<KeyValuePair>) => {
    commit(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)))
  }

  return (
    <SettingsField label={label} description={description} tooltip={tooltip}>
      <div className="flex flex-col gap-2 min-w-0" data-testid={testId}>
        {pairs.length === 0 && (
          <p className="text-xs text-muted-foreground min-w-0">{resolvedEmpty}</p>
        )}

        <div className="flex flex-col gap-1.5 min-w-0">
          {pairs.map((pair, index) => (
            <div key={itemKeys[index]} className="flex items-center gap-2 min-w-0">
              <input
                type="text"
                value={pair.k}
                onChange={(e) => updateAt(index, { k: e.target.value })}
                placeholder={keyPlaceholder}
                aria-label={resolvedKeyAria}
                className={cn(INPUT_CLASSES, 'font-mono')}
              />
              <input
                type="text"
                value={pair.v}
                onChange={(e) => updateAt(index, { v: e.target.value })}
                placeholder={valuePlaceholder}
                aria-label={resolvedValueAria}
                className={INPUT_CLASSES}
              />
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                aria-label={resolvedRemove}
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
      </div>
    </SettingsField>
  )
}
