import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, AsyncLock } from '@itphx/synth-shared';

export interface JsonStoreConfig {
  dataDir: string;
  subdir: string;
}

/**
 * Структурный контракт JSON-хранилища. Нужен, чтобы core-фабрики роутов можно
 * было переиспользовать в backend с его собственным `JsonStore` (у классов есть
 * приватные поля, поэтому напрямую типы не совместимы, а публичный API — общий).
 */
export interface JsonStoreLike<T> {
  load(key: string): Promise<T | null>;
  save(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(): Promise<T[]>;
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
    const path = this._filePath(key);
    const lock = this._getLock(key);

    await lock.acquire();
    try {
      await unlink(path).catch(() => {});
    } finally {
      lock.release();
    }
  }

  async exists(key: string): Promise<boolean> {
    const val = await this.load(key);
    return val !== null;
  }

  async list(): Promise<T[]> {
    const dir = this._dir();
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const results: T[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const item = await this.load(file.replace('.json', ''));
      if (item) results.push(item);
    }
    return results;
  }
}
