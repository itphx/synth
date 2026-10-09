/**
 * Общая классификация ошибок LLM-провайдеров.
 *
 * Вынесено из ChatOrchestrator (_classifyError / _isRecoverable), чтобы
 * retry-цикл саб-агента (task.ts / task-resume.ts) использовал ту же
 * таксономию, что и QueueProcessor основной сессии:
 *   recoverable   — network_error, timeout, rate_limit, server_error, unknown
 *   unrecoverable — auth_error, model_not_found, context_length,
 *                   provider_not_found, no_user_query
 */
import { ContextLengthExceededError } from '../providers/exceptions.js';

/**
 * Классификация ошибки провайдера по тексту. Совпадает с
 * ChatOrchestrator._classifyError (оркестратор делегирует сюда).
 */
export function classifyLlmError(errMsg: string): string {
  const lower = errMsg.toLowerCase();
  // Провайдер отверг цепочку сообщений без исходного user-запроса (например
  // openai: `Bad request: {"detail":"no user query found in messages"}`,
  // ollama: `Ollama bad request: ...`). Это тупик tool-цепочки, не ретраится.
  if (lower.includes('no user query found in messages')) return 'no_user_query';
  if (lower.includes('rate') || lower.includes('limit') || lower.includes('429')) return 'rate_limit';
  if (lower.includes('abort') || lower.includes('operation was aborted')) return 'timeout';
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('fetch failed') || lower.includes('network') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('eai_again')) return 'network_error';
  if (lower.includes('502') || lower.includes('503') || lower.includes('bad gateway')) return 'server_error';
  if (lower.includes('context length') || lower.includes('too long')) return 'context_length';
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth')) return 'auth_error';
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('invalid'))) return 'model_not_found';
  return 'unknown';
}

/** Типы ошибок, при которых повтор не имеет смысла. */
const UNRECOVERABLE_TYPES = [
  'auth_error', 'model_not_found', 'context_length', 'provider_not_found',
  'validation', 'no_user_query',
];

/**
 * Подстроки, однозначно указывающие на невосполнимую ошибку.
 *
 * Единая точка истины — объединение из трёх ранее расходившихся списков:
 *   - llm-error.ts (auth/model/key/подстрока 401): model not found,
 *     model_not_found, does not exist, invalid model, unknown model,
 *     invalid api key, incorrect api key, 401, authentication, unauthorized
 *   - queue/processor.ts._isRecoverable (валидация/десериализация/type):
 *     missing field, failed to deserialize, invalid type, unknown field,
 *     bad request, validation, err_invalid_arg_type, cannot read properties,
 *     is not a function, is not defined
 */
const UNRECOVERABLE_PATTERNS = [
  'model not found', 'model_not_found', 'does not exist',
  'invalid model', 'unknown model', 'invalid api key',
  'incorrect api key', '401', 'authentication', 'unauthorized',
  'missing field', 'failed to deserialize', 'invalid type',
  'unknown field', 'bad request', 'validation',
  'err_invalid_arg_type', 'cannot read properties',
  'is not a function', 'is not defined',
];

/**
 * Политика ретрая LLM-провайдеров — единая для основной сессии
 * (QueueProcessor/оркестратор) и саб-агента (task.ts).
 */
export const LLM_MAX_ATTEMPTS = 3;
/** Backoff между попытками, мс (index = попытка - 1). */
export const LLM_RETRY_DELAYS_MS = [5000, 15000, 30000];

/**
 * Порог одинаковых tool-вызовов подряд (doom loop) — единый для оркестратора
 * (`_processMessage`) и саб-агента (`task.ts`): на N-м повторе повторный вызов
 * не исполняется, а в историю уходит сообщение `tool.doom_loop`.
 */
export const MAX_DOOM_LOOP_COUNT = 3;

/**
 * Восполняемая ли ошибка провайдера (можно ретраить): network/timeout/
 * rate_limit/server_error — да; auth/model_not_found/context_length —
 * нет. Приоритеты:
 *   1. ContextLengthExceededError (по классу) — невосполнима.
 *   2. Явно переданный `errorType` из UNRECOVERABLE_TYPES — невосполнима.
 *   3. Иначе — по подстрокам UNRECOVERABLE_PATTERNS в
 *      `errMsg ?? error.message ?? String(error)`.
 */
export function isLlmErrorRecoverable(error: unknown, errMsg?: string, errorType?: string): boolean {
  if (error instanceof ContextLengthExceededError) return false;
  if (errorType && UNRECOVERABLE_TYPES.includes(errorType)) return false;
  const raw = errMsg ?? (error instanceof Error ? error.message : String(error));
  const lower = raw.toLowerCase();
  return !UNRECOVERABLE_PATTERNS.some((p) => lower.includes(p));
}
