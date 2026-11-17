import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Schedule, ScheduleInput, ScheduleRunStatus } from '@itphx/synth-shared';
import {
  generateId,
  AsyncLock,
  atomicWrite,
  safeJsonParse,
  nowISO,
  deriveScheduleProjectId,
  normalizeScheduleProject,
  SCHEDULE_PROJECT_REQUIRED_ERROR,
} from '@itphx/synth-shared';
import { FileMutex } from './file-mutex.js';
import type { Mutex } from './mutex.js';
import type { ScheduleRepository } from './ports/schedule-repository.js';

/** ADR-051: версия схемы файла расписаний — для будущей миграции (ADR-096). */
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
   * ADR-096: внешний мьютекс (file/PG) — приоритетнее `crossProcess`. Позволяет
   * composition root'у подставить backend-специфичную реализацию; не задан и
   * `crossProcess` — мутации идут только под in-process `AsyncLock`.
   */
  mutex?: Mutex;
  /**
   * PROP-141: резолвер «id сессии → id проекта» для бэкфилла `projectId`
   * у легаси-расписаний с целью `bound`/`queue` (проект сессии-цели).
   *
   * Задаёт **composition root** (порт сессий хранилища). Не задан — проект
   * таких записей вывести нечем: они остаются в реестре, но отключаются
   * (`lastError = 'project_required'`).
   */
  resolveSessionProject?: (sessionId: string) => Promise<string | undefined>;
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
 * запись tmp→rename). Модель PG-ready (ADR-097): плоские записи со стабильным
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

  private async _loadRaw(): Promise<SchedulesFile> {
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

  /**
   * PROP-141: чтение приводит записи к контракту «проект обязателен»:
   * проект выводится из цели; вывести нельзя — запись отключается
   * (`project_required`) и не срабатывает. Запись при этом **не теряется**.
   */
  private async _load(): Promise<SchedulesFile> {
    const file = await this._loadRaw();
    return { ...file, schedules: file.schedules.map(normalizeScheduleProject) };
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
   * (`target.mode` — `bound`/`queue` и совпадающий `target.sessionId`).
   * Ephemeral-цели сессию не адресуют (создают разовую), поэтому не
   * учитываются; цель `pipeline` (ADR-101) сессию не адресует вовсе.
   * Используется оркестратором: при `true` в системный промпт добавляется
   * статическое описание системного пользователя `Scheduler`.
   */
  async hasEnabledTargetFor(sessionId: string): Promise<boolean> {
    const file = await this._load();
    return file.schedules.some(
      (schedule) =>
        schedule.enabled
        && (schedule.target.mode === 'bound' || schedule.target.mode === 'queue')
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
      // PROP-141: проект обязателен — запись без проекта отключается
      // (`project_required`) и не срабатывает.
      const schedule: Schedule = normalizeScheduleProject({
        ...input,
        projectId: input.projectId ?? '',
        id,
        createdAt: now,
        updatedAt: now,
      });
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
      // Контракт порта: пара триггеров заменяется целиком. Собственный ключ
      // `cron`/`every` в патче сбрасывает второй триггер (в т.ч. лечит старую
      // запись с обоими полями), отсутствие ключей — триггер не трогает.
      if (Object.hasOwn(patch, 'cron') || Object.hasOwn(patch, 'every')) {
        if (patch.cron !== undefined) updated.cron = patch.cron;
        else delete updated.cron;
        if (patch.every !== undefined) updated.every = patch.every;
        else delete updated.every;
      }
      // Владение — атрибуция/область доступа, а не содержимое: `ownerId`
      // пользовательским патчем не очищается (`undefined` = «не менять»).
      if (Object.hasOwn(patch, 'ownerId') && patch.ownerId === undefined) {
        if (current.ownerId !== undefined) updated.ownerId = current.ownerId;
        else delete updated.ownerId;
      }
      // PROP-141: проект — обязательное денормализованное поле: собственным
      // ключом с `undefined` он не очищается (иначе расписание осталось бы
      // без проекта и перестало бы срабатывать).
      if (Object.hasOwn(patch, 'projectId') && patch.projectId === undefined) {
        updated.projectId = current.projectId;
      }
      // PROP-141: запись без проекта не срабатывает — нормализация и на
      // записи (иначе «включено без проекта» сохранилось бы в файле).
      file.schedules[index] = normalizeScheduleProject(updated);
      await this._save(file);
      return file.schedules[index];
    });
  }

  /**
   * PROP-141: бэкфилл `projectId` у легаси-расписаний (идемпотентно).
   *
   * Проект выводится из цели: `pipeline` → `target.projectId`, `ephemeral` →
   * `target.project`, `bound`/`queue` → проект сессии-цели
   * (`resolveSessionProject`, резолвер даёт composition root).
   *
   * Вывести нельзя — запись **не теряется**: она остаётся в реестре, но
   * отключается и помечается `lastError = 'project_required'` (не
   * срабатывает). Повторный вызов ничего не меняет (у всех записей проект
   * уже есть либо запись уже отключена) — безопасно вызывать при каждом
   * старте процесса.
   */
  async backfillProjectIds(): Promise<{ backfilled: number; disabled: number }> {
    return this._lockedMutation(async () => {
      const file = await this._loadRaw();
      let backfilled = 0;
      let disabled = 0;
      let changed = false;
      const schedules: Schedule[] = [];

      for (const schedule of file.schedules) {
        const projectId = await this._resolveProjectId(schedule);
        if (projectId) {
          if (schedule.projectId !== projectId) {
            schedule.projectId = projectId;
            backfilled++;
            changed = true;
          }
          schedules.push(schedule);
          continue;
        }
        // Проект вывести нельзя: запись остаётся, но не срабатывает.
        if (schedule.enabled || schedule.lastError !== SCHEDULE_PROJECT_REQUIRED_ERROR) {
          disabled++;
          changed = true;
        }
        schedule.enabled = false;
        schedule.lastError = SCHEDULE_PROJECT_REQUIRED_ERROR;
        schedules.push(schedule);
      }

      if (changed) {
        file.schedules = schedules;
        await this._save(file);
      }
      return { backfilled, disabled };
    });
  }

  /**
   * PROP-141: проект расписания (свой или выводимый из цели).
   *
   * `bound`/`queue` — проект сессии-цели: нужен резолвер composition root'а.
   * Ошибка резолвера не роняет бэкфилл — запись просто останется без
   * проекта (и будет отключена).
   */
  private async _resolveProjectId(schedule: Schedule): Promise<string | undefined> {
    if (schedule.projectId) return schedule.projectId;
    const derived = deriveScheduleProjectId(schedule.target);
    if (derived) return derived;
    const target = schedule.target;
    if (target.mode !== 'bound' && target.mode !== 'queue') return undefined;
    const resolver = this._config.resolveSessionProject;
    if (!resolver) return undefined;
    try {
      return (await resolver(target.sessionId)) || undefined;
    } catch {
      return undefined;
    }
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
