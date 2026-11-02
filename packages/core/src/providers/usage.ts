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
  /** Валюта стоимости: провайдерская (`usage.cost`), иначе `pricing.currency ?? 'USD'`. */
  currency: Currency;
}

/** Допустимая валюта провайдерской стоимости (неизвестная → USD). */
function normalizeCostCurrency(value: unknown): Currency {
  return value === 'RUB' || value === 'CNY' || value === 'USD' ? value : 'USD';
}

/**
 * ADR-102/ADR-118 (паритет с opencode `Usage.cost`): best-effort разбор
 * стоимости из provider-usage. Поля: `usage.cost` (число или объект),
 * `usage.total_cost`, `usage.cost_usd`; валюта — `usage.currency` или
 * `cost.currency` (неизвестная → USD). `0` — достоверная стоимость.
 */
export function parseUsageCost(
  usage: Record<string, unknown> | undefined,
): TokenUsage['cost'] | undefined {
  if (!usage) return undefined;
  const candidates: unknown[] = [usage.cost, usage.total_cost, usage.cost_usd];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    let amount: unknown = candidate;
    let currency: unknown = usage.currency;
    if (typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      amount = obj.amount ?? obj.total ?? obj.value ?? obj.cost;
      currency = obj.currency ?? usage.currency;
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    return { amount, currency: normalizeCostCurrency(currency) };
  }
  return undefined;
}

/**
 * ADR-070 §2.6: стоимость usage по ценам модели (`price / 1_000_000`).
 * Приоритет — **стоимость от провайдера** (`usage.cost`), затем каталожная
 * цена модели. Возвращает `null`, если нет ни провайдерской стоимости, ни
 * цен — вызывающий решает, писать ли `metadata.cost_usd`. Стоимость считается
 * в валюте провайдера/`pricing.currency` (по умолчанию USD).
 */
export function computeUsageCost(
  usage: TokenUsage | undefined,
  pricing: UsagePricing | null | undefined,
): UsageCost | null {
  if (!usage) return null;
  // Провайдер вернул стоимость — приоритетнее каталога (opencode `Usage.cost`).
  if (usage.cost && Number.isFinite(usage.cost.amount)) {
    return {
      costUsd: usage.cost.amount,
      breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      currency: usage.cost.currency,
    };
  }
  if (!pricing) return null;
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
