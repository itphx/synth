/**
 * In-memory реализация порта **единого реестра фоновых прогонов** (ADR-096,
 * второй backend за единым слоем хранения; этап 1 roadmap 0.13 — блок 1.2;
 * PROP-096 — фоновые саб-агенты, PROP-097 — фоновые шелл-процессы).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в `Map`
 * процесса. Семантика повторяет файловую реализацию
 * (`FileBackgroundRunStore`): upsert по `id` (`startedAt` иммутабельно,
 * `updatedAt` монотонно обновляется), список «свежие первыми»
 * (`startedAt` убыв.) с фильтрами по «И», `remove` — идемпотентно,
 * `prune` — только терминальные статусы старше отсечки.
 *
 * Возвращаемые записи — копии (`structuredClone`), как в остальных
 * memory-портах: мутация результата не влияет на стор.
 */

import type {
  BackgroundRunFilter,
  BackgroundRunRecord,
  BackgroundRunStatus,
} from '@itphx/synth-shared';
import { BACKGROUND_RUN_TERMINAL_STATUSES } from '@itphx/synth-shared';
import type { BackgroundRunRepository } from '../ports/background-run-repository.js';
import { resolveCollectionLimit } from '../ports/collection-limit.js';
import { isOlderThan, parseCutoffMs } from '../retention.js';

/**
 * Порт реестра фоновых прогонов поверх `Map` (реализация —
 * `FileBackgroundRunStore`).
 */
export class MemoryBackgroundRunRepository implements BackgroundRunRepository {
  private readonly _runs = new Map<string, BackgroundRunRecord>();

  async save(record: BackgroundRunRecord): Promise<void> {
    const stored = this._runs.get(record.id);
    this._runs.set(record.id, {
      ...structuredClone(record),
      // `startedAt` иммутабельно; `updatedAt` ставит вызывающий (сервис).
      startedAt: stored?.startedAt ?? record.startedAt,
      updatedAt: record.updatedAt,
    });
  }

  async get(id: string): Promise<BackgroundRunRecord | null> {
    const record = this._runs.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(filter?: BackgroundRunFilter): Promise<BackgroundRunRecord[]> {
    const filtered = [...this._runs.values()].filter((r) => matches(r, filter));
    // Свежие первыми (`startedAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort(byStartedAtDesc);
    return sorted
      .slice(0, resolveCollectionLimit(filter?.limit))
      .map((r) => structuredClone(r));
  }

  async remove(id: string): Promise<boolean> {
    return this._runs.delete(id);
  }

  async prune(before: string, statuses?: BackgroundRunStatus[]): Promise<number> {
    const cutoff = parseCutoffMs(before);
    if (cutoff === null) return 0;
    const allowed = prunableStatuses(statuses);
    let removed = 0;
    for (const [id, record] of [...this._runs.entries()]) {
      if (!(allowed.has(record.status) && isOlderThan(record.updatedAt, cutoff))) continue;
      this._runs.delete(id);
      removed += 1;
    }
    return removed;
  }
}

/**
 * Статусы, которые можно чистить: только терминальные. Нетерминальные статусы
 * из аргумента игнорируются — «running» не удаляется никогда.
 */
function prunableStatuses(
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
