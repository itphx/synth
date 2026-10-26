import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type {
  BackgroundRunFilter,
  BackgroundRunRecord,
  BackgroundRunStatus,
} from '@itphx/synth-shared';
import { BACKGROUND_RUN_TERMINAL_STATUSES } from '@itphx/synth-shared';
import type { BackgroundRunRepository } from './ports/background-run-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import { resolveCollectionLimit } from './ports/collection-limit.js';
import { isOlderThan, parseCutoffMs } from './retention.js';

export interface FileBackgroundRunStoreConfig {
  dataDir: string;
}

/** Ключ массива прогонов внутри JSON-файла. */
const RUNS_KEY = 'runs';

/**
 * Файловая реализация порта единого реестра фоновых прогонов (ADR-096 — слой
 * хранения; ADR-005 — JSON + атомарная запись tmp→rename; этап 1 roadmap 0.13 —
 * блок 1.2; PROP-096/PROP-097).
 *
 * Физическое расположение: `{dataDir}/processes/registry.json` (PROP-097
 * «Реестр»). Логи процессов лежат рядом — `{dataDir}/processes/<id>.log`
 * (BlobStore, следующий блок).
 *
 * Семантика повторяет in-memory реализацию (`MemoryBackgroundRunRepository`):
 * upsert по `id` (`startedAt` иммутабельно, `updatedAt` монотонно
 * обновляется), список «свежие первыми» (`startedAt` убыв.) с фильтрами по
 * «И», `prune` — только терминальные статусы старше отсечки.
 */
export class FileBackgroundRunStore implements BackgroundRunRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FileBackgroundRunStoreConfig) {}

  /** Путь файла реестра (`{dataDir}/processes/registry.json`). */
  path(): string {
    return join(this._config.dataDir, 'processes', 'registry.json');
  }

  async save(record: BackgroundRunRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      const index = records.findIndex((r) => r.id === record.id);
      const stored = index === -1 ? undefined : records[index];
      const next: BackgroundRunRecord = {
        ...record,
        // `startedAt` иммутабельно (начало прогона не меняется); `updatedAt`
        // ставит вызывающий (сервис) — порт не подставляет «сейчас», иначе
        // retention-очистка по метке записи теряла бы смысл.
        startedAt: stored?.startedAt ?? record.startedAt,
        updatedAt: record.updatedAt,
      };
      if (index === -1) records.push(next);
      else records[index] = next;
      await this._write(records);
    } finally {
      this._lock.release();
    }
  }

  async get(id: string): Promise<BackgroundRunRecord | null> {
    const records = await this._read();
    return records.find((r) => r.id === id) ?? null;
  }

  async list(filter?: BackgroundRunFilter): Promise<BackgroundRunRecord[]> {
    const records = await this._read();
    const filtered = records.filter((r) => matches(r, filter));
    // Свежие первыми (`startedAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort(byStartedAtDesc);
    return sorted.slice(0, resolveCollectionLimit(filter?.limit));
  }

  async remove(id: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      const next = records.filter((r) => r.id !== id);
      if (next.length === records.length) return false;
      await this._write(next);
      return true;
    } finally {
      this._lock.release();
    }
  }

  async prune(before: string, statuses?: BackgroundRunStatus[]): Promise<number> {
    const cutoff = parseCutoffMs(before);
    if (cutoff === null) return 0;
    const allowed = prunableStatuses(statuses);
    await this._lock.acquire();
    try {
      const records = await this._read();
      if (records.length === 0) return 0;
      const kept = records.filter((r) => !(allowed.has(r.status) && isOlderThan(r.updatedAt, cutoff)));
      const removed = records.length - kept.length;
      if (removed === 0) return 0;
      await this._write(kept);
      return removed;
    } finally {
      this._lock.release();
    }
  }

  private async _read(): Promise<BackgroundRunRecord[]> {
    return readCollectionFile<BackgroundRunRecord>(this.path(), RUNS_KEY, 'реестр фоновых прогонов');
  }

  private async _write(records: BackgroundRunRecord[]): Promise<void> {
    await writeCollectionFile(this.path(), RUNS_KEY, records);
  }
}

/**
 * Статусы, которые можно чистить: только терминальные. Нетерминальные статусы
 * из аргумента игнорируются — «running» не удаляется никогда.
 */
export function prunableStatuses(
  statuses?: BackgroundRunStatus[],
): ReadonlySet<BackgroundRunStatus> {
  if (statuses === undefined) return new Set(BACKGROUND_RUN_TERMINAL_STATUSES);
  return new Set(statuses.filter((status) => BACKGROUND_RUN_TERMINAL_STATUSES.includes(status)));
}

/** Совпадает ли прогон с фильтрами выборки (все условия — по «И»). */
function matches(record: BackgroundRunRecord, filter: BackgroundRunFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.kind !== undefined && record.kind !== filter.kind) return false;
  if (filter.status !== undefined && record.status !== filter.status) return false;
  if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) return false;
  if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false;
  return true;
}

/** Сортировка «свежие первыми» (`startedAt` убыв.), тайбрейкер — `id`. */
function byStartedAtDesc(a: BackgroundRunRecord, b: BackgroundRunRecord): number {
  const diff = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return a.id.localeCompare(b.id);
}
