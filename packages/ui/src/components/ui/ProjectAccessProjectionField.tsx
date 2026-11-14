import { cn } from '@/lib/utils'
import type { ProjectAccessProjection } from '@/lib/projectAccess'

/**
 * PROP-133 §4: выбор проекции доступа к проекту.
 *
 * Три проекции — «Только автору» / «Только выбранным» / «Всем пользователям» —
 * это **проекции состояния** списка доступа, а не отдельный флаг. Подписи
 * длинные, а правая панель — 320 px, поэтому вариант с переносом строки
 * (нативные радио) вместо сегментированного контрола: подпись не обрезается
 * и не выезжает за панель (в т.ч. на телефоне).
 */
export function ProjectAccessProjectionField({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  testIdPrefix,
}: {
  value: ProjectAccessProjection
  options: { value: ProjectAccessProjection; label: string }[]
  onChange: (value: ProjectAccessProjection) => void
  disabled?: boolean
  ariaLabel: string
  testIdPrefix: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex flex-col gap-1"
      data-testid={`${testIdPrefix}-group`}
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'flex items-start gap-1.5 text-xs text-foreground',
            disabled ? 'opacity-60' : 'cursor-pointer',
          )}
        >
          <input
            type="radio"
            name={testIdPrefix}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
            data-testid={`${testIdPrefix}-${option.value}`}
            className="mt-0.5 shrink-0"
          />
          <span className="min-w-0 break-words">{option.label}</span>
        </label>
      ))}
    </div>
  )
}
