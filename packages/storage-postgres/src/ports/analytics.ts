/**
 * Порт роллапов аналитики PostgreSQL-драйвера (PROP-102).
 *
 * Таблица `analytics_rollups` (миграция 003): ключ бакета — составной первичный
 * ключ `(family, day, dimensions)` (`jsonb` нормализует порядок ключей объекта,
 * поэтому равенство измерений устойчиво и годится для btree-равенства; отдельный
 * `dimensions_key` не нужен). `measures`/`cost_by_currency` — `jsonb`-словари
 * чисел (`cost_by_currency` пустая → `NULL`).
 *
 * `increment` — атомарный upsert `INSERT … ON CONFLICT (family, day, dimensions)
 * DO UPDATE` с суммированием `measures`/`cost_by_currency` прямо в SQL (jsonb →
 * `jsonb_each_text` → `SUM` → `jsonb_object_agg`); advisory-локи не нужны —
 * конкурентные инкременты сериализуются конфликтом уникального ключа. `set` —
 * точная перезапись полей из `EXCLUDED`.
 *
 * Семантика нормализации/сложения/агрегации повторяет общий core-хелпер
 * (`analytics-rollup-helpers.ts`): драйвер не тянет core рантаймом (только
 * `import type`), поэтому фильтр по семейству/периоду выполняется в SQL, а
 * группировка `groupBy` и слияние мер — локальной точной репликой хелпера.
 */

import type {
  AnalyticsDimension,
  AnalyticsRollupBucket,
  AnalyticsRollupQuery,
  AnalyticsRollupRow,
} from '@itphx/synth-shared';
import type { AnalyticsRollupRepository, StorageContext } from '@itphx/synth-core';
import type { PostgresExecutor } from '../pool.js';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';

type Row = Record<string, unknown>;

// ────────────────────────────────────────────────────────────────────────────
// Локальная реплика `packages/core/src/storage/analytics-rollup-helpers.ts`
// (core не тянется рантаймом; поведение обязано совпадать с memory/file).
// ────────────────────────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Оставить только finite-числа (NaN/Infinity — мусор). */
function normalizeNumberMap(input: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (isFiniteNumber(value)) out[key] = value;
  }
  return out;
}

/**
 * Нормализовать бакет: в измерениях — только строки, в мерах — только
 * finite-числа; пустая разбивка по валютам опускается (поле не задаётся).
 */
