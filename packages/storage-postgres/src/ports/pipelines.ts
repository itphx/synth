/**
 * PG-реализация портов **движка пайплайнов** (ADR-101): спецификации
 * (черновик + опубликованные версии), прогоны и журнал выполнения.
 *
 * Таблицы (миграция 004): `pipeline_specs`, `pipeline_versions`, `pipeline_runs`,
 * `pipeline_run_events`.
 *
 * Семантика повторяет файловые реализации core (`FileProjectPipelineStore`,
 * `FilePipelineRunStore`):
 * - upsert по `id`: `created_at` не перезаписывается, `updated_at` монотонно
 *   не убывает (в SQL — `GREATEST` + сдвиг 1 мс, паритет с
 *   `record-timestamps.ts` core);
 * - список пайплайнов — по `id` asc, фильтры `scope`/`projectId` — по «И»;
 * - список прогонов — «свежие первыми» (`created_at` убыв., тайбрейкер `id`),
 *   фильтры — по «И», `limit` — дефолт 100 / потолок 1000;
 * - журнал событий — **append-only** (`seq bigserial`), чтение хронологическое
 *   (по `ts`, затем порядок добавления), `limit` — последние N;
 * - удаление пайплайна удаляет его версии, но **не** прогоны (прогон
 *   самодостаточен — несёт снимок спецификации).
 *
 * Драйвер не тянет core рантаймом (только `import type`), поэтому потолок
 * выборки и правило timestamps повторены здесь локально — как в
 * `ports/analytics.ts` (локальная точная реплика core-хелпера).
 */

import type {
  PipelineRecord,
  PipelineRunEventRecord,
  PipelineRunRecord,
  PipelineRunRepository,
  PipelineScope,
  PipelineVersionRecord,
  ProjectPipelineRepository,
  StorageContext,
} from '@itphx/synth-core';
import type { PipelineSpec } from '@itphx/synth-shared';
import { normalizeIconKey } from '@itphx/synth-shared';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';
import { compact, toIso, toIsoRequired } from './events-core.js';

/** Часть `StorageContext`, которой владеет группа `pipelines`. */
export type PipelinePorts = Pick<StorageContext, 'projectPipelines' | 'pipelineRuns'>;

// ── Локальные реплики core-хелперов (core рантаймом не тянем) ────────────────

/** Дефолтный потолок выборки прогонов (паритет с core `COLLECTION_LIMIT_DEFAULT`). */
const RUN_LIST_DEFAULT_LIMIT = 100;
/** Абсолютный потолок выборки прогонов (паритет с core `COLLECTION_LIMIT_MAX`). */
const RUN_LIST_MAX_LIMIT = 1000;

/** Привести `limit` к допустимому виду: дефолт 100, потолок 1000. */
function resolveRunLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return RUN_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), RUN_LIST_MAX_LIMIT);
}

/**
 * Выражение `updated_at` при upsert: максимум из «сейчас», входящего и
 * сохранённого значения; если максимум совпал с сохранённым — сдвиг на 1 мс
 * (паритет с `resolveUpdatedAt` в `record-timestamps.ts` core: метка не
 * откатывается и всегда наблюдаема).
 */
function updatedAtExpr(table: string): string {
  return `CASE
    WHEN GREATEST(EXCLUDED.updated_at, ${table}.updated_at, now()) <= ${table}.updated_at
      THEN ${table}.updated_at + interval '1 millisecond'
    ELSE GREATEST(EXCLUDED.updated_at, ${table}.updated_at, now())
  END`;
}

// ── projectPipelines ─────────────────────────────────────────────────────────

