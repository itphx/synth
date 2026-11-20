import { Icon, type IconName } from '../icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useRetryCountdown } from './RetryStatus'
import { useChatStore, type SubagentRetryState } from '@/stores/chatStore'
import { isRecoverableErrorType } from '@/lib/streamErrors'
import { stopReasonInfo, type StopSeverity } from '@/lib/stopReason'

/** Ошибка дочерней сессии (последнее сообщение с role=error / metadata.error). */
export interface SubagentSessionError {
  attempts?: number
  maxRetries?: number
  errorType?: string
  error?: string
  /**
   * PROP-143: причина остановки хода — durable-запись `execution_stopped`
   * (`metadata.type='execution_stopped'`, причина в `metadata.reason`).
   *
   * Заполняется, когда последнее сообщение дочерней сессии — служебная
   * запись остановки, а не прежняя ошибка `role='error'`.
   */
  stopReason?: string
}

interface SubagentResumeBarProps {
  sessionId: string
  lastError: SubagentSessionError | null
  onResume: () => void
  onStop: () => void
}

/**
 * Тон плашки по тону причины остановки (`lib/stopReason.ts`): красный —
 * только реальный сбой (`error`), янтарный — штатное завершение ограничителем
 * (`warning`), нейтральный — остановка человеком.
 */
const TONES: Record<StopSeverity, { box: string; text: string; icon: IconName; button: string }> = {
  error: {
    box: 'border-destructive/20 bg-destructive/5',
    text: 'text-destructive',
    icon: 'error-warning',
    button: 'bg-destructive/15 text-destructive hover:bg-destructive/25',
  },
  warning: {
    box: 'border-status-warning/20 bg-status-warning/5',
    text: 'text-status-warning',
    icon: 'information',
    button: 'bg-status-warning/15 text-status-warning hover:bg-status-warning/25',
  },
  neutral: {
    box: 'border-border/40 bg-surface-inset',
    text: 'text-muted-foreground',
    icon: 'information',
    button: 'bg-interactive-hover text-foreground',
  },
}

/**
 * Плашка в дочерней сессии саб-агента (B8): над композером.
 *
 * Вертикальный зазор задаёт контейнер ритма родителя (в чате —
 * `data-testid="chat-composer-zone"`, `flex flex-col gap-2`): собственных
 * `mt-*`/`mb-*` у плашки нет. Компонент используется только из этой зоны;
 * если понадобится в другом месте — оборачивать контейнером с ритмом, а не
 * возвращать отступы внутрь блока.
 *
 * Приоритеты отображения:
 *  1. Возобновление идёт (`subagent.resume.started`) → «Возобновление…» + «Стоп».
 *  2. Активный retry внутри resume (`subagent.retry`) → «Повторная попытка N/M через Xс».
 *  3. Последнее сообщение — durable-запись остановки (PROP-143,
 *     `metadata.type='execution_stopped'`) → плашка **только с действием**:
 *     причина уже показана служебным блоком в ленте, дублировать её текст
 *     здесь не нужно. Кнопка «Продолжить» — по `resumable` таблицы причин
 *     (только `provider_error`/`internal`/`empty`); у причин-ограничителей
 *     плашки нет вовсе — продолжение идёт новым сообщением/решением
 *     основного агента (решение владельца).
 *  4. Последнее сообщение — прежняя ошибка (`role='error'`): в ленте её нет
 *     (legacy-запись скрыта), поэтому текст остаётся здесь, а кнопка — по
 *     recoverable-типу ошибки.
 *  5. Нечего показывать → null.
 */
export function SubagentResumeBar({ sessionId, lastError, onResume, onStop }: SubagentResumeBarProps) {
  const { t } = useI18n()
  const resuming = useChatStore((s) => s.subagentResumingBySession[sessionId] || null)
  const retry: SubagentRetryState | null = useChatStore((s) => s.subagentRetryBySession[sessionId] || null)
  const secondsLeft = useRetryCountdown(retry?.retryInMs ?? 5000)

  if (resuming) {
    return (
      <div className="shrink-0 mx-auto w-4/5 rounded-lg border border-purple-500/20 bg-purple-500/5">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Icon name="refresh" className="size-3.5 text-purple-500 shrink-0 animate-spin" />
          <span className="text-xs text-purple-600 dark:text-purple-400 flex-1">
            {t('chat.subagent.resuming')}
            {retry && (
              <span className="block text-[0.625rem] text-muted-foreground">
                {t('chat.retry.inProgress', {
                  current: String(retry.attempt),
                  max: String(retry.maxRetries),
                  sec: String(secondsLeft),
                })}
              </span>
            )}
          </span>
          <button
            onClick={onStop}
            className="shrink-0 rounded px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
          >
            {t('chat.subagent.stop')}
          </button>
        </div>
      </div>
    )
  }

  if (!lastError) return null

  const stopReason = lastError.stopReason
  // Durable-запись остановки: тон и решение о продолжении — из таблицы причин;
  // прежняя ошибка провайдера — по типу ошибки (recoverable), тон — как у сбоя.
  const info = stopReason ? stopReasonInfo(stopReason) : null
  const tone = TONES[info?.severity ?? 'error']
  // У причин без продолжения (лимиты шагов/контекста/вывода, рестарт, отказ,
  // потеря прогона, остановка человеком) действия нет — плашку не рисуем:
  // причина и так видна служебным блоком в ленте.
  if (info && !info.resumable) return null
  const recoverable = info ? info.resumable : isRecoverableErrorType(lastError.errorType)
  const attemptsLabel = lastError.attempts != null
    ? t('chat.subagent.errorAttempts', {
        attempts: String(lastError.attempts),
        max: String(lastError.maxRetries ?? 3),
      })
    : null

  return (
    <div className={cn('shrink-0 mx-auto w-4/5 rounded-lg border', tone.box)}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon name={tone.icon} className={cn('size-3.5 shrink-0', tone.text)} />
        {info
          // Плашка durable-записи — только действие: причина уже в ленте,
          // остаётся длительность попыток мелким шрифтом (может отсутствовать).
          ? (attemptsLabel && (
              <span className="min-w-0 flex-1 text-[0.625rem] text-muted-foreground">{attemptsLabel}</span>
            ))
          : (
            <span className={cn('text-xs flex-1 min-w-0', tone.text)}>
              {t('chat.subagent.errorStopped')}
              {attemptsLabel && (
                <span className="ml-1 text-[0.625rem] text-muted-foreground">({attemptsLabel})</span>
              )}
            </span>
          )}
        {info && !attemptsLabel && <span className="flex-1" />}
        {recoverable && (
          <button
            onClick={onResume}
            className={cn(
              'shrink-0 rounded px-2 py-0.5 text-[0.6875rem] font-medium transition-colors',
              tone.button,
            )}
          >
            {t('chat.subagent.resume')}
          </button>
        )}
      </div>
    </div>
  )
}
