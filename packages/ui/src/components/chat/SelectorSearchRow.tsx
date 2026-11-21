import type { MouseEvent } from 'react'
import { Icon } from '../icon/Icon'

/**
 * Действие в строке поиска селектора композера (обновить, сбросить на
 * умолчание, свернуть и т.п.).
 *
 * Общая строка поиска нужна, чтобы строка и кнопки в селекторах модели и
 * агента выглядели и вели себя одинаково: набор действий передаётся списком,
 * а порядок кнопок задаёт вызывающий компонент.
 */
export interface SelectorSearchAction {
  /** Имя иконки кита (`refresh`, `arrow-go-back`, `arrow-up-s`, …). */
  icon: string
  /** Подпись для тултипа/скринридера (i18n-строка). */
  title: string
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  /** Крутить иконку (идёт запрос/обновление). */
  spinning?: boolean
  /** Маркер для тестов и отладки. */
  testId?: string
}

export interface SelectorSearchRowProps {
  value: string
  placeholder: string
  onChange: (value: string) => void
  /** Кнопка очистки — показывается только при непустом вводе. */
  onClear?: () => void
  clearTitle?: string
  /**
   * Действия справа от поля. Порядок — как в массиве: слева направо, кнопки
   * прижаты к правому краю, как у соседних селекторов композера.
   */
  actions?: SelectorSearchAction[]
  /** Автофокус поля (на мобильном выключается: он поднял бы клавиатуру). */
  autoFocus?: boolean
}

/**
 * Строка поиска селектора: иконка, поле и группа кнопок справа.
 *
 * Раскладка — один флекс-ряд (а не абсолютное позиционирование кнопок по
 * `right-*`): при разном наборе действий (у модели их больше) кнопки не
 * наезжают друг на друга, а поле само сжимается. Именно это даёт «общий вид»
 * строки в селекторах модели и агента.
 */
export function SelectorSearchRow({
  value,
  placeholder,
  onChange,
  onClear,
  clearTitle,
  actions = [],
  autoFocus = false,
}: SelectorSearchRowProps) {
  return (
    <div className="flex items-center gap-1">
      <div className="relative min-w-0 flex-1">
        <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="pl-8 pr-2 h-8 w-full text-xs bg-background border border-border rounded-md px-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          autoFocus={autoFocus}
        />
      </div>
      {/* Очистка — часть поля (сразу за ним), остальные действия — отдельной группой. */}
      {onClear && value.trim().length > 0 && (
        <button
          type="button"
          onClick={onClear}
          title={clearTitle}
          aria-label={clearTitle}
          className="shrink-0 p-1 rounded hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors"
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </button>
      )}
      {actions.length > 0 && (
        <div className="flex shrink-0 items-center gap-0.5">
          {actions.map((action) => (
            <button
              key={`${action.icon}:${action.title}`}
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              title={action.title}
              aria-label={action.title}
              data-testid={action.testId}
              className="shrink-0 p-1 rounded hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-default"
            >
              <Icon
                name={action.icon}
                className={`h-3.5 w-3.5 ${action.spinning ? 'animate-spin' : ''}`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
