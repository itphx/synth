/**
 * PG-реализация портов планировщика (PROP-032, волна 3b): `schedules`/`jobs`.
 *
 * Семантика повторяет файловые реализации core (`ScheduleStore`, `JobStore`):
 * id `sch_<uuid>`, `updatedAt` при правке; `hasEnabledTargetFor` учитывает
 * `enabled` и `target.mode !== 'ephemeral'` (SQL `EXISTS` по `target->>'sessionId'`);
 * Job-история — append-only (`jobs.seq`), `list` — последние N в порядке добавления.
 */

import type { ScheduleRunUpdate, JobListOptions, StorageContext } from '@itphx/synth-core';
import { type Schedule, type ScheduleInput, type ScheduleJob, generateId } from '@itphx/synth-shared';
import type { PortDeps } from './deps.js';
import { compact, toInt, toIso, toIsoRequired } from './events-core.js';

/** Часть `StorageContext`, которой владеет под-группа планировщика. */
export type EventSchedulerPorts = Pick<StorageContext, 'schedules' | 'jobs'>;

// ── schedules ────────────────────────────────────────────────────────────────

type ScheduleRow = {
  id: string;
  name: string;
  enabled: boolean;
  cron: string | null;
  every: string | null;
  target: unknown;
  prompt: string | null;
  payload: unknown;
  owner_id: string | null;
  catch_up: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_run_at: Date | string | null;
  next_run_at: Date | string | null;
  last_status: string | null;
  last_error: string | null;
};

function toSchedule(row: ScheduleRow): Schedule {
  return compact({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    cron: row.cron ?? undefined,
    every: row.every ?? undefined,
    target: (row.target ?? { mode: 'ephemeral' }) as Schedule['target'],
    prompt: row.prompt ?? undefined,
    payload: (row.payload ?? undefined) as Schedule['payload'],
    ownerId: row.owner_id ?? undefined,
    catchUp: (row.catch_up ?? undefined) as Schedule['catchUp'],
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
    lastRunAt: toIso(row.last_run_at),
    nextRunAt: toIso(row.next_run_at),
    lastStatus: (row.last_status ?? undefined) as Schedule['lastStatus'],
    lastError: row.last_error ?? undefined,
  });
}

/** ADR-051/ADR-089: реестр расписаний поверх `schedules`. */
export class PgScheduleRepository {
  constructor(private readonly _deps: PortDeps) {}

  async list(): Promise<Schedule[]> {
    const rows = await this._deps.connection.query<ScheduleRow>(
      'SELECT * FROM schedules ORDER BY created_at, id',
    );
    return rows.map(toSchedule);
  }

