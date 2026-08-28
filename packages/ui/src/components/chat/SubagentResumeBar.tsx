import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useRetryCountdown } from './RetryStatus'
import { useChatStore, type SubagentRetryState } from '@/stores/chatStore'
import { isRecoverableErrorType } from '@/lib/streamErrors'

/** Ошибка дочерней сессии (последнее сообщение с role=error / metadata.error). */
export interface SubagentSessionError {
  attempts?: number
  maxRetries?: number
  errorType?: string
  error?: string
}

interface SubagentResumeBarProps {
  sessionId: string
  lastError: SubagentSessionError | null
  onResume: () => void
  onStop: () => void
}

/**
 * Плашка в дочерней сессии саб-агента (B8): над read-only заглушкой поля ввода.
 * Приоритеты отображения:
 *  1. Возобновление идёт (subagent.resume.started) → «Возобновление…» + «Остановить».
 *  2. Активный retry внутри resume (subagent.retry) → «Повторная попытка N/M через Xс».
 *  3. Последнее сообщение — ошибка провайдера → «Сабагент остановлен…» + «Продолжить»
 *     (кнопка только для recoverable error_type).
 *  4. Нечего показывать → null.
 */
export function SubagentResumeBar({ sessionId, lastError, onResume, onStop }: SubagentResumeBarProps) {
  const { t } = useI18n()
  const resuming = useChatStore((s) => s.subagentResumingBySession[sessionId] || null)
  const retry: SubagentRetryState | null = useChatStore((s) => s.subagentRetryBySession[sessionId] || null)
  const secondsLeft = useRetryCountdown(retry?.retryInMs ?? 5000)

  if (resuming) {
    return (
      <div className="shrink-0 mx-auto mb-2 w-4/5 rounded-lg border border-purple-500/20 bg-purple-500/5">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Icon name="refresh" className="size-3.5 text-purple-500 shrink-0 animate-spin" />
          <span className="text-xs text-purple-600 dark:text-purple-400 flex-1">
            {t('chat.subagent.resuming')}
            {retry && (
              <span className="block text-[10px] text-muted-foreground">
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
            className="shrink-0 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
          >
            {t('chat.subagent.stop')}
          </button>
        </div>
      </div>
    )
  }

  if (!lastError) return null

  const recoverable = isRecoverableErrorType(lastError.errorType)
  const attemptsLabel = lastError.attempts != null
    ? t('chat.subagent.errorAttempts', {
        attempts: String(lastError.attempts),
        max: String(lastError.maxRetries ?? 3),
      })
    : null

  return (
    <div className="shrink-0 mx-auto mb-2 w-4/5 rounded-lg border border-destructive/20 bg-destructive/5">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon name="error-warning" className="size-3.5 text-destructive shrink-0" />
        <span className="text-xs text-destructive flex-1 min-w-0">
          {t('chat.subagent.errorStopped')}
          {attemptsLabel && (
            <span className="ml-1 text-[10px] text-muted-foreground">({attemptsLabel})</span>
          )}
        </span>
        {recoverable && (
          <button
            onClick={onResume}
            className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
          >
            {t('chat.subagent.resume')}
          </button>
        )}
      </div>
    </div>
  )
}
