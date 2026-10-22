/**
 * In-memory реализация порта журнала аудита плагинов (ADR-096, PROP-090 §9).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): журнал — массив в памяти.
 * Семантика повторяет файловую (`FilePluginAuditStore`): append-only,
 * `list` — «свежие первыми» (новые → старые), фильтры `plugin`/`action`/
 * `outcome`, `limit` — последние N, `clear` — полная очистка с числом
 * удалённых записей.
 */

import type { PluginAuditEntry } from '@itphx/synth-shared';
import type {
  PluginAuditListOptions,
  PluginAuditRepository,
} from '../ports/index.js';

/** Порт журнала аудита плагинов поверх массива. */
export class MemoryPluginAuditRepository implements PluginAuditRepository {
  private _entries: PluginAuditEntry[] = [];

  async append(entry: PluginAuditEntry): Promise<void> {
    this._entries.push(structuredClone(entry));
  }

  async list(opts: PluginAuditListOptions = {}): Promise<PluginAuditEntry[]> {
    // Порядок добавления — по времени, поэтому «свежие первыми» — разворот.
    let entries = this._entries.map((entry) => structuredClone(entry)).reverse();
    if (opts.plugin !== undefined) {
      entries = entries.filter((entry) => entry.plugin === opts.plugin);
    }
    if (opts.action !== undefined) {
      entries = entries.filter((entry) => entry.action === opts.action);
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
