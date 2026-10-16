import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Schedule, ScheduleInput, ScheduleRunStatus } from '@itphx/synth-shared';
import { generateId, AsyncLock, atomicWrite, safeJsonParse, nowISO } from '@itphx/synth-shared';
import { FileMutex } from './file-mutex.js';
import type { Mutex } from './mutex.js';
import type { ScheduleRepository } from './ports/schedule-repository.js';

/** ADR-051: версия схемы файла расписаний — для будущей миграции (PROP-032). */
export const SCHEDULES_SCHEMA_VERSION = 1;

export interface ScheduleStoreConfig {
  dataDir: string;
  /**
   * ADR-051/ADR-089: межпроцессная сериализация мутаций (file-мьютекс поверх
   * in-process `AsyncLock`) для нескольких реплик с общим `dataDir`.
   * Default `false` — поведение single-process не меняется.
   */
  crossProcess?: boolean;
  /**
   * PROP-032: внешний мьютекс (file/PG) — приоритетнее `crossProcess`. Позволяет
   * composition root'у подставить backend-специфичную реализацию; не задан и
   * `crossProcess` — мутации идут только под in-process `AsyncLock`.
   */
  mutex?: Mutex;
}

/** ADR-051/ADR-089: результат очередного запуска расписания (`markRun`). */
export interface ScheduleRunUpdate {
  /** Время запуска, ISO-8601. */
  at: string;
  status: ScheduleRunStatus;
  error?: string;
  /** Пересчитанное время следующего запуска (не задано — оставить прежним). */
  nextRunAt?: string;
}

interface SchedulesFile {
  schemaVersion: number;
  schedules: Schedule[];
}

function isSchedule(value: unknown): value is Schedule {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Schedule).id === 'string' &&
    typeof (value as Schedule).name === 'string'
  );
}

/**
 * ADR-051/ADR-089: реестр расписаний планировщика.
 *
 * Хранится одним JSON-файлом `{dataDir}/schedules.json` (ADR-005, атомарная
 * запись tmp→rename). Модель PG-ready (PROP-032): плоские записи со стабильным
 * `id` и `schemaVersion`.
 */
export class ScheduleStore implements ScheduleRepository {
  private _lock = new AsyncLock();
  private _mutex?: Mutex;

  constructor(private _config: ScheduleStoreConfig) {
    this._mutex =
      _config.mutex ??
      (_config.crossProcess
        ? new FileMutex({ path: join(_config.dataDir, 'scheduler', 'schedules.lock') })
        : undefined);
  }

  private _filePath(): string {
    return join(this._config.dataDir, 'schedules.json');
  }

