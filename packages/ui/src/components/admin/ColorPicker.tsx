import { cn } from '@/lib/utils'

const COLORS = [
  { value: '--primary', label: 'Основной' },
  { value: '--status-info', label: 'Инфо' },
  { value: '--status-success', label: 'Успех' },
  { value: '--status-warning', label: 'Предупр.' },
  { value: '--status-error', label: 'Ошибка' },
  { value: '--chart-1', label: 'График 1' },
  { value: '--chart-2', label: 'График 2' },
  { value: '--chart-3', label: 'График 3' },
  { value: '--chart-4', label: 'График 4' },
  { value: '--chart-5', label: 'График 5' },
  { value: '--syntax-keyword', label: 'Ключ.сл.' },
  { value: '--syntax-function', label: 'Функция' },
  { value: '--syntax-number', label: 'Число' },
  { value: '--syntax-type', label: 'Тип' },
  { value: '--syntax-variable', label: 'Переменная' },
]

interface ColorPickerProps {
  value: string | null
  onChange: (color: string) => void
}

export const ColorPicker = ({ value, onChange }: ColorPickerProps) => (
  <div className="flex flex-wrap gap-1.5">
    <button
      type="button"
      onClick={() => onChange('')}
      className={cn(
        'size-7 rounded-full border-2 flex items-center justify-center text-[10px]',
        !value
          ? 'border-blue-500'
          : 'border-border hover:border-muted-foreground',
      )}
      title="По умолчанию"
    >
      <span className="text-muted-foreground">—</span>
    </button>
    {COLORS.map((c) => (
      <button
        key={c.value}
        type="button"
        onClick={() => onChange(c.value)}
        title={c.label}
        className={cn(
          'size-7 rounded-full border-2 transition-colors',
          value === c.value
            ? 'border-blue-500 scale-110'
            : 'border-transparent hover:scale-105',
        )}
        style={{ background: `var(${c.value})` }}
      />
    ))}
  </div>
)
