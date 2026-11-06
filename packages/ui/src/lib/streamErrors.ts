/**
 * Классификация ошибок LLM-провайдера для UI (B5–B8).
 *
 * Бэкенд (orchestrator/queue processor) помечает stream.error и tool_result
 * саб-агента полем error_type. UI решает по нему: показывать ли кнопку
 * «Повторить»/«Продолжить» или только текст (повтор бессмысленен).
 */

/**
 * Ошибки, при которых повторная отправка имеет смысл (транзиентные сбои
 * провайдера). Legacy-имена `network`/`auth` оставлены для старых ядер и
 * гибрида: актуальное ядро отдаёт `network_error`/`auth_error`
 * (`packages/core/src/engine/llm-error.ts`).
 */
export const RECOVERABLE_ERROR_TYPES = ['network', 'network_error', 'timeout', 'rate_limit', 'server_error'] as const

/**
 * Ошибки, при которых повторная отправка бессмысленна (кнопка не показывается).
 * `remote_auth_expired` — истёкшая сессия гибрида: нужен повторный вход, а не
 * повтор запроса.
 */
export const NON_RETRYABLE_ERROR_TYPES = [
  'context_length', 'auth', 'auth_error', 'remote_auth_expired',
  'model_not_found', 'provider_not_found', 'no_user_query', 'validation',
  'retry_cancelled', 'resume_failed', 'internal', 'unknown',
] as const

export type RecoverableErrorType = (typeof RECOVERABLE_ERROR_TYPES)[number]

/** true, если по ошибке такого типа имеет смысл показывать кнопку повтора. */
export function isRecoverableErrorType(errorType: string | null | undefined): boolean {
  if (!errorType) return false
  return (RECOVERABLE_ERROR_TYPES as readonly string[]).includes(errorType)
}

/**
 * Действие по финальной ошибке стрима (B6):
 * - 'retry' — recoverable-ошибка: показываем кнопку «Повторить»;
 * - 'info'  — повтор бессмысленен: только текст.
 */
export function resolveStreamErrorAction(errorType: string | null | undefined): 'retry' | 'info' {
  return isRecoverableErrorType(errorType) ? 'retry' : 'info'
}
