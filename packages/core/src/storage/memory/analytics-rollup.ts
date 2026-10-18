/**
 * In-memory реализация порта `AnalyticsRollupRepository` (PROP-102).
 *
 * Семантика повторяет файловую (`AnalyticsRollupStore`): бакеты держатся в
 * массиве, ключ/инкремент/агрегация — общие (`analytics-rollup-helpers.ts`).
 * Модули ФС (`fs`/`path`) не тянутся; состояние — в памяти процесса
 * (герметичные тесты). Нормализация и агрегация всегда строят новые объекты,
 * поэтому внутреннее состояние не утекает наружу копией ссылок.
 */

import type {
  AnalyticsRollupBucket,
  AnalyticsRollupQuery,
  AnalyticsRollupRow,
} from '@itphx/synth-shared';
import type { AnalyticsRollupRepository } from '../ports/index.js';
import {
  aggregateRollupQuery,
  applyIncrement,
  normalizeBucket,
  rollupBucketKey,
} from '../analytics-rollup-helpers.js';

/** Порт пред-агрегированных суточных роллапов аналитики поверх массива. */
export class MemoryAnalyticsRollupRepository implements AnalyticsRollupRepository {
  private _buckets: AnalyticsRollupBucket[] = [];

  /** Индекс бакета с тем же ключом `(family, day, dimensions)`, иначе −1. */
  private _indexOf(normalized: AnalyticsRollupBucket): number {
    const key = rollupBucketKey(normalized);
    return this._buckets.findIndex((bucket) => rollupBucketKey(bucket) === key);
  }

  async increment(bucket: AnalyticsRollupBucket): Promise<void> {
    const normalized = normalizeBucket(bucket);
    const index = this._indexOf(normalized);
    if (index === -1) {
      this._buckets.push(normalized);
    } else {
      applyIncrement(this._buckets[index]!, normalized);
    }
  }

  async set(bucket: AnalyticsRollupBucket): Promise<void> {
    const normalized = normalizeBucket(bucket);
    const index = this._indexOf(normalized);
    if (index === -1) {
      this._buckets.push(normalized);
    } else {
      this._buckets[index] = normalized;
    }
  }

  async query(query: AnalyticsRollupQuery): Promise<AnalyticsRollupRow[]> {
    return aggregateRollupQuery(this._buckets, query);
  }

  /** Удаляет бакеты с `day < beforeDay` (граничный `beforeDay` остаётся). */
  async prune(beforeDay: string): Promise<number> {
    const kept = this._buckets.filter((bucket) => bucket.day >= beforeDay);
    const removed = this._buckets.length - kept.length;
    this._buckets = kept;
    return removed;
  }

  async clear(): Promise<number> {
    const removed = this._buckets.length;
    this._buckets = [];
    return removed;
  }
}
