/**
 * In-memory реализация порта **ожиданий подтверждения прав** (ADR-096, второй
 * backend за единым слоем хранения; ADR-029 — ожидания переживают рестарт
 * инстанса).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в `Map`
 * процесса. Семантика повторяет файловую реализацию
 * (`FilePendingApprovalStore`): upsert по `approvalId`, список с фильтром по
 * сессии, `delete` идемпотентно, `clear` возвращает число снятых записей.
 *
 * Возвращаемые записи — копии (`structuredClone`), как в остальных
 * memory-портах: мутация результата не влияет на стор.
 */

import type {
  PendingApprovalRepository,
  PendingApprovalRecord,
} from '../ports/pending-approval-repository.js';

/**
 * Порт ожиданий подтверждения прав поверх `Map` (реализация —
 * `FilePendingApprovalStore`).
 */
export class MemoryPendingApprovalRepository implements PendingApprovalRepository {
  private readonly _records = new Map<string, PendingApprovalRecord>();

  async save(record: PendingApprovalRecord): Promise<void> {
    this._records.set(record.approvalId, structuredClone(record));
  }

  async delete(approvalId: string): Promise<void> {
    // Отсутствующая запись — не ошибка (идемпотентно).
    this._records.delete(approvalId);
  }

  async list(sessionId?: string): Promise<PendingApprovalRecord[]> {
    const records = [...this._records.values()];
    const filtered = sessionId === undefined
      ? records
      : records.filter((r) => r.sessionId === sessionId);
    return filtered.map((r) => structuredClone(r));
  }

  async clear(sessionId?: string): Promise<number> {
    if (sessionId === undefined) {
      const removed = this._records.size;
      this._records.clear();
      return removed;
    }
    let removed = 0;
    for (const [id, record] of [...this._records.entries()]) {
      if (record.sessionId !== sessionId) continue;
      this._records.delete(id);
      removed += 1;
    }
    return removed;
  }
}
