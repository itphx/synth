import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LockOptions, Mutex } from './mutex.js';

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
 * **Ownership-токен.** Каталог-лок содержит файл `owner` с id владельца
 * (`randomUUID` на инстанс `FileMutex`). `release()` удаляет лок только если
 * токен свой: иначе «протухший» владелец A после stale-takeover мог бы снести
 * лок нового владельца B, и в секцию вошёл бы третий писатель (потерянные
 * обновления). `touch()` тоже проверяет владение — «зомби» после перехвата не
 * продлевает чужой лок. Перехват (`rm` + повторный `mkdir`) перезаписывает
 * токен новым владельцем.
 *
 * Fail-open: ошибки логируются `console.warn` и не роняют вызывающего.
 */
export class FileMutex implements Mutex {
  private _path: string;
  private _staleMs: number;
  private _retryMs: number;
  private _timeoutMs: number;
  /** Уникальный id этого инстанса-владельца (пишется в `owner`). */
  private _ownerId = randomUUID();

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

  /** Путь к файлу-токену владельца внутри каталога-лока. */
  private _ownerPath(): string {
    return join(this._path, 'owner');
  }

  /** Записать свой ownership-токен в лок. Best-effort (ошибки — `warn`). */
  private async _writeOwner(): Promise<void> {
    try {
      await writeFile(this._ownerPath(), this._ownerId, 'utf-8');
    } catch (err) {
      console.warn(`[FileMutex] не удалось записать владельца лока ${this._path}: ${String(err)}`);
    }
  }

  /**
   * Прочитать токен владельца лока: содержимое, `'gone'` — файла/лока нет,
   * `'error'` — сбой чтения. Ошибка трактуется консервативно: вызывающий не
   * удаляет и не продлевает лок, который не может подтвердить как свой.
   */
  private async _readOwner(): Promise<string | 'gone' | 'error'> {
    try {
      return await readFile(this._ownerPath(), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'gone';
      console.warn(`[FileMutex] не удалось прочитать владельца лока ${this._path}: ${String(err)}`);
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
      let created = false;
      try {
        await mkdir(this._path);
        created = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          console.warn(`[FileMutex] не удалось создать лок ${this._path} (fail-open): ${String(err)}`);
          return true;
        }
      }

      if (created) {
        // Сразу фиксируем владение: `release`/`touch` сверяют этот токен.
        await this._writeOwner();
        return true;
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

  /**
   * Обновить mtime лока, чтобы он не считался устаревшим. Best-effort.
   *
   * Токен сверяется: если лок перехвачен другим владельцем (или пропал), mtime
   * не трогаем — иначе «зомби»-процесс продлевал бы чужой лок и маскировал его
   * смерть (stale takeover не срабатывал бы).
   */
  async touch(): Promise<void> {
    const owner = await this._readOwner();
    if (owner === 'error') return; // warn уже отдан в `_readOwner`
    if (owner === 'gone') return; // лок освобождён/исчез — продлевать нечего
    if (owner.trim() !== this._ownerId) {
      console.warn(`[FileMutex] лок ${this._path} принадлежит другому владельцу — heartbeat пропущен`);
      return;
    }
    try {
      const now = new Date();
      await utimes(this._path, now, now);
    } catch (err) {
      console.warn(`[FileMutex] не удалось обновить mtime лока ${this._path}: ${String(err)}`);
    }
  }

  /**
   * Освободить лок. Best-effort: удаляем каталог-лок **только если его
   * ownership-токен наш**.
   *
   * Зачем: сценарий A держит лок дольше `staleMs` → B перехватывает (`rm` +
   * `mkdir`) → A завершает работу и в `finally` вызывает `release()`. Без
   * проверки A удалил бы лок B, и в секцию вошёл бы C параллельно (два писателя).
   * При чужом токене (или если токен прочитать не удалось) лок НЕ трогаем — это
   * консервативный выбор: залипший чужой лок снимется штатным stale-takeover.
   *
   * Что токен **не** гарантирует: проверка «прочитали токен → удалили» не
   * атомарна (TOCTOU). Если ровно в этом окне лок успел протухнуть и B сделал
   * `rm`+`mkdir`, A может прочитать свой токен и снести уже лок B. Окно
   * минимизируется heartbeat'ом (`withLock(fn, { heartbeat: true })` не даёт
   * живому локу протухнуть) и тем, что `release` вызывается сразу по завершении
   * операции. Полностью гонку снимает лишь атомарный протокол на стороне FS/ОС
   * (rename в уникальное имя, K8s `Lease`, PG advisory lock) — вне рамок этого
   * примитива.
   */
  async release(): Promise<void> {
    const owner = await this._readOwner();
    if (owner === 'error') return; // warn уже отдан в `_readOwner`
    if (owner === 'gone') return; // лок уже освобождён/перехвачен
    if (owner.trim() !== this._ownerId) {
      console.warn(`[FileMutex] не освобождаем лок ${this._path}: он принадлежит другому владельцу`);
      return;
    }
    try {
      await rm(this._path, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[FileMutex] не удалось освободить лок ${this._path}: ${String(err)}`);
    }
  }

  /**
   * Выполнить `fn` под локом: захват с ретраями до `timeoutMs`, в `finally` —
   * освобождение (только если лок действительно был захвачен). При таймауте —
   * `warn` и выполнение без межпроцессной блокировки.
   *
   * **Осознанный fail-open.** При недоступности лока операция всё равно
   * выполняется: проект выбрал «доступность важнее сериализации»
   * (ADR-051/ADR-089) — залипший/недоступный файл-лок не должен блокировать
   * работу инстанса. Цена: под перегрузкой/сбоем FS возможны параллельные
   * секции (потерянные обновления) — принимается явно, не «баг».
   *
   * `heartbeat: true` — пока `fn` выполняется, периодически продлевать mtime
   * лока (`touch`, токен сверяется), чтобы долгая операция не выглядела
   * устаревшей и не была перехвачена живым владельцем. Интервал — `staleMs / 3`
   * (заметно меньше `staleMs`). Таймер снимается в `finally`; при fail-open
   * (лок не захвачен) heartbeat не стартует.
   */
  async withLock<T>(fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
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

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (acquired && opts?.heartbeat && this._staleMs > 0) {
      const intervalMs = Math.max(10, Math.floor(this._staleMs / 3));
      heartbeat = setInterval(() => {
        void this.touch();
      }, intervalMs);
      heartbeat.unref?.();
    }

    try {
      return await fn();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (acquired) await this.release();
    }
  }
}
