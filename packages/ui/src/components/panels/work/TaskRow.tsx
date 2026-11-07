import { useState, type ReactNode } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import { MarkdownText } from './MarkdownText'
import { WORK_PRIORITY_CLASSES, WORK_PRIORITY_LABEL_KEYS } from './labels'
import type { WorkMoveTarget, WorkPriority } from './types'

export interface TaskRowProps {
  /** Заголовок пункта (plain). */
  title: string
  /** Подпись статуса/колонки (plain). */
  status?: string
  /** Приоритет пункта. */
  priority?: WorkPriority
  /**
   * Текст пункта — Markdown (описание плана / содержимое ToDo).
   *
   * В свёрнутом виде показывается **plain-превью** (без разметки), при
   * раскрытии — полный markdown.
   */
  body?: string
  /** Дополнительные бейджи (теги, связь с пунктом плана). */
  badges?: ReactNode
  /** Содержимое раскрытой строки (id, даты, зависимости). */
  details?: ReactNode
  /** Строка раскрыта при первом рендере. */
  defaultExpanded?: boolean
  /** Только чтение: действия не показываются. */
  readOnly?: boolean
  /** Изменить пункт. */
  onEdit?: () => void
  /** Переместить пункт (без списка целей — вызывающий открывает свой выбор). */
  onMove?: () => void
  /** Удалить пункт. */
  onDelete?: () => void
  /** Цели перемещения — тач-альтернатива drag & drop (ADR-044). */
  moveTargets?: WorkMoveTarget[]
  /** Пункт перемещён в цель. */
  onMoveTo?: (targetId: string) => void
  /** Длина plain-превью в свёрнутом виде (символы). */
  previewLength?: number
  /**
   * Показывать plain-превью `body` в свёрнутой строке.
   *
   * Для ToDo `body` — это тот же текст, что и `title` (заголовок = содержимое),
   * поэтому превью дублировало бы строку. План показывает превью описания.
   */
  showPreview?: boolean
  /** Маркер для тестов. */
  testId?: string
  /** Классы корня. */
  className?: string
}

/**
 * Строка пункта работы — общая для плана и ToDo (PROP-054).
 *
 * Компактная для правой панели (~300 px): одна строка + раскрытие, без
 * вложенного скролла и без `max-h-*` (пункт PROP-054 «Убрать фиксированный
 * max-h-48»). Действия появляются по наведению/фокусу, но на тач-устройствах
 * (pointer-coarse) видны всегда — иначе ими нельзя пользоваться.
 */
export function TaskRow({
  title,
  status,
  priority,
  body,
  badges,
  details,
  defaultExpanded = false,
  readOnly = false,
  onEdit,
  onMove,
  onDelete,
  moveTargets,
  onMoveTo,
  previewLength = 120,
  showPreview = true,
  testId,
  className,
}: TaskRowProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [menuOpen, setMenuOpen] = useState(false)

  const hasBody = Boolean(body && body.trim())
  const hasDetails = details !== undefined && details !== null
  const canExpand = hasBody || hasDetails
  const showMenu = Boolean(menuOpen && moveTargets && moveTargets.length > 0)

  return (
    <div
      className={cn('group relative rounded-lg border border-border/60 bg-input px-2 py-1.5', className)}
      data-testid={testId}
    >
      <div className="flex items-start gap-1.5">
        {status && (
          <span
            className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground"
            data-testid={testId ? `${testId}-status` : undefined}
          >
            {status}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="min-w-0 break-words text-xs text-foreground" data-testid={testId ? `${testId}-title` : undefined}>
              {title}
            </span>
            {badges}
            {priority && (
              <span
                className={cn(
                  'shrink-0 rounded px-1 py-0.5 text-[0.5625rem] uppercase tracking-wide',
                  WORK_PRIORITY_CLASSES[priority],
                )}
                data-testid={testId ? `${testId}-priority` : undefined}
              >
                {t(WORK_PRIORITY_LABEL_KEYS[priority])}
              </span>
            )}
          </div>

          {!expanded && hasBody && showPreview && (
            <MarkdownText
              content={body ?? ''}
              mode="plain"
              maxLength={previewLength}
              className="mt-0.5 text-[0.625rem] text-muted-foreground/70"
              testId={testId ? `${testId}-preview` : undefined}
            />
          )}
        </div>

        {!readOnly && (onEdit || onMove || onDelete || (moveTargets && moveTargets.length > 0)) && (
          <div
            className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            data-testid={testId ? `${testId}-actions` : undefined}
          >
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                title={t('work.task.action.edit')}
                aria-label={t('work.task.action.edit')}
                data-testid={testId ? `${testId}-edit` : undefined}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
              >
                <Icon name="edit-2" className="size-3.5" />
              </button>
            )}
            {(onMove || (moveTargets && moveTargets.length > 0)) && (
              <button
                type="button"
                onClick={() => {
                  if (moveTargets && moveTargets.length > 0) {
                    setMenuOpen((v) => !v)
                    return
                  }
                  onMove?.()
                }}
                title={t('work.task.action.move')}
                aria-label={t('work.task.action.move')}
                aria-expanded={moveTargets && moveTargets.length > 0 ? showMenu : undefined}
                data-testid={testId ? `${testId}-move` : undefined}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
              >
                <Icon name="expand-up-down" className="size-3.5" />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                title={t('work.task.action.delete')}
                aria-label={t('work.task.action.delete')}
                data-testid={testId ? `${testId}-delete` : undefined}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-destructive"
              >
                <Icon name="trash-2" className="size-3.5" />
              </button>
            )}
          </div>
        )}

        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? t('work.task.collapse') : t('work.task.expand')}
            aria-label={expanded ? t('work.task.collapse') : t('work.task.expand')}
            data-testid={testId ? `${testId}-expand` : undefined}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
          >
            <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-1 border-t border-border/60 pt-1" data-testid={testId ? `${testId}-details` : undefined}>
          {hasBody && (
            <MarkdownText
              content={body ?? ''}
              mode="render"
              className="text-xs"
              testId={testId ? `${testId}-body` : undefined}
            />
          )}
          {hasDetails && <div className="mt-1 text-[0.625rem] text-muted-foreground/80">{details}</div>}
        </div>
      )}

      {showMenu && (
        <div
          role="menu"
          aria-label={t('work.task.moveMenu')}
          className="mt-1 flex flex-wrap gap-1 rounded-md border border-border bg-surface-inset px-1.5 py-1"
          data-testid={testId ? `${testId}-move-menu` : undefined}
        >
          {moveTargets!.map((target) => (
            <button
              key={target.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onMoveTo?.(target.id)
              }}
              data-testid={testId ? `${testId}-move-${target.id}` : undefined}
              className="rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-foreground transition-colors hover:bg-interactive-hover"
            >
              {target.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
