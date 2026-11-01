/**
 * Политика ограничения контекстного окна модели — чистая функция проверки
 * (instance-wide `context.windowPolicy`).
 *
 * Вызывается оркестратором **перед каждым** LLM-вызовом основного цикла:
 * оценка промпта (`estimatePromptChars` + `estimateTokens`) сравнивается с
 * окном модели за вычетом резерва на вывод. Значения политики:
 * - `off` — проверок нет (ни предупреждений, ни блокировки);
 * - `warn` — сервер не блокирует (предупреждения рисует UI);
 * - `enforce` — вызов **не отправляется**, если оценка не влезает в окно.
 *
 * Неизвестное окно (`ModelConfig.contextWindow` = `0`/не задано) не блокирует
 * никогда: оценка без окна бессмысленна, а тихая блокировка всех ходов была бы
 * регрессией. Это предохранитель, а не бюджетирование.
 */
import type { ContextWindowPolicy } from '@itphx/synth-shared';

/** Итог проверки: `allow` — вызов разрешён, `block` — не отправлять. */
export type ContextWindowGuardAction = 'allow' | 'block';

/**
 * Причина решения:
 * - `policy_off` — политика `off`;
 * - `unknown_window` — окно модели неизвестно (`<= 0`);
 * - `fits` — оценка влезает (или политика `warn` — не блокируем);
 * - `exceeded` — оценка выше лимита при `enforce`.
 */
export type ContextWindowGuardReason =
  | 'policy_off'
  | 'unknown_window'
  | 'fits'
  | 'exceeded';

/** Вход проверки контекстного окна. */
export interface ContextWindowCheckInput {
  /** Эффективная политика (env > runtime > config > default). */
  policy: ContextWindowPolicy;
  /** Оценка промпта в токенах (сообщения + system prompt + tools). */
  estimatedTokens: number;
  /** Размер контекстного окна модели в токенах (`0`/`<= 0` — неизвестно). */
  windowTokens: number;
  /** Резерв под вывод (эффективный `max_tokens`). */
  reserveTokens?: number;
}

/** Результат проверки. */
export interface ContextWindowCheckResult {
  action: ContextWindowGuardAction;
  reason: ContextWindowGuardReason;
  /** Допустимый объём промпта (`windowTokens - reserveTokens`); `undefined`, если окно неизвестно. */
  allowLimit?: number;
}

/**
 * Проверить, влезает ли оценка промпта в окно модели.
 *
 * `allowLimit = windowTokens - max(0, reserveTokens)`. Блокировка — только при
 * `policy === 'enforce'` и `estimatedTokens > allowLimit`; `warn` и `off`
 * никогда не блокируют.
 */
export function checkContextWindowWindow(input: ContextWindowCheckInput): ContextWindowCheckResult {
  if (input.policy === 'off') {
    return { action: 'allow', reason: 'policy_off' };
  }
  if (!(input.windowTokens > 0)) {
    return { action: 'allow', reason: 'unknown_window' };
  }

  const reserve = Math.max(0, input.reserveTokens ?? 0);
  const allowLimit = input.windowTokens - reserve;

  if (input.policy === 'enforce' && input.estimatedTokens > allowLimit) {
    return { action: 'block', reason: 'exceeded', allowLimit };
  }
  return { action: 'allow', reason: 'fits', allowLimit };
}
