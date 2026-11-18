// BlockingRunCard: компактная карточка **блокирующего** прогона (ADR-111 §detach).
//
// Отдельный компонент, а не `RunCard`: `RunCard` типизирован под запись
// реестра (`BackgroundRunRecord`), а у блокирующего прогона ни статуса, ни
// команды/exit code нет — он ещё идёт внутри хода. Показываем только то, что
// есть: вид, имя, время работы и три действия — открыть, остановить, в фон.

import { useI18n } from '@/lib/i18n'
import { formatDuration } from '@/lib/formatStats'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import type { BlockingRun } from '@/lib/api/synthApi'

const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Время работы блокирующего прогона от старта до «сейчас» (мс). */
export function blockingUptimeMs(run: BlockingRun, now: number): number | undefined {
  const started = Date.parse(run.startedAt ?? '')
  if (!Number.isFinite(started)) return undefined
  return Math.max(0, now - started)
}

/** Человеческое имя прогона: заголовок (команда/описание) или id. */
function runTitle(run: BlockingRun): string {
  return run.title || run.id
}

export interface BlockingRunCardProps {
  run: BlockingRun
  /** Текущее время (тикер раз в секунду). */
  now: number
  /** Идёт ли операция над записью (кнопки заблокированы). */
  busy: boolean
  /** Имя сессии-владельца. */
  sessionName: string
  /** Открыть: дочернюю сессию (`subagent`) или live-лог (`process`). */
  onOpen: () => void
  /** Остановить блокирующий прогон. */
  onStop: () => void
  /** Перевести в фон. */
  onDetach: () => void
}

/**
 * Карточка блокирующего прогона.
 *
 * Правила доступа в UI не дублируются: остановку/чтение решает сервер
 * (`403`/`404`), ошибка показывается тостом в обработчике.
 */
export function BlockingRunCard({
  run,
  now,
  busy,
  sessionName,
  onOpen,
  onStop,
  onDetach,
}: BlockingRunCardProps) {
  const { t } = useI18n()
  const uptimeMs = blockingUptimeMs(run, now)
  const canOpen = run.kind === 'process' || Boolean(run.childSessionId)

  return (
    <li
      data-testid={`processes-blocking-item-${run.id}`}
      data-kind={run.kind}
      className="min-w-0 space-y-1.5 rounded-lg border border-border bg-surface-inset p-2.5"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon
          name={run.kind === 'subagent' ? 'robot-2' : 'terminal-box'}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={runTitle(run)}>
          {runTitle(run)}
        </span>
        <span className={`${BADGE} bg-primary/15 text-primary`} data-testid={`processes-blocking-status-${run.id}`}>
          <Icon name="loader-2" className="mr-1 inline size-3 animate-spin" />
          {t('processes.status.running')}
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate" title={sessionName}>
          {t('processes.row.session')}: <span className="break-words">{sessionName}</span>
        </span>
        {uptimeMs !== undefined && (
          <span data-testid={`processes-blocking-uptime-${run.id}`}>
            {t('processes.row.uptime')}: {formatDuration(uptimeMs)}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onDetach}
          disabled={busy}
          title={t('processes.action.detach')}
          aria-label={t('processes.action.detach')}
          data-testid={`processes-blocking-detach-${run.id}`}
        >
          <Icon name="download" className="size-4" />
          {t('processes.action.detach')}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onStop}
          disabled={busy}
          title={t('processes.action.stop')}
          aria-label={t('processes.action.stop')}
          data-testid={`processes-blocking-stop-${run.id}`}
        >
          <Icon name="stop" className="size-4" />
        </Button>
        {canOpen && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpen}
            title={t('processes.action.open')}
            aria-label={t('processes.action.open')}
            data-testid={`processes-blocking-open-${run.id}`}
          >
            <Icon name={run.kind === 'process' ? 'eye' : 'arrow-right-s'} className="size-4" />
          </Button>
        )}
      </div>
    </li>
  )
}
