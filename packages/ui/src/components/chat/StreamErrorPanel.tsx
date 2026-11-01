import { useI18n } from '@/lib/i18n'
import { resolveStreamErrorAction } from '@/lib/streamErrors'
import { ComposerBanner } from './ComposerBanner'

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
 * Стиль/поведение — общий `ComposerBanner` (вариант `error`): `mx-auto w-4/5`,
 * палитра destructive, опциональная кнопка «Повторить».
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
    <ComposerBanner
      variant="error"
      icon="error-warning"
      testId="stream-error-panel"
      title={text}
      action={showRetry ? (
        <button
          onClick={onRetry}
          className="shrink-0 rounded px-2 py-0.5 text-[0.6875rem] font-medium bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
        >
          {t('chat.streamError.retry')}
        </button>
      ) : undefined}
    >
      {errorType !== 'context_length' && errorType !== 'auth' && error && (
        <span className="block truncate text-[0.625rem] text-muted-foreground" title={error}>
          {error}
        </span>
      )}
    </ComposerBanner>
  )
}
