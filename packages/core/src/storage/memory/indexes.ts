/**
 * In-memory реализация порта **индексов памяти** (ADR-096, второй backend за
 * единым слоем хранения; PROP-047 §2.1 «предпосылка A»).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в `Map`/массиве
 * процесса. Семантика повторяет файловую реализацию
 * (`FileMemoryIndexStore`): upsert по `id` (`createdAt` сохраняется,
 * `updatedAt` монотонно обновляется), детерминированный порядок списков,
 * `replaceChunks` — атомарная замена поколения (остальные поколения не
 * трогаются), `deleteIndex` — каскад по чанкам.
 *
 * Возвращаемые записи — копии (`structuredClone`), как в остальных
 * memory-портах: мутация результата не влияет на стор.
 */

import type {
  MemoryChunkRecord,
  MemoryIndexQuery,
  MemoryIndexRecord,
  // Порт импортируется под другим именем: класс реализации совпадает с именем
  // порта (`MemoryIndexRepository`) — иначе импорт конфликтует с локальным
  // объявлением (в публичном API core класс экспортируется как
  // `MemoryIndexRepositoryImpl`).
  MemoryIndexRepository as MemoryIndexRepositoryPort,
  MemoryIndexScope,
  MemoryIndexState,
} from '../ports/memory-index-repository.js';
import { resolveCollectionLimit } from '../ports/collection-limit.js';
import { resolveCreatedAt, resolveUpdatedAt } from '../record-timestamps.js';

/** Состояния индекса как список (для фильтра-«И»). */
function stateList(state: MemoryIndexQuery['state']): readonly MemoryIndexState[] | undefined {
  if (state === undefined) return undefined;
  return Array.isArray(state) ? (state as readonly MemoryIndexState[]) : [state as MemoryIndexState];
}

/**
 * Область видимости индекса при чтении: `instance` — как есть, всё прочее
 * (включая отсутствующее поле легаси-записи) — `project`.
 */
function normalizeScope(scope: unknown): MemoryIndexScope {
  return scope === 'instance' ? 'instance' : 'project';
}

/** Совпадает ли индекс с фильтрами запроса (все условия — по «И»). */
function matches(index: MemoryIndexRecord, query: MemoryIndexQuery | undefined): boolean {
  if (!query) return true;
  if (query.namespace !== undefined && index.namespace !== query.namespace) return false;
  if (query.projectId !== undefined && index.projectId !== query.projectId) return false;
  if (query.scope !== undefined && index.scope !== query.scope) return false;
  if (query.providerId !== undefined && index.providerId !== query.providerId) return false;
  const states = stateList(query.state);
  if (states !== undefined && !states.includes(index.state)) return false;
  return true;
}

/**
 * Порт индексов памяти и их чанков поверх `Map`/массива (ADR-096; реализация —
 * `FileMemoryIndexStore`).
 */
export class MemoryIndexRepository implements MemoryIndexRepositoryPort {
  private readonly _indexes = new Map<string, MemoryIndexRecord>();
  /** Чанки — по индексу и поколению: `indexId → generation → чанки`. */
  private readonly _chunks = new Map<string, Map<number, MemoryChunkRecord[]>>();

  async saveIndex(index: MemoryIndexRecord): Promise<void> {
    const stored = this._indexes.get(index.id);
    // Область видимости при сохранении **не выдумывается**: пишется как есть
    // (нормализация — на чтении).
    this._indexes.set(index.id, {
      ...structuredClone(index),
      // `createdAt` иммутабельно, `updatedAt` монотонно обновляется.
      createdAt: resolveCreatedAt(stored?.createdAt, index.createdAt),
      updatedAt: resolveUpdatedAt(stored?.updatedAt, index.updatedAt),
    });
  }

  async getIndex(id: string): Promise<MemoryIndexRecord | null> {
    const index = this._indexes.get(id);
    if (!index) return null;
    return { ...structuredClone(index), scope: normalizeScope(index.scope) };
  }

  async listIndexes(query?: MemoryIndexQuery): Promise<MemoryIndexRecord[]> {
    const filtered = [...this._indexes.values()]
      .map((index) => ({ ...index, scope: normalizeScope(index.scope) }))
      .filter((index) => matches(index, query));
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });
    const offset =
      query?.offset !== undefined && Number.isFinite(query.offset)
        ? Math.max(0, Math.floor(query.offset))
        : 0;
    return sorted
      .slice(offset, offset + resolveCollectionLimit(query?.limit))
      .map((index) => structuredClone(index));
  }

  async deleteIndex(id: string): Promise<boolean> {
    const deleted = this._indexes.delete(id);
    if (!deleted) return false;
    // Чанки индекса удаляются каскадом (все поколения).
    this._chunks.delete(id);
    return true;
  }

  async setState(id: string, state: MemoryIndexState, error?: string): Promise<boolean> {
    const index = this._indexes.get(id);
    if (!index) return false;
    this._indexes.set(id, {
      ...index,
      state,
      ...(error !== undefined ? { error } : { error: undefined }),
      updatedAt: resolveUpdatedAt(index.updatedAt, undefined),
    });
    return true;
  }

  async replaceChunks(
    indexId: string,
    generation: number,
    chunks: readonly MemoryChunkRecord[],
  ): Promise<number> {
    // Атомарная замена поколения: поколение `generation` заменяется целиком,
    // остальные поколения не трогаются. Идентичность поколения приводится к
    // аргументам метода (паритет с файловой и PostgreSQL-реализациями).
    let generations = this._chunks.get(indexId);
    if (!generations) {
      generations = new Map<number, MemoryChunkRecord[]>();
      this._chunks.set(indexId, generations);
    }
    generations.set(
      generation,
      chunks.map((chunk) => ({ ...structuredClone(chunk), indexId, generation })),
    );
    return chunks.length;
  }

  async listChunks(
    indexId: string,
    opts?: { generation?: number; documentId?: string; limit?: number; offset?: number },
  ): Promise<MemoryChunkRecord[]> {
    const generations = this._chunks.get(indexId);
    const all: MemoryChunkRecord[] = [];
    if (generations) {
      for (const [generation, chunks] of generations.entries()) {
        if (opts?.generation !== undefined && generation !== opts.generation) continue;
        for (const chunk of chunks) {
          if (opts?.documentId !== undefined && chunk.documentId !== opts.documentId) continue;
          all.push(chunk);
        }
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
    const offset =
      opts?.offset !== undefined && Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
    return sorted
      .slice(offset, offset + resolveCollectionLimit(opts?.limit))
      .map((chunk) => structuredClone(chunk));
  }

  async deleteChunks(indexId: string, generation?: number): Promise<number> {
    const generations = this._chunks.get(indexId);
    if (!generations) return 0;
    let removed = 0;
    if (generation !== undefined) {
      const chunks = generations.get(generation);
      if (!chunks) return 0;
      removed = chunks.length;
      generations.delete(generation);
    } else {
      for (const chunks of generations.values()) removed += chunks.length;
      generations.clear();
    }
    return removed;
  }

  async countChunks(indexId: string, generation?: number): Promise<number> {
    const generations = this._chunks.get(indexId);
    if (!generations) return 0;
    if (generation !== undefined) return generations.get(generation)?.length ?? 0;
    let total = 0;
    for (const chunks of generations.values()) total += chunks.length;
    return total;
  }
}
