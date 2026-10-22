/**
 * In-memory реализации портов планировщика (ADR-096, шаг W2.2).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`). Семантика повторяет файловую
 * (`ScheduleStore`/`JobStore`): id `sch_<uuid>`, `updatedAt` при правке,
 * append-журнал Job в порядке добавления (`limit` → последние N), retention по
 * `startedAt`, `hasEnabledTargetFor` учитывает `enabled` и `mode !== 'ephemeral'`.
 * Межпроцессная сериализация (`crossProcess`/`FileMutex`) в памяти не нужна.
 */

import type { Schedule, ScheduleInput, ScheduleJob } from '@itphx/synth-shared';
import { generateId, nowISO } from '@itphx/synth-shared';
import type { JobListOptions } from '../job-store.js';
import type { ScheduleRunUpdate } from '../schedule-store.js';
import type { JobRepository, ScheduleRepository } from '../ports/index.js';

/** Порт реестра расписаний поверх `Map` (семантика `ScheduleStore`). */
export class MemoryScheduleRepository implements ScheduleRepository {
  private readonly _schedules = new Map<string, Schedule>();

  async list(): Promise<Schedule[]> {
    return [...this._schedules.values()].map((s) => structuredClone(s));
  }

  async hasEnabledTargetFor(sessionId: string): Promise<boolean> {
    for (const schedule of this._schedules.values()) {
      if (schedule.enabled && schedule.target.mode !== 'ephemeral' && schedule.target.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  async get(id: string): Promise<Schedule | null> {
    const schedule = this._schedules.get(id);
    return schedule ? structuredClone(schedule) : null;
  }

  async create(input: ScheduleInput): Promise<Schedule> {
    const now = nowISO();
    const schedule: Schedule = { ...input, id: `sch_${generateId()}`, createdAt: now, updatedAt: now };
    this._schedules.set(schedule.id, structuredClone(schedule));
    return structuredClone(schedule);
  }

  async update(id: string, patch: Partial<ScheduleInput>): Promise<Schedule | null> {
    const current = this._schedules.get(id);
    if (!current) return null;
    const updated: Schedule = { ...current, ...patch, id, updatedAt: nowISO() };
    this._schedules.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async remove(id: string): Promise<boolean> {
    return this._schedules.delete(id);
  }

  async markRun(id: string, run: ScheduleRunUpdate): Promise<Schedule | null> {
    const current = this._schedules.get(id);
    if (!current) return null;
    const updated: Schedule = {
      ...current,
      lastRunAt: run.at,
      lastStatus: run.status,
      lastError: run.error,
      ...(run.nextRunAt !== undefined ? { nextRunAt: run.nextRunAt } : {}),
    };
    this._schedules.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async setNextRun(id: string, nextRunAt: string | undefined): Promise<Schedule | null> {
    const current = this._schedules.get(id);
    if (!current) return null;
    const updated: Schedule = { ...current };
    if (nextRunAt === undefined) delete updated.nextRunAt;
    else updated.nextRunAt = nextRunAt;
    this._schedules.set(id, structuredClone(updated));
    return structuredClone(updated);
  }
}

/** Порт append-истории Job поверх массива (семантика `JobStore`). */
export class MemoryJobRepository implements JobRepository {
  private _jobs: ScheduleJob[] = [];

  async append(job: ScheduleJob): Promise<void> {
    this._jobs.push(structuredClone(job));
  }

  async list(opts: JobListOptions = {}): Promise<ScheduleJob[]> {
    let jobs = this._jobs.map((j) => structuredClone(j));
    if (opts.scheduleId !== undefined) {
      jobs = jobs.filter((job) => job.scheduleId === opts.scheduleId);
    }
    const { limit } = opts;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return jobs;
    return jobs.slice(-Math.floor(limit));
  }

  async prune(retentionDays: number): Promise<number> {
    if (this._jobs.length === 0) return 0;
    const days = Number.isFinite(retentionDays) ? retentionDays : 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const kept = this._jobs.filter((job) => {
      const t = Date.parse(job.startedAt);
      return Number.isNaN(t) ? true : t >= cutoff;
    });
    const removed = this._jobs.length - kept.length;
    if (removed === 0) return 0;
    this._jobs = kept;
    return removed;
  }
}
