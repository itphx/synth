import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, AsyncLock } from '@itphx/synth-shared';
import type { DocumentRepository } from './ports/document-repository.js';

export interface JsonStoreConfig {
  dataDir: string;
  subdir: string;
}

/**
 * Структурный контракт JSON-хранилища (алиас порта `DocumentRepository`).
 * Нужен, чтобы core-фабрики роутов можно было переиспользовать в backend с его
 * собственным `JsonStore` (у классов есть приватные поля, поэтому напрямую типы
 * не совместимы, а публичный API — общий). ADR-096 (W2.4): сам порт —
 * `DocumentRepository<T>`, `JsonStore` его реализует.
 */
export type JsonStoreLike<T> = DocumentRepository<T>;

export class JsonStore<T> implements DocumentRepository<T> {
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

  /**
   * Удаляет запись и освобождает её из карты блокировок: иначе `_locks` рос бы
   * на каждом удалённом ключе, а повторный `save` после `delete` создал бы новый
   * lock. Ключ валидируется в `_filePath` (path traversal / `\` → ошибка);
   * отсутствие файла ошибкой не считается.
   */
  async delete(key: string): Promise<void> {
    const path = this._filePath(key);
    const lock = this._getLock(key);

    await lock.acquire();
    try {
      await unlink(path).catch(() => {});
    } finally {
      lock.release();
      this._locks.delete(key);
    }
  }

  /**
   * Запись существует, только если её можно прочитать как валидный JSON
   * (`load() !== null`). Битый/недописанный файл (оборвавшаяся атомарная
   * запись) существующим не считается — вызывающий код сможет его перезаписать.
   */
  async exists(key: string): Promise<boolean> {
    const val = await this.load(key);
    return val !== null;
  }

  /**
   * Собирает все записи, включая вложенные ключи в подкаталогах: ключ модели
   * имеет вид `provider/model` → файл `models/<provider>/<model>.json`.
   * Ключ вычисляется относительно корня subdir, чтобы последующий `load()`
   * нашёл запись. Не-`.json` файлы (в т.ч. временные `.tmp.*` атомарной записи)
   * игнорируются.
   */
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
}
