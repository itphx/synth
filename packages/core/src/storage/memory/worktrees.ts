/**
 * In-memory реализация порта **инвентаря worktree'ов** (ADR-096, второй
 * backend за единым слоем хранения; ADR-114 — worktrees).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в `Map`
 * процесса. Семантика повторяет файловую реализацию
 * (`FileWorktreeStore`): upsert по `id` (`createdAt` сохраняется,
 * `updatedAt` — метка вызывающего), детерминированный порядок списка
 * («свежие первыми»), фильтр по проекту, `delete` идемпотентно,
 * `deleteByProject` возвращает число удалённых записей.
 *
 * Возвращаемые записи — копии (`structuredClone`), как в остальных
 * memory-портах: мутация результата не влияет на стор.
 */

import type { WorktreeRecord } from '@itphx/synth-shared';
import type { WorktreeRepository } from '../ports/worktree-repository.js';
import { resolveCreatedAt } from '../record-timestamps.js';

/**
 * Порт инвентаря worktree'ов поверх `Map` (реализация — `FileWorktreeStore`).
 */
export class MemoryWorktreeRepository implements WorktreeRepository {
  private readonly _worktrees = new Map<string, WorktreeRecord>();

  async save(record: WorktreeRecord): Promise<void> {
    const stored = this._worktrees.get(record.id);
    this._worktrees.set(record.id, {
      ...structuredClone(record),
      // `createdAt` иммутабельно; `updatedAt` ставит вызывающий (сервис).
      createdAt: resolveCreatedAt(stored?.createdAt, record.createdAt),
      updatedAt: record.updatedAt,
    });
  }

  async get(id: string): Promise<WorktreeRecord | null> {
    const record = this._worktrees.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(filter?: { projectId?: string }): Promise<WorktreeRecord[]> {
    const filtered = [...this._worktrees.values()].filter((r) => matches(r, filter));
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    return [...filtered].sort(byCreatedAtDesc).map((r) => structuredClone(r));
  }

  async delete(id: string): Promise<void> {
    // Отсутствующая запись — не ошибка (идемпотентно).
    this._worktrees.delete(id);
  }

  async deleteByProject(projectId: string): Promise<number> {
    let removed = 0;
    for (const [id, record] of [...this._worktrees.entries()]) {
      if (record.projectId !== projectId) continue;
      this._worktrees.delete(id);
      removed += 1;
    }
    return removed;
  }
}

/** Совпадает ли запись с фильтрами выборки (все условия — по «И»). */
function matches(
  record: WorktreeRecord,
  filter: { projectId?: string } | undefined,
): boolean {
  if (!filter) return true;
  if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false;
  return true;
}

/** Сортировка «свежие первыми» (`createdAt` убыв.), тайбрейкер — `id`. */
function byCreatedAtDesc(a: WorktreeRecord, b: WorktreeRecord): number {
  const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return a.id.localeCompare(b.id);
}
