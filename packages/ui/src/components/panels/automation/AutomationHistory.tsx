import { useCallback, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'

/**
 * Раскрываемый блок истории автоматизации (PROP-141, этап 7b).
 *
 * Общий для двух видов истории: Job-история расписания (`GET
 * /schedules/:id/jobs`) и срабатывания таймера (`GET /timers/:id/firings`).
 * История грузится лениво — при первом раскрытии; повторное раскрытие отдаёт
 * кэш, кнопка «Обновить» перечитывает с сервера.
 */

/** Запись истории срабатываний. */
export interface AutomationHistoryEntry {
  id: string
  /** Ключ статуса — задаёт цвет бейджа. */
  statusKey: string
  /** Подпись статуса. */
  statusLabel: string
  /** Время (уже отформатированное). */
  time: string
  /** Дополнительная подпись (триггер, результат). */
  detail?: string
  /** Текст ошибки. */
  error?: string
}

export interface AutomationHistoryProps {
  /** Идентификатор блока — основа `data-testid`. */
  testId: string
  /** Раскрыт ли блок (управляемый режим — переключатель в действиях карточки). */
  open: boolean
  /** Переключить раскрытие. */
  onToggle: () => void
  /** Загрузчик истории (лениво, при первом раскрытии). */
  load: () => Promise<AutomationHistoryEntry[]>
}

/** Цвет бейджа статуса записи истории. */
const HISTORY_STATUS_CLASS: Record<string, string> = {
  ok: 'bg-primary/15 text-primary',
  error: 'bg-destructive/10 text-destructive',
  skipped: 'bg-muted text-muted-foreground',
}

/**
 * Блок «История» — раскрывается по кнопке, грузится лениво.
 */
export function AutomationHistory({ testId, open, onToggle, load }: AutomationHistoryProps) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<AutomationHistoryEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setEntries(await load())
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [load, t])

  const toggle = () => {
    const next = !open
    onToggle()
    if (next && entries === null && !loading) void reload()
  }

  return (
    <div className="min-w-0" data-testid={testId}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        className="flex w-full min-w-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {t('automation.history.title')}
        </span>
        {entries && entries.length > 0 && (
          <span className="shrink-0 text-muted-foreground">{entries.length}</span>
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5 min-w-0">
          <div className="flex items-center justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="min-h-8 px-2"
              onClick={() => void reload()}
              disabled={loading}
              data-testid={`${testId}-refresh`}
            >
              <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
              {t('common.refresh')}
            </Button>
          </div>

          {error && (
            <div role="alert" className="break-words text-xs text-destructive">
              {t('automation.history.loadError', { error })}
            </div>
          )}

          {!error && entries && entries.length === 0 && (
            <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
              {t('automation.history.empty')}
            </p>
          )}

          {!error && entries && entries.length > 0 && (
            <ul className="space-y-1.5 min-w-0" data-testid={`${testId}-list`}>
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="min-w-0 space-y-1 rounded-md border border-border/60 bg-background p-2"
                  data-testid={`${testId}-entry-${entry.id}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
                        HISTORY_STATUS_CLASS[entry.statusKey] ?? 'bg-muted text-muted-foreground',
                      )}
                    >
                      {entry.statusLabel}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground">
                      {entry.time}
                    </span>
                  </div>
                  {entry.detail && (
                    <div className="break-words text-[0.6875rem] text-muted-foreground">
                      {entry.detail}
                    </div>
                  )}
                  {entry.error && (
                    <div className="break-words text-[0.6875rem] text-destructive">{entry.error}</div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!error && entries === null && loading && (
            <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
          )}
        </div>
      )}
    </div>
  )
}
