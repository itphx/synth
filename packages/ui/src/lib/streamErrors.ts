/**
 * Классификация ошибок LLM-провайдера для UI (B5–B8).
 *
 * Бэкенд (orchestrator/queue processor) помечает stream.error и tool_result
 * саб-агента полем error_type. UI решает по нему: показывать ли кнопку
 * «Повторить»/«Продолжить» или только текст (повтор бессмысленен).
 */

/** Ошибки, при которых повторная отправка имеет смысл (транзиентные сбои провайдера). */
export const RECOVERABLE_ERROR_TYPES = ['network', 'timeout', 'rate_limit', 'server_error'] as const

/** Ошибки, при которых повторная отправка бессмысленна (кнопка не показывается). */
export const NON_RETRYABLE_ERROR_TYPES = ['context_length', 'auth', 'model_not_found', 'resume_failed', 'internal', 'unknown'] as const

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
