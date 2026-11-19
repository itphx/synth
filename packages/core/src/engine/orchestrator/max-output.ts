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
 *
 * **Адаптивное ужатие (паритет с opencode `session/model-request.ts`).**
 * `max_tokens` живёт в том же контекстном окне, что и промпт: если промпт
 * большой, запрошенный лимит вывода приводит к ошибке провайдера
 * «context length exceeded». Поэтому базовый лимит дополнительно подрезается
 * до свободного места:
 *
 * ```text
 * room   = floor(contextWindow * (1 - headroom)) - measured - ceil(estimated * 1.15)
 * result = min(min(base, OUTPUT_TOKEN_MAX), max(OUTPUT_TOKEN_MIN, room))
 * ```
 *
 * `1.15` — запас на ошибку оценки входа. Неизвестное окно модели (`0`) или
 * неизвестный размер входа — поведение прежнее (fail-open: только базовый
 * лимит, ограниченный `OUTPUT_TOKEN_MAX`). `headroom` — 1 % на обычном шаге;
 * для компактизации/суммаризации — `0` (это служебные вызовы, им нужен весь
 * остаток окна).
 */

/** Явное «авто» в настройке сессии/конфиге: лимит определяет каталог/дефолт. */
export const AUTO_MAX_OUTPUT_TOKENS = 0;

/** Дефолт `llm.maxTokens` (и последний фоллбэк резолва). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

/** Пол вывода для моделей с обязательным reasoning (thinking в том же `max_tokens`). */
export const REASONING_MIN_OUTPUT_TOKENS = 8192;

/**
 * Потолок запрошенного лимита вывода: выше него `max_tokens` не поднимаем даже
 * при большом окне (паритет с opencode `OUTPUT_TOKEN_MAX`). Защищает от
 * случайного `sessionMax = 1_000_000` в настройках сессии.
 */
export const OUTPUT_TOKEN_MAX = 256_000;

/**
 * Пол адаптивного ужатия: если свободного места в окне совсем мало, ниже этого
 * значения лимит не опускаем — иначе модель получит «обрезанный» ответ всегда.
 * Ошибку превышения окна в этом случае ловит предохранитель контекста.
 */
export const OUTPUT_TOKEN_MIN = 1024;

/** Запас на ошибку оценки входа (оценка в символах/токенах всегда приблизительна). */
export const INPUT_ESTIMATE_MARGIN = 1.15;

/** Доля окна, оставляемая «на всякий случай» на обычном шаге. */
export const DEFAULT_CONTEXT_HEADROOM = 0.01;

/**
 * Резолв лимита вывода вызова.
 *
 *  - `sessionMax` — `SessionSettings.maxTokens` (`0`/`undefined` = авто);
 *  - `modelMax` — `ModelConfig.maxOutputTokens` (`0`/`undefined` = неизвестно);
 *  - `configMax` — `llm.maxTokens` (`0`/`undefined` = дефолт);
 *  - `requireReasoning` — модель требует reasoning (эвристика/каталог);
 *  - `contextWindow` — окно модели в токенах (`0`/`undefined` = неизвестно);
 *  - `inputMeasuredTokens` — фактический размер промпта прошлого вызова
 *    (`usage.inputTokens` провайдера; `0`/`undefined` = нет измерения);
 *  - `inputEstimatedTokens` — оценка текущего промпта (оценщик контекста);
 *  - `headroom` — доля окна «на всякий случай» (по умолчанию 1 %).
 *
 * Результат — целое > 0.
 */
export function resolveMaxOutputTokens(input: {
  sessionMax?: number;
  modelMax?: number;
  configMax?: number;
  requireReasoning?: boolean;
  contextWindow?: number;
  inputMeasuredTokens?: number;
  inputEstimatedTokens?: number;
  headroom?: number;
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

  // Потолок запроса: выше него не поднимаем ни при каком окне.
  let limit = Math.min(base, OUTPUT_TOKEN_MAX);

  const window = positiveInt(input.contextWindow);
  const measured = nonNegativeInt(input.inputMeasuredTokens);
  const estimated = nonNegativeInt(input.inputEstimatedTokens);
  // Адаптивное ужатие — только когда известны и окно, и размер входа:
  // без них «свободное место» не посчитать (fail-open, прежнее поведение).
  if (window !== undefined && (measured !== undefined || estimated !== undefined)) {
    const headroom = normalizeHeadroom(input.headroom);
    const room = Math.floor(window * (1 - headroom))
      - (measured ?? 0)
      - Math.ceil((estimated ?? 0) * INPUT_ESTIMATE_MARGIN);
    limit = Math.min(limit, Math.max(OUTPUT_TOKEN_MIN, room));
  }

  return Math.max(1, Math.trunc(limit));
}

/** Положительное целое или `undefined` («не задано/авто»). */
function positiveInt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}

/** Неотрицательное целое или `undefined` (нет измерения/оценки). */
function nonNegativeInt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

/** `headroom` в диапазоне 0…0.9; мусор — дефолт (1 %). */
function normalizeHeadroom(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_CONTEXT_HEADROOM;
  }
  return Math.min(value, 0.9);
}
