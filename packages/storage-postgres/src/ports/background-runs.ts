/**
 * PG-реализация порта **единого реестра фоновых прогонов** (этап 1 roadmap 0.13
 * — блок 1.2, ADR-097; PROP-096 — фоновые саб-агенты, PROP-097 — фоновые
 * шелл-процессы).
 *
 * Таблица `background_runs` (миграция 021): вид, статус, владелец и параметры
 * прогона; `metadata` — `jsonb`; лог процесса — относительный путь в
 * BlobStore (`log_path`), сами логи остаются на диске (ФС-периметр вне портов,
 * ADR-091/ADR-092).
 *
 * Семантика повторяет файловые реализации core (`FileBackgroundRunStore`) и
 * in-memory (`MemoryBackgroundRunRepository`):
 * - upsert по `id`: `started_at` не перезаписывается, `updated_at` — метка
 *   вызывающего (драйвер не подставляет «сейчас» — иначе retention-очистка по
 *   метке записи теряла бы смысл);
 * - список — «свежие первыми» (`started_at` убыв., тайбрейкер `id`), фильтры —
 *   по «И»;
 * - `prune` — **только терминальные** статусы, метка которых строго старше
 *   отсечки (`updated_at < $2`); нетерминальный `running` не удаляется никогда.
 *
 * Драйвер не тянет core рантаймом (только `import type`), поэтому потолок
 * выборки повторён здесь локально — как в `ports/pipelines.ts`.
 */

import type { BackgroundRunRepository, StorageContext } from '@itphx/synth-core';
import type {
  BackgroundRunFilter,
  BackgroundRunKind,
  BackgroundRunRecord,
  BackgroundRunStatus,
} from '@itphx/synth-shared';
import { BACKGROUND_RUN_TERMINAL_STATUSES } from '@itphx/synth-shared';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';
import { compact, toIso, toIsoRequired } from './events-core.js';

/** Часть `StorageContext`, которой владеет группа «фоновые прогоны». */
export type BackgroundRunPorts = Pick<StorageContext, 'backgroundRuns'>;

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

/**
 * Статусы, которые можно чистить: только терминальные. Нетерминальные статусы
 * из аргумента игнорируются — `running` не удаляется никогда.
 */
function prunableStatuses(statuses?: BackgroundRunStatus[]): BackgroundRunStatus[] {
  if (statuses === undefined) return [...BACKGROUND_RUN_TERMINAL_STATUSES];
  return statuses.filter((status) => BACKGROUND_RUN_TERMINAL_STATUSES.includes(status));
}

// ────────────────────────────────────────────────────────────────────────────
// backgroundRuns (этап 1 roadmap 0.13, блок 1.2)
// ────────────────────────────────────────────────────────────────────────────

type BackgroundRunRow = {
  id: string;
  kind: string;
  status: string;
  session_id: string;
  project_id: string | null;
  child_session_id: string | null;
  agent_role: string | null;
  description: string | null;
  command: string | null;
  cwd: string | null;
  pid: number | null;
  log_path: string | null;
  exit_code: number | null;
  signal: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  updated_at: Date | string;
  summary: string | null;
  metadata: unknown;
};

/** Запись фонового прогона из колонок. */
function toBackgroundRun(row: BackgroundRunRow): BackgroundRunRecord {
  return compact({
    id: row.id,
    kind: row.kind as BackgroundRunKind,
    status: row.status as BackgroundRunStatus,
    sessionId: row.session_id,
    projectId: row.project_id ?? undefined,
    childSessionId: row.child_session_id ?? undefined,
    agentRole: row.agent_role ?? undefined,
    description: row.description ?? undefined,
    command: row.command ?? undefined,
    cwd: row.cwd ?? undefined,
    pid: row.pid ?? undefined,
    logPath: row.log_path ?? undefined,
    exitCode: row.exit_code ?? undefined,
    signal: row.signal ?? undefined,
    startedAt: toIsoRequired(row.started_at),
    finishedAt: toIso(row.finished_at),
    updatedAt: toIsoRequired(row.updated_at),
    summary: row.summary ?? undefined,
    metadata: (row.metadata ?? undefined) as Record<string, unknown> | undefined,
  }) as BackgroundRunRecord;
}

