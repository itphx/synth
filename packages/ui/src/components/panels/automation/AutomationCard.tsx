import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { InfoField } from '@/components/ui/settings'

/**
 * Единая карточка автоматизации (PROP-141, этап 7b).
 *
 * Форма — та же, что у карточки прогона в «Процессах»: оболочка
 * (`min-w-0 space-y-2 rounded-lg border border-border bg-surface-inset p-3`),
 * шапка (иконка вида, имя, бейдж состояния), строки-подробности через
 * `InfoField` и действия иконочными кнопками справа внизу.
 *
 * Карточка общая для трёх видов: расписание (`calendar-schedule`), таймер
 * (`time`), будильник (`alarm`) — различаются иконкой, бейджем и составом
 * действий.
 */

/** Общий стиль бейджа (как в «Памяти»/«Процессах»). */
export const AUTOMATION_BADGE =
  'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/**
 * Цвет бейджа состояния по ключу.
 *
 * Ключи — общие для трёх видов: `active`/`enabled`, `paused`, `disabled`,
 * `error`, `fired`, `cancelled`.
 */
export const AUTOMATION_STATUS_CLASS: Record<string, string> = {
  active: 'bg-primary/15 text-primary',
  enabled: 'bg-primary/15 text-primary',
  paused: 'bg-status-warning/15 text-status-warning',
  disabled: 'bg-muted text-muted-foreground',
  error: 'bg-destructive/15 text-destructive',
  fired: 'bg-status-caution/15 text-status-caution',
  cancelled: 'bg-muted text-muted-foreground',
}

/** Строка «лейбл — значение» карточки. */
export interface AutomationCardField {
  label: string
  value: string
  /** Моноширинный шрифт (id, cron-выражение). */
  mono?: boolean
}

/** Иконочное действие карточки. */
export interface AutomationCardAction {
  /** Идентификатор действия — основа `data-testid`. */
  key: string
  icon: IconName
  /** Подпись (тултип + `aria-label`). */
  label: string
  onClick: () => void
  /** Действие заблокировано (идёт операция). */
  disabled?: boolean
  /** Действие удаления — красная подсветка при наведении. */
  destructive?: boolean
}

export interface AutomationCardProps {
  /** Идентификатор карточки — основа `data-testid`. */
  testId: string
  /** Иконка вида автоматизации. */
  icon: IconName
  /** Отображаемое имя (у таймера — имя или комментарий). */
  name: string
  /** Ключ состояния — задаёт цвет бейджа. */
  statusKey: string
  /** Подпись бейджа состояния. */
  statusLabel: string
  /** Строки-подробности. */
  fields: AutomationCardField[]
  /** Комментарий (усечённый) — под строками-подробностями. */
  comment?: string
  /** Текст последней ошибки. */
  error?: string
  /** Действия (иконочные кнопки). */
  actions: AutomationCardAction[]
  /** Дополнительное содержимое (раскрываемая история). */
  children?: ReactNode
}

/**
 * Карточка автоматизации — расписание, таймер или будильник.
 */
export function AutomationCard({
  testId,
  icon,
  name,
  statusKey,
  statusLabel,
  fields,
  comment,
  error,
  actions,
  children,
}: AutomationCardProps) {
  return (
    <li
      data-testid={testId}
      className="min-w-0 space-y-2 rounded-lg border border-border bg-surface-inset p-3"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
          {name}
        </span>
        <span
          className={cn(
            AUTOMATION_BADGE,
            AUTOMATION_STATUS_CLASS[statusKey] ?? 'bg-muted text-muted-foreground',
          )}
          data-testid={`${testId}-status`}
        >
          {statusLabel}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 min-w-0">
        {fields.map((field) => (
          <InfoField key={field.label} label={field.label} value={field.value} mono={field.mono} />
        ))}
      </dl>

      {comment && (
        <p className="break-words text-xs text-muted-foreground" data-testid={`${testId}-comment`}>
          {comment}
        </p>
      )}

      {error && (
        <p className="break-words text-xs text-destructive" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}

      {children}

      {actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-1">
          {actions.map((action) => (
            <Button
              key={action.key}
              variant="ghost"
              size="icon"
              className={cn(action.destructive && 'hover:text-destructive')}
              onClick={action.onClick}
              disabled={action.disabled}
              title={action.label}
              aria-label={action.label}
              data-testid={`${testId}-${action.key}`}
            >
              <Icon name={action.icon} className="size-4" />
            </Button>
          ))}
        </div>
      )}
    </li>
  )
}