function normalizeBucket(bucket: AnalyticsRollupBucket): AnalyticsRollupBucket {
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

/** Отсортированные пары осей — устойчивый порядок (устойчив к `&`/`=` в значениях). */
function sortedDimensionPairs(dimensions: Record<string, string>): Array<[string, string]> {
  return Object.entries(dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Значение оси бакета (`day` — отдельным полем, прочие — из `dimensions`). */
function axisValue(bucket: AnalyticsRollupBucket, axis: string): string | undefined {
  return axis === 'day' ? bucket.day : bucket.dimensions[axis];
}

/** Подходит ли бакет под фильтры (семейство, период включительно, оси по равенству). */
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

/** Агрегировать бакеты по `groupBy` (пусто — одна итоговая строка). */
function aggregateRollups(
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

// ────────────────────────────────────────────────────────────────────────────
// Чтение строк БД → бакет
// ────────────────────────────────────────────────────────────────────────────

function rowToBucket(row: Row): AnalyticsRollupBucket {
  const bucket: AnalyticsRollupBucket = {
    family: String(row.family) as AnalyticsRollupBucket['family'],
    day: String(row.day),
    dimensions: (row.dimensions ?? {}) as Record<string, string>,
    measures: (row.measures ?? {}) as Record<string, number>,
  };
  if (row.cost_by_currency !== null && row.cost_by_currency !== undefined) {
    bucket.costByCurrency = row.cost_by_currency as Record<string, number>;
  }
  return bucket;
}

/** Параметры записи бакета: family/day + нормализованные jsonb-словари. */
function bucketParams(bucket: AnalyticsRollupBucket): unknown[] {
  const normalized = normalizeBucket(bucket);
  return [
    normalized.family,
    normalized.day,
    jsonbParam(normalized.dimensions),
    jsonbParam(normalized.measures),
    normalized.costByCurrency ? jsonbParam(normalized.costByCurrency) : null,
  ];
}

/**
 * `jsonb_object_agg` сумм (`SUM`) с `COALESCE` для пустого набора строк
 * (нет ни одной меры) → `'{}'::jsonb`.
 */
const SQL_SUM_MEASURES = `COALESCE(jsonb_object_agg(key, total), '{}'::jsonb)`;
const SQL_EACH_SUM = `SELECT key, SUM(value::numeric) AS total
                         FROM (%ROWS%) AS merged
                         GROUP BY key`;

/** Слитый `measures` при инкременте: сумма по ключам существующих и новых мер. */
const INCREMENT_SQL = `
INSERT INTO analytics_rollups (family, day, dimensions, measures, cost_by_currency)
VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
ON CONFLICT (family, day, dimensions) DO UPDATE SET
  measures = (
    SELECT ${SQL_SUM_MEASURES}
    FROM (${SQL_EACH_SUM.replace(
      '%ROWS%',
      `SELECT key, value FROM jsonb_each_text(analytics_rollups.measures)
       UNION ALL
       SELECT key, value FROM jsonb_each_text(EXCLUDED.measures)`,
    )}) AS summed
  ),
  cost_by_currency = CASE
    WHEN COALESCE(analytics_rollups.cost_by_currency, '{}'::jsonb) = '{}'::jsonb
     AND COALESCE(EXCLUDED.cost_by_currency, '{}'::jsonb) = '{}'::jsonb
    THEN NULL
    ELSE (
      SELECT ${SQL_SUM_MEASURES}
      FROM (${SQL_EACH_SUM.replace(
        '%ROWS%',
        `SELECT key, value FROM jsonb_each_text(COALESCE(analytics_rollups.cost_by_currency, '{}'::jsonb))
         UNION ALL
         SELECT key, value FROM jsonb_each_text(COALESCE(EXCLUDED.cost_by_currency, '{}'::jsonb))`,
      )}) AS summed
    )
  END`;

/** Точная перезапись бакета по ключу (`set`). */
const SET_SQL = `
INSERT INTO analytics_rollups (family, day, dimensions, measures, cost_by_currency)
VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
ON CONFLICT (family, day, dimensions) DO UPDATE SET
  measures = EXCLUDED.measures,
  cost_by_currency = EXCLUDED.cost_by_currency`;

/** Порт пред-агрегированных суточных роллапов аналитики поверх SQL. */
class PostgresAnalyticsRollupRepository implements AnalyticsRollupRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async increment(bucket: AnalyticsRollupBucket): Promise<void> {
    await this._db().query(INCREMENT_SQL, bucketParams(bucket));
  }

  async set(bucket: AnalyticsRollupBucket): Promise<void> {
    await this._db().query(SET_SQL, bucketParams(bucket));
  }

  async query(query: AnalyticsRollupQuery): Promise<AnalyticsRollupRow[]> {
    const params: unknown[] = [query.family];
    let where = 'family = $1';
    if (query.from !== undefined) {
      params.push(query.from);
      where += ` AND day >= $${params.length}`;
    }
    if (query.to !== undefined) {
      params.push(query.to);
      where += ` AND day <= $${params.length}`;
    }
    const rows = await this._db().query<Row>(
      `SELECT family, day, dimensions, measures, cost_by_currency
         FROM analytics_rollups WHERE ${where}`,
      params,
    );
    return aggregateRollups(rows.map(rowToBucket), query);
  }

  async prune(beforeDay: string): Promise<number> {
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM analytics_rollups WHERE day < $1 RETURNING 1) SELECT count(*)::int AS n FROM deleted',
      [beforeDay],
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value : Number(value) || 0;
  }

  async clear(): Promise<number> {
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM analytics_rollups RETURNING 1) SELECT count(*)::int AS n FROM deleted',
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value : Number(value) || 0;
  }
}

/** Часть `StorageContext`, которой владеет группа `analytics`. */
export type AnalyticsPorts = Pick<StorageContext, 'analyticsRollups'>;

/** Собрать порт роллапов аналитики. */
export function buildAnalyticsPorts(deps: PortDeps): AnalyticsPorts {
  return { analyticsRollups: new PostgresAnalyticsRollupRepository(deps) };
}
