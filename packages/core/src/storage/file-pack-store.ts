import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type { PackInstallation, PackRepository } from './ports/pack-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import { resolveCreatedAt, resolveUpdatedAt } from './record-timestamps.js';

export interface FilePackStoreConfig {
  dataDir: string;
}

/** Ключ массива установок внутри JSON-файла. */
const PACKS_KEY = 'packs';

/**
 * ADR-086 §5 / PROP-068: файловая реализация порта реестра установок пакетов
 * расширений (ADR-096 — слой хранения; ADR-005 — JSON + атомарная запись
 * tmp→rename).
 *
 * Физическое расположение: `{dataDir}/packs.json`.
 *
 * Ключ записи — имя пакета (уникально в инстансе): `save` — upsert по имени
 * (`installedAt` сохраняется при перезаписи, `updatedAt` обновляется),
 * `delete` — снятие установки.
 */
export class FilePackStore implements PackRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FilePackStoreConfig) {}

  /** Путь файла реестра установок. */
  path(): string {
    return join(this._config.dataDir, 'packs.json');
  }

  async save(pack: PackInstallation): Promise<void> {
    await this._lock.acquire();
    try {
      const packs = await this._read();
      const index = packs.findIndex((p) => p.name === pack.name);
      const stored = index === -1 ? undefined : packs[index];
      const record: PackInstallation = {
        ...pack,
        // `installedAt` иммутабельно, `updatedAt` монотонно обновляется.
        installedAt: resolveCreatedAt(stored?.installedAt, pack.installedAt),
        updatedAt: resolveUpdatedAt(stored?.updatedAt, pack.updatedAt),
      };
      if (index === -1) {
        packs.push(record);
      } else {
        packs[index] = record;
      }
      await this._write(packs);
    } finally {
      this._lock.release();
    }
  }

  async get(name: string): Promise<PackInstallation | null> {
    const packs = await this._read();
    return packs.find((p) => p.name === name) ?? null;
  }

  async list(): Promise<PackInstallation[]> {
    const packs = await this._read();
    // Детерминированный порядок — по имени.
    return [...packs].sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(name: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const packs = await this._read();
      const next = packs.filter((p) => p.name !== name);
      if (next.length === packs.length) return false;
      await this._write(next);
      return true;
    } finally {
      this._lock.release();
    }
  }

  private async _read(): Promise<PackInstallation[]> {
    return readCollectionFile<PackInstallation>(this.path(), PACKS_KEY, 'файл реестра пакетов');
  }

  private async _write(packs: PackInstallation[]): Promise<void> {
    await writeCollectionFile(this.path(), PACKS_KEY, packs);
  }
}
