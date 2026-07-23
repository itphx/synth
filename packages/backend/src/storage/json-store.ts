import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, AsyncLock } from '@synth/shared';

export interface JsonStoreConfig {
  dataDir: string;
  subdir: string;
}

export class JsonStore<T> {
  private _locks = new Map<string, AsyncLock>();

  constructor(private config: JsonStoreConfig) {}

  private _getLock(key: string): AsyncLock {
    if (!this._locks.has(key)) {
      this._locks.set(key, new AsyncLock());
    }
    return this._locks.get(key)!;
  }

  private _validateKey(key: string): void {
    if (key.includes('..') || key.includes('\\')) {
      throw new Error(`Недопустимый ключ: ${key}`);
    }
  }

  private _filePath(key: string): string {
    this._validateKey(key);
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
    const lock = this._getLock(key);

    await lock.acquire();
    try {
      await mkdir(dirname(path), { recursive: true });
      const data = JSON.stringify(value, null, 2);
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        data,
      );
    } finally {
      lock.release();
    }
  }

  async delete(key: string): Promise<void> {
    this._validateKey(key);
    const lock = this._getLock(key);
    await lock.acquire();
    try {
      await unlink(this._filePath(key)).catch(() => {});
    } finally {
      lock.release();
      this._locks.delete(key);
    }
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
