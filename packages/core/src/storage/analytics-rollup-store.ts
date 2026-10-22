import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ANALYTICS_FAMILIES } from '@itphx/synth-shared';
import type {
  AnalyticsRollupBucket,
  AnalyticsRollupQuery,
  AnalyticsRollupRow,
} from '@itphx/synth-shared';
import { AsyncLock, atomicWrite, safeJsonParse } from '@itphx/synth-shared';
import type { AnalyticsRollupRepository } from './ports/analytics-rollup-repository.js';
import {
  aggregateRollupQuery,
  applyIncrement,
  normalizeBucket,
  rollupBucketKey,
} from './analytics-rollup-helpers.js';

/** Версия схемы файла роллапов аналитики — для будущей миграции (ADR-096). */
export const ANALYTICS_ROLLUPS_SCHEMA_VERSION = 1;

export interface AnalyticsRollupStoreConfig {
  dataDir: string;
}

interface AnalyticsRollupsFile {
  schemaVersion: number;
  buckets: AnalyticsRollupBucket[];
}

const FAMILY_SET: ReadonlySet<string> = new Set(ANALYTICS_FAMILIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Лёгкая защита от мусора при чтении (повреждённый/устаревший файл): семейство
 * из реестра, `day` — строка, `dimensions`/`measures` — объекты, `costByCurrency`
 * (если задан) — объект. Неизвестные числовые меры сохраняются (см.
 * `normalizeNumberMap`), проверяется только форма.
 */
function isRollupBucket(value: unknown): value is AnalyticsRollupBucket {
  if (!isRecord(value)) return false;
  if (typeof value.family !== 'string' || !FAMILY_SET.has(value.family)) return false;
  if (typeof value.day !== 'string') return false;
  if (!isRecord(value.dimensions)) return false;
  if (!isRecord(value.measures)) return false;
  if (value.costByCurrency !== undefined && !isRecord(value.costByCurrency)) return false;
  return true;
}

/**
 * ADR-102: файловая реализация порта `AnalyticsRollupRepository` — пред-
 * агрегированные суточные роллапы аналитики.
 *
 * Хранится одним JSON-файлом `{dataDir}/analytics/rollups.json` (ADR-005,
 * атомарная запись tmp→rename): `{schemaVersion, buckets}`. Модель PG-ready
 * (ADR-096): плоские записи со стабильным `schemaVersion`. Вся логика ключа,
 * инкремента и агрегации — в `analytics-rollup-helpers.ts` (общая с memory-
 * реализацией, чтобы та не тянула модули ФС).
 */
export class AnalyticsRollupStore implements AnalyticsRollupRepository {
  private _lock = new AsyncLock();

  constructor(private _config: AnalyticsRollupStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'analytics', 'rollups.json');
  }

  /** Чтение бакетов с лёгкой валидацией и нормализацией; отсутствие/мусор → []. */
  private async _load(): Promise<AnalyticsRollupBucket[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf-8');
    } catch {
      return [];
    }
    const parsed = safeJsonParse<AnalyticsRollupsFile | null>(raw, null);
    if (!parsed || !Array.isArray(parsed.buckets)) return [];
    return parsed.buckets.filter(isRollupBucket).map(normalizeBucket);
  }

  private async _save(buckets: AnalyticsRollupBucket[]): Promise<void> {
    const path = this._filePath();
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(
      { schemaVersion: ANALYTICS_ROLLUPS_SCHEMA_VERSION, buckets },
      null,
      2,
    );
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }

  async increment(bucket: AnalyticsRollupBucket): Promise<void> {
    await this._lock.acquire();
    try {
      const normalized = normalizeBucket(bucket);
      const buckets = await this._load();
      const key = rollupBucketKey(normalized);
      const existing = buckets.find((b) => rollupBucketKey(b) === key);
      if (existing) {
        applyIncrement(existing, normalized);
      } else {
        buckets.push(normalized);
      }
      await this._save(buckets);
    } finally {
      this._lock.release();
    }
  }

  async set(bucket: AnalyticsRollupBucket): Promise<void> {
    await this._lock.acquire();
    try {
      const normalized = normalizeBucket(bucket);
      const buckets = await this._load();
      const key = rollupBucketKey(normalized);
      const index = buckets.findIndex((b) => rollupBucketKey(b) === key);
      if (index === -1) {
        buckets.push(normalized);
      } else {
        buckets[index] = normalized;
      }
      await this._save(buckets);
    } finally {
      this._lock.release();
    }
  }

  async query(query: AnalyticsRollupQuery): Promise<AnalyticsRollupRow[]> {
    const buckets = await this._load();
    return aggregateRollupQuery(buckets, query);
  }

  /** Удаляет бакеты с `day < beforeDay` (граничный `beforeDay` остаётся). */
  async prune(beforeDay: string): Promise<number> {
    await this._lock.acquire();
    try {
      const buckets = await this._load();
      const kept = buckets.filter((b) => b.day >= beforeDay);
      const removed = buckets.length - kept.length;
      if (removed === 0) return 0;
      await this._save(kept);
      return removed;
    } finally {
      this._lock.release();
    }
  }

  async clear(): Promise<number> {
    await this._lock.acquire();
    try {
      const buckets = await this._load();
      if (buckets.length === 0) return 0;
      await this._save([]);
      return buckets.length;
    } finally {
      this._lock.release();
    }
  }
}