  /**
   * Мутация под in-process `AsyncLock` (+ file-мьютекс при `crossProcess`):
   * read-modify-write не теряет записи даже при нескольких репликах.
   *
   * Долгая операция держит file-лок живым через heartbeat (`withLock` c
   * `heartbeat: true`): иначе секция > `staleMs` (30 c) считалась бы устаревшей
   * и могла быть перехвачена живым владельцем.
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

  /** Защита от path traversal в `id` (как в `JsonStore._validateKey`). */
  private _validateId(id: string): void {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error(`Недопустимый id расписания: ${id}`);
    }
  }

  private async _load(): Promise<SchedulesFile> {
    try {
      const raw = await readFile(this._filePath(), 'utf-8');
      const parsed = safeJsonParse<SchedulesFile | null>(raw, null);
      if (!parsed || !Array.isArray(parsed.schedules)) {
        return { schemaVersion: SCHEDULES_SCHEMA_VERSION, schedules: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? SCHEDULES_SCHEMA_VERSION,
        schedules: parsed.schedules.filter(isSchedule),
      };
    } catch {
      return { schemaVersion: SCHEDULES_SCHEMA_VERSION, schedules: [] };
    }
  }

  private async _save(file: SchedulesFile): Promise<void> {
    const path = this._filePath();
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(
      { schemaVersion: SCHEDULES_SCHEMA_VERSION, schedules: file.schedules },
      null,
      2,
    );
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }

  async list(): Promise<Schedule[]> {
    const file = await this._load();
    return [...file.schedules];
  }

  /**
   * ADR-051/ADR-089: есть ли включённое расписание, нацеленное на сессию
   * (`target.mode !== 'ephemeral'` и совпадающий `target.sessionId`). Ephemeral-
   * цели сессию не адресуют (создают разовую), поэтому не учитываются.
   * Используется оркестратором: при `true` в системный промпт добавляется
   * статическое описание системного пользователя `Scheduler`.
   */
  async hasEnabledTargetFor(sessionId: string): Promise<boolean> {
    const file = await this._load();
    return file.schedules.some(
      (schedule) =>
        schedule.enabled
        && schedule.target.mode !== 'ephemeral'
        && schedule.target.sessionId === sessionId,
    );
  }

  async get(id: string): Promise<Schedule | null> {
    const file = await this._load();
    return file.schedules.find((s) => s.id === id) ?? null;
  }

  /** Создаёт расписание: id `sch_<uuid>`, `createdAt`/`updatedAt` = now. */
  async create(input: ScheduleInput): Promise<Schedule> {
    return this._lockedMutation(async () => {
      const id = `sch_${generateId()}`;
      this._validateId(id);

      const now = nowISO();
      const schedule: Schedule = { ...input, id, createdAt: now, updatedAt: now };
      const file = await this._load();
      file.schedules.push(schedule);
      await this._save(file);
      return schedule;
    });
  }

  /** Обновляет расписание (partial-патч); `updatedAt` выставляется в now. */
  async update(id: string, patch: Partial<ScheduleInput>): Promise<Schedule | null> {
    this._validateId(id);
    return this._lockedMutation(async () => {
      const file = await this._load();
      const index = file.schedules.findIndex((s) => s.id === id);
      if (index === -1) return null;

      const current = file.schedules[index]!;
      const updated: Schedule = { ...current, ...patch, id, updatedAt: nowISO() };
      file.schedules[index] = updated;
      await this._save(file);
      return updated;
    });
  }

  async remove(id: string): Promise<boolean> {
    this._validateId(id);
    return this._lockedMutation(async () => {
      const file = await this._load();
      const next = file.schedules.filter((s) => s.id !== id);
      if (next.length === file.schedules.length) return false;
      file.schedules = next;
      await this._save(file);
      return true;
    });
  }

  /**
   * Фиксирует результат запуска: `lastRunAt`/`lastStatus`/`lastError` и,
   * если задано, `nextRunAt`. `updatedAt` не трогается (следующий запуск —
   * служебное поле сервиса, а не пользовательская правка).
   */
  async markRun(id: string, run: ScheduleRunUpdate): Promise<Schedule | null> {
    this._validateId(id);
    return this._lockedMutation(async () => {
      const file = await this._load();
      const index = file.schedules.findIndex((s) => s.id === id);
      if (index === -1) return null;

      const current = file.schedules[index]!;
      const updated: Schedule = {
        ...current,
        lastRunAt: run.at,
        lastStatus: run.status,
        lastError: run.error,
        ...(run.nextRunAt !== undefined ? { nextRunAt: run.nextRunAt } : {}),
      };
      file.schedules[index] = updated;
      await this._save(file);
      return updated;
    });
  }

  /**
   * Устанавливает только `nextRunAt` (служебное поле сервиса): используется
   * при старте/создании/обновлении, чтобы не смешивать с результатом запуска.
   */
  async setNextRun(id: string, nextRunAt: string | undefined): Promise<Schedule | null> {
    this._validateId(id);
    return this._lockedMutation(async () => {
      const file = await this._load();
      const index = file.schedules.findIndex((s) => s.id === id);
      if (index === -1) return null;

      const current = file.schedules[index]!;
      const updated: Schedule = { ...current };
      if (nextRunAt === undefined) {
        delete updated.nextRunAt;
      } else {
        updated.nextRunAt = nextRunAt;
      }
      file.schedules[index] = updated;
      await this._save(file);
      return updated;
    });
  }
}
