/**
 * PG-реализация портов **памяти**: факты, индексы и чанки (PROP-047 §2.1
 * «предпосылка A», ADR-097).
 *
 * Таблицы (миграция 017): `memory_facts`, `memory_indexes`, `memory_chunks`.
 *
 * Семантика повторяет файловые реализации core (`FileMemoryFactStore`,
 * `FileMemoryIndexStore`) и in-memory (`MemoryFactRepository`/
 * `MemoryIndexRepository`):
 * - upsert по `id`: `created_at` не перезаписывается, `updated_at` монотонно
 *   не убывает (в SQL — `GREATEST` + сдвиг 1 мс, паритет с
 *   `record-timestamps.ts` core);
 * - список — «свежие первыми» (`created_at` убыв., тайбрейкер `id`), фильтры —
 *   по «И», `limit` — дефолт 100 / потолок 1000, `offset` — пропуск;
 * - `supersede` — **идемпотентно**: статус `superseded` + `superseded_by`;
 * - `replaceChunks` — **атомарная замена поколения** в транзакции: чанки
 *   поколения удаляются и пишутся заново, другие поколения не трогаются;
 *   `indexId`/`generation` чанка приводятся к аргументам метода (идентичность
 *   поколения задаёт вызывающий — так поведение одинаково на всех backend'ах);
 * - `deleteIndex` — **каскад** (чанки удаляются вместе с индексом).
 *
 * Векторы хранятся в `jsonb` (не `pgvector`: расширение в БД не установлено,
 * `CREATE EXTENSION` требует прав администратора — миграция должна проходить на
 * «голой» БД). ANN-поиск в порт не входит — retrieval в плагине (PROP-047 §3).
 *
 * Драйвер не тянет core рантаймом (только `import type`), поэтому потолок
 * выборки и правило timestamps повторены здесь локально — как в
 * `ports/pipelines.ts`.
 */

import type {
  MemoryChunkRecord,
  MemoryFactQuery,
  MemoryFactRecord,
  MemoryFactRepository,
  MemoryFactStatus,
  MemoryIndexQuery,
  MemoryIndexRecord,
  MemoryIndexRepository,
  MemoryIndexState,
  StorageContext,
} from '@itphx/synth-core';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';
import { compact, toIso, toIsoRequired } from './events-core.js';

// ── Локальные реплики core-хелперов (core не тянется рантаймом) ──────────────

/** Дефолтный потолок выборки (паритет с core `COLLECTION_LIMIT_DEFAULT`). */
const LIST_DEFAULT_LIMIT = 100;
/** Абсолютный потолок выборки (паритет с core `COLLECTION_LIMIT_MAX`). */
const LIST_MAX_LIMIT = 1000;

/** Привести `limit` к допустимому виду: дефолт 100, потолок 1000. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), LIST_MAX_LIMIT);
}

/** Смещение пагинации: неотрицательное целое (по умолчанию — 0). */
function resolveOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
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

/**
 * То же выражение для `UPDATE` (без `EXCLUDED`): параметр — новое значение
 * `updated_at`.
 */
function updatedAtUpdateExpr(table: string, param: string): string {
  return `CASE
    WHEN GREATEST(${param}::timestamptz, ${table}.updated_at, now()) <= ${table}.updated_at
      THEN ${table}.updated_at + interval '1 millisecond'
    ELSE GREATEST(${param}::timestamptz, ${table}.updated_at, now())
  END`;
}

/** Статусы факта как список (для фильтра-«И»). */
function statusList(status: MemoryFactQuery['status']): readonly MemoryFactStatus[] | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? (status as readonly MemoryFactStatus[]) : [status as MemoryFactStatus];
}

/** Состояния индекса как список (для фильтра-«И»). */
function stateList(state: MemoryIndexQuery['state']): readonly MemoryIndexState[] | undefined {
  if (state === undefined) return undefined;
  return Array.isArray(state) ? (state as readonly MemoryIndexState[]) : [state as MemoryIndexState];
}

// ────────────────────────────────────────────────────────────────────────────
// memoryFacts (PROP-047)
// ────────────────────────────────────────────────────────────────────────────

type MemoryFactRow = {
  id: string;
  namespace: string;
  version: number;
  text: string;
  kind: string;
  project_id: string | null;
  user_id: string | null;
  provenance: unknown;
  confidence: number;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  valid_until: Date | string | null;
  superseded_by: string | null;
  revisions: unknown;
  metadata: unknown;
};

/** Запись факта из колонок. */
function toFact(row: MemoryFactRow): MemoryFactRecord {
  return compact({
    id: row.id,
    namespace: row.namespace,
    version: row.version,
    text: row.text,
    kind: row.kind,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    provenance: row.provenance as MemoryFactRecord['provenance'],
    confidence: row.confidence,
    status: row.status as MemoryFactStatus,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
    validUntil: toIso(row.valid_until),
    supersededBy: row.superseded_by ?? undefined,
    revisions: (row.revisions ?? undefined) as MemoryFactRecord['revisions'],
    metadata: (row.metadata ?? undefined) as Record<string, unknown> | undefined,
  }) as MemoryFactRecord;
}

