import { join } from 'node:path';
import { AsyncLock, generateId, nowISO } from '@itphx/synth-shared';
import type {
  Timer,
  TimerCreateInput,
  TimerFilter,
  TimerPatch,
  TimerStatus,
} from '@itphx/synth-shared';
import type { TimerRepository } from './ports/timer-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import {
  applyTimerPatch,
  byTimerFiresAtAsc,
  isTimerDue,
  paginateTimers,
  timerMatchesFilter,
} from './timer-utils.js';
import { FileMutex } from './file-mutex.js';
import type { Mutex } from './mutex.js';

export interface FileTimerStoreConfig {
  dataDir: string;
  /**
   * ADR-051/ADR-089: межпроцестная сериализация мутаций (file-мьютекс поверх
   * in-process `AsyncLock`) для нескольких реплик с общим `dataDir`.
   * Default `false` — поведение single-process не меняется.
   */
  crossProcess?: boolean;
  /**
   * ADR-096: внешний мьютекс (file/PG) — приоритетнее `crossProcess`.
   * Позволяет composition root'у подставить backend-специфичную реализацию.
   */
  mutex?: Mutex;
}

/** Ключ массива таймеров внутри JSON-файла. */
const TIMERS_KEY = 'timers';

/**
 * Файловая реализация порта реестра таймеров/будильников (PROP-141, Часть B;
 * ADR-096 — слой хранения; ADR-005 — JSON + атомарная запись tmp→rename).
 *
 * Физическое расположение: `{dataDir}/timers.json` (версия схемы — 1, как у
 * соседних JSON-коллекций). История срабатываний — отдельный append-only
 * журнал `{dataDir}/timers/firings.jsonl` (`FileTimerFiringStore`).
 *
 * Семантика повторяет in-memory реализацию (`MemoryTimerRepository`):
 * `create` — id `tmr_<uuid>`, таймстемпы = now, статус по умолчанию —
 * `active`; `list` — по ближайшему срабатыванию (`firesAt` возраст.,
 * тайбрейкер `id`); `listDue` — активные с `firesAt <= at`; `update`/
 * `setStatus` — частичная правка с `updatedAt` = now; `remove` идемпотентно;
 * `removeBySession` — каскад по сессии.
 */
export class FileTimerStore implements TimerRepository {
  private readonly _lock = new AsyncLock();
  private readonly _mutex?: Mutex;

  constructor(private readonly _config: FileTimerStoreConfig) {
    this._mutex =
      _config.mutex ??
      (_config.crossProcess
        ? new FileMutex({ path: join(_config.dataDir, 'timers', 'timers.lock') })
        : undefined);
  }

  /** Путь файла таймеров (`{dataDir}/timers.json`). */
  path(): string {
    return join(this._config.dataDir, 'timers.json');
  }

  /**
   * Мутация под in-process `AsyncLock` (+ file-мьютекс при `crossProcess`):
   * read-modify-write не теряет записи даже при нескольких репликах.
   */
  private async _lockedMutation<T>(fn: () => Promise<T>): Promise<T> {
    await this._lock.acquire();
    try {
      if (this._mutex) return await this._mutex.withLock(fn, { heartbeat: true });
      return await fn();
    } finally {
      this._lock.release();
    }
  }

  async list(filter?: TimerFilter): Promise<Timer[]> {
    const timers = await this._read();
    const filtered = timers.filter((t) => timerMatchesFilter(t, filter));
    return paginateTimers([...filtered].sort(byTimerFiresAtAsc), filter);
  }

  async get(id: string): Promise<Timer | null> {
    const timers = await this._read();
    return timers.find((t) => t.id === id) ?? null;
  }

  async create(input: TimerCreateInput & { firesAt: string }): Promise<Timer> {
    return this._lockedMutation(async () => {
      const now = nowISO();
      const timer: Timer = {
        ...input,
        // Префикс по виду: `alm_` для будильника, `tmr_` для таймера
        // (ADR-141 — одна сущность `Timer`, но id читаем).
        id: `${input.kind === 'alarm' ? 'alm' : 'tmr'}_${generateId()}`,
        status: input.status ?? 'active',
        createdAt: now,
        updatedAt: now,
      };
      const timers = await this._read();
      timers.push(timer);
      await this._write(timers);
      return timer;
    });
  }

  async update(id: string, patch: TimerPatch): Promise<Timer | null> {
    return this._lockedMutation(async () => {
      const timers = await this._read();
      const index = timers.findIndex((t) => t.id === id);
      if (index === -1) return null;
      const updated = applyTimerPatch(timers[index]!, patch);
      timers[index] = updated;
      await this._write(timers);
      return updated;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this._lockedMutation(async () => {
      const timers = await this._read();
      const next = timers.filter((t) => t.id !== id);
      if (next.length === timers.length) return false;
      await this._write(next);
      return true;
    });
  }

  async listDue(at: string): Promise<Timer[]> {
    const timers = await this._read();
    return timers
      .filter((t) => t.status === 'active' && isTimerDue(t, at))
      .sort(byTimerFiresAtAsc);
  }

  async countActive(sessionId: string): Promise<number> {
    const timers = await this._read();
    return timers.filter((t) => t.status === 'active' && t.sessionId === sessionId).length;
  }

  async setStatus(id: string, status: TimerStatus, patch?: TimerPatch): Promise<Timer | null> {
    return this._lockedMutation(async () => {
      const timers = await this._read();
      const index = timers.findIndex((t) => t.id === id);
      if (index === -1) return null;
      const updated = applyTimerPatch(timers[index]!, { ...(patch ?? {}), status });
      timers[index] = updated;
      await this._write(timers);
      return updated;
    });
  }

  async removeBySession(sessionId: string): Promise<number> {
    return this._lockedMutation(async () => {
      const timers = await this._read();
      const kept = timers.filter((t) => t.sessionId !== sessionId);
      const removed = timers.length - kept.length;
      if (removed === 0) return 0;
      await this._write(kept);
      return removed;
    });
  }

  private async _read(): Promise<Timer[]> {
    return readCollectionFile<Timer>(this.path(), TIMERS_KEY, 'файл таймеров');
  }

  private async _write(timers: Timer[]): Promise<void> {
    await writeCollectionFile(this.path(), TIMERS_KEY, timers);
  }
}
