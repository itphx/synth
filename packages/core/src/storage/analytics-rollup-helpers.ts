/**
 * Общая логика роллапов аналитики (ADR-102) для реализаций порта
 * `AnalyticsRollupRepository`.
 *
 * Вынесено отдельно, чтобы memory-реализация не тянула модули ФС (`fs`/`path`):
 * и файловый стор, и in-memory репозиторий используют один и тот же ключ бакета,
 * инкремент и агрегацию запроса. Модуль — internal (наружу не публикуется).
 */

import type {
  AnalyticsDimension,
  AnalyticsRollupBucket,
  AnalyticsRollupQuery,
  AnalyticsRollupRow,
} from '@itphx/synth-shared';

/** Числовая мера конечна и пригодна к агрегации. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Оставить только finite-числа. Неизвестные числовые меры сохраняются как есть
 * (`NaN`/`Infinity` — мусор, отбрасываются).
 */
export function normalizeNumberMap(input: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (isFiniteNumber(value)) out[key] = value;
  }
  return out;
}

/**
 * Нормализовать бакет: в измерениях — только строковые значения, в мерах — только
 * finite-числа. Пустая разбивка по валютам опускается (поле не задаётся).
 */
export function normalizeBucket(bucket: AnalyticsRollupBucket): AnalyticsRollupBucket {
  const dimensions: Record<string, string> = {};
  for (const [key, value] of Object.entries(bucket.dimensions ?? {})) {
    if (typeof value === 'string') dimensions[key] = value;
  }

  const normalized: AnalyticsRollupBucket = {
    family: bucket.family,
    day: bucket.day,
    dimensions,
    measures: normalizeNumberMap(bucket.measures),
  };
  const costByCurrency = normalizeNumberMap(bucket.costByCurrency);
  if (Object.keys(costByCurrency).length > 0) normalized.costByCurrency = costByCurrency;
  return normalized;
}

/** Отсортированные пары осей — детерминированный порядок, устойчивый к `&`/`=` в значениях. */
function sortedDimensionPairs(dimensions: Record<string, string>): Array<[string, string]> {
  return Object.entries(dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Устойчивый ключ бакета: `family\0day\0` + `JSON.stringify` отсортированных пар
 * осей. Не склейка `k=v&…` — значения могут содержать любые символы.
 */
export function rollupBucketKey(
  bucket: Pick<AnalyticsRollupBucket, 'family' | 'day' | 'dimensions'>,
): string {
  return `${bucket.family}\0${bucket.day}\0${JSON.stringify(sortedDimensionPairs(bucket.dimensions))}`;
}

/** Наложить инкремент: суммировать меры и разбивку стоимости по валютам. */
export function applyIncrement(target: AnalyticsRollupBucket, delta: AnalyticsRollupBucket): void {
  for (const [key, value] of Object.entries(delta.measures)) {
    target.measures[key] = (target.measures[key] ?? 0) + value;
  }
  if (delta.costByCurrency) {
    const merged = target.costByCurrency ?? {};
    for (const [key, value] of Object.entries(delta.costByCurrency)) {
      merged[key] = (merged[key] ?? 0) + value;
    }
    if (Object.keys(merged).length > 0) target.costByCurrency = merged;
  }
}

/** Значение оси бакета (`day` — отдельным полем, прочие — из `dimensions`). */
function axisValue(bucket: AnalyticsRollupBucket, axis: string): string | undefined {
  return axis === 'day' ? bucket.day : bucket.dimensions[axis];
}

/** Подходит ли бакет под фильтры запроса (семейство, период включительно, оси по равенству). */
function matchesQuery(bucket: AnalyticsRollupBucket, query: AnalyticsRollupQuery): boolean {
  if (bucket.family !== query.family) return false;
  if (query.from !== undefined && bucket.day < query.from) return false;
  if (query.to !== undefined && bucket.day > query.to) return false;
  if (query.dimensions) {
    for (const [axis, expected] of Object.entries(query.dimensions)) {
      if (expected === undefined) continue;
      if (axisValue(bucket, axis) !== expected) return false;
    }
  }
  return true;
}

/** Детерминированный порядок строк: лексикографически по осям группировки. */
function compareRows(
  a: AnalyticsRollupRow,
  b: AnalyticsRollupRow,
  axes: readonly AnalyticsDimension[],
): number {
  for (const axis of axes) {
    const av = a.dimensions[axis] ?? '';
    const bv = b.dimensions[axis] ?? '';
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * Агрегировать бакеты по `groupBy`: суммирование `measures`/`costByCurrency`,
 * порядок строк — по осям группировки. Пустой `groupBy` → одна итоговая строка с
 * `dimensions: {}`. Пустая разбивка по валютам в строке опускается.
 */
export function aggregateRollupQuery(
  buckets: Iterable<AnalyticsRollupBucket>,
  query: AnalyticsRollupQuery,
): AnalyticsRollupRow[] {
  const groupBy = query.groupBy ?? [];
  const groups = new Map<string, AnalyticsRollupRow>();

  for (const bucket of buckets) {
    if (!matchesQuery(bucket, query)) continue;

    const dimensions: Record<string, string> = {};
    for (const axis of groupBy) {
      const value = axisValue(bucket, axis);
      if (value !== undefined) dimensions[axis] = value;
    }
    const key = JSON.stringify(sortedDimensionPairs(dimensions));

    let row = groups.get(key);
    if (!row) {
      row = { dimensions, measures: {} };
      groups.set(key, row);
    }
    for (const [measure, value] of Object.entries(bucket.measures)) {
      row.measures[measure] = (row.measures[measure] ?? 0) + value;
    }
    if (bucket.costByCurrency) {
      const merged = row.costByCurrency ?? {};
      for (const [currency, value] of Object.entries(bucket.costByCurrency)) {
        merged[currency] = (merged[currency] ?? 0) + value;
      }
      if (Object.keys(merged).length > 0) row.costByCurrency = merged;
    }
  }

  const rows = [...groups.values()];
  for (const row of rows) {
    if (row.costByCurrency && Object.keys(row.costByCurrency).length === 0) delete row.costByCurrency;
  }
  rows.sort((a, b) => compareRows(a, b, groupBy));
  return rows;
}
