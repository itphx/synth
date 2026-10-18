import type {
  AnalyticsRollupBucket,
  AnalyticsRollupQuery,
  AnalyticsRollupRow,
} from '@itphx/synth-shared';

/**
 * Порт пред-агрегированных суточных роллапов аналитики (PROP-102).
 *
 * Ключ бакета — `(family, day, dimensions)` (измерения в отсортированном
 * порядке). `increment` — идемпотентный upsert по ключу с суммированием
 * `measures`/`costByCurrency`; `set` — точная перезапись. `query` фильтрует по
 * семейству/периоду/осям и агрегирует по `groupBy` (пусто — одна итоговая
 * строка).
 *
 * Единственная точка доступа к роллапам для домена (ADR-096): прямой записи в
 * `$SYNTH_DATA_DIR` в обход порта нет (инвариант 2). Любая реализация обязана
 * пройти контрактный suite `storage/contract/*`.
 */
export interface AnalyticsRollupRepository {
  /** Инкрементировать бакет: upsert по ключу + суммирование мер. */
  increment(bucket: AnalyticsRollupBucket): Promise<void>;
  /** Записать бакет ровно как есть (перезапись, в т.ч. до пустых мер). */
  set(bucket: AnalyticsRollupBucket): Promise<void>;
  /** Срез/серия: фильтры семейство/период/оси + агрегация по `groupBy`. */
  query(query: AnalyticsRollupQuery): Promise<AnalyticsRollupRow[]>;
  /** Удалить бакеты с `day < beforeDay`; число удалённых. */
  prune(beforeDay: string): Promise<number>;
  /** Полная очистка; число удалённых бакетов. */
  clear(): Promise<number>;
}
