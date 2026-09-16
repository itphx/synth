import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

const COLORS = [
  '--primary',
  '--status-info',
  '--status-success',
  '--status-warning',
  '--status-error',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--syntax-keyword',
  '--syntax-function',
  '--syntax-number',
  '--syntax-type',
  '--syntax-variable',
]

interface ColorPickerProps {
  value: string | null
  onChange: (color: string) => void
}

export const ColorPicker = ({ value, onChange }: ColorPickerProps) => {
  const { t } = useI18n()

  const colorLabels: Record<string, string> = {
    '--primary': t('admin.colorPicker.primary'),
    '--status-info': t('admin.colorPicker.info'),
    '--status-success': t('admin.colorPicker.success'),
    '--status-warning': t('admin.colorPicker.warning'),
    '--status-error': t('admin.colorPicker.error'),
    '--chart-1': t('admin.colorPicker.chart1'),
    '--chart-2': t('admin.colorPicker.chart2'),
    '--chart-3': t('admin.colorPicker.chart3'),
    '--chart-4': t('admin.colorPicker.chart4'),
    '--chart-5': t('admin.colorPicker.chart5'),
    '--syntax-keyword': t('admin.colorPicker.keyword'),
    '--syntax-function': t('admin.colorPicker.function'),
    '--syntax-number': t('admin.colorPicker.number'),
    '--syntax-type': t('admin.colorPicker.type'),
    '--syntax-variable': t('admin.colorPicker.variable'),
  }

  return (
  <div className="flex flex-wrap gap-1.5">
    <button
      type="button"
      onClick={() => onChange('')}
      className={cn(
        'size-7 rounded-full border-2 flex items-center justify-center text-[0.625rem]',
        !value
          ? 'border-primary'
          : 'border-border hover:border-muted-foreground',
      )}
      title={t('admin.colorPicker.default')}
    >
      <span className="text-muted-foreground">—</span>
    </button>
    {COLORS.map((c) => (
      <button
        key={c}
        type="button"
        onClick={() => onChange(c)}
        title={colorLabels[c]}
        className={cn(
          'size-7 rounded-full border-2 transition-colors',
          value === c
            ? 'border-primary scale-110'
            : 'border-transparent hover:scale-105',
        )}
        style={{ background: `var(${c})` }}
      />
    ))}
  </div>
  )
}
