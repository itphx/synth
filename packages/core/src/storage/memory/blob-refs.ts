/**
 * In-memory реализация порта учёта ссылок на blob-объекты
 * (ADR-115/ADR-116, ADR-096 — слой хранения).
 *
 * Семантика повторяет файловую реализацию (`FileBlobRefRepository`):
 * первичный ключ — тройка `(blobPath, ownerKind, ownerId)`, поэтому `add`
 * идемпотентен; `remove` идемпотентен; `removeByOwner` возвращает число
 * снятых ссылок; `listByOwner` отдаёт пути в детерминированном порядке.
 */
import type { BlobOwnerKind, BlobRef, BlobRefRepository } from '../ports/blob-ref-repository.js';

export class MemoryBlobRefRepository implements BlobRefRepository {
  /** Ключ ссылки — тройка (blobPath + владелец). */
  private readonly _refs = new Map<string, BlobRef>();

  private _key(ref: BlobRef): string {
    return `${ref.blobPath}\0${ref.ownerKind}\0${ref.ownerId}`;
  }

  async add(ref: BlobRef): Promise<void> {
    const key = this._key(ref);
    if (this._refs.has(key)) return;
    this._refs.set(key, { ...ref });
  }

  async remove(ref: BlobRef): Promise<void> {
    this._refs.delete(this._key(ref));
  }

  async removeByOwner(ownerKind: BlobOwnerKind, ownerId: string): Promise<number> {
    let removed = 0;
    for (const [key, ref] of [...this._refs]) {
      if (ref.ownerKind === ownerKind && ref.ownerId === ownerId) {
        this._refs.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async listByOwner(ownerKind: BlobOwnerKind, ownerId: string): Promise<string[]> {
    return [...this._refs.values()]
      .filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId)
      .map((r) => r.blobPath)
      .sort((a, b) => a.localeCompare(b));
  }

  async countRefs(blobPath: string): Promise<number> {
    let count = 0;
    for (const ref of this._refs.values()) {
      if (ref.blobPath === blobPath) count += 1;
    }
    return count;
  }
}
