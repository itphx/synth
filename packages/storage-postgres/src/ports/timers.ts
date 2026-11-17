/**
 * PG-реализация портов **таймеров/будильников** и **истории их срабатываний**
 * (PROP-141, Часть B; ADR-097 — драйвер слоя хранения).
 *
 * Таблицы `timers`/`timer_firings` (миграция 037): реестр автоматизаций
 * (привязка к проекту и сессии, режим повтора, статус, ближайшее
 * срабатывание) и append-only журнал срабатываний.
 *
 * Семантика повторяет файловые реализации core (`FileTimerStore`/
 * `FileTimerFiringStore`) и in-memory (`MemoryTimerRepository`):
 * - `list` — фильтры по «И», порядок **по ближайшему срабатыванию**
 *   (`fires_at` возраст., тайбрейкер `id`), постраничный срез;
 * - `listDue` — `status = 'active'` и `fires_at <= at`;
 * - `countActive` — счётчик активных таймеров сессии;
 * - `update`/`setStatus` — частичная правка, `updated_at` = now();
 * - `remove` идемпотентно, `removeBySession` — каскад по сессии;
 * - история срабатываний — порядок добавления (`seq`), `limit` — последние N,
 *   `prune` — записи **строго старше** отсечки.
 *
 * Драйвер не тянет core рантаймом (только `import type`), поэтому потолок
 * выборки и правила порядка повторены здесь локально — как в
 * `ports/background-runs.ts`.
 */

import { randomUUID } from 'node:crypto';
import type {
  StorageContext,
  TimerFiringRepository,
  TimerRepository,
} from '@itphx/synth-core';
import type {
  Timer,
  TimerCreateInput,
  TimerFiring,
  TimerFiringOutcome,
  TimerFilter,
  TimerKind,
  TimerPatch,
  TimerRepeat,
  TimerStatus,
} from '@itphx/synth-shared';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';
import { compact, toIso, toIsoRequired } from './events-core.js';

/** Часть `StorageContext`, которой владеет группа «таймеры». */
export type TimerPorts = Pick<StorageContext, 'timers' | 'timerFirings'>;

// ── Локальные реплики core-хелперов (core рантаймом не тянем) ────────────────

/** Дефолтный потолок выборки (паритет с core `COLLECTION_LIMIT_DEFAULT`). */
const LIST_DEFAULT_LIMIT = 100;
/** Абсолютный потолок выборки (паритет с core `COLLECTION_LIMIT_MAX`). */
const LIST_MAX_LIMIT = 1000;

/** Привести `limit` к допустимому виду: дефолт 100, потолок 1000. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), LIST_MAX_LIMIT);
}

/** Привести `offset` к допустимому виду: неотрицательное целое (иначе 0). */
function resolveOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}

/** Разобрать `repeat` из `jsonb` — объект с полем `mode`. */
function toTimerRepeat(value: unknown): TimerRepeat {
  const raw = (value ?? {}) as Partial<TimerRepeat> & { mode?: string };
  if (raw.mode === 'daily') {
    return { mode: 'daily', time: String(raw.time ?? ''), timezone: String(raw.timezone ?? '') };
  }
  if (raw.mode === 'every') return { mode: 'every', everySec: Number(raw.everySec ?? 0) };
  return { mode: 'once' };
}

// ────────────────────────────────────────────────────────────────────────────
// timers (PROP-141, Часть B)
// ────────────────────────────────────────────────────────────────────────────

/** Строка таблицы `timers`. */
type TimerRow = {
  id: string;
  kind: string;
  name: string | null;
  comment: string;
  project_id: string;
  session_id: string;
  owner_id: string;
  repeat: unknown;
  status: string;
  fires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  fired_at: Date | string | null;
  last_error: string | null;
};

/** Запись таймера из колонок. */
function toTimer(row: TimerRow): Timer {
  return compact({
    id: row.id,
    kind: row.kind as TimerKind,
    name: row.name ?? undefined,
    comment: row.comment,
    projectId: row.project_id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    repeat: toTimerRepeat(row.repeat),
    status: row.status as TimerStatus,
    firesAt: toIsoRequired(row.fires_at),
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
    firedAt: toIso(row.fired_at),
    lastError: row.last_error ?? undefined,
  }) as Timer;
}

/** Порт реестра таймеров поверх таблицы `timers`. */
export class PgTimerRepository implements TimerRepository {
  constructor(private readonly _deps: PortDeps) {}

