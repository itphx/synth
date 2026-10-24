import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type {
  MemoryChunkRecord,
  MemoryIndexQuery,
  MemoryIndexRecord,
  MemoryIndexRepository,
  MemoryIndexState,
} from './ports/memory-index-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import { resolveCollectionLimit } from './ports/collection-limit.js';
import { resolveCreatedAt, resolveUpdatedAt } from './record-timestamps.js';

export interface FileMemoryIndexStoreConfig {
  dataDir: string;
}

/** Ключ массива индексов внутри JSON-файла. */
const INDEXES_KEY = 'indexes';
/** Ключ массива чанков внутри JSON-файла поколения. */
const CHUNKS_KEY = 'chunks';

/**
 * Файловая реализация порта индексов памяти (ADR-096 — слой хранения; ADR-005 —
 * JSON + атомарная запись tmp→rename; PROP-047 §2.1 «предпосылка A»).
 *
 * Физическое расположение:
 * - индексы — `{dataDir}/memory/indexes.json` (JSON-коллекция);
 * - чанки — `{dataDir}/memory/chunks/<безопасный-id>/g<generation>.json`
 *   (по файлу на поколение).
 *
 * **Почему чанки — отдельными файлами по поколениям.** Чанки несут векторы
 * эмбеддингов, поэтому один общий файл означал бы перезапись всего корпуса при
 * каждой замене поколения (и конфликт параллельной записи индексов между
 * собой). Файл на поколение даёт: (1) замена поколения пишет ровно один файл —
 * старое поколение **физически не трогается** (это и требует контракт
 * `replaceChunks`); (2) индексы разных проектов/провайдеров не делят файл;
 * (3) удаление индекса — удаление каталога чанков. Обратная сторона — больше
 * файлов; компромисс принят осознанно (объём одного поколения — основной
 * объём памяти, и он переписывается целиком, как и при общей коллекции).
 *
 * Имя каталога индекса — **безопасный сегмент** (id санитизируется + короткий
 * sha256-хэш): id приходит от плагина, поэтому путь не должен зависеть от
 * произвольной строки (обход каталога невозможен).
 *
 * Каталоги создаются при первой записи; отсутствие файла — пустой репозиторий
 * (не ошибка). Повреждённый JSON — понятная ошибка (`readCollectionFile`).
 */
