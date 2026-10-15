/**
 * ADR-070 §2.3: нормализация usage и статистика prompt-cache.
 */
import type { Currency, TokenUsage } from '@itphx/synth-shared';

/**
 * Cache hit rate — доля кэшированных входных токенов:
 * `cacheReadTokens / inputTokens`. При `inputTokens === 0` (нет входных
 * токенов) возвращает 0, а не NaN/Infinity.
 */
export function computeCacheHitRate(
  cacheReadTokens: number | undefined,
  inputTokens: number | undefined,
): number {
  const input = inputTokens || 0;
  if (input <= 0) return 0;
  return (cacheReadTokens || 0) / input;
}

/** Цены модели за 1M токенов (совместимо с `ModelPricing` оркестратора). */
export interface UsagePricing {
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  /** Валюта цен модели; отсутствует → USD (обратная совместимость). */
  currency?: Currency;
}

/** Разбивка стоимости сообщения по типам токенов (в валюте pricing). */
export interface UsageCostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageCost {
  /** Номинальная сумма (в валюте `currency`). Имя сохранено для совместимости. */
  costUsd: number;
  breakdown: UsageCostBreakdown;
  /** Валюта стоимости: `pricing.currency ?? 'USD'`. */
  currency: Currency;
}

/**
 * ADR-070 §2.6: стоимость usage по ценам модели (`price / 1_000_000`).
 * Возвращает `null`, если usage или цены не заданы — вызывающий решает,
 * писать ли `metadata.cost_usd`. Единый расчёт для сессии, сообщения и
 * агрегированной статистики. Стоимость считается в валюте `pricing.currency`
 * (по умолчанию USD).
 */
export function computeUsageCost(
  usage: TokenUsage | undefined,
  pricing: UsagePricing | null | undefined,
): UsageCost | null {
  if (!usage || !pricing) return null;
  const { inputPrice, outputPrice, cacheReadPrice, cacheWritePrice } = pricing;
  // ADR-070 §2.6 (LOW): если ни одна цена не задана — стоимость неизвестна,
  // а не «бесплатно». Возвращаем null, чтобы `metadata.cost_usd`/
  // `cost_breakdown` не писались (как для модели без записи цен).
  if (
    inputPrice == null &&
    outputPrice == null &&
    cacheReadPrice == null &&
    cacheWritePrice == null
  ) {
    return null;
  }
  const div = 1_000_000;
  const input = ((usage.inputTokens || 0) * (pricing.inputPrice ?? 0)) / div;
  const output = ((usage.outputTokens || 0) * (pricing.outputPrice ?? 0)) / div;
  const cacheRead = usage.cacheReadTokens && pricing.cacheReadPrice
    ? (usage.cacheReadTokens * pricing.cacheReadPrice) / div
    : 0;
  const cacheWrite = usage.cacheWriteTokens && pricing.cacheWritePrice
    ? (usage.cacheWriteTokens * pricing.cacheWritePrice) / div
    : 0;
  return {
    costUsd: input + output + cacheRead + cacheWrite,
    breakdown: { input, output, cacheRead, cacheWrite },
    currency: pricing.currency ?? 'USD',
  };
}
