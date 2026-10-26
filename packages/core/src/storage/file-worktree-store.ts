import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type { WorktreeRecord } from '@itphx/synth-shared';
import type { WorktreeRepository } from './ports/worktree-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import { resolveCreatedAt } from './record-timestamps.js';

export interface FileWorktreeStoreConfig {
  dataDir: string;
}

/** Ключ массива записей внутри JSON-файла. */
const WORKTREES_KEY = 'worktrees';

/**
 * Файловая реализация порта инвентаря worktree'ов (ADR-096 — слой хранения;
 * ADR-005 — JSON + атомарная запись tmp→rename; ADR-114 — worktrees).
 *
 * Физическое расположение: `{dataDir}/worktrees.json`.
 *
 * Каталог создаётся при первой записи; отсутствие файла — пустой репозиторий
 * (не ошибка). Повреждённый JSON — понятная ошибка, а не тихий пустой список
 * (`readCollectionFile`): молчаливая пустая коллекция выглядела бы как
 * «все worktree'ы потеряны».
 *
 * Семантика повторяет in-memory реализацию (`MemoryWorktreeRepository`):
 * upsert по `id` (`createdAt` сохраняется, `updatedAt` — метка вызывающего),
 * список «свежие первыми» с фильтром по проекту, `delete` идемпотентно,
 * `deleteByProject` возвращает число удалённых записей.
 *
 * Конкурентные записи сериализуются `AsyncLock` — тот же приём, что у соседних
 * коллекций (например, `FileQuestionStore`).
 */
export class FileWorktreeStore implements WorktreeRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FileWorktreeStoreConfig) {}

  /** Путь файла записей (`{dataDir}/worktrees.json`). */
  path(): string {
    return join(this._config.dataDir, 'worktrees.json');
  }

  async save(record: WorktreeRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      const index = records.findIndex((r) => r.id === record.id);
      const stored = index === -1 ? undefined : records[index];
      const next: WorktreeRecord = {
        ...record,
        // `createdAt` иммутабельно; `updatedAt` ставит вызывающий (сервис) —
        // порт не подставляет «сейчас».
        createdAt: resolveCreatedAt(stored?.createdAt, record.createdAt),
        updatedAt: record.updatedAt,
      };
      if (index === -1) records.push(next);
      else records[index] = next;
      await this._write(records);
    } finally {
      this._lock.release();
    }
  }

  async get(id: string): Promise<WorktreeRecord | null> {
    const records = await this._read();
    return records.find((r) => r.id === id) ?? null;
  }

  async list(filter?: { projectId?: string }): Promise<WorktreeRecord[]> {
    const records = await this._read();
    const filtered = records.filter((r) => matches(r, filter));
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    return [...filtered].sort(byCreatedAtDesc);
  }

  async delete(id: string): Promise<void> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      const kept = records.filter((r) => r.id !== id);
      // Записи нет — идемпотентно, файл не трогаем.
      if (kept.length === records.length) return;
      await this._write(kept);
    } finally {
      this._lock.release();
    }
  }

  async deleteByProject(projectId: string): Promise<number> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      if (records.length === 0) return 0;
      const kept = records.filter((r) => r.projectId !== projectId);
      const removed = records.length - kept.length;
      if (removed === 0) return 0;
      await this._write(kept);
      return removed;
    } finally {
      this._lock.release();
    }
  }

  private async _read(): Promise<WorktreeRecord[]> {
    return readCollectionFile<WorktreeRecord>(this.path(), WORKTREES_KEY, 'файл worktree');
  }

  private async _write(records: WorktreeRecord[]): Promise<void> {
    await writeCollectionFile(this.path(), WORKTREES_KEY, records);
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