export class FileMemoryIndexStore implements MemoryIndexRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FileMemoryIndexStoreConfig) {}

  /** Каталог памяти (`{dataDir}/memory`). */
  root(): string {
    return join(this._config.dataDir, 'memory');
  }

  /** Путь файла индексов. */
  path(): string {
    return join(this.root(), `${INDEXES_KEY}.json`);
  }

  /** Каталог чанков индекса (`{dataDir}/memory/chunks/<безопасный-id>`). */
  chunksDir(indexId: string): string {
    return join(this.root(), 'chunks', safeSegment(indexId));
  }

  /** Путь файла чанков поколения. */
  generationPath(indexId: string, generation: number): string {
    return join(this.chunksDir(indexId), `g${generation}.json`);
  }

  async saveIndex(index: MemoryIndexRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const indexes = await this._readIndexes();
      const position = indexes.findIndex((i) => i.id === index.id);
      const stored = position === -1 ? undefined : indexes[position];
      const record: MemoryIndexRecord = {
        ...index,
        // `createdAt` иммутабельно, `updatedAt` монотонно обновляется.
        createdAt: resolveCreatedAt(stored?.createdAt, index.createdAt),
        updatedAt: resolveUpdatedAt(stored?.updatedAt, index.updatedAt),
      };
      if (position === -1) {
        indexes.push(record);
      } else {
        indexes[position] = record;
      }
      await this._writeIndexes(indexes);
    } finally {
      this._lock.release();
    }
  }

  async getIndex(id: string): Promise<MemoryIndexRecord | null> {
    const indexes = await this._readIndexes();
    return indexes.find((i) => i.id === id) ?? null;
  }

  async listIndexes(query?: MemoryIndexQuery): Promise<MemoryIndexRecord[]> {
    const indexes = await this._readIndexes();
    const filtered = indexes.filter((index) => matches(index, query));
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });
    const offset = resolveOffset(query?.offset);
    return sorted.slice(offset, offset + resolveCollectionLimit(query?.limit));
  }

  async deleteIndex(id: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const indexes = await this._readIndexes();
      const next = indexes.filter((i) => i.id !== id);
      if (next.length === indexes.length) return false;
      await this._writeIndexes(next);
      // Чанки индекса удаляются каскадом (все поколения).
      await rm(this.chunksDir(id), { recursive: true, force: true });
      return true;
    } finally {
      this._lock.release();
    }
  }

  async setState(id: string, state: MemoryIndexState, error?: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const indexes = await this._readIndexes();
      const position = indexes.findIndex((i) => i.id === id);
      if (position === -1) return false;
      const stored = indexes[position] as MemoryIndexRecord;
      indexes[position] = {
        ...stored,
        state,
        ...(error !== undefined ? { error } : { error: undefined }),
        updatedAt: resolveUpdatedAt(stored.updatedAt, undefined),
      };
      await this._writeIndexes(indexes);
      return true;
    } finally {
      this._lock.release();
    }
  }

  async replaceChunks(
    indexId: string,
    generation: number,
    chunks: readonly MemoryChunkRecord[],
  ): Promise<number> {
    await this._lock.acquire();
    try {
      // Атомарная замена поколения: пишется ровно один файл поколения, другие
      // поколения индекса не трогаются. Идентичность поколения приводится к
      // аргументам метода (паритет с in-memory и PostgreSQL-реализациями).
      await writeCollectionFile(
        this.generationPath(indexId, generation),
        CHUNKS_KEY,
        chunks.map((chunk) => ({ ...chunk, indexId, generation })),
      );
      return chunks.length;
    } finally {
      this._lock.release();
    }
  }

  async listChunks(
    indexId: string,
    opts?: { generation?: number; documentId?: string; limit?: number; offset?: number },
  ): Promise<MemoryChunkRecord[]> {
    const all: MemoryChunkRecord[] = [];
    for (const generation of await this._generations(indexId)) {
      if (opts?.generation !== undefined && generation !== opts.generation) continue;
      const chunks = await this._readChunks(indexId, generation);
      for (const chunk of chunks) {
        if (opts?.documentId !== undefined && chunk.documentId !== opts.documentId) continue;
        all.push(chunk);
      }
    }
    // Порядок — по поколению, затем документ и порядковый номер чанка в нём,
    // тайбрейкер — `id`.
    const sorted = [...all].sort((a, b) => {
      if (a.generation !== b.generation) return a.generation - b.generation;
      if (a.documentId !== b.documentId) return a.documentId.localeCompare(b.documentId);
      if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
      return a.id.localeCompare(b.id);
    });
    const offset = resolveOffset(opts?.offset);
    return sorted.slice(offset, offset + resolveCollectionLimit(opts?.limit));
  }

  async deleteChunks(indexId: string, generation?: number): Promise<number> {
    await this._lock.acquire();
    try {
      if (generation !== undefined) {
        const chunks = await this._readChunks(indexId, generation);
        await rm(this.generationPath(indexId, generation), { force: true });
        return chunks.length;
      }
      let removed = 0;
      for (const gen of await this._generations(indexId)) {
        const chunks = await this._readChunks(indexId, gen);
        await rm(this.generationPath(indexId, gen), { force: true });
        removed += chunks.length;
      }
      return removed;
    } finally {
      this._lock.release();
    }
  }

  async countChunks(indexId: string, generation?: number): Promise<number> {
    if (generation !== undefined) {
      return (await this._readChunks(indexId, generation)).length;
    }
    let total = 0;
    for (const gen of await this._generations(indexId)) {
      total += (await this._readChunks(indexId, gen)).length;
    }
    return total;
  }

  private async _readIndexes(): Promise<MemoryIndexRecord[]> {
    return readCollectionFile<MemoryIndexRecord>(this.path(), INDEXES_KEY, 'файл индексов памяти');
  }

  private async _writeIndexes(indexes: MemoryIndexRecord[]): Promise<void> {
    await writeCollectionFile(this.path(), INDEXES_KEY, indexes);
  }

  private async _readChunks(indexId: string, generation: number): Promise<MemoryChunkRecord[]> {
    return readCollectionFile<MemoryChunkRecord>(
      this.generationPath(indexId, generation),
      CHUNKS_KEY,
      'файл чанков индекса памяти',
    );
  }

  /** Поколения индекса, для которых есть файл чанков (по возрастанию). */
  private async _generations(indexId: string): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(this.chunksDir(indexId));
    } catch {
      return [];
    }
    const generations: number[] = [];
    for (const entry of entries) {
      const generation = parseGenerationFile(entry);
      if (generation !== undefined) generations.push(generation);
    }
    return generations.sort((a, b) => a - b);
  }
}

/** Имя файла поколения → номер поколения (`g3.json` → 3); иначе `undefined`. */
function parseGenerationFile(name: string): number | undefined {
  if (!name.startsWith('g') || !name.endsWith('.json')) return undefined;
  const parsed = Number(name.slice(1, -'.json'.length));
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Безопасный сегмент пути для id индекса: только `[A-Za-z0-9_-]`, длина
 * ограничена, к имени добавляется короткий sha256-хэш исходного id (уникальность
 * при совпадении sanitized-форм).
 */
function safeSegment(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${sanitized}-${digest}`;
}

/** Состояния индекса как список (для фильтра-«И»). */
function stateList(state: MemoryIndexQuery['state']): readonly MemoryIndexState[] | undefined {
  if (state === undefined) return undefined;
  return Array.isArray(state) ? (state as readonly MemoryIndexState[]) : [state as MemoryIndexState];
}

/** Совпадает ли индекс с фильтрами запроса (все условия — по «И»). */
function matches(index: MemoryIndexRecord, query: MemoryIndexQuery | undefined): boolean {
  if (!query) return true;
  if (query.namespace !== undefined && index.namespace !== query.namespace) return false;
  if (query.projectId !== undefined && index.projectId !== query.projectId) return false;
  if (query.providerId !== undefined && index.providerId !== query.providerId) return false;
  const states = stateList(query.state);
  if (states !== undefined && !states.includes(index.state)) return false;
  return true;
}

/** Смещение пагинации: неотрицательное целое (по умолчанию — 0). */
function resolveOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}
