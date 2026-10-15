import type { Stats } from 'node:fs';
import { mkdir, rm, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FileMutexOptions {
  /** Путь к каталогу-локу (создаётся атомарно через `mkdir`). */
  path: string;
  /** Считать лок устаревшим, если его mtime старше (мс). По умолчанию 30_000. */
  staleMs?: number;
  /** Пауза между попытками захвата (мс). По умолчанию 25. */
  retryMs?: number;
  /** Общий таймаут `withLock` (мс). По умолчанию 5_000. */
  timeoutMs?: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Не держать event loop живым из-за ожидания лока.
    t.unref?.();
  });
}

/**
 * ADR-051/ADR-089: простой файловый мьютекс для общего `dataDir` на одном хосте/FS.
 *
 * Атомарность — через `mkdir(path)`: он эксклюзивен, второй процесс получит
 * `EEXIST`. Устаревший лок (mtime старше `staleMs`) перехватывается — защита от
 * падения процесса-владельца. Смысла вне общего FS (разные dataDir на реплику)
 * нет: там нужен K8s `Lease`/PG advisory lock (см. тех.долг ADR-051).
 *
 * Fail-open: ошибки логируются `console.warn` и не роняют вызывающего.
 */
export class FileMutex {
  private _path: string;
  private _staleMs: number;
  private _retryMs: number;
  private _timeoutMs: number;

  constructor(options: FileMutexOptions) {
    this._path = options.path;
    this._staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this._retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Проверка лока: статистика, `'gone'` — лок исчез, `'error'` — сбой (fail-open). */
  private async _statLock(): Promise<Stats | 'gone' | 'error'> {
    try {
      return await stat(this._path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'gone';
      console.warn(`[FileMutex] не удалось проверить лок ${this._path} (fail-open): ${String(err)}`);
      return 'error';
    }
  }

  /**
   * Одна попытка захвата. `true` — лок наш. `false` — лок занят живым
   * владельцем. Ошибки создания (кроме `EEXIST`) — fail-open `true`.
   *
   * Захват всегда подтверждается успешным `mkdir`: если лок исчез между `mkdir`
   * (`EEXIST`) и `stat` — владелец его только что освободил, — проверка
   * повторяется. Иначе `tryAcquire` вернул бы «acquired», не владея локом, и две
   * секции пошли бы параллельно (потерянные обновления: файл-«флейк»
   * `schedule-store.test.ts` «crossProcess: конкурентные create»).
   */
  async tryAcquire(): Promise<boolean> {
    try {
      await mkdir(dirname(this._path), { recursive: true });
    } catch (err) {
      console.warn(`[FileMutex] не удалось создать родительский каталог лока: ${String(err)}`);
    }

    // До двух попыток: повторяем, если лок исчез между `mkdir` и `stat`.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(this._path);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          console.warn(`[FileMutex] не удалось создать лок ${this._path} (fail-open): ${String(err)}`);
          return true;
        }
      }

      // Лок существует — проверяем устаревание.
      const info = await this._statLock();
      if (info === 'gone') continue; // лок освобождён владельцем — повторяем захват
      if (info === 'error') return true; // fail-open

      if (this._staleMs > 0 && Date.now() - info.mtimeMs > this._staleMs) {
        console.warn(`[FileMutex] лок ${this._path} устарел — перехватываем`);
        try {
          await rm(this._path, { recursive: true, force: true });
        } catch (err) {
          console.warn(
            `[FileMutex] не удалось удалить устаревший лок ${this._path} (fail-open): ${String(err)}`,
          );
          return true;
        }
        continue; // повторяем захват, не присваивая лок без `mkdir`
      }

      return false; // лок занят живым владельцем
    }

    // Лок исчезал при каждой проверке — захватить не удалось; вызывающий повторит.
    return false;
  }

  /** Обновить mtime лока, чтобы он не считался устаревшим. Best-effort. */
  async touch(): Promise<void> {
    try {
      const now = new Date();
      await utimes(this._path, now, now);
    } catch (err) {
      console.warn(`[FileMutex] не удалось обновить mtime лока ${this._path}: ${String(err)}`);
    }
  }

  /** Освободить лок (рекурсивно удалить каталог-лок). Best-effort. */
  async release(): Promise<void> {
    try {
      await rm(this._path, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[FileMutex] не удалось освободить лок ${this._path}: ${String(err)}`);
    }
  }

  /**
   * Выполнить `fn` под локом: захват с ретраями до `timeoutMs`, в `finally` —
   * освобождение (только если лок действительно был захвачен). При таймауте —
   * `warn` и выполнение без межпроцессной блокировки (fail-open: ставить
   * операцию важнее, чем гарантировать сериализацию).
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this._timeoutMs;
    let acquired = false;
    while (Date.now() < deadline) {
      if (await this.tryAcquire()) {
        acquired = true;
        break;
      }
      await delay(this._retryMs);
    }
    if (!acquired) {
      console.warn(
        `[FileMutex] не удалось захватить лок ${this._path} за ${this._timeoutMs}мс — продолжаем без блокировки`,
      );
    }
    try {
      return await fn();
    } finally {
      if (acquired) await this.release();
    }
  }
}
