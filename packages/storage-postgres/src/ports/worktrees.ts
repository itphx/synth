/**
 * PG-реализация порта **инвентаря git-worktree'ов** (ADR-114, ADR-097).
 *
 * Хранение — **существующий** generic-слой `documents(kind, key, value jsonb)`
 * (миграция `001-init`): `kind = 'worktree'`, ключ документа — `id` записи,
 * значение — сама запись (`WorktreeRecord`) целиком. Новая таблица и новая
 * миграция **не нужны**: `kind` — свободный текст без CHECK-ограничений
 * (ADR-114 §2.2), расширяется лишь список `kind` в драйвере.
 *
 * Семантика повторяет файловые реализации core (`FileWorktreeStore`) и
 * in-memory (`MemoryWorktreeRepository`):
 * - upsert по `id`: `createdAt` не перезаписывается (сохранённое значение
 *   приоритетно), `updatedAt` — метка вызывающего (драйвер не подставляет
 *   «сейчас»);
 * - `list` — «свежие первыми» (`createdAt` убыв., тайбрейкер `id`), фильтр по
 *   проекту (поле записи);
 * - `delete` — идемпотентно, `deleteByProject` — число удалённых записей.
 *
 * Порядок сортировки и фильтр считаются в драйвере (объём коллекции мал), а
 * не SQL'ем: так семантика совпадает с файловым/в-памяти backend'ами
 * байт-в-байт (сортировка по ISO-8601-метке, а не по тексту jsonb).
 */

import type { StorageContext, WorktreeRepository } from '@itphx/synth-core';
import type { WorktreeRecord } from '@itphx/synth-shared';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';

/** Часть `StorageContext`, которой владеет группа «worktrees». */
export type WorktreePorts = Pick<StorageContext, 'worktrees'>;

/** `kind` generic-таблицы `documents` для записей worktree. */
const WORKTREE_KIND = 'worktree';

/** Порт инвентаря worktree'ов поверх таблицы `documents`. */
export class PgWorktreeRepository implements WorktreeRepository {
  constructor(private readonly _deps: PortDeps) {}

  async save(record: WorktreeRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO documents (kind, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (kind, key) DO UPDATE SET
         value = CASE
           WHEN documents.value ? 'createdAt'
             THEN jsonb_set(EXCLUDED.value, '{createdAt}', documents.value->'createdAt')
           ELSE EXCLUDED.value
         END,
         updated_at = now()`,
      [WORKTREE_KIND, record.id, jsonbParam(record)],
    );
  }

  async get(id: string): Promise<WorktreeRecord | null> {
    const rows = await this._deps.connection.query<{ value: WorktreeRecord }>(
      'SELECT value FROM documents WHERE kind = $1 AND key = $2 LIMIT 1',
      [WORKTREE_KIND, id],
    );
    const row = rows[0];
    return row ? (row.value as WorktreeRecord) : null;
  }

  async list(filter?: { projectId?: string }): Promise<WorktreeRecord[]> {
    const params: unknown[] = [WORKTREE_KIND];
    let sql = 'SELECT value FROM documents WHERE kind = $1';
    if (filter?.projectId !== undefined) {
      params.push(filter.projectId);
      sql += ` AND value->>'projectId' = $${params.length}`;
    }
    const rows = await this._deps.connection.query<{ value: WorktreeRecord }>(sql, params);
    const records = rows.map((row) => row.value as WorktreeRecord);
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    return [...records].sort(byCreatedAtDesc);
  }

  async delete(id: string): Promise<void> {
    await this._deps.connection.query('DELETE FROM documents WHERE kind = $1 AND key = $2', [
      WORKTREE_KIND,
      id,
    ]);
  }

  async deleteByProject(projectId: string): Promise<number> {
    const rows = await this._deps.connection.query<{ key: string }>(
      `DELETE FROM documents
        WHERE kind = $1 AND value->>'projectId' = $2
        RETURNING key`,
      [WORKTREE_KIND, projectId],
    );
    return rows.length;
  }
}

/** Сортировка «свежие первыми» (`createdAt` убыв.), тайбрейкер — `id`. */
function byCreatedAtDesc(a: WorktreeRecord, b: WorktreeRecord): number {
  const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return a.id.localeCompare(b.id);
}

/** Собрать порт инвентаря worktree'ов (ADR-114). */
export function buildWorktreePorts(deps: PortDeps): WorktreePorts {
  return {
    worktrees: new PgWorktreeRepository(deps),
  };
}
