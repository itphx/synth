/**
 * Лимит вывода (`max_tokens`) LLM-вызова — единая политика резолва.
 *
 * Приоритет источников: явная настройка сессии → каталог модели
 * (`ModelConfig.maxOutputTokens`) → конфиг инстанса (`llm.maxTokens`) →
 * встроенный дефолт. Каталог при этом ещё и **кап**: больше заявленного
 * моделью лимита не отправляем.
 *
 * Для reasoning-моделей (adaptive thinking расходует тот же бюджет вывода)
 * маленький лимит целиком уходит в размышления — ответ приходит пустым.
 * Поэтому у моделей с обязательным reasoning действует пол
 * `REASONING_MIN_OUTPUT_TOKENS` (кап модели важнее пола: если каталог
 * говорит, что модель умеет меньше — не выходим за него).
 */

/** Явное «авто» в настройке сессии/конфиге: лимит определяет каталог/дефолт. */
export const AUTO_MAX_OUTPUT_TOKENS = 0;

/** Дефолт `llm.maxTokens` (и последний фоллбэк резолва). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Пол вывода для моделей с обязательным reasoning (thinking в том же `max_tokens`). */
export const REASONING_MIN_OUTPUT_TOKENS = 8192;

/**
 * Резолв лимита вывода вызова.
 *
 *  - `sessionMax` — `SessionSettings.maxTokens` (`0`/`undefined` = авто);
 *  - `modelMax` — `ModelConfig.maxOutputTokens` (`0`/`undefined` = неизвестно);
 *  - `configMax` — `llm.maxTokens` (`0`/`undefined` = дефолт);
 *  - `requireReasoning` — модель требует reasoning (эвристика/каталог).
 *
 * Результат — целое > 0.
 */
export function resolveMaxOutputTokens(input: {
  sessionMax?: number;
  modelMax?: number;
  configMax?: number;
  requireReasoning?: boolean;
}): number {
  const sessionMax = positiveInt(input.sessionMax);
  const modelMax = positiveInt(input.modelMax);
  const configMax = positiveInt(input.configMax);

  let base = sessionMax ?? modelMax ?? configMax ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (modelMax !== undefined) base = Math.min(base, modelMax);

  if (input.requireReasoning) {
    const floor = modelMax !== undefined
      ? Math.min(REASONING_MIN_OUTPUT_TOKENS, modelMax)
      : REASONING_MIN_OUTPUT_TOKENS;
    if (base < floor) base = floor;
  }

  return Math.max(1, Math.trunc(base));
}

/** Положительное целое или `undefined` («не задано/авто»). */
function positiveInt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}
