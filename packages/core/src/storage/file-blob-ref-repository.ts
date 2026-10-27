import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type { BlobOwnerKind, BlobRef, BlobRefRepository } from './ports/blob-ref-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';

export interface FileBlobRefRepositoryConfig {
  dataDir: string;
}

/** Ключ массива записей внутри JSON-файла. */
const BLOB_REFS_KEY = 'refs';

/**
 * Файловая реализация порта учёта ссылок на blob-объекты
 * (ADR-096 — слой хранения; ADR-005 — JSON + атомарная запись tmp→rename;
 * ADR-115/ADR-116 — учёт ссылок для дедупа и GC).
 *
 * Физическое расположение: `{dataDir}/blob-refs.json`.
 *
 * Каталог создаётся при первой записи; отсутствие файла — пустой репозиторий
 * (не ошибка). Повреждённый JSON — понятная ошибка, а не тихая пустая коллекция
 * (`readCollectionFile`): молчаливая пустая коллекция выглядела бы как «все
 * ссылки потеряны» (а значит — как «все объекты осиротели»).
 *
 * Конкурентные записи сериализуются `AsyncLock` — тот же приём, что у соседних
 * коллекций (например, `FileWorktreeStore`).
 */
export class FileBlobRefRepository implements BlobRefRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FileBlobRefRepositoryConfig) {}

  /** Путь файла записей (`{dataDir}/blob-refs.json`). */
  path(): string {
    return join(this._config.dataDir, 'blob-refs.json');
  }

  async add(ref: BlobRef): Promise<void> {
    await this._lock.acquire();
    try {
      const refs = await this._read();
      // Первичный ключ — вся тройка: повторная запись не создаёт дубля.
      if (refs.some((r) => isSameRef(r, ref))) return;
      refs.push({ ...ref });
      await this._write(refs);
    } finally {
      this._lock.release();
    }
  }

  async remove(ref: BlobRef): Promise<void> {
    await this._lock.acquire();
    try {
      const refs = await this._read();
      const kept = refs.filter((r) => !isSameRef(r, ref));
      // Ссылка не найдена — идемпотентно, файл не трогаем.
      if (kept.length === refs.length) return;
      await this._write(kept);
    } finally {
      this._lock.release();
    }
  }

  async removeByOwner(ownerKind: BlobOwnerKind, ownerId: string): Promise<number> {
    await this._lock.acquire();
    try {
      const refs = await this._read();
      if (refs.length === 0) return 0;
      const kept = refs.filter((r) => !(r.ownerKind === ownerKind && r.ownerId === ownerId));
      const removed = refs.length - kept.length;
      if (removed === 0) return 0;
      await this._write(kept);
      return removed;
    } finally {
      this._lock.release();
    }
  }

  async listByOwner(ownerKind: BlobOwnerKind, ownerId: string): Promise<string[]> {
    const refs = await this._read();
    return refs
      .filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId)
      .map((r) => r.blobPath)
      .sort((a, b) => a.localeCompare(b));
  }

  async countRefs(blobPath: string): Promise<number> {
    const refs = await this._read();
    return refs.filter((r) => r.blobPath === blobPath).length;
  }

  private async _read(): Promise<BlobRef[]> {
    return readCollectionFile<BlobRef>(this.path(), BLOB_REFS_KEY, 'файл ссылок на блобы');
  }

  private async _write(refs: BlobRef[]): Promise<void> {
    await writeCollectionFile(this.path(), BLOB_REFS_KEY, refs);
  }
}

/** Совпадают ли две ссылки (первичный ключ — вся тройка). */
function isSameRef(a: BlobRef, b: BlobRef): boolean {
  return a.blobPath === b.blobPath && a.ownerKind === b.ownerKind && a.ownerId === b.ownerId;
}
