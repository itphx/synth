/**
 * In-memory реализации портов аудита security-политик и журнала внешних
 * запросов (egress). Семантика повторяет файловые реализации: append-only,
 * `list` — «свежие первыми», фильтры/лимит, `prune`/`clear` с числом удалённых.
 */

import type { EgressRequestLogEntry, SecurityAuditEntry } from '@itphx/synth-shared';
import type {
  EgressRequestLogListOptions,
  EgressRequestLogRepository,
  SecurityAuditListOptions,
  SecurityAuditRepository,
} from '../ports/index.js';

/** Порт аудита изменений egress/security-политик поверх массива. */
export class MemorySecurityAuditRepository implements SecurityAuditRepository {
  private _entries: SecurityAuditEntry[] = [];

  async append(entry: SecurityAuditEntry): Promise<void> {
    this._entries.push(structuredClone(entry));
  }

  async list(opts: SecurityAuditListOptions = {}): Promise<SecurityAuditEntry[]> {
    let entries = this._entries.map((entry) => structuredClone(entry)).reverse();
    if (opts.scope !== undefined) entries = entries.filter((entry) => entry.scope === opts.scope);
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

/** Порт журнала внешних запросов поверх массива. */
export class MemoryEgressRequestLogRepository implements EgressRequestLogRepository {
  private _entries: EgressRequestLogEntry[] = [];

  async append(entry: EgressRequestLogEntry): Promise<void> {
    this._entries.push(structuredClone(entry));
  }

  async list(opts: EgressRequestLogListOptions = {}): Promise<EgressRequestLogEntry[]> {
    let entries = this._entries.map((entry) => structuredClone(entry)).reverse();
    if (opts.scope !== undefined) entries = entries.filter((entry) => entry.scope === opts.scope);
    if (opts.status !== undefined) entries = entries.filter((entry) => entry.status === opts.status);
    const { limit } = opts;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
    return entries.slice(0, Math.floor(limit));
  }

  async prune(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = Date.now() - days * 24 * 3600_000;
    const kept = this._entries.filter((entry) => {
      const ts = Date.parse(entry.ts);
      return Number.isFinite(ts) && ts >= cutoff;
    });
    const removed = this._entries.length - kept.length;
    this._entries = kept;
    return removed;
  }

  async clear(): Promise<number> {
    const removed = this._entries.length;
    this._entries = [];
    return removed;
  }
}
