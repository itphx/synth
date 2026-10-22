/**
 * ADR-102: дериваты отчётов аналитики, считаемые **на чтении** из сырых
 * счётчиков роллапов. Хранилище дериватов не персистит (дублирование
 * денормализованного значения расходится с сырым счётчиком).
 *
 * Дериваты определены только для «usage-производных» семейств (`usage` и
 * `prompt`): `prompt` — производное чтение того же семейства `usage`, отдельной
 * записи не требует.
 */

import type { AnalyticsReportKind } from '@itphx/synth-shared';
import { computeCacheHitRate } from '../providers/usage.js';

/**
 * Семейства, к мерам которых применимы дериваты (`usage` и производное
 * `prompt`). Для `activity`/`decision` меры остаются сырыми.
 */
export function isUsageDerivedFamily(kind: AnalyticsReportKind): boolean {
  return kind === 'usage' || kind === 'prompt';
}

/**
 * Посчитать дериваты по сырым счётчикам строки/итога:
 * - `total_tokens = input_tokens + output_tokens`;
 * - `cache_hit_rate = cache_read_tokens / input_tokens` (0 при нуле входных);
 * - `reasoning_ratio = reasoning_tokens / output_tokens` (0 при нуле выходных);
 * - `output_tps = output_tokens / (duration_ms / 1000)` (0 при нуле длительности).
 *
 * Отсутствующие счётчики трактуются как 0; знаменатель 0 → дериват 0 (без
 * `NaN`/`Infinity`). Возвращает только дериваты — вызывающий накладывает их
 * поверх сырых мер.
 */
export function deriveMeasures(measures: Record<string, number>): Record<string, number> {
  const input = measures.input_tokens ?? 0;
  const output = measures.output_tokens ?? 0;
  const cacheRead = measures.cache_read_tokens ?? 0;
  const reasoning = measures.reasoning_tokens ?? 0;
  const durationMs = measures.duration_ms ?? 0;
  return {
    total_tokens: input + output,
    cache_hit_rate: computeCacheHitRate(cacheRead, input),
    reasoning_ratio: output > 0 ? reasoning / output : 0,
    output_tps: durationMs > 0 ? output / (durationMs / 1000) : 0,
  };
}