  async list(filter?: TimerFilter): Promise<Timer[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter?.sessionId !== undefined) {
      params.push(filter.sessionId);
      where.push(`session_id = $${params.length}`);
    }
    if (filter?.projectId !== undefined) {
      params.push(filter.projectId);
      where.push(`project_id = $${params.length}`);
    }
    if (filter?.status !== undefined) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter?.kind !== undefined) {
      params.push(filter.kind);
      where.push(`kind = $${params.length}`);
    }
    // Порядок — по ближайшему срабатыванию (`fires_at` возраст., тайбрейкер `id`).
    params.push(resolveLimit(filter?.limit));
    const limitParam = params.length;
    params.push(resolveOffset(filter?.offset));
    const offsetParam = params.length;

    const sql =
      'SELECT * FROM timers' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY fires_at ASC, id ASC' +
      ` LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const rows = await this._deps.connection.query<TimerRow>(sql, params);
    return rows.map(toTimer);
  }

  async get(id: string): Promise<Timer | null> {
    const rows = await this._deps.connection.query<TimerRow>(
      'SELECT * FROM timers WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toTimer(rows[0]) : null;
  }

  async create(input: TimerCreateInput & { firesAt: string }): Promise<Timer> {
    const rows = await this._deps.connection.query<TimerRow>(
      `INSERT INTO timers
         (id, kind, name, comment, project_id, session_id, owner_id, repeat, status,
          fires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz,
               now()::timestamptz, now()::timestamptz)
       RETURNING *`,
      [
        `tmr_${randomUUID()}`,
        input.kind,
        input.name ?? null,
        input.comment,
        input.projectId,
        input.sessionId,
        input.ownerId,
        jsonbParam(input.repeat),
        input.status ?? 'active',
        input.firesAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('PG: не удалось создать таймер (пустой RETURNING)');
    return toTimer(row);
  }

  async update(id: string, patch: TimerPatch): Promise<Timer | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (patch.kind !== undefined) sets.push(`kind = ${push(patch.kind)}`);
    if (patch.comment !== undefined) sets.push(`comment = ${push(patch.comment)}`);
    if (patch.repeat !== undefined) sets.push(`repeat = ${push(jsonbParam(patch.repeat))}::jsonb`);
    if (patch.status !== undefined) sets.push(`status = ${push(patch.status)}`);
    if (patch.firesAt !== undefined) sets.push(`fires_at = ${push(patch.firesAt)}::timestamptz`);
    // `null` — сброс необязательного поля (`name`/`fired_at`/`last_error`).
    if (patch.name !== undefined) sets.push(`name = ${push(patch.name)}`);
    if (patch.firedAt !== undefined) sets.push(`fired_at = ${push(patch.firedAt)}`);
    if (patch.lastError !== undefined) sets.push(`last_error = ${push(patch.lastError)}`);
    sets.push('updated_at = now()::timestamptz');

    params.push(id);
    const rows = await this._deps.connection.query<TimerRow>(
      `UPDATE timers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return rows[0] ? toTimer(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM timers WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }

  async listDue(at: string): Promise<Timer[]> {
    const rows = await this._deps.connection.query<TimerRow>(
      `SELECT * FROM timers
        WHERE status = 'active' AND fires_at <= $1::timestamptz
        ORDER BY fires_at ASC, id ASC`,
      [at],
    );
    return rows.map(toTimer);
  }

  async countActive(sessionId: string): Promise<number> {
    const rows = await this._deps.connection.query<{ count: string | number }>(
      `SELECT COUNT(*)::bigint AS count FROM timers
        WHERE status = 'active' AND session_id = $1`,
      [sessionId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async setStatus(id: string, status: TimerStatus, patch?: TimerPatch): Promise<Timer | null> {
    return this.update(id, { ...(patch ?? {}), status });
  }

  async removeBySession(sessionId: string): Promise<number> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM timers WHERE session_id = $1 RETURNING id',
      [sessionId],
    );
    return rows.length;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// timerFirings (PROP-141, Часть B)
// ────────────────────────────────────────────────────────────────────────────

/** Строка таблицы `timer_firings`. */
type TimerFiringRow = {
  id: string;
  timer_id: string;
  fired_at: Date | string;
  scheduled_for: Date | string;
  lag_ms: string | number;
  outcome: string;
  session_id: string;
};

/** Запись срабатывания из колонок. */
function toTimerFiring(row: TimerFiringRow): TimerFiring {
  return {
    id: row.id,
    timerId: row.timer_id,
    firedAt: toIsoRequired(row.fired_at),
    scheduledFor: toIsoRequired(row.scheduled_for),
    lagMs: Number(row.lag_ms ?? 0),
    outcome: row.outcome as TimerFiringOutcome,
    sessionId: row.session_id,
  };
}

/** Порт истории срабатываний поверх таблицы `timer_firings`. */
export class PgTimerFiringRepository implements TimerFiringRepository {
  constructor(private readonly _deps: PortDeps) {}

  async append(firing: TimerFiring): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO timer_firings
         (id, timer_id, fired_at, scheduled_for, lag_ms, outcome, session_id)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        firing.id,
        firing.timerId,
        firing.firedAt,
        firing.scheduledFor,
        firing.lagMs,
        firing.outcome,
        firing.sessionId,
      ],
    );
  }

  async list(timerId: string, limit?: number): Promise<TimerFiring[]> {
    const bounded = limit !== undefined && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : undefined;
    // Порядок добавления (`seq`), как у Job-истории; `limit` — **последние N**
    // (как в файловой реализации: `slice(-limit)`).
    const rows = bounded === undefined
      ? await this._deps.connection.query<TimerFiringRow>(
          'SELECT * FROM timer_firings WHERE timer_id = $1 ORDER BY seq ASC',
          [timerId],
        )
      : await this._deps.connection.query<TimerFiringRow>(
          `SELECT * FROM (
             SELECT * FROM timer_firings WHERE timer_id = $1 ORDER BY seq DESC LIMIT $2
           ) t ORDER BY seq ASC`,
          [timerId, bounded],
        );
    return rows.map(toTimerFiring);
  }

  async prune(before: string): Promise<number> {
    const rows = await this._deps.connection.query<{ id: string }>(
      `DELETE FROM timer_firings
        WHERE fired_at < $1::timestamptz
        RETURNING id`,
      [before],
    );
    return rows.length;
  }
}

/** Собрать порты группы «таймеры» (PROP-141, Часть B). */
export function buildTimerPorts(deps: PortDeps): TimerPorts {
  return {
    timers: new PgTimerRepository(deps),
    timerFirings: new PgTimerFiringRepository(deps),
  };
}
