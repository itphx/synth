import { PROJECT_COLORS } from '@/lib/projectMeta'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

interface ColorPickerProps {
  value: string | null
  onChange: (color: string) => void
}

/**
 * Палитра агентов — общая палитра темы из `PROJECT_COLORS` (`a1..a16`), без
 * собственного списка цветов. Сохраняемое значение — имя CSS-переменной без
 * обёртки `var()` (`--palette-1` … `--palette-16` по индексу слота), поэтому
 * места рендера агентского цвета (`resolveColor()`/`var(${color})`) работают
 * без изменений. Старые сохранённые значения (`--primary` и т.п.) совместимы.
 */
export const ColorPicker = ({ value, onChange }: ColorPickerProps) => {
  const { t } = useI18n()

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={() => onChange('')}
        data-testid="agent-color-none"
        className={cn(
          'size-[var(--control-height)] rounded-full border-2 flex items-center justify-center text-[0.625rem]',
          !value
            ? 'border-primary'
            : 'border-border hover:border-muted-foreground',
        )}
        title={t('admin.colorPicker.default')}
      >
        <span className="text-muted-foreground">—</span>
      </button>
      {PROJECT_COLORS.map((color, index) => {
        const cssVarName = `--palette-${index + 1}`
        return (
          <button
            key={color.key}
            type="button"
            onClick={() => onChange(cssVarName)}
            data-testid={`agent-color-${color.key}`}
            title={t(color.labelKey)}
            className={cn(
              'size-[var(--control-height)] rounded-full border-2 transition-colors',
              value === cssVarName
                ? 'border-primary scale-110'
                : 'border-transparent hover:scale-105',
            )}
            style={{ background: color.cssVar }}
          />
        )
      })}
    </div>
  )
}
