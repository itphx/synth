/**
 * In-memory реализация порта lock-файла плагинов (ADR-096, PROP-068 §4.4).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): lock — карта в памяти.
 * Семантика повторяет файловую (`FilePluginLockStore`): upsert по имени
 * плагина, `installed_at` иммутабельно, `updated_at` обновляется, `list` —
 * детерминированный порядок по имени, `delete` — снятие записи.
 */

import type { PluginLockEntry } from '@itphx/synth-shared';
import type { PluginLockRepository } from '../ports/index.js';

/** Порт lock-файла плагинов поверх памяти. */
export class MemoryPluginLockRepository implements PluginLockRepository {
  private _entries = new Map<string, PluginLockEntry>();

  async save(entry: PluginLockEntry): Promise<void> {
    const stored = this._entries.get(entry.name);
    this._entries.set(entry.name, {
      ...structuredClone(entry),
      installed_at: stored?.installed_at ?? entry.installed_at,
    });
  }

  async get(name: string): Promise<PluginLockEntry | null> {
    const entry = this._entries.get(name);
    return entry ? structuredClone(entry) : null;
  }

  async list(): Promise<PluginLockEntry[]> {
    return [...this._entries.values()]
      .map((entry) => structuredClone(entry))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(name: string): Promise<boolean> {
    return this._entries.delete(name);
  }
}