type PipelineSpecRow = {
  id: string;
  scope: string;
  project_id: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  draft: unknown;
  draft_version: number;
  published_version: number | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type PipelineVersionRow = {
  pipeline_id: string;
  version: number;
  spec: unknown;
  published_at: Date | string;
  published_by: string | null;
};

/** Запись пайплайна из колонок; ключ иконки нормализуется при чтении. */
function toPipeline(row: PipelineSpecRow): PipelineRecord {
  return compact({
    id: row.id,
    scope: row.scope as PipelineScope,
    projectId: row.project_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    icon: normalizeIconKey(row.icon),
    draft: (row.draft ?? undefined) as PipelineSpec | undefined,
    draftVersion: row.draft_version,
    publishedVersion: row.published_version ?? undefined,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  }) as PipelineRecord;
}

/** Запись опубликованной версии из колонок. */
function toPipelineVersion(row: PipelineVersionRow): PipelineVersionRecord {
  return compact({
    pipelineId: row.pipeline_id,
    version: row.version,
    spec: row.spec as PipelineSpec,
    publishedAt: toIsoRequired(row.published_at),
    publishedBy: row.published_by ?? undefined,
  }) as PipelineVersionRecord;
}

/**
 * ADR-101: спецификации пайплайнов поверх `pipeline_specs`/`pipeline_versions`.
 */
export class PgProjectPipelineRepository implements ProjectPipelineRepository {
  constructor(private readonly _deps: PortDeps) {}

  async savePipeline(rec: PipelineRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO pipeline_specs
         (id, scope, project_id, name, description, icon, draft, draft_version,
          published_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::timestamptz,
               GREATEST($11::timestamptz, now()))
       ON CONFLICT (id) DO UPDATE SET
         scope = EXCLUDED.scope,
         project_id = EXCLUDED.project_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         icon = EXCLUDED.icon,
         draft = EXCLUDED.draft,
         draft_version = EXCLUDED.draft_version,
         published_version = EXCLUDED.published_version,
         created_at = pipeline_specs.created_at,
         updated_at = ${updatedAtExpr('pipeline_specs')}`,
      [
        rec.id,
        rec.scope,
        rec.projectId ?? null,
        rec.name,
        rec.description ?? null,
        rec.icon ?? null,
        rec.draft !== undefined ? jsonbParam(rec.draft) : null,
        rec.draftVersion,
        rec.publishedVersion ?? null,
        rec.createdAt,
        rec.updatedAt,
      ],
    );
  }

  async getPipeline(id: string): Promise<PipelineRecord | null> {
    const rows = await this._deps.connection.query<PipelineSpecRow>(
      'SELECT * FROM pipeline_specs WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toPipeline(rows[0]) : null;
  }

  async listPipelines(filter?: {
    scope?: PipelineScope;
    projectId?: string;
  }): Promise<PipelineRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter?.scope !== undefined) {
      params.push(filter.scope);
      where.push(`scope = $${params.length}`);
    }
    if (filter?.projectId !== undefined) {
      params.push(filter.projectId);
      where.push(`project_id = $${params.length}`);
    }
    const sql =
      'SELECT * FROM pipeline_specs' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY id ASC';
    const rows = await this._deps.connection.query<PipelineSpecRow>(sql, params);
    return rows.map(toPipeline);
  }

  async deletePipeline(id: string): Promise<boolean> {
    return this._deps.connection.withTransaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        'DELETE FROM pipeline_specs WHERE id = $1 RETURNING id',
        [id],
      );
      if (rows.length === 0) return false;
      // Версии пайплайна удаляются каскадом; прогоны **не** трогаются — прогон
      // самодостаточен (несёт снимок спецификации).
      await tx.query('DELETE FROM pipeline_versions WHERE pipeline_id = $1', [id]);
      return true;
    });
  }

  async saveVersion(rec: PipelineVersionRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO pipeline_versions (pipeline_id, version, spec, published_at, published_by)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5)
       ON CONFLICT (pipeline_id, version) DO UPDATE SET
         spec = EXCLUDED.spec,
         published_at = EXCLUDED.published_at,
         published_by = EXCLUDED.published_by`,
      [
        rec.pipelineId,
        rec.version,
        jsonbParam(rec.spec),
        rec.publishedAt,
        rec.publishedBy ?? null,
      ],
    );
  }

  async getVersion(pipelineId: string, version: number): Promise<PipelineVersionRecord | null> {
    const rows = await this._deps.connection.query<PipelineVersionRow>(
      'SELECT * FROM pipeline_versions WHERE pipeline_id = $1 AND version = $2 LIMIT 1',
      [pipelineId, version],
    );
    return rows[0] ? toPipelineVersion(rows[0]) : null;
  }

  async listVersions(pipelineId: string): Promise<PipelineVersionRecord[]> {
    const rows = await this._deps.connection.query<PipelineVersionRow>(
      'SELECT * FROM pipeline_versions WHERE pipeline_id = $1 ORDER BY version ASC',
      [pipelineId],
    );
    return rows.map(toPipelineVersion);
  }
}

// ── pipelineRuns ──────────────────────────────────────────────────────────────

