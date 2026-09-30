import { Icon } from '@/components/icon/Icon'
import type { IconName } from '@/components/icon/icons'
import { EntityIconPicker } from '@/components/ui/EntityIconPicker'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { resolveIconName, resolveIconColor } from '@/lib/entityIcon'
import { cn } from '@/lib/utils'

export interface EntityIconTriggerProps {
  /** Текущий ключ иконки (`null`/`undefined` — иконка не задана). */
  icon: string | null | undefined
  /** Текущий ключ цвета (`null`/`undefined` — цвет не задан). */
  color: string | null | undefined
  /** Выбор иконки; `null` — сброс. */
  onIconChange: (icon: string | null) => void
  /** Выбор цвета; `null` — сброс. */
  onColorChange: (color: string | null) => void
  disabled?: boolean
  /** Иконка, если ключ не задан/неизвестен (например, `folder-3`/`chat-new`). */
  fallbackIcon: IconName
  /** `data-testid` кнопки-триггера (на него опираются тесты панелей). */
  testId: string
  /** Подпись для `aria-label`/`title` (обычно название секции «Иконка и цвет»). */
  label: string
}

/**
 * Компактный триггер выбора иконки/цвета сущности (проект/сессия): рендерит
 * эффективную иконку с цветом, по клику открывает общий `EntityIconPicker`.
 * Встраивается в строку «Имя» верхних секций панелей (`SessionSettingsTab`/`ProjectTab`);
 * сохранение значений — на стороне вызывающего (`usePanelSettingSave`).
 */
export function EntityIconTrigger({
  icon,
  color,
  onIconChange,
  onColorChange,
  disabled,
  fallbackIcon,
  testId,
  label,
}: EntityIconTriggerProps) {
  const cssColor = resolveIconColor(color)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={label}
          title={label}
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded align-middle transition-colors hover:bg-interactive-hover',
            disabled ? 'cursor-default opacity-50' : 'cursor-pointer',
          )}
        >
          <Icon
            name={resolveIconName(icon) ?? fallbackIcon}
            className="size-4"
            style={cssColor ? { color: cssColor } : undefined}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-72 p-3">
        <EntityIconPicker
          icon={icon}
          color={color}
          onIconChange={onIconChange}
          onColorChange={onColorChange}
          disabled={disabled}
        />
      </PopoverContent>
    </Popover>
  )
}
