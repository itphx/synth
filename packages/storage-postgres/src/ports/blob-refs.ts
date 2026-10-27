/**
 * PG-реализация порта **учёта ссылок на объекты blob-хранилища**
 * (ADR-115 §«Хранение», ADR-116 §3, ADR-097).
 *
 * Хранение — таблица `blob_refs` (миграция `024_blob_refs`): первичный ключ —
 * тройка `(blob_path, owner_kind, owner_id)`, индекс по владельцу
 * `(owner_kind, owner_id)`.
 *
 * Байты самих объектов в БД **не** лежат (том, ADR-116 §2) — здесь только
 * учёт ссылок: по нему дедуп (по содержимому) и детерминированный GC (ссылок
 * не осталось → объект можно удалять).
 *
 * Семантика повторяет файловую реализацию core (`FileBlobRefRepository`) и
 * in-memory (`MemoryBlobRefRepository`):
 * - `add` **идемпотентен** (`ON CONFLICT DO NOTHING` — дубля не создаётся);
 * - `remove` снимает ровно одну ссылку; отсутствие ссылки — не ошибка;
 * - `removeByOwner` снимает все ссылки владельца и возвращает их число;
 * - `listByOwner` отдаёт пути в детерминированном порядке (`ORDER BY`);
 * - `countRefs` считает ссылки на объект.
 */

import type { BlobOwnerKind, BlobRef, BlobRefRepository, StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';

/** Часть `StorageContext`, которой владеет группа «blob-refs». */
export type BlobRefPorts = Pick<StorageContext, 'blobRefs'>;

/** Порт учёта ссылок на blob-объекты поверх таблицы `blob_refs`. */
export class PgBlobRefRepository implements BlobRefRepository {
  constructor(private readonly _deps: PortDeps) {}

  async add(ref: BlobRef): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO blob_refs (blob_path, owner_kind, owner_id, created_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (blob_path, owner_kind, owner_id) DO NOTHING`,
      [ref.blobPath, ref.ownerKind, ref.ownerId],
    );
  }

  async remove(ref: BlobRef): Promise<void> {
    await this._deps.connection.query(
      'DELETE FROM blob_refs WHERE blob_path = $1 AND owner_kind = $2 AND owner_id = $3',
      [ref.blobPath, ref.ownerKind, ref.ownerId],
    );
  }

  async removeByOwner(ownerKind: BlobOwnerKind, ownerId: string): Promise<number> {
    const rows = await this._deps.connection.query<{ blob_path: string }>(
      'DELETE FROM blob_refs WHERE owner_kind = $1 AND owner_id = $2 RETURNING blob_path',
      [ownerKind, ownerId],
    );
    return rows.length;
  }

  async listByOwner(ownerKind: BlobOwnerKind, ownerId: string): Promise<string[]> {
    const rows = await this._deps.connection.query<{ blob_path: string }>(
      'SELECT blob_path FROM blob_refs WHERE owner_kind = $1 AND owner_id = $2 ORDER BY blob_path ASC',
      [ownerKind, ownerId],
    );
    return rows.map((row) => row.blob_path);
  }

  async countRefs(blobPath: string): Promise<number> {
    const rows = await this._deps.connection.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM blob_refs WHERE blob_path = $1',
      [blobPath],
    );
    const raw = rows[0]?.count;
    const count = raw !== undefined ? Number(raw) : 0;
    return Number.isFinite(count) ? count : 0;
  }
}

/** Собрать порт учёта ссылок на blob-объекты (ADR-115/ADR-116). */
export function buildBlobRefPorts(deps: PortDeps): BlobRefPorts {
  return {
    blobRefs: new PgBlobRefRepository(deps),
  };
}
