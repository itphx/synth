/**
 * PG-реализация порта **legacy-пайплайнов** (ADR-051/ADR-100, ADR-116, ADR-097):
 * определения автомата и экземпляры прогонов.
 *
 * Не путать с `ports/pipelines.ts` (ADR-101 — движок пайплайнов проекта:
 * `pipeline_specs`/`pipeline_versions`/`pipeline_runs`/`pipeline_run_events`).
 * Здесь — реестр **инстанса** «декларация + учёт» (ADR-051/ADR-100), который
 * ставится пакетами расширений.
 *
 * Таблицы (миграция `025_packs_pipelines`): `pipeline_definitions`,
 * `pipeline_instances`.
 *
 * Семантика повторяет файловую реализацию core (`FilePipelineStore`) и
 * in-memory (`MemoryPipelineRepository`):
 * - upsert по `id`: `created_at` не перезаписывается, `updated_at` монотонно
 *   не убывает (в SQL — `GREATEST` + сдвиг 1 мс, паритет с
 *   `record-timestamps.ts` core);
 * - `listDefinitions` — детерминированный порядок (`ORDER BY id ASC`);
 * - `deleteDefinition` — `true`, если запись была удалена; экземпляры **не**
 *   трогаются (прогон самодостаточен, паритет с файловой реализацией);
 * - `listInstances` — «свежие первыми» (`created_at` убыв., тайбрейкер `id`),
 *   фильтры `pipelineId`/`status` — по «И», `limit` — дефолт 100 / потолок 1000.
 *
 * Драйвер не тянет core рантаймом (только `import type`), поэтому потолок
 * выборки повторён здесь локально — точная реплика
 * `resolvePipelineInstanceLimit` (`storage/ports/pipeline-repository.ts` core);
 * паритет значений зафиксирован контрактным suite (константы
 * `PIPELINE_INSTANCE_DEFAULT_LIMIT`/`PIPELINE_INSTANCE_MAX_LIMIT` проверяются
 * там же, а `limit`-сценарии — на этой реализации).
 */

import type {
  PipelineDefinitionRecord,
  PipelineInstanceFilter,
  PipelineInstanceRecord,
  PipelineRepository,
  StorageContext,
} from '@itphx/synth-core';
import type {
  PipelineErrorPolicy,
  PipelineStep,
  PipelineStepState,
  PipelineTrigger,
} from '@itphx/synth-shared';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';
import { compact, toIsoRequired } from './events-core.js';

/** Часть `StorageContext`, которой владеет группа «legacy-pipelines». */
export type LegacyPipelinePorts = Pick<StorageContext, 'pipelines'>;

// ── Локальные реплики core-хелперов (core рантаймом не тянем) ────────────────

/** Дефолтный потолок выборки экземпляров (паритет с core `PIPELINE_INSTANCE_DEFAULT_LIMIT`). */
const INSTANCE_LIST_DEFAULT_LIMIT = 100;
/** Абсолютный потолок выборки экземпляров (паритет с core `PIPELINE_INSTANCE_MAX_LIMIT`). */
const INSTANCE_LIST_MAX_LIMIT = 1000;

/** Привести `limit` к допустимому виду: дефолт 100, потолок 1000 (как в core). */
function resolveInstanceLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return INSTANCE_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), INSTANCE_LIST_MAX_LIMIT);
}

/**
 * Выражение `updated_at` при upsert: максимум из «сейчас», входящего и
 * сохранённого значения; если максимум совпал с сохранённым — сдвиг на 1 мс
 * (паритет с `resolveUpdatedAt` в `record-timestamps.ts` core).
 */
function updatedAtExpr(table: string): string {
  return `CASE
    WHEN GREATEST(EXCLUDED.updated_at, ${table}.updated_at, now()) <= ${table}.updated_at
      THEN ${table}.updated_at + interval '1 millisecond'
    ELSE GREATEST(EXCLUDED.updated_at, ${table}.updated_at, now())
  END`;
}

// ── Определения ─────────────────────────────────────────────────────────────