type PipelineRunRow = {
  id: string;
  pipeline_id: string;
  version: number;
  spec: unknown;
  project_id: string | null;
  status: string;
  current_node: string | null;
  trigger_data: unknown;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type PipelineRunEventRow = {
  seq: string;
  run_id: string;
  ts: Date | string;
  type: string;
  payload: unknown;
};

/** Запись прогона из колонок. */
function toRun(row: PipelineRunRow): PipelineRunRecord {
  return compact({
    id: row.id,
    pipelineId: row.pipeline_id,
    version: row.version,
    spec: row.spec as PipelineSpec,
    projectId: row.project_id ?? undefined,
    status: row.status as PipelineRunRecord['status'],
    currentNode: row.current_node ?? undefined,
    trigger: (row.trigger_data ?? undefined) as PipelineRunRecord['trigger'],
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    error: row.error ?? undefined,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  }) as PipelineRunRecord;
}

/** Событие прогона из колонок. */
function toRunEvent(row: PipelineRunEventRow): PipelineRunEventRecord {
  return compact({
    runId: row.run_id,
    ts: toIsoRequired(row.ts),
    type: row.type as PipelineRunEventRecord['type'],
    payload: (row.payload ?? undefined) as Record<string, unknown> | undefined,
  }) as PipelineRunEventRecord;
}

/**
 * ADR-101: прогоны пайплайнов и журнал выполнения поверх `pipeline_runs`/
 * `pipeline_run_events`.
 */
export class PgPipelineRunRepository implements PipelineRunRepository {
  constructor(private readonly _deps: PortDeps) {}

  async saveRun(rec: PipelineRunRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO pipeline_runs
         (id, pipeline_id, version, spec, project_id, status, current_node, trigger_data,
          started_at, finished_at, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9::timestamptz,
               $10::timestamptz, $11, $12::timestamptz, GREATEST($13::timestamptz, now()))
       ON CONFLICT (id) DO UPDATE SET
         pipeline_id = EXCLUDED.pipeline_id,
         version = EXCLUDED.version,
         spec = EXCLUDED.spec,
         project_id = EXCLUDED.project_id,
         status = EXCLUDED.status,
         current_node = EXCLUDED.current_node,
         trigger_data = EXCLUDED.trigger_data,
         started_at = EXCLUDED.started_at,
         finished_at = EXCLUDED.finished_at,
         error = EXCLUDED.error,
         created_at = pipeline_runs.created_at,
         updated_at = ${updatedAtExpr('pipeline_runs')}`,
      [
        rec.id,
        rec.pipelineId,
        rec.version,
        jsonbParam(rec.spec),
        rec.projectId ?? null,
        rec.status,
        rec.currentNode ?? null,
        rec.trigger !== undefined ? jsonbParam(rec.trigger) : null,
        rec.startedAt ?? null,
        rec.finishedAt ?? null,
        rec.error ?? null,
        rec.createdAt,
        rec.updatedAt,
      ],
    );
  }

  async getRun(id: string): Promise<PipelineRunRecord | null> {
    const rows = await this._deps.connection.query<PipelineRunRow>(
      'SELECT * FROM pipeline_runs WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listRuns(filter?: {
    pipelineId?: string;
    projectId?: string;
    status?: PipelineRunRecord['status'];
    limit?: number;
  }): Promise<PipelineRunRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter?.pipelineId !== undefined) {
      params.push(filter.pipelineId);
      where.push(`pipeline_id = $${params.length}`);
    }
    if (filter?.projectId !== undefined) {
      params.push(filter.projectId);
      where.push(`project_id = $${params.length}`);
    }
    if (filter?.status !== undefined) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    params.push(resolveRunLimit(filter?.limit));
    const sql =
      'SELECT * FROM pipeline_runs' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC, id ASC' +
      ` LIMIT $${params.length}`;
    const rows = await this._deps.connection.query<PipelineRunRow>(sql, params);
    return rows.map(toRun);
  }

  async appendEvent(ev: PipelineRunEventRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO pipeline_run_events (run_id, ts, type, payload)
       VALUES ($1, $2::timestamptz, $3, $4::jsonb)`,
      [ev.runId, ev.ts, ev.type, ev.payload !== undefined ? jsonbParam(ev.payload) : null],
    );
  }

  async listEvents(
    runId: string,
    opts?: { limit?: number },
  ): Promise<PipelineRunEventRecord[]> {
    const limit = opts?.limit;
    if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
      // Последние N по хронологии — в хронологическом порядке.
      const rows = await this._deps.connection.query<PipelineRunEventRow>(
        `SELECT * FROM (
           SELECT * FROM pipeline_run_events WHERE run_id = $1
            ORDER BY ts DESC, seq DESC LIMIT $2
         ) t ORDER BY ts ASC, seq ASC`,
        [runId, Math.floor(limit)],
      );
      return rows.map(toRunEvent);
    }
    const rows = await this._deps.connection.query<PipelineRunEventRow>(
      'SELECT * FROM pipeline_run_events WHERE run_id = $1 ORDER BY ts ASC, seq ASC',
      [runId],
    );
    return rows.map(toRunEvent);
  }
}

/** Собрать порты группы `pipelines` (ADR-101). */
export function buildPipelinePorts(deps: PortDeps): PipelinePorts {
  return {
    projectPipelines: new PgProjectPipelineRepository(deps),
    pipelineRuns: new PgPipelineRunRepository(deps),
  };
}
