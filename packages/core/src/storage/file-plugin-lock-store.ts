import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type { PluginLockEntry } from '@itphx/synth-shared';
import type { PluginLockRepository } from './ports/plugin-lock-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';

export interface FilePluginLockStoreConfig {
  /**
   * Путь к lock-файлу (`plugins.lock.json`).
   *
   * Задаётся явно (раскладка `<home>/plugin/` или `{dataDir}/plugin/`) — в
   * отличие от большинства файловых портов, путь lock'а зависит от
   * home-модели (ADR-079), а не только от `dataDir`.
   */
  path: string;
}

/** Ключ массива записей внутри JSON-файла. */
const PLUGINS_KEY = 'plugins';

/**
 * PROP-068 §4.4 / ADR-090: файловая реализация порта lock-файла плагинов
 * (ADR-096 — слой хранения; ADR-005 — JSON + атомарная запись tmp→rename).
 *
 * Ключ записи — имя плагина: `save` — upsert по имени (`installed_at`
 * сохраняется при перезаписи, `updated_at` обновляется), `delete` — снятие
 * записи.
 */
export class FilePluginLockStore implements PluginLockRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FilePluginLockStoreConfig) {}

  /** Путь lock-файла. */
  path(): string {
    return this._config.path;
  }

  async save(entry: PluginLockEntry): Promise<void> {
    await this._lock.acquire();
    try {
      const entries = await this._read();
      const index = entries.findIndex((item) => item.name === entry.name);
      const stored = index === -1 ? undefined : entries[index];
      const record: PluginLockEntry = {
        ...entry,
        // `installed_at` иммутабельно, `updated_at` монотонно обновляется.
        installed_at: stored?.installed_at ?? entry.installed_at,
        updated_at: entry.updated_at,
      };
      if (index === -1) {
        entries.push(record);
      } else {
        entries[index] = record;
      }
      await this._write(entries);
    } finally {
      this._lock.release();
    }
  }

  async get(name: string): Promise<PluginLockEntry | null> {
    const entries = await this._read();
    return entries.find((item) => item.name === name) ?? null;
  }

  async list(): Promise<PluginLockEntry[]> {
    const entries = await this._read();
    // Детерминированный порядок — по имени.
    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(name: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const entries = await this._read();
      const next = entries.filter((item) => item.name !== name);
      if (next.length === entries.length) return false;
      await this._write(next);
      return true;
    } finally {
      this._lock.release();
    }
  }

  private async _read(): Promise<PluginLockEntry[]> {
    return readCollectionFile<PluginLockEntry>(
      this._config.path,
      PLUGINS_KEY,
      'файл lock-плагинов',
    );
  }

  private async _write(entries: PluginLockEntry[]): Promise<void> {
    await writeCollectionFile(this._config.path, PLUGINS_KEY, entries);
  }
}

/**
 * Путь lock-файла по умолчанию (без home-модели): `{dataDir}/plugin/plugins.lock.json`.
 */
export function defaultPluginLockPath(dataDir: string): string {
  return join(dataDir, 'plugin', 'plugins.lock.json');
}
