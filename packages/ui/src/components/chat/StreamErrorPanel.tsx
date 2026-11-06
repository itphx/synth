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
  /**
   * Действие повторного входа в гибрид (`remote_auth_expired`): истекла
   * серверная сессия — повтор запроса бессмысленен, нужен logout/вход заново.
   */
  onHybridLogin?: () => void
}

/**
 * Плашка финальной ошибки провайдера над полем ввода (B6).
 * Стиль/поведение — общий `ComposerBanner` (вариант `error`): `mx-auto w-4/5`,
 * палитра destructive, опциональная кнопка «Повторить» (recoverable) либо
 * «Войти в гибрид заново» (`remote_auth_expired`).
 */
export function StreamErrorPanel({ error, errorType, onRetry, onHybridLogin }: StreamErrorPanelProps) {
  const { t } = useI18n()

  // Локализованный текст вместо сырого сообщения провайдера.
  // `auth_error` — актуальный тип ядра, `auth` — legacy (старые ядра/гибрид).
  const text = errorType === 'context_length'
    ? t('chat.streamError.contextLength')
    : errorType === 'auth_error' || errorType === 'auth'
      ? t('chat.streamError.authFailed')
      : errorType === 'remote_auth_expired'
        ? t('router.remote_auth_expired')
        : errorType === 'provider_disabled'
          ? t('chat.streamError.providerDisabled')
          : errorType === 'model_disabled'
            ? t('chat.streamError.modelDisabled')
            : t('chat.streamError.generic')

  const showRetry = resolveStreamErrorAction(errorType) === 'retry' && !!onRetry
  const showHybridLogin = errorType === 'remote_auth_expired' && !!onHybridLogin

  // Сырой текст не показываем у локализованных без технической детали типов.
  const showRawError = errorType !== 'context_length'
    && errorType !== 'auth_error'
    && errorType !== 'auth'
    && errorType !== 'remote_auth_expired'
    && errorType !== 'provider_disabled'
    && errorType !== 'model_disabled'

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
      ) : showHybridLogin ? (
        <button
          onClick={onHybridLogin}
          className="shrink-0 rounded px-2 py-0.5 text-[0.6875rem] font-medium bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
        >
          {t('chat.streamError.hybridRelogin')}
        </button>
      ) : undefined}
    >
      {showRawError && error && (
        <span className="block truncate text-[0.625rem] text-muted-foreground" title={error}>
          {error}
        </span>
      )}
    </ComposerBanner>
  )
}
