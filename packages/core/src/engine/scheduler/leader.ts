import { join } from 'node:path';
import { FileMutex } from '../../storage/file-mutex.js';

/**
 * ADR-051/ADR-089: выбор лидера-владельца тикера планировщика. Только лидер
 * запускает тикер; остальные процессы ждут. Контракт — узел координации,
 * абстракция позволяет позже добавить K8s `Lease`/PG advisory lock.
 */
export interface SchedulerLeader {
  /** Попытка стать лидером: `true` — мы владелец. */
  acquire(): Promise<boolean>;
  /** Продлить владение (heartbeat), best-effort. */
  touch(): Promise<void>;
  /** Отпустить лидерство, best-effort. */
  release(): Promise<void>;
}

/** Дефолт: каждый процесс считает себя лидером (single-process). */
export class AlwaysLeader implements SchedulerLeader {
  async acquire(): Promise<boolean> {
    return true;
  }
  async touch(): Promise<void> {}
  async release(): Promise<void> {}
}

export interface FileLeaderOptions {
  dataDir: string;
  /** Период тика, мс; используется для расчёта `staleMs` (3×tick). */
  tickMs?: number;
  /** Явный `staleMs`; иначе `3 × tickMs`. */
  staleMs?: number;
}

/**
 * PROP-141 (Часть B): общий лидер-выбор для нескольких тикеров.
 *
 * Шедулер и движок таймеров работают в одном процессе и должны быть лидером
 * **одновременно** (иначе в multi-replica один процесс тикает расписания, а
 * другой — таймеры, и «лидером» оказываются оба). Второй лок означал бы двух
 * владельцев; `FileMutex.tryAcquire` на том же экземпляре повторно не
 * проходит (лок уже наш) — поэтому лидер-выбор **общий**, а не продублированный.
 *
 * Обёртка считает потребителей: первый `acquire()` захватывает лок, следующие
 * присоединяются к нему; лок освобождается, когда последний потребитель
 * вышел (`release`).
 */
export class SharedLeader implements SchedulerLeader {
  private _users = 0;
  private _acquired = false;

  constructor(private _inner: SchedulerLeader) {}

  /** Захват лидерства (первый потребитель — реальный захват лока). */
  async acquire(): Promise<boolean> {
    if (this._acquired) {
      this._users += 1;
      return true;
    }
    const acquired = await this._inner.acquire();
    if (!acquired) return false;
    this._acquired = true;
    this._users = 1;
    return true;
  }

  /** Продление владения — только владельцем лока. */
  async touch(): Promise<void> {
    if (!this._acquired) return;
    await this._inner.touch();
  }

  /** Выход потребителя; лок освобождается последним. */
  async release(): Promise<void> {
    if (!this._acquired) return;
    this._users = Math.max(0, this._users - 1);
    if (this._users > 0) return;
    this._acquired = false;
    await this._inner.release();
  }
}

/**
 * File-based лидер на общем `dataDir`: владелец — тот, кто создал каталог-лок
 * `{dataDir}/scheduler/leader.lock`. Лок старше `3 × tickMs` перехватывается
 * (падение владельца). Работает только при общем FS; иначе — `AlwaysLeader`.
 */
export class FileLeader implements SchedulerLeader {
  private _mutex: FileMutex;

  constructor(options: FileLeaderOptions) {
    const tickMs = options.tickMs ?? 60_000;
    this._mutex = new FileMutex({
      path: join(options.dataDir, 'scheduler', 'leader.lock'),
      staleMs: options.staleMs ?? tickMs * 3,
    });
  }

  async acquire(): Promise<boolean> {
    return this._mutex.tryAcquire();
  }

  async touch(): Promise<void> {
    await this._mutex.touch();
  }

  async release(): Promise<void> {
    await this._mutex.release();
  }
}
