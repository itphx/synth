/**
 * In-memory реализация порта **фактов памяти** (ADR-096, второй backend за
 * единым слоем хранения; PROP-047 §2.1 «предпосылка A»).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в `Map`
 * процесса. Семантика повторяет файловую реализацию
 * (`FileMemoryFactStore`): upsert по `id` (`createdAt` сохраняется,
 * `updatedAt` монотонно обновляется), детерминированный порядок списка
 * («свежие первыми»), фильтры по «И», `supersede` — идемпотентно.
 *
 * Возвращаемые записи — копии (`structuredClone`), как в остальных
 * memory-портах: мутация результата не влияет на стор.
 */

import type {
  MemoryFactQuery,
  MemoryFactRecord,
  // Порт импортируется под другим именем: класс реализации совпадает с именем
  // порта (`MemoryFactRepository`) — иначе импорт конфликтует с локальным
  // объявлением (в публичном API core класс экспортируется как
  // `MemoryFactRepositoryImpl`).
  MemoryFactRepository as MemoryFactRepositoryPort,
  MemoryFactStatus,
} from '../ports/memory-fact-repository.js';
import { resolveCollectionLimit } from '../ports/collection-limit.js';
import { resolveCreatedAt, resolveUpdatedAt } from '../record-timestamps.js';

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

/**
 * Порт фактов памяти поверх `Map` (ADR-096; реализация —
 * `FileMemoryFactStore`).
 */
export class MemoryFactRepository implements MemoryFactRepositoryPort {
  private readonly _facts = new Map<string, MemoryFactRecord>();

  async save(fact: MemoryFactRecord): Promise<void> {
    const stored = this._facts.get(fact.id);
    this._facts.set(fact.id, {
      ...structuredClone(fact),
      // `createdAt` иммутабельно, `updatedAt` монотонно обновляется.
      createdAt: resolveCreatedAt(stored?.createdAt, fact.createdAt),
      updatedAt: resolveUpdatedAt(stored?.updatedAt, fact.updatedAt),
    });
  }

  async get(id: string): Promise<MemoryFactRecord | null> {
    const fact = this._facts.get(id);
    return fact ? structuredClone(fact) : null;
  }

  async list(query?: MemoryFactQuery): Promise<MemoryFactRecord[]> {
    const filtered = [...this._facts.values()].filter((fact) => matches(fact, query));
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });
    const offset = query?.offset !== undefined && Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset)) : 0;
    return sorted
      .slice(offset, offset + resolveCollectionLimit(query?.limit))
      .map((fact) => structuredClone(fact));
  }

  async delete(id: string): Promise<boolean> {
    return this._facts.delete(id);
  }

  async supersede(id: string, nextId: string): Promise<boolean> {
    const fact = this._facts.get(id);
    if (!fact) return false;
    // Идемпотентно: повторный вызов с тем же `nextId` не меняет запись.
    if (fact.status === 'superseded' && fact.supersededBy === nextId) return true;
    this._facts.set(id, {
      ...fact,
      status: 'superseded',
      supersededBy: nextId,
      updatedAt: resolveUpdatedAt(fact.updatedAt, undefined),
    });
    return true;
  }

  async count(query?: MemoryFactQuery): Promise<number> {
    let total = 0;
    for (const fact of this._facts.values()) {
      if (matches(fact, query)) total += 1;
    }
    return total;
  }
}
