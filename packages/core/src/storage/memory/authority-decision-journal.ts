/**
 * In-memory реализация порта журнала решений Authority-слоя (ADR-096, PROP-108 Ф1).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): журнал — массив в памяти.
 * Семантика повторяет файловую (`FileAuthorityDecisionJournal`): append-only,
 * `list` — «свежие первыми» (новые → старые), фильтры
 * `action`/`effect`/`source`, `limit` — последние N, `clear` — полная очистка с
 * числом удалённых записей.
 */

import type { AuthorityDecisionEntry } from '@itphx/synth-shared';
import type {
  AuthorityDecisionJournal,
  AuthorityDecisionListOptions,
} from '../ports/index.js';

/** Порт журнала решений Authority-слоя поверх массива. */
export class MemoryAuthorityDecisionJournal implements AuthorityDecisionJournal {
  private _entries: AuthorityDecisionEntry[] = [];

  async append(entry: AuthorityDecisionEntry): Promise<void> {
    this._entries.push(structuredClone(entry));
  }

  async list(opts: AuthorityDecisionListOptions = {}): Promise<AuthorityDecisionEntry[]> {
    // Порядок добавления — по времени, поэтому «свежие первыми» — разворот.
    let entries = this._entries.map((entry) => structuredClone(entry)).reverse();
    if (opts.action !== undefined) {
      entries = entries.filter((entry) => entry.action === opts.action);
    }
    if (opts.effect !== undefined) {
      entries = entries.filter((entry) => entry.effect === opts.effect);
    }
    if (opts.source !== undefined) {
      entries = entries.filter((entry) => entry.source === opts.source);
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
