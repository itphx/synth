import type { WorktreeRecord } from '@itphx/synth-shared';

/**
 * Порт инвентаря git-worktree'ов (ADR-114, ADR-096 — слой хранения).
 *
 * Worktree — вторичная рабочая копия репозитория проекта; запись в порте —
 * **данные** (путь каталога, ветка, привязка к проекту). Создание каталога,
 * `git worktree add`, привязка сессии и резолв рабочего каталога — забота
 * сервиса, порт только хранит.
 *
 * Семантика (общая для всех backend'ов):
 * - `save` — **полная перезапись** записи (upsert по `id`): `createdAt`
 *   иммутабельно (сохранённое значение приоритетно), `updatedAt` ставит
 *   **вызывающий** (сервис) — порт не подставляет «сейчас», иначе метка
 *   изменения записи теряла бы смысл;
 * - `list` — «свежие первыми» (`createdAt` убыв., тайбрейкер `id`), фильтр —
 *   по «И» (сейчас единственный фильтр — проект);
 * - `delete` — идемпотентно: удаление отсутствующей записи — не ошибка;
 * - `deleteByProject` — снятие всех записей проекта (prune/удаление
 *   проекта); возвращает число фактически удалённых записей.
 */
export interface WorktreeRepository {
  /** Upsert по `id` (создание или перезапись). */
  save(record: WorktreeRecord): Promise<void>;
  /** Запись по `id`; отсутствующая — `null`. */
  get(id: string): Promise<WorktreeRecord | null>;
  /**
   * Список записей (свежие первыми); фильтр — по «И».
   * @future-backend — `WHERE project_id = ? ORDER BY created_at DESC, id ASC`.
   */
  list(filter?: { projectId?: string }): Promise<WorktreeRecord[]>;
  /** Удаление записи; отсутствующая — не ошибка (идемпотентно). */
  delete(id: string): Promise<void>;
  /** Удаление всех записей проекта; возвращает число удалённых записей. */
  deleteByProject(projectId: string): Promise<number>;
}
