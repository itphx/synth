/**
 * In-memory реализация порта аудит-журнала обслуживания инстанса (ADR-096, W2.2).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): журнал — массив в памяти.
 * Семантика повторяет файловую (`MaintenanceAuditStore`, ADR-092): append-only,
 * `list` — «свежие первыми» (новые → старые), фильтр `op`, `limit` — последние N,
 * `clear` — полная очистка с числом удалённых записей.
 */

import type { MaintenanceAuditEntry } from '@itphx/synth-shared';
import type {
  MaintenanceAuditListOptions,
  MaintenanceAuditRepository,
} from '../ports/index.js';

/** Порт аудит-журнала обслуживания поверх массива (семантика `MaintenanceAuditStore`). */
export class MemoryMaintenanceAuditRepository implements MaintenanceAuditRepository {
  private _entries: MaintenanceAuditEntry[] = [];

  async append(entry: MaintenanceAuditEntry): Promise<void> {
    this._entries.push(structuredClone(entry));
  }

  async list(opts: MaintenanceAuditListOptions = {}): Promise<MaintenanceAuditEntry[]> {
    // Порядок добавления — по времени, поэтому «свежие первыми» — разворот.
    let entries = this._entries.map((entry) => structuredClone(entry)).reverse();
    if (opts.op !== undefined) {
      entries = entries.filter((entry) => entry.op === opts.op);
    }
    const { limit } = opts;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
    return entries.slice(0, Math.floor(limit));
  }

  async clear(): Promise<number> {
    const removed = this._entries.length;
    this._entries = [];
    return removed;
  }
}
