import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite } from '@synth/shared';

export interface JsonStoreConfig {
  dataDir: string;
  subdir: string;
}

export class JsonStore<T> {
  constructor(private config: JsonStoreConfig) {}

  private _filePath(key: string): string {
    return join(this.config.dataDir, this.config.subdir, `${key}.json`);
  }

  private _dir(): string {
    return join(this.config.dataDir, this.config.subdir);
  }

  async load(key: string): Promise<T | null> {
    try {
      const data = await readFile(this._filePath(key), 'utf-8');
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  async save(key: string, value: T): Promise<void> {
    const path = this._filePath(key);
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(value, null, 2);
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }

  async delete(key: string): Promise<void> {
    await unlink(this._filePath(key)).catch(() => {});
  }

  async list(): Promise<T[]> {
    const items: T[] = [];
    await this._collectItems(this._dir(), items);
    return items;
  }

  private async _collectItems(dir: string, items: T[]): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry.endsWith('.json')) {
        const key = full
          .slice(this._dir().length + 1)
          .replace(/\.json$/, '');
        const item = await this.load(key);
        if (item) items.push(item);
      } else {
        await this._collectItems(full, items);
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this._filePath(key), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }
}