/** Порт реестра фоновых прогонов поверх таблицы `background_runs`. */
export class PgBackgroundRunRepository implements BackgroundRunRepository {
  constructor(private readonly _deps: PortDeps) {}

  async save(record: BackgroundRunRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO background_runs
         (id, kind, status, session_id, project_id, child_session_id, agent_role, description,
          command, cwd, pid, log_path, exit_code, signal, started_at, finished_at, updated_at,
          summary, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz,
               $16::timestamptz, $17::timestamptz, $18, $19::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         status = EXCLUDED.status,
         session_id = EXCLUDED.session_id,
         project_id = EXCLUDED.project_id,
         child_session_id = EXCLUDED.child_session_id,
         agent_role = EXCLUDED.agent_role,
         description = EXCLUDED.description,
         command = EXCLUDED.command,
         cwd = EXCLUDED.cwd,
         pid = EXCLUDED.pid,
         log_path = EXCLUDED.log_path,
         exit_code = EXCLUDED.exit_code,
         signal = EXCLUDED.signal,
         started_at = background_runs.started_at,
         finished_at = EXCLUDED.finished_at,
         updated_at = EXCLUDED.updated_at,
         summary = EXCLUDED.summary,
         metadata = EXCLUDED.metadata`,
      [
        record.id,
        record.kind,
        record.status,
        record.sessionId,
        record.projectId ?? null,
        record.childSessionId ?? null,
        record.agentRole ?? null,
        record.description ?? null,
        record.command ?? null,
        record.cwd ?? null,
        record.pid ?? null,
        record.logPath ?? null,
        record.exitCode ?? null,
        record.signal ?? null,
        record.startedAt,
        record.finishedAt ?? null,
        record.updatedAt,
        record.summary ?? null,
        record.metadata !== undefined ? jsonbParam(record.metadata) : null,
      ],
    );
  }

  async get(id: string): Promise<BackgroundRunRecord | null> {
    const rows = await this._deps.connection.query<BackgroundRunRow>(
      'SELECT * FROM background_runs WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toBackgroundRun(rows[0]) : null;
  }

  async list(filter?: BackgroundRunFilter): Promise<BackgroundRunRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter?.kind !== undefined) {
      params.push(filter.kind);
      where.push(`kind = $${params.length}`);
    }
    if (filter?.status !== undefined) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter?.sessionId !== undefined) {
      params.push(filter.sessionId);
      where.push(`session_id = $${params.length}`);
    }
    if (filter?.projectId !== undefined) {
      params.push(filter.projectId);
      where.push(`project_id = $${params.length}`);
    }
    params.push(resolveLimit(filter?.limit));
    const sql =
      'SELECT * FROM background_runs' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY started_at DESC, id ASC' +
      ` LIMIT $${params.length}`;
    const rows = await this._deps.connection.query<BackgroundRunRow>(sql, params);
    return rows.map(toBackgroundRun);
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM background_runs WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }

  async prune(before: string, statuses?: BackgroundRunStatus[]): Promise<number> {
    const allowed = prunableStatuses(statuses);
    // Пустой набор статусов — чистить нечего (нетерминальные игнорируются).
    if (allowed.length === 0) return 0;
    const rows = await this._deps.connection.query<{ id: string }>(
      `DELETE FROM background_runs
        WHERE status = ANY($1::text[]) AND updated_at < $2::timestamptz
        RETURNING id`,
      [allowed, before],
    );
    return rows.length;
  }
}

/** Собрать порты группы «фоновые прогоны» (этап 1 roadmap 0.13, блок 1.2). */
export function buildBackgroundRunPorts(deps: PortDeps): BackgroundRunPorts {
  return {
    backgroundRuns: new PgBackgroundRunRepository(deps),
  };
}
