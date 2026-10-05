import { useEffect, useState } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { StreamRetry } from '@/stores/chatStore'

/** Обратный отсчёт до повторной попытки (сбрасывается при новом stream.retry). */
export function useRetryCountdown(retryInMs: number): number {
  const [secondsLeft, setSecondsLeft] = useState(Math.max(1, Math.ceil(retryInMs / 1000)))

  useEffect(() => {
    setSecondsLeft(Math.max(1, Math.ceil(retryInMs / 1000)))
    const timer = setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)
    return () => clearInterval(timer)
  }, [retryInMs])

  return secondsLeft
}

/**
 * Статус повторной попытки + кнопки-иконки «Повторить сейчас» / «Отменить».
 * Используется в «крутилке» (StreamingPlaceholder) и в user-сообщении,
 * когда активный стрим ещё не получил ни одного чанка.
 */
export function RetryStatus({
  retry,
  onRetryNow,
  onCancelRetry,
  className,
}: {
  retry: StreamRetry
  onRetryNow?: () => void
  onCancelRetry?: () => void
  className?: string
}) {
  const { t } = useI18n()
  const secondsLeft = useRetryCountdown(retry.retryInMs)

  return (
    <div className={cn('flex flex-wrap items-center gap-2 mt-2 pt-1.5 border-t border-status-warning/20', className)}>
      <Icon name="refresh" className="size-3.5 text-status-warning shrink-0" />
      <span className="text-xs text-status-warning">
        {t('chat.retry.inProgress', {
          current: String(retry.attempt),
          max: String(retry.maxRetries),
          sec: String(secondsLeft),
        })}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={onRetryNow}
          title={t('chat.retry.now')}
          className="rounded p-1 text-status-warning hover:bg-status-warning/10 transition-colors"
        >
          <Icon name="refresh" className="size-3.5" />
        </button>
        <button
          onClick={onCancelRetry}
          title={t('chat.retry.cancel')}
          className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
        >
          <Icon name="close" className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