/** Порт фактов памяти поверх таблицы `memory_facts`. */
export class PgMemoryFactRepository implements MemoryFactRepository {
  constructor(private readonly _deps: PortDeps) {}

  async save(fact: MemoryFactRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO memory_facts
         (id, namespace, version, text, kind, project_id, user_id, provenance,
          confidence, status, created_at, updated_at, valid_until, superseded_by,
          revisions, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::timestamptz,
               $12::timestamptz, $13::timestamptz, $14, $15::jsonb, $16::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         namespace = EXCLUDED.namespace,
         version = EXCLUDED.version,
         text = EXCLUDED.text,
         kind = EXCLUDED.kind,
         project_id = EXCLUDED.project_id,
         user_id = EXCLUDED.user_id,
         provenance = EXCLUDED.provenance,
         confidence = EXCLUDED.confidence,
         status = EXCLUDED.status,
         created_at = memory_facts.created_at,
         updated_at = ${updatedAtExpr('memory_facts')},
         valid_until = EXCLUDED.valid_until,
         superseded_by = EXCLUDED.superseded_by,
         revisions = EXCLUDED.revisions,
         metadata = EXCLUDED.metadata`,
      [
        fact.id,
        fact.namespace,
        fact.version,
        fact.text,
        fact.kind,
        fact.projectId ?? null,
        fact.userId ?? null,
        jsonbParam(fact.provenance),
        fact.confidence,
        fact.status,
        fact.createdAt,
        fact.updatedAt,
        fact.validUntil ?? null,
        fact.supersededBy ?? null,
        jsonbParam(fact.revisions),
        jsonbParam(fact.metadata),
      ],
    );
  }

  async get(id: string): Promise<MemoryFactRecord | null> {
    const rows = await this._deps.connection.query<MemoryFactRow>(
      'SELECT * FROM memory_facts WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toFact(rows[0]) : null;
  }

  async list(query?: MemoryFactQuery): Promise<MemoryFactRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query?.namespace !== undefined) {
      params.push(query.namespace);
      where.push(`namespace = $${params.length}`);
    }
    if (query?.projectId !== undefined) {
      params.push(query.projectId);
      where.push(`project_id = $${params.length}`);
    }
    if (query?.userId !== undefined) {
      params.push(query.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (query?.kind !== undefined) {
      params.push(query.kind);
      where.push(`kind = $${params.length}`);
    }
    const statuses = statusList(query?.status);
    if (statuses !== undefined) {
      params.push(statuses as unknown as string[]);
      where.push(`status = ANY($${params.length}::text[])`);
    }
    params.push(resolveLimit(query?.limit));
    const limitParam = params.length;
    params.push(resolveOffset(query?.offset));
    const offsetParam = params.length;

    const sql =
      'SELECT * FROM memory_facts' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC, id ASC' +
      ` LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const rows = await this._deps.connection.query<MemoryFactRow>(sql, params);
    return rows.map(toFact);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM memory_facts WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }

  async supersede(id: string, nextId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const rows = await this._deps.connection.query<{ id: string }>(
      `UPDATE memory_facts
          SET status = 'superseded',
              superseded_by = $2,
              updated_at = ${updatedAtUpdateExpr('memory_facts', '$3')}
        WHERE id = $1
        RETURNING id`,
      [id, nextId, now],
    );
    return rows.length > 0;
  }

  async count(query?: MemoryFactQuery): Promise<number> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query?.namespace !== undefined) {
      params.push(query.namespace);
      where.push(`namespace = $${params.length}`);
    }
    if (query?.projectId !== undefined) {
      params.push(query.projectId);
      where.push(`project_id = $${params.length}`);
    }
    if (query?.userId !== undefined) {
      params.push(query.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (query?.kind !== undefined) {
      params.push(query.kind);
      where.push(`kind = $${params.length}`);
    }
    const statuses = statusList(query?.status);
    if (statuses !== undefined) {
      params.push(statuses as unknown as string[]);
      where.push(`status = ANY($${params.length}::text[])`);
    }
    const sql =
      'SELECT count(*)::int AS n FROM memory_facts' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '');
    const rows = await this._deps.connection.query<{ n: number }>(sql, params);
    return rows[0]?.n ?? 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// memoryIndexes (PROP-047)
// ────────────────────────────────────────────────────────────────────────────

type MemoryIndexRow = {
  id: string;
  namespace: string;
  name: string;
  provider_id: string;
  project_id: string | null;
  source: unknown;
  state: string;
  generation: number;
  fingerprint: unknown;
  stats: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  error: string | null;
};

type MemoryChunkRow = {
  index_id: string;
  generation: number;
  id: string;
  document_id: string;
  ordinal: number;
  text: string;
  vector: unknown;
  embedding_input_hash: string | null;
  metadata: unknown;
};

/** Запись индекса из колонок. */
function toIndex(row: MemoryIndexRow): MemoryIndexRecord {
  return compact({
    id: row.id,
    namespace: row.namespace,
    name: row.name,
    providerId: row.provider_id,
    projectId: row.project_id ?? undefined,
    source: row.source as MemoryIndexRecord['source'],
    state: row.state as MemoryIndexState,
    generation: row.generation,
    fingerprint: row.fingerprint as MemoryIndexRecord['fingerprint'],
    stats: row.stats as MemoryIndexRecord['stats'],
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
    error: row.error ?? undefined,
  }) as MemoryIndexRecord;
}

/** Запись чанка из колонок. */
function toChunk(row: MemoryChunkRow): MemoryChunkRecord {
  return compact({
    indexId: row.index_id,
    generation: row.generation,
    id: row.id,
    documentId: row.document_id,
    ordinal: row.ordinal,
    text: row.text,
    vector: (row.vector ?? undefined) as number[] | undefined,
    embeddingInputHash: row.embedding_input_hash ?? undefined,
    metadata: (row.metadata ?? undefined) as Record<string, unknown> | undefined,
  }) as MemoryChunkRecord;
}

/** Порт индексов памяти и их чанков поверх `memory_indexes`/`memory_chunks`. */
export class PgMemoryIndexRepository implements MemoryIndexRepository {
  constructor(private readonly _deps: PortDeps) {}

  async saveIndex(index: MemoryIndexRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO memory_indexes
         (id, namespace, name, provider_id, project_id, source, state, generation,
          fingerprint, stats, created_at, updated_at, error)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb,
               $11::timestamptz, $12::timestamptz, $13)
       ON CONFLICT (id) DO UPDATE SET
         namespace = EXCLUDED.namespace,
         name = EXCLUDED.name,
         provider_id = EXCLUDED.provider_id,
         project_id = EXCLUDED.project_id,
         source = EXCLUDED.source,
         state = EXCLUDED.state,
         generation = EXCLUDED.generation,
         fingerprint = EXCLUDED.fingerprint,
         stats = EXCLUDED.stats,
         created_at = memory_indexes.created_at,
         updated_at = ${updatedAtExpr('memory_indexes')},
         error = EXCLUDED.error`,
      [
        index.id,
        index.namespace,
        index.name,
        index.providerId,
        index.projectId ?? null,
        jsonbParam(index.source),
        index.state,
        index.generation,
        jsonbParam(index.fingerprint),
        jsonbParam(index.stats),
        index.createdAt,
        index.updatedAt,
        index.error ?? null,
      ],
    );
  }

  async getIndex(id: string): Promise<MemoryIndexRecord | null> {
    const rows = await this._deps.connection.query<MemoryIndexRow>(
      'SELECT * FROM memory_indexes WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toIndex(rows[0]) : null;
  }

  async listIndexes(query?: MemoryIndexQuery): Promise<MemoryIndexRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query?.namespace !== undefined) {
      params.push(query.namespace);
      where.push(`namespace = $${params.length}`);
    }
    if (query?.projectId !== undefined) {
      params.push(query.projectId);
      where.push(`project_id = $${params.length}`);
    }
    if (query?.providerId !== undefined) {
      params.push(query.providerId);
      where.push(`provider_id = $${params.length}`);
    }
    const states = stateList(query?.state);
    if (states !== undefined) {
      params.push(states as unknown as string[]);
      where.push(`state = ANY($${params.length}::text[])`);
    }
    params.push(resolveLimit(query?.limit));
    const limitParam = params.length;
    params.push(resolveOffset(query?.offset));
    const offsetParam = params.length;

    const sql =
      'SELECT * FROM memory_indexes' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC, id ASC' +
      ` LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const rows = await this._deps.connection.query<MemoryIndexRow>(sql, params);
    return rows.map(toIndex);
  }

  async deleteIndex(id: string): Promise<boolean> {
    return this._deps.connection.withTransaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        'DELETE FROM memory_indexes WHERE id = $1 RETURNING id',
        [id],
      );
      if (rows.length === 0) return false;
      // Чанки индекса удаляются каскадом (все поколения).
      await tx.query('DELETE FROM memory_chunks WHERE index_id = $1', [id]);
      return true;
    });
  }

  async setState(id: string, state: MemoryIndexState, error?: string): Promise<boolean> {
    const now = new Date().toISOString();
    const rows = await this._deps.connection.query<{ id: string }>(
      `UPDATE memory_indexes
          SET state = $2,
              error = $3,
              updated_at = ${updatedAtUpdateExpr('memory_indexes', '$4')}
        WHERE id = $1
        RETURNING id`,
      [id, state, error ?? null, now],
    );
    return rows.length > 0;
  }

  async replaceChunks(
    indexId: string,
    generation: number,
    chunks: readonly MemoryChunkRecord[],
  ): Promise<number> {
    if (chunks.length === 0) {
      // Пустое поколение — тоже замена: старые чанки поколения удаляются.
      await this._deps.connection.query(
        'DELETE FROM memory_chunks WHERE index_id = $1 AND generation = $2',
        [indexId, generation],
      );
      return 0;
    }
    return this._deps.connection.withTransaction(async (tx) => {
      // Атомарная замена поколения: старые чанки поколения удаляются, новые
      // пишутся в той же транзакции; другие поколения не трогаются.
      await tx.query('DELETE FROM memory_chunks WHERE index_id = $1 AND generation = $2', [
        indexId,
        generation,
      ]);
      for (const batch of chunkBatches(chunks)) {
        const values: string[] = [];
        const params: unknown[] = [];
        for (const chunk of batch) {
          const base = params.length;
          values.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
              `$${base + 6}, $${base + 7}::jsonb, $${base + 8}, $${base + 9}::jsonb)`,
          );
          params.push(
            indexId,
            generation,
            chunk.id,
            chunk.documentId,
            chunk.ordinal,
            chunk.text,
            jsonbParam(chunk.vector),
            chunk.embeddingInputHash ?? null,
            jsonbParam(chunk.metadata),
          );
        }
        await tx.query(
          `INSERT INTO memory_chunks
             (index_id, generation, id, document_id, ordinal, text, vector,
              embedding_input_hash, metadata)
           VALUES ${values.join(', ')}`,
          params,
        );
      }
      return chunks.length;
    });
  }

  async listChunks(
    indexId: string,
    opts?: { generation?: number; documentId?: string; limit?: number; offset?: number },
  ): Promise<MemoryChunkRecord[]> {
    const params: unknown[] = [indexId];
    const where: string[] = ['index_id = $1'];
    if (opts?.generation !== undefined) {
      params.push(opts.generation);
      where.push(`generation = $${params.length}`);
    }
    if (opts?.documentId !== undefined) {
      params.push(opts.documentId);
      where.push(`document_id = $${params.length}`);
    }
    params.push(resolveLimit(opts?.limit));
    const limitParam = params.length;
    params.push(resolveOffset(opts?.offset));
    const offsetParam = params.length;

    const sql =
      'SELECT * FROM memory_chunks' +
      ` WHERE ${where.join(' AND ')}` +
      ' ORDER BY generation ASC, document_id ASC, ordinal ASC, id ASC' +
      ` LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const rows = await this._deps.connection.query<MemoryChunkRow>(sql, params);
    return rows.map(toChunk);
  }

  async deleteChunks(indexId: string, generation?: number): Promise<number> {
    const params: unknown[] = [indexId];
    let sql = 'DELETE FROM memory_chunks WHERE index_id = $1';
    if (generation !== undefined) {
      params.push(generation);
      sql += ' AND generation = $2';
    }
    const rows = await this._deps.connection.query<{ id: string }>(`${sql} RETURNING id`, params);
    return rows.length;
  }

  async countChunks(indexId: string, generation?: number): Promise<number> {
    const params: unknown[] = [indexId];
    let sql = 'SELECT count(*)::int AS n FROM memory_chunks WHERE index_id = $1';
    if (generation !== undefined) {
      params.push(generation);
      sql += ' AND generation = $2';
    }
    const rows = await this._deps.connection.query<{ n: number }>(sql, params);
    return rows[0]?.n ?? 0;
  }
}

/**
 * Разбить чанки на партии для multi-row INSERT: один запрос — одна транзакция,
 * но не больше параметров, чем PostgreSQL допускает (65535).
 */
function chunkBatches(chunks: readonly MemoryChunkRecord[]): MemoryChunkRecord[][] {
  const MAX_ROWS = 500;
  const batches: MemoryChunkRecord[][] = [];
  for (let i = 0; i < chunks.length; i += MAX_ROWS) {
    batches.push(chunks.slice(i, i + MAX_ROWS));
  }
  return batches;
}

/** Часть `StorageContext`, которой владеет группа портов памяти. */
export type MemoryPorts = Pick<StorageContext, 'memoryFacts' | 'memoryIndexes'>;

/** Собрать порты памяти (PROP-047 §2.1, ADR-096). */
export function buildMemoryPorts(deps: PortDeps): MemoryPorts {
  return {
    memoryFacts: new PgMemoryFactRepository(deps),
    memoryIndexes: new PgMemoryIndexRepository(deps),
  };
}
