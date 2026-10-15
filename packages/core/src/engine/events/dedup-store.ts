import { mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * ADR-051/ADR-089: источник дедупа событий по стабильному `dedupKey`.
 *
 * `EventRouter` не решает сам, что считать дубликатом, а спрашивает у store.
 * Атомарность `tryClaim` — контракт реализации: два конкурентных вызова с одним
 * ключом должны вернуть `true` ровно один раз, даже между процессами.
 */
export interface DedupStore {
  /** Атомарный claim ключа: true — ключ наш (впервые), false — уже занят. */
  tryClaim(key: string): Promise<boolean>;
  /** Предзаполнить кэш ключами (например, из журнала при старте). */
  seed(keys: Iterable<string>): void;
}

/**
 * In-process реализация дедупа (текущее поведение ADR-089): `Set` ключей.
 * Дефолт: single-process, межпроцессной атомарности нет.
 */
export class MemoryDedupStore implements DedupStore {
  private _seen = new Set<string>();

  seed(keys: Iterable<string>): void {
    for (const key of keys) this._seen.add(key);
  }

  async tryClaim(key: string): Promise<boolean> {
    if (this._seen.has(key)) return false;
    this._seen.add(key);
    return true;
  }
}

export interface FileDedupStoreConfig {
  dataDir: string;
}

/**
 * Межпроцессная реализация дедупа на общем `dataDir`: claim — атомарное создание
 * файла-маркера `{dataDir}/events/dedup/<sha256(key)>` (`open(path, 'wx')`).
 *
 * Fail-open: при ошибке, отличной от «файл уже есть» (`EEXIST`), пишем `warn` и
 * считаем ключ нашим (`true`) — лучше не потерять событие, чем отбросить его.
 * `seed` — no-op: маркеры персистентны, отдельный кэш не нужен.
 */
export class FileDedupStore implements DedupStore {
  private _dir: string;
  private _ensured?: Promise<void>;

  constructor(config: FileDedupStoreConfig) {
    this._dir = join(config.dataDir, 'events', 'dedup');
  }

  seed(): void {
    // Файлы-маркеры персистентны — предзаполнение не требуется.
  }

  async tryClaim(key: string): Promise<boolean> {
    const path = join(this._dir, this._hash(key));
    await this._ensureDir();
    try {
      const handle = await open(path, 'wx');
      await handle.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
      console.warn(`[FileDedupStore] claim ключа не удался (fail-open): ${String(err)}`);
      return true;
    }
  }

  private _ensureDir(): Promise<void> {
    if (!this._ensured) {
      this._ensured = mkdir(this._dir, { recursive: true }).then(
        () => undefined,
        (err) => {
          // Сброс кэша, чтобы следующий claim попробовал снова.
          this._ensured = undefined;
          console.warn(`[FileDedupStore] не удалось создать каталог дедупа: ${String(err)}`);
        },
      );
    }
    return this._ensured;
  }

  private _hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}
