import { join } from 'node:path';
import { FileMutex } from '../../storage/file-mutex.js';

/**
 * AD-051/AD-089: выбор лидера-владельца тикера планировщика. Только лидер
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