type DefinitionRow = {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
  steps: unknown;
  on_error: string | null;
  max_attempts: number | null;
  ttl: string | null;
  installed_by: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

/** Определение из колонок; скалярные поля — колонки, шаги — `jsonb`. */
function toDefinition(row: DefinitionRow): PipelineDefinitionRecord {
  return compact({
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    version: row.version ?? undefined,
    steps: (row.steps ?? []) as PipelineStep[],
    onError: (row.on_error ?? undefined) as PipelineErrorPolicy | undefined,
    maxAttempts: row.max_attempts ?? undefined,
    ttl: row.ttl ?? undefined,
    // Провенанс установки (ADR-086 §5): `{pack, version}` либо отсутствует.
    installedBy: (row.installed_by ?? undefined) as
      | PipelineDefinitionRecord['installedBy']
      | undefined,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  }) as PipelineDefinitionRecord;
}

// ── Экземпляры ──────────────────────────────────────────────────────────────

type InstanceRow = {
  id: string;
  pipeline_id: string;
  pipeline_version: string | null;
  status: string;
  steps: unknown;
  current_step: string | null;
  trigger: unknown;
  attempts: number;
  payload: unknown;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

/** Экземпляр из колонок: `steps`/`trigger`/`payload` — `jsonb`. */
function toInstance(row: InstanceRow): PipelineInstanceRecord {
  return compact({
    id: row.id,
    pipelineId: row.pipeline_id,
    pipelineVersion: row.pipeline_version ?? undefined,
    status: row.status as PipelineInstanceRecord['status'],
    steps: (row.steps ?? []) as PipelineStepState[],
    currentStep: row.current_step ?? undefined,
    trigger: (row.trigger ?? undefined) as PipelineTrigger | undefined,
    attempts: row.attempts,
    payload: (row.payload ?? undefined) as Record<string, unknown> | undefined,
    error: row.error ?? undefined,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  }) as PipelineInstanceRecord;
}

/**
 * ADR-051/ADR-100: реестр определений и экземпляров пайплайнов инстанса.
 */
export class PgPipelineRepository implements PipelineRepository {
  constructor(private readonly _deps: PortDeps) {}

  async saveDefinition(def: PipelineDefinitionRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO pipeline_definitions
         (id, name, description, version, steps, on_error, max_attempts, ttl,
          installed_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::timestamptz,
               GREATEST($11::timestamptz, now()))
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         version = EXCLUDED.version,
         steps = EXCLUDED.steps,
         on_error = EXCLUDED.on_error,
         max_attempts = EXCLUDED.max_attempts,
         ttl = EXCLUDED.ttl,
         installed_by = EXCLUDED.installed_by,
         created_at = pipeline_definitions.created_at,
         updated_at = ${updatedAtExpr('pipeline_definitions')}`,
      [
        def.id,
        def.name,
        def.description ?? null,
        def.version ?? null,
        jsonbParam(def.steps),
        def.onError ?? null,
        def.maxAttempts ?? null,
        def.ttl ?? null,
        def.installedBy !== undefined ? jsonbParam(def.installedBy) : null,
        def.createdAt,
        def.updatedAt,
      ],
    );
  }

  async getDefinition(id: string): Promise<PipelineDefinitionRecord | null> {
    const rows = await this._deps.connection.query<DefinitionRow>(
      'SELECT * FROM pipeline_definitions WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toDefinition(rows[0]) : null;
  }

  async listDefinitions(): Promise<PipelineDefinitionRecord[]> {
    const rows = await this._deps.connection.query<DefinitionRow>(
      'SELECT * FROM pipeline_definitions ORDER BY id ASC',
    );
    return rows.map(toDefinition);
  }

  async deleteDefinition(id: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM pipeline_definitions WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }

  async saveInstance(instance: PipelineInstanceRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO pipeline_instances
         (id, pipeline_id, pipeline_version, status, steps, current_step, trigger,
          attempts, payload, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9::jsonb, $10,
               $11::timestamptz, GREATEST($12::timestamptz, now()))
       ON CONFLICT (id) DO UPDATE SET
         pipeline_id = EXCLUDED.pipeline_id,
         pipeline_version = EXCLUDED.pipeline_version,
         status = EXCLUDED.status,
         steps = EXCLUDED.steps,
         current_step = EXCLUDED.current_step,
         trigger = EXCLUDED.trigger,
         attempts = EXCLUDED.attempts,
         payload = EXCLUDED.payload,
         error = EXCLUDED.error,
         created_at = pipeline_instances.created_at,
         updated_at = ${updatedAtExpr('pipeline_instances')}`,
      [
        instance.id,
        instance.pipelineId,
        instance.pipelineVersion ?? null,
        instance.status,
        jsonbParam(instance.steps),
        instance.currentStep ?? null,
        instance.trigger !== undefined ? jsonbParam(instance.trigger) : null,
        instance.attempts,
        instance.payload !== undefined ? jsonbParam(instance.payload) : null,
        instance.error ?? null,
        instance.createdAt,
        instance.updatedAt,
      ],
    );
  }

  async getInstance(id: string): Promise<PipelineInstanceRecord | null> {
    const rows = await this._deps.connection.query<InstanceRow>(
      'SELECT * FROM pipeline_instances WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toInstance(rows[0]) : null;
  }

  async listInstances(filter?: PipelineInstanceFilter): Promise<PipelineInstanceRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter?.pipelineId !== undefined) {
      params.push(filter.pipelineId);
      where.push(`pipeline_id = $${params.length}`);
    }
    if (filter?.status !== undefined) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    params.push(resolveInstanceLimit(filter?.limit));
    const sql =
      'SELECT * FROM pipeline_instances' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC, id ASC' +
      ` LIMIT $${params.length}`;
    const rows = await this._deps.connection.query<InstanceRow>(sql, params);
    return rows.map(toInstance);
  }
}

/** Собрать порт legacy-пайплайнов (ADR-051/ADR-100). */
export function buildLegacyPipelinePorts(deps: PortDeps): LegacyPipelinePorts {
  return {
    pipelines: new PgPipelineRepository(deps),
  };
}