  /**
   * Есть ли включённое расписание, нацеленное на сессию (не `ephemeral`).
   * `EXISTS` по `target->>'sessionId'` (индекс `schedules_enabled_idx`).
   */
  async hasEnabledTargetFor(sessionId: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM schedules
         WHERE enabled = true
           AND target->>'mode' <> 'ephemeral'
           AND target->>'sessionId' = $1
       ) AS present`,
      [sessionId],
    );
    return rows[0]?.present === true;
  }

  async get(id: string): Promise<Schedule | null> {
    const rows = await this._deps.connection.query<ScheduleRow>(
      'SELECT * FROM schedules WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  }

  /** Создаёт расписание: id `sch_<uuid>`, `createdAt`/`updatedAt` = now. */
  async create(input: ScheduleInput): Promise<Schedule> {
    const id = `sch_${generateId()}`;
    const now = new Date().toISOString();
    const rows = await this._deps.connection.query<ScheduleRow>(
      `INSERT INTO schedules
         (id, name, enabled, cron, every, target, prompt, payload, owner_id, catch_up,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $11)
       RETURNING *`,
      [
        id,
        input.name,
        input.enabled,
        input.cron ?? null,
        input.every ?? null,
        JSON.stringify(input.target ?? {}),
        input.prompt ?? null,
        input.payload !== undefined ? JSON.stringify(input.payload) : null,
        input.ownerId ?? null,
        input.catchUp ?? null,
        now,
      ],
    );
    return toSchedule(rows[0]!);
  }

  /** Обновляет расписание (partial-патч); `updatedAt` выставляется в now. */
  async update(id: string, patch: Partial<ScheduleInput>): Promise<Schedule | null> {
    const sets = ['updated_at = $1'];
    const params: unknown[] = [new Date().toISOString()];

    if (patch.name !== undefined) {
      params.push(patch.name);
      sets.push(`name = $${params.length}`);
    }
    if (patch.enabled !== undefined) {
      params.push(patch.enabled);
      sets.push(`enabled = $${params.length}`);
    }
    if (patch.cron !== undefined) {
      params.push(patch.cron);
      sets.push(`cron = $${params.length}`);
    }
    if (patch.every !== undefined) {
      params.push(patch.every);
      sets.push(`every = $${params.length}`);
    }
    if (patch.target !== undefined) {
      params.push(JSON.stringify(patch.target));
      sets.push(`target = $${params.length}::jsonb`);
    }
    if (patch.prompt !== undefined) {
      params.push(patch.prompt);
      sets.push(`prompt = $${params.length}`);
    }
    if (patch.payload !== undefined) {
      params.push(JSON.stringify(patch.payload));
      sets.push(`payload = $${params.length}::jsonb`);
    }
    if (patch.ownerId !== undefined) {
      params.push(patch.ownerId);
      sets.push(`owner_id = $${params.length}`);
    }
    if (patch.catchUp !== undefined) {
      params.push(patch.catchUp);
      sets.push(`catch_up = $${params.length}`);
    }

    params.push(id);
    const rows = await this._deps.connection.query<ScheduleRow>(
      `UPDATE schedules SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM schedules WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }

  /** Фиксация результата запуска (`updatedAt` не трогается). */
  async markRun(id: string, run: ScheduleRunUpdate): Promise<Schedule | null> {
    const sets = ['last_run_at = $2', 'last_status = $3', 'last_error = $4'];
    const params: unknown[] = [id, run.at, run.status, run.error ?? null];
    if (run.nextRunAt !== undefined) {
      params.push(run.nextRunAt);
      sets.push(`next_run_at = $${params.length}`);
    }
    const rows = await this._deps.connection.query<ScheduleRow>(
      `UPDATE schedules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  }

  /** Обновление только `nextRunAt` (служебное поле сервиса). */
  async setNextRun(id: string, nextRunAt: string | undefined): Promise<Schedule | null> {
    const rows = await this._deps.connection.query<ScheduleRow>(
      'UPDATE schedules SET next_run_at = $2 WHERE id = $1 RETURNING *',
      [id, nextRunAt ?? null],
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  }
}

// ── jobs ─────────────────────────────────────────────────────────────────────

type JobRow = {
  seq: string;
  id: string;
  schedule_id: string;
  schedule_name: string;
  trigger: string;
  status: string;
  started_at: Date | string;
  finished_at: Date | string;
  duration_ms: number | string;
  target: unknown;
  dedup_key: string | null;
  decision: string | null;
  reason: string | null;
  session_id: string | null;
  error: string | null;
};

function toJob(row: JobRow): ScheduleJob {
  return compact({
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleName: row.schedule_name,
    trigger: row.trigger as ScheduleJob['trigger'],
    status: row.status as ScheduleJob['status'],
    startedAt: toIsoRequired(row.started_at),
    finishedAt: toIsoRequired(row.finished_at),
    durationMs: toInt(row.duration_ms) ?? 0,
    target: (row.target ?? { mode: 'ephemeral' }) as ScheduleJob['target'],
    dedupKey: row.dedup_key ?? undefined,
    decision: (row.decision ?? undefined) as ScheduleJob['decision'],
    reason: row.reason ?? undefined,
    sessionId: row.session_id ?? undefined,
    error: row.error ?? undefined,
  });
}

/** ADR-051: append-only история срабатываний поверх `jobs`. */
export class PgJobRepository {
  constructor(private readonly _deps: PortDeps) {}

  async append(job: ScheduleJob): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO jobs
         (id, schedule_id, schedule_name, trigger, status, started_at, finished_at,
          duration_ms, target, dedup_key, decision, reason, session_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)`,
      [
        job.id,
        job.scheduleId,
        job.scheduleName,
        job.trigger,
        job.status,
        job.startedAt,
        job.finishedAt,
        job.durationMs,
        JSON.stringify(job.target ?? {}),
        job.dedupKey ?? null,
        job.decision ?? null,
        job.reason ?? null,
        job.sessionId ?? null,
        job.error ?? null,
      ],
    );
  }

  /**
   * История в порядке добавления (старые → новые); фильтр `scheduleId`,
   * `limit` — последние N.
   */
  async list(opts: JobListOptions = {}): Promise<ScheduleJob[]> {
    const limited = opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0;
    const limit = limited ? Math.floor(opts.limit as number) : 0;
    let rows: JobRow[];

    if (opts.scheduleId !== undefined && limited) {
      rows = await this._deps.connection.query<JobRow>(
        `SELECT * FROM (
           SELECT * FROM jobs WHERE schedule_id = $1 ORDER BY seq DESC LIMIT $2
         ) t ORDER BY seq ASC`,
        [opts.scheduleId, limit],
      );
    } else if (opts.scheduleId !== undefined) {
      rows = await this._deps.connection.query<JobRow>(
        'SELECT * FROM jobs WHERE schedule_id = $1 ORDER BY seq ASC',
        [opts.scheduleId],
      );
    } else if (limited) {
      rows = await this._deps.connection.query<JobRow>(
        `SELECT * FROM (
           SELECT * FROM jobs ORDER BY seq DESC LIMIT $1
         ) t ORDER BY seq ASC`,
        [limit],
      );
    } else {
      rows = await this._deps.connection.query<JobRow>('SELECT * FROM jobs ORDER BY seq ASC');
    }
    return rows.map(toJob);
  }

  /** Retention: удаляет записи старше `retentionDays` (по `startedAt`). */
  async prune(retentionDays: number): Promise<number> {
    const days = Number.isFinite(retentionDays) ? retentionDays : 0;
    const rows = await this._deps.connection.query<{ seq: string }>(
      `DELETE FROM jobs WHERE started_at < now() - interval '1 day' * $1::double precision RETURNING seq`,
      [days],
    );
    return rows.length;
  }
}

/** Собрать под-группу портов планировщика. */
export function buildEventSchedulerPorts(deps: PortDeps): EventSchedulerPorts {
  return {
    schedules: new PgScheduleRepository(deps),
    jobs: new PgJobRepository(deps),
  };
}
