/**
 * In-memory реализация порта журнала операций со слоем доступов
 * (ADR-096, ADR-105 Ф4).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): журнал — массив в памяти.
 * Семантика повторяет файловую (`FileCredentialAuditStore`): append-only,
 * `list` — «свежие первыми» (новые → старые), фильтры `credentialId`/
 * `provider`/`op`/`outcome`, `limit` — последние N, `clear` — полная очистка
 * с числом удалённых записей.
 */

import type { ExternalCredentialAuditEntry } from '@itphx/synth-shared';
import type {
  CredentialAuditListOptions,
  CredentialAuditRepository,
} from '../ports/index.js';

/** Порт журнала операций со слоем доступов поверх массива. */
export class MemoryCredentialAuditRepository implements CredentialAuditRepository {
  private _entries: ExternalCredentialAuditEntry[] = [];

  async append(entry: ExternalCredentialAuditEntry): Promise<void> {
    this._entries.push(structuredClone(entry));
  }

  async list(opts: CredentialAuditListOptions = {}): Promise<ExternalCredentialAuditEntry[]> {
    // Порядок добавления — по времени, поэтому «свежие первыми» — разворот.
    let entries = this._entries.map((entry) => structuredClone(entry)).reverse();
    if (opts.credentialId !== undefined) {
      entries = entries.filter((entry) => entry.credentialId === opts.credentialId);
    }
    if (opts.provider !== undefined) {
      entries = entries.filter((entry) => entry.provider === opts.provider);
    }
    if (opts.op !== undefined) {
      entries = entries.filter((entry) => entry.op === opts.op);
    }
    if (opts.outcome !== undefined) {
      entries = entries.filter((entry) => entry.outcome === opts.outcome);
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
