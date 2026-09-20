/**
 * AD-071 §2.6: оценка токенов по символам и калибровка chars-per-token.
 *
 * `estTokens` в манифесте/toolsDetail/MCP — оценка: `ceil(chars / ratio)`, где
 * `ratio` — chars-per-token. Дефолт `4` (эвристика AD-070). После успешного
 * ответа LLM фактический `usage.inputTokens` позволяет уточнить `ratio` для
 * модели: `ratio = promptChars / usage.inputTokens`.
 *
 * Калибровка хранится per-model и обновляется EWMA (α = 0.3): одиночный семпл
 * шумный (кэш, tool-chain, разные сериализации), поэтому сглаживаем, но
 * сохраняем отзывчивость. Аномальные семплы (ratio вне `[2, 8]` или
 * `inputTokens < 500`) отбрасываются.
 */

import {
  DEFAULT_CHARS_PER_TOKEN,
  MAX_CHARS_PER_TOKEN,
  MIN_CALIBRATION_INPUT_TOKENS,
  MIN_CHARS_PER_TOKEN,
} from '@itphx/synth-shared';

export {
  DEFAULT_CHARS_PER_TOKEN,
  MAX_CHARS_PER_TOKEN,
  MIN_CALIBRATION_INPUT_TOKENS,
  MIN_CHARS_PER_TOKEN,
};

/** Вес нового наблюдения в EWMA (0.3 — компромисс отзывчивости и сглаживания). */
export const RATIO_EWMA_ALPHA = 0.3;

/** Оценка токенов по длине в символах и chars-per-token. */
export function estimateTokens(chars: number, ratio: number = DEFAULT_CHARS_PER_TOKEN): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(chars / safeRatio);
}

/**
 * Калибрует chars-per-token по факту: `promptChars / inputTokens`.
 *
 * @param promptChars размер промпта в символах (сообщения + system + tools)
 * @param inputTokens фактический input-usage ответа
 * @param current текущее откалиброванное значение (undefined — калибровки нет)
 * @returns новое значение или `null`, если семпл ненадёжен/аномален
 */
export function calibrateCharsPerToken(
  promptChars: number,
  inputTokens: number,
  current?: number,
): number | null {
  if (!Number.isFinite(promptChars) || promptChars <= 0) return null;
  if (!Number.isFinite(inputTokens) || inputTokens < MIN_CALIBRATION_INPUT_TOKENS) return null;

  const observed = promptChars / inputTokens;
  if (!Number.isFinite(observed) || observed < MIN_CHARS_PER_TOKEN || observed > MAX_CHARS_PER_TOKEN) {
    return null;
  }

  // Первый семпл — как есть; далее EWMA поверх текущего.
  const hasCurrent = current != null && Number.isFinite(current) && current > 0;
  const next = hasCurrent
    ? current! * (1 - RATIO_EWMA_ALPHA) + observed * RATIO_EWMA_ALPHA
    : observed;

  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, next));
}
