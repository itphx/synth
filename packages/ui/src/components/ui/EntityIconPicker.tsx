import { Icon } from '@/components/icon/Icon'
import { PROJECT_ICONS, PROJECT_COLORS } from '@/lib/projectMeta'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

export interface EntityIconPickerProps {
  /** Текущий ключ иконки (`null`/`undefined` — иконка не задана). */
  icon: string | null | undefined
  /** Текущий ключ цвета (`null`/`undefined` — цвет не задан). */
  color: string | null | undefined
  /** Выбор иконки; `null` — сброс. */
  onIconChange: (icon: string | null) => void
  /** Выбор цвета; `null` — сброс. */
  onColorChange: (color: string | null) => void
  disabled?: boolean
}

/**
 * Пикер иконки и цвета для проекта/сессии (ADR-075). Только ключи реестра
 * (`PROJECT_ICONS`/`PROJECT_COLORS`), без загружаемых картинок; цвет — палитра
 * CSS-переменных. Контролируемый: сохранение — на стороне вызывающего.
 */
export function EntityIconPicker({
  icon,
  color,
  onIconChange,
  onColorChange,
  disabled,
}: EntityIconPickerProps) {
  const { t } = useI18n()

  return (
    <div className="space-y-3" data-testid="entity-picker">
      <div>
        <div className="mb-1.5 text-[0.625rem] uppercase tracking-wide text-muted-foreground/60">
          {t('leftPanel.icon')}
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onIconChange(null)}
            title={t('entityIcon.noIcon')}
            data-testid="entity-icon-none"
            className={cn(
              'flex size-7 items-center justify-center rounded-md border transition-colors',
              !icon ? 'border-primary bg-primary/10' : 'border-border hover:bg-interactive-hover',
              disabled && 'opacity-50 cursor-default',
            )}
          >
            <Icon name="close" className="size-3.5 text-muted-foreground" />
          </button>
          {PROJECT_ICONS.map(({ key, icon: iconName, label }) => (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onIconChange(key)}
              title={label}
              data-testid={`entity-icon-${key}`}
              className={cn(
                'flex size-7 items-center justify-center rounded-md border transition-colors',
                icon === key
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                disabled && 'opacity-50 cursor-default',
              )}
            >
              <Icon name={iconName} className="size-4" />
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[0.625rem] uppercase tracking-wide text-muted-foreground/60">
          {t('leftPanel.color')}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onColorChange(null)}
            title={t('entityIcon.noColor')}
            data-testid="entity-color-none"
            className={cn(
              'flex size-6 items-center justify-center rounded-full border-2 text-[0.625rem]',
              !color ? 'border-primary' : 'border-border hover:border-muted-foreground',
              disabled && 'opacity-50 cursor-default',
            )}
          >
            <span className="text-muted-foreground">—</span>
          </button>
          {PROJECT_COLORS.map(({ key, labelKey, cssVar }) => (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onColorChange(key)}
              title={t(labelKey)}
              data-testid={`entity-color-${key}`}
              className={cn(
                'size-6 rounded-full border-2 transition-transform',
                color === key ? 'border-primary scale-110' : 'border-transparent hover:scale-105',
                disabled && 'opacity-50 cursor-default',
              )}
              style={{ background: cssVar }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
