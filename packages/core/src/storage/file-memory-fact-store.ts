import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type {
  MemoryFactQuery,
  MemoryFactRecord,
  MemoryFactRepository,
  MemoryFactStatus,
} from './ports/memory-fact-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import { resolveCollectionLimit } from './ports/collection-limit.js';
import { resolveCreatedAt, resolveUpdatedAt } from './record-timestamps.js';

export interface FileMemoryFactStoreConfig {
  dataDir: string;
}

/** Ключ массива фактов внутри JSON-файла. */
const FACTS_KEY = 'facts';

/**
 * Файловая реализация порта фактов памяти (ADR-096 — слой хранения; ADR-005 —
 * JSON + атомарная запись tmp→rename; PROP-047 §2.1 «предпосылка A»).
 *
 * Физическое расположение: `{dataDir}/memory/facts.json`.
 *
 * Каталог создаётся при первой записи; отсутствие файла — пустой репозиторий
 * (не ошибка). Повреждённый JSON — понятная ошибка, а не тихий пустой список
 * (`readCollectionFile`).
 *
 * Семантика повторяет in-memory реализацию (`MemoryFactRepository`): upsert по
 * `id` (`createdAt` сохраняется, `updatedAt` монотонно обновляется), список
 * «свежие первыми» с фильтрами по «И», `supersede` — идемпотентно.
 */
export class FileMemoryFactStore implements MemoryFactRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FileMemoryFactStoreConfig) {}

  /** Каталог памяти (`{dataDir}/memory`). */
  root(): string {
    return join(this._config.dataDir, 'memory');
  }

  /** Путь файла фактов. */
  path(): string {
    return join(this.root(), `${FACTS_KEY}.json`);
  }

  async save(fact: MemoryFactRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const facts = await this._read();
      const index = facts.findIndex((f) => f.id === fact.id);
      const stored = index === -1 ? undefined : facts[index];
      const record: MemoryFactRecord = {
        ...fact,
        // `createdAt` иммутабельно, `updatedAt` монотонно обновляется.
        createdAt: resolveCreatedAt(stored?.createdAt, fact.createdAt),
        updatedAt: resolveUpdatedAt(stored?.updatedAt, fact.updatedAt),
      };
      if (index === -1) {
        facts.push(record);
      } else {
        facts[index] = record;
      }
      await this._write(facts);
    } finally {
      this._lock.release();
    }
  }

  async get(id: string): Promise<MemoryFactRecord | null> {
    const facts = await this._read();
    return facts.find((f) => f.id === id) ?? null;
  }

  async list(query?: MemoryFactQuery): Promise<MemoryFactRecord[]> {
    const facts = await this._read();
    const filtered = facts.filter((fact) => matches(fact, query));
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });
    const offset = resolveOffset(query?.offset);
    return sorted.slice(offset, offset + resolveCollectionLimit(query?.limit));
  }

  async delete(id: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const facts = await this._read();
      const next = facts.filter((f) => f.id !== id);
      if (next.length === facts.length) return false;
      await this._write(next);
      return true;
    } finally {
      this._lock.release();
    }
  }

  async supersede(id: string, nextId: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const facts = await this._read();
      const index = facts.findIndex((f) => f.id === id);
      if (index === -1) return false;
      const stored = facts[index] as MemoryFactRecord;
      // Идемпотентно: повторный вызов с тем же `nextId` не меняет запись.
      if (stored.status === 'superseded' && stored.supersededBy === nextId) return true;
      facts[index] = {
        ...stored,
        status: 'superseded',
        supersededBy: nextId,
        updatedAt: resolveUpdatedAt(stored.updatedAt, undefined),
      };
      await this._write(facts);
      return true;
    } finally {
      this._lock.release();
    }
  }

  async count(query?: MemoryFactQuery): Promise<number> {
    const facts = await this._read();
    return facts.filter((fact) => matches(fact, query)).length;
  }

  private async _read(): Promise<MemoryFactRecord[]> {
    return readCollectionFile<MemoryFactRecord>(this.path(), FACTS_KEY, 'файл фактов памяти');
  }

  private async _write(facts: MemoryFactRecord[]): Promise<void> {
    await writeCollectionFile(this.path(), FACTS_KEY, facts);
  }
}

/** Статусы факта как список (для фильтра-«И»). */
function statusList(status: MemoryFactQuery['status']): readonly MemoryFactStatus[] | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? (status as readonly MemoryFactStatus[]) : [status as MemoryFactStatus];
}

/** Совпадает ли факт с фильтрами запроса (все условия — по «И»). */
function matches(fact: MemoryFactRecord, query: MemoryFactQuery | undefined): boolean {
  if (!query) return true;
  if (query.namespace !== undefined && fact.namespace !== query.namespace) return false;
  if (query.projectId !== undefined && fact.projectId !== query.projectId) return false;
  if (query.userId !== undefined && fact.userId !== query.userId) return false;
  if (query.kind !== undefined && fact.kind !== query.kind) return false;
  const statuses = statusList(query.status);
  if (statuses !== undefined && !statuses.includes(fact.status)) return false;
  return true;
}

/** Смещение пагинации: неотрицательное целое (по умолчанию — 0). */
function resolveOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}
