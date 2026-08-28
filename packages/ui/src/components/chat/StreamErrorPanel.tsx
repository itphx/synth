import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { resolveStreamErrorAction } from '@/lib/streamErrors'

interface StreamErrorPanelProps {
  /** Сырой текст ошибки от провайдера. */
  error: string
  /** Тип ошибки (payload.error_type события stream.error). */
  errorType: string
  /** Повторная отправка последнего user-сообщения (кнопка видна только для recoverable). */
  onRetry?: () => void
}

/**
 * Плашка финальной ошибки провайдера над полем ввода (B6).
 * Стиль консистентен с QueuePanel (mx-auto w-4/5, палитра destructive вместо yellow).
 */
export function StreamErrorPanel({ error, errorType, onRetry }: StreamErrorPanelProps) {
  const { t } = useI18n()

  // Локализованный текст вместо сырого сообщения провайдера
  const text = errorType === 'context_length'
    ? t('chat.streamError.contextLength')
    : errorType === 'auth'
      ? t('chat.streamError.authFailed')
      : t('chat.streamError.generic')

  const showRetry = resolveStreamErrorAction(errorType) === 'retry' && !!onRetry

  return (
    <div className="shrink-0 mx-auto w-4/5 rounded-lg border border-destructive/20 bg-destructive/5">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon name="error-warning" className="size-3.5 text-destructive shrink-0" />
        <span className="text-xs text-destructive flex-1 min-w-0">
          {text}
          {errorType !== 'context_length' && errorType !== 'auth' && error && (
            <span className="block truncate text-[10px] text-muted-foreground" title={error}>
              {error}
            </span>
          )}
        </span>
        {showRetry && (
          <button
            onClick={onRetry}
            className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
          >
            {t('chat.streamError.retry')}
          </button>
        )}
      </div>
    </div>
  )
}
