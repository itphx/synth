/**
 * Порт `SessionRepository` поверх PostgreSQL (PROP-032, волна 3b).
 *
 * Группа портов **сессий** PostgreSQL-драйвера: единственная фабрика
 * `buildSessionPorts(deps)` собирает `StorageContext['sessions']`.
 *
 * Семантика — паритет с файловой (`FileStore`) и in-memory
 * (`MemorySessionRepository`) реализациями:
 *   - `save` — **одна транзакция**: upsert строки `sessions` + **полная замена**
 *     child-таблиц (`messages`/`session_references`/`checkpoints`/`sticky_notes`):
 *     `DELETE … WHERE session_id` + массовый `INSERT` (по чанкам);
 *   - `appendMessage`/`updateMessage` — **точечные** операции над одной строкой
 *     `messages` в транзакции под тем же per-session advisory-локом, без
 *     перезаписи истории: append берёт `seq = MAX(seq)+1`, update целится по
 *     `seq` (fallback — `id`) и не меняет `id`/`seq`/`created_at`; обе операции
 *     обновляют `sessions.updated_at`;
 *   - `seq` сообщений — **позиционный**: при записи драйвер нормализует его по
 *     порядку массива `1..n`. Это снимает legacy-коллизию `UNIQUE (session_id, seq)`
 *     (у старых сессий у всех сообщений `seq = 0`) и делает порядок однозначным;
 *     домен и так переставляет `seq = i+1` при ветвлении/merge — приведение к
 *     позиции смысла не меняет;
 *   - `id` сообщения **не уникален** в пределах сессии (legacy-дубликаты):
 *     PK `messages` — суррогатный `message_uid`, поэтому дубликаты `id`
 *     сохраняются без потерь (upsert по `id` их молча схлопывал);
 *   - per-session сериализация записи — транзакционный `pg_advisory_xact_lock`
 *     (держится до `COMMIT`; аналог per-session `AsyncLock` файловой реализации);
 *   - чтения (`load`/`list`/`listForUser`/`listForUserScope`/`search`) отдают
 *     **полную** `Session`; сообщения/child-строки подгружаются **батчем**
 *     (`WHERE session_id = ANY($1)`, без N+1); порядок сообщений — по `seq` с
 *     тайбрейкером `created_at`, затем `id` (детерминированное чтение);
 *   - `listLight` — метаданные без истории (`messages`/`pendingMessages`/
 *     `checkpoints` пусты, child-таблицы не читаются): одна выборка из `sessions`
 *     тем же `WHERE`/порядком, что у `list`; `loadLight` — та же проекция по
 *     одному id (одна выборка по PK);
 *   - `list`/`listForUser*` сортируют `updated_at DESC`; архивированные сессии
 *     **не** отфильтровываются — это ответственность менеджера
 *     (`SessionManager.listSessions`, как и у файловой/memory реализаций);
 *   - `delete` отсутствующей — не ошибка; `load` отсутствующей → `null`;
 *     `list` пустого → `[]`; `addReference`/`removeReference` отсутствующей
 *     сессии → `throw`; `getReferences` отсутствующей → `[]`.
 *
 * `search` — подстрока без учёта регистра (`ILIKE`) по `title` и `content`
 * сообщений; индекс `messages_content_trgm_idx` (`pg_trgm`) уже заведён в
 * `001_init`. Символы `%`/`_`/`\` экранируются — семантика «подстрока», как у
 * `includes` файловой/memory реализаций.
 */

import type { PostgresConnection, PostgresExecutor } from '../pool.js';
import { jsonbParam } from '../json-param.js';
import type { Message, Session, SessionReference } from '@itphx/synth-shared';
import { generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { SessionFilter, SessionRepository, StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import {
  checkpointRow,
  deserializeMessage,
  deserializeReference,
  deserializeSession,
  deserializeSessionLight,
  emptySessionChildren,
  messageRow,
  referenceRow,
  serializeSession,
  stickyNoteRow,
  type CheckpointRow,
  type MessageRow,
  type SessionChildren,
  type SessionReferenceRow,
  type SessionRow,
  type StickyNoteRow,
} from './sessions-mapping.js';

/** Часть `StorageContext`, которой владеет группа `sessions`. */
export type SessionPorts = Pick<StorageContext, 'sessions'>;

/** Колонки `sessions` (порядок — как в `001_init`). */
const SESSION_FIELDS = [
  'id',
  'title',
  'icon',
  'color',
  'session_origin',
  'parent_id',
  'branch_point',
  'plan_approved',
  'mode',
  'user_id',
  'owner_id',
  'project_id',
  'todos',
  'prompt_states',
  'obfuscation_map',
  'status',
  'settings',
  'mcp_servers',
  'pending_messages',
  'current_stream',
  'summarization_pending',
  'can_summarize',
  'created_at',
  'updated_at',
  'expires_at',
  'archived_at',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_write_cost',
  'cache_hit_rate',
] as const;

const SESSION_JSON_FIELDS: ReadonlySet<string> = new Set([
  'todos',
  'prompt_states',
  'obfuscation_map',
  'status',
  'settings',
  'mcp_servers',
  'pending_messages',
  'current_stream',
]);

/** Колонки `messages` (порядок — как в `001_init`). */
const MESSAGE_FIELDS = [
  'id',
  'session_id',
  'seq',
  'role',
  'origin',
  'source_msg_id',
  'content',
  'parts',
  'tool_calls',
  'tool_call_id',
  'usage',
  'metadata',
  'prompt_meta',
  'debug_data',
  'summary_of',
  'model',
  'provider',
  'provider_type',
  'reasoning',
  'source',
  'author',
  'agent_role',
  'qa_pass',
  'qa_reason',
  'disabled',
  'pinned',
  'hidden',
  'ephemeral',
  'created_at',
] as const;

const MESSAGE_JSON_FIELDS: ReadonlySet<string> = new Set([
  'parts',
  'tool_calls',
  'usage',
  'metadata',
  'prompt_meta',
  'debug_data',
  'summary_of',
]);

/**
 * Колонки `messages`, которые заменяет `updateMessage`. Неизменяемые —
 * суррогатный `message_uid` (PK), доменный `id`, `session_id`, позиционный
 * `seq` и `created_at`: они сохраняются от исходной строки (цель ищется по
 * `seq`, fallback по `id`).
 */
export const MESSAGE_MUTABLE_FIELDS = MESSAGE_FIELDS.filter(
  (field) => field !== 'id' && field !== 'session_id' && field !== 'seq' && field !== 'created_at',
);

/** Обязательные поля сообщения: безопасные дефолты (паритет с file/memory). */
function prepareMessage(message: Message): Message {
  return {
    ...message,
    id: message.id || generateId(),
    origin: message.origin || 'local',
    parts: message.parts && message.parts.length > 0
      ? message.parts
      : [makeTextPart(message.content ?? '')],
    createdAt: message.createdAt || nowISO(),
  };
}

const REFERENCE_FIELDS = [
  'id',
  'session_id',
  'ref_session_id',
  'label',
  'message_range',
  'auto_summary',
  'ordinal',
  'created_at',
] as const;

const REFERENCE_JSON_FIELDS: ReadonlySet<string> = new Set(['message_range']);

const CHECKPOINT_FIELDS = ['id', 'session_id', 'messages', 'created_at'] as const;

const CHECKPOINT_JSON_FIELDS: ReadonlySet<string> = new Set(['messages']);

const NOTE_FIELDS = ['id', 'session_id', 'content', 'disabled', 'created_at', 'updated_at'] as const;

const NOTE_JSON_FIELDS: ReadonlySet<string> = new Set();

/** Размер пакета строк в одном `INSERT` (лимит параметров протокола — 65535). */
const INSERT_CHUNK_SIZE = 200;

/** Значение для jsonb-колонки: нативный объект/массив → JSON-строка (NUL — вычищены). */
export function jsonParam(value: unknown): string | null {
  return jsonbParam(value);
}

/**
 * Значения строки в порядке колонок (jsonb — сериализуются, `undefined` → `NULL`).
 * Экспортирован для unit-тестов сериализации (NUL не должен доходить до PG).
 */
export function rowValues(
  row: Record<string, unknown>,
  fields: readonly string[],
  jsonFields: ReadonlySet<string>,
): unknown[] {
  return fields.map((field) => (jsonFields.has(field) ? jsonParam(row[field]) : row[field] ?? null));
}

/** Экранирование спецсимволов `LIKE` — подстрока ищется буквально. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Пакетный upsert строк (по частям, чтобы не упираться в лимит параметров). */
async function upsertRows(
  tx: PostgresExecutor,
  table: string,
  fields: readonly string[],
  rows: Array<Record<string, unknown>>,
  jsonFields: ReadonlySet<string>,
  conflictKey: readonly string[],
): Promise<void> {
  if (rows.length === 0) return;

  const updatable = fields.filter((field) => !conflictKey.includes(field));
  const conflictAction = updatable.length > 0
    ? `DO UPDATE SET ${updatable.map((field) => `${field} = EXCLUDED.${field}`).join(', ')}`
    : 'DO NOTHING';

  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK_SIZE);
    const valuesSql = chunk
      .map((_row, rowIndex) =>
        `(${fields.map((_field, colIndex) => `$${rowIndex * fields.length + colIndex + 1}`).join(', ')})`,
      )
      .join(', ');
    const params = chunk.flatMap((row) => rowValues(row, fields, jsonFields));

    await tx.query(
      `INSERT INTO ${table} (${fields.join(', ')}) VALUES ${valuesSql} ` +
        `ON CONFLICT (${conflictKey.join(', ')}) ${conflictAction}`,
      params,
    );
  }
}

/**
 * Пакетный `INSERT` строк без `ON CONFLICT` (по частям, чтобы не упираться в
 * лимит параметров). Вызывается после `DELETE … WHERE session_id` — полная
 * замена child-строк в той же транзакции.
 */
async function insertRows(
  tx: PostgresExecutor,
  table: string,
  fields: readonly string[],
  rows: Array<Record<string, unknown>>,
  jsonFields: ReadonlySet<string>,
): Promise<void> {
  if (rows.length === 0) return;

  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK_SIZE);
    const valuesSql = chunk
      .map((_row, rowIndex) =>
        `(${fields.map((_field, colIndex) => `$${rowIndex * fields.length + colIndex + 1}`).join(', ')})`,
      )
      .join(', ');
    const params = chunk.flatMap((row) => rowValues(row, fields, jsonFields));

    await tx.query(
      `INSERT INTO ${table} (${fields.join(', ')}) VALUES ${valuesSql}`,
      params,
    );
  }
}

/** Полная замена child-строк сессии: `DELETE` + массовый `INSERT`. */
async function replaceRows(
  tx: PostgresExecutor,
  table: string,
  fields: readonly string[],
  rows: Array<Record<string, unknown>>,
  jsonFields: ReadonlySet<string>,
  sessionId: string,
): Promise<void> {
  await tx.query(`DELETE FROM ${table} WHERE session_id = $1`, [sessionId]);
  await insertRows(tx, table, fields, rows, jsonFields);
}

/** `WHERE` для `list`/`search` (фильтры — по колонкам `sessions`). */
function buildListWhere(filter?: SessionFilter): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.projectId) {
    params.push(filter.projectId);
    conditions.push(`s.project_id = $${params.length}`);
  }
  if (filter?.userId) {
    params.push(filter.userId);
    conditions.push(`s.user_id = $${params.length}`);
  }
  if (filter?.parentId !== undefined) {
    if (filter.parentId === null) {
      conditions.push('s.parent_id IS NULL');
    } else {
      params.push(filter.parentId);
      conditions.push(`s.parent_id = $${params.length}`);
    }
  }
  if (filter?.search) {
    params.push(`%${escapeLike(filter.search)}%`);
    const pattern = `$${params.length}`;
    conditions.push(
      `(s.title ILIKE ${pattern} OR EXISTS (` +
        `SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content ILIKE ${pattern}))`,
    );
  }

  return { sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** `SessionRepository` поверх PostgreSQL. */
export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly _connection: PostgresConnection) {}

  async load(sessionId: string): Promise<Session | null> {
    const rows = await this._connection.query<SessionRow>(
      'SELECT * FROM sessions WHERE id = $1',
      [sessionId],
    );
    const row = rows[0];
    if (!row) return null;

    const children = await this._loadChildren([sessionId]);
    return deserializeSession(row, children.get(sessionId) ?? emptySessionChildren());
  }

  /**
   * Запись сессии: одна транзакция, per-session advisory-лок, **полная замена**
   * истории и child-таблиц. `seq` сообщений нормализуется позиционно (`1..n`),
   * дубликаты `id` сохраняются как есть.
   */
  async save(session: Session): Promise<void> {
    const sessionRow = serializeSession(session);
    // `seq` — позиция сообщения в массиве (`1..n`): снимает legacy-коллизию
    // `UNIQUE (session_id, seq)` (у старых сессий `seq = 0` у всех) и делает
    // порядок однозначным. Дубликаты `id` сообщений сохраняются (PK — суррогатный).
    const messageRows = (session.messages ?? []).map((msg, index) =>
      messageRow(msg, session.id, index + 1),
    );
    const referenceRows = (session.references ?? []).map((ref, index) =>
      referenceRow(session.id, ref, index),
    );
    const checkpointRows = (session.checkpoints ?? []).map(checkpointRow);
    const noteRows = (session.stickyNotes ?? []).map((note) => stickyNoteRow(session.id, note));

    await this._connection.withTransaction(async (tx) => {
      await this._lockSession(tx, session.id);

      await upsertRows(tx, 'sessions', SESSION_FIELDS, [sessionRow], SESSION_JSON_FIELDS, ['id']);

      // Сообщения — полная замена в той же транзакции: `DELETE` + массовый
      // `INSERT`. Дубликаты `id` допустимы (суррогатный PK `message_uid`);
      // уникальность `(session_id, seq)` выполняется по построению (позиция).
      await replaceRows(tx, 'messages', MESSAGE_FIELDS, messageRows, MESSAGE_JSON_FIELDS, session.id);

      // Ссылки — полная замена (паритет с файловой реализацией: `save`
      // перезаписывает `session.references` целиком); `id`/`ordinal` — свежие,
      // дубликаты одной `ref_session_id` допустимы (разные диапазоны).
      await replaceRows(
        tx,
        'session_references',
        REFERENCE_FIELDS,
        referenceRows,
        REFERENCE_JSON_FIELDS,
        session.id,
      );

      await replaceRows(tx, 'checkpoints', CHECKPOINT_FIELDS, checkpointRows, CHECKPOINT_JSON_FIELDS, session.id);

      await replaceRows(tx, 'sticky_notes', NOTE_FIELDS, noteRows, NOTE_JSON_FIELDS, session.id);
    });
  }

  /**
   * Точечная дозапись сообщения (`SessionRepository.appendMessage`): одна
   * транзакция + per-session advisory-лок (как у `save`), `seq = MAX(seq)+1`
   * вычисляется в той же транзакции, `INSERT` одной строки, обновление
   * `sessions.updated_at`. Остальная история не перезаписывается.
   */
  async appendMessage(sessionId: string, message: Message): Promise<Message | null> {
    const prepared = prepareMessage(message);

    return this._connection.withTransaction(async (tx) => {
      await this._lockSession(tx, sessionId);

      const present = await tx.query<{ present: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM sessions WHERE id = $1) AS present',
        [sessionId],
      );
      if (present[0]?.present !== true) return null;

      const next = await tx.query<{ seq: string | number }>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = $1',
        [sessionId],
      );
      const seq = Number(next[0]?.seq ?? 1);

      const row = messageRow(prepared, sessionId, seq);
      const placeholders = MESSAGE_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
      const inserted = await tx.query<MessageRow>(
        `INSERT INTO messages (${MESSAGE_FIELDS.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        rowValues(row, MESSAGE_FIELDS, MESSAGE_JSON_FIELDS),
      );

      await tx.query('UPDATE sessions SET updated_at = now() WHERE id = $1', [sessionId]);

      const insertedRow = inserted[0];
      return insertedRow ? deserializeMessage(insertedRow) : null;
    });
  }

  /**
   * Точечное обновление сообщения (`SessionRepository.updateMessage`): одна
   * транзакция + per-session advisory-лок; цель — по `seq` (первая по
   * `seq, created_at, id`), fallback по `id`. `message_uid`/`id`/`seq`/
   * `created_at` исходной строки не меняются, `sessions.updated_at` обновляется.
   */
  async updateMessage(sessionId: string, message: Message): Promise<Message | null> {
    const prepared = prepareMessage(message);
    const row = messageRow(prepared, sessionId, prepared.seq);
    const setSql = MESSAGE_MUTABLE_FIELDS
      .map((field, index) => `${field} = $${index + 1}`)
      .join(', ');
    const params = rowValues(row, MESSAGE_MUTABLE_FIELDS, MESSAGE_JSON_FIELDS);

    return this._connection.withTransaction(async (tx) => {
      await this._lockSession(tx, sessionId);

      const messageUid = await this._findMessageUid(tx, sessionId, prepared);
      if (!messageUid) return null;

      const updated = await tx.query<MessageRow>(
        `UPDATE messages SET ${setSql} WHERE message_uid = $${params.length + 1} RETURNING *`,
        [...params, messageUid],
      );
      await tx.query('UPDATE sessions SET updated_at = now() WHERE id = $1', [sessionId]);

      const updatedRow = updated[0];
      return updatedRow ? deserializeMessage(updatedRow) : null;
    });
  }

  /**
   * Метаданные сессии без истории (`SessionRepository.loadLight`): одна
   * выборка по PK, child-таблицы не читаются.
   */
  async loadLight(sessionId: string): Promise<Session | null> {
    const rows = await this._connection.query<SessionRow>(
      'SELECT * FROM sessions WHERE id = $1',
      [sessionId],
    );
    const row = rows[0];
    return row ? deserializeSessionLight(row) : null;
  }

  async delete(sessionId: string): Promise<void> {
    await this._connection.withTransaction(async (tx) => {
      await this._lockSession(tx, sessionId);
      // Child-таблицы уходят каскадом (`ON DELETE CASCADE`).
      await tx.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    });
  }

  async exists(sessionId: string): Promise<boolean> {
    const rows = await this._connection.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM sessions WHERE id = $1) AS present',
      [sessionId],
    );
    return rows[0]?.present === true;
  }

  async list(filter?: SessionFilter): Promise<Session[]> {
    const { sql, params } = buildListWhere(filter);
    return this._listByWhere(sql, params);
  }

  /**
   * Лёгкий список (`SessionRepository.listLight`): тот же `WHERE`/порядок, что у
   * `list`, но **без** батчевой подгрузки child-таблиц — сообщения/чекпоинты не
   * читаются вовсе. SQL содержит только `FROM sessions` (для `filter.search`
   * добавляется `EXISTS (SELECT 1 FROM messages …)` — подзапрос-предикат, не join).
   */
  async listLight(filter?: SessionFilter): Promise<Session[]> {
    const { sql, params } = buildListWhere(filter);
    const rows = await this._connection.query<SessionRow>(
      `SELECT s.* FROM sessions s ${sql} ORDER BY s.updated_at DESC, s.id ASC`,
      params,
    );
    return rows.map(deserializeSessionLight);
  }

  /** Поиск по содержимому — тот же скан, что у `list` (паритет с файловой реализацией). */
  async search(query: string, filter?: SessionFilter): Promise<Session[]> {
    return this.list({ ...filter, search: query });
  }

  async listForUser(userId: string, ownerIds: string[] = []): Promise<Session[]> {
    // `ownerIds` — дополнительные id владельца (legacy-UUID профиля `local`, ADR-089).
    const ids = [userId, ...ownerIds];
    return this._listByWhere(
      'WHERE (s.user_id = ANY($1::text[]) OR s.owner_id = ANY($1::text[]))',
      [ids],
    );
  }

  /** «Свои + сессии проектов участия» (ADR-089); пустой `projectIds` → `listForUser`. */
  async listForUserScope(
    userId: string,
    projectIds: string[],
    ownerIds: string[] = [],
  ): Promise<Session[]> {
    if (projectIds.length === 0) return this.listForUser(userId, ownerIds);
    const ids = [userId, ...ownerIds];
    return this._listByWhere(
      'WHERE ((s.user_id = ANY($1::text[]) OR s.owner_id = ANY($1::text[])) '
        + 'OR s.project_id = ANY($2::text[]))',
      [ids, projectIds],
    );
  }

  async addReference(sessionId: string, ref: SessionReference): Promise<void> {
    await this._connection.withTransaction(async (tx) => {
      await this._lockSession(tx, sessionId);
      await this._assertSessionExists(tx, sessionId);
      // Append (дубликаты разрешены): новая ссылка получает следующий `ordinal`.
      const next = await tx.query<{ ordinal: string | number }>(
        'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM session_references WHERE session_id = $1',
        [sessionId],
      );
      const ordinal = Number(next[0]?.ordinal ?? 0);
      await tx.query(
        `INSERT INTO session_references
           (${REFERENCE_FIELDS.join(', ')})
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        rowValues(referenceRow(sessionId, ref, ordinal), REFERENCE_FIELDS, REFERENCE_JSON_FIELDS),
      );
    });
  }

  async removeReference(sessionId: string, refSessionId: string): Promise<void> {
    await this._connection.withTransaction(async (tx) => {
      await this._lockSession(tx, sessionId);
      await this._assertSessionExists(tx, sessionId);
      // Удаляются **все** совпадения (паритет с file/memory: `filter` по refSessionId).
      await tx.query(
        'DELETE FROM session_references WHERE session_id = $1 AND ref_session_id = $2',
        [sessionId, refSessionId],
      );
    });
  }

  async getReferences(sessionId: string): Promise<SessionReference[]> {
    if (!(await this.exists(sessionId))) return [];
    const rows = await this._connection.query<SessionReferenceRow>(
      'SELECT * FROM session_references WHERE session_id = $1 ORDER BY ordinal',
      [sessionId],
    );
    return rows.map(deserializeReference);
  }

  /** Список по готовому `WHERE` + батчевая подгрузка child-данных. */
  private async _listByWhere(whereSql: string, params: unknown[]): Promise<Session[]> {
    const rows = await this._connection.query<SessionRow>(
      `SELECT s.* FROM sessions s ${whereSql} ORDER BY s.updated_at DESC, s.id ASC`,
      params,
    );
    if (rows.length === 0) return [];

    const children = await this._loadChildren(rows.map((row) => row.id));
    return rows.map((row) =>
      deserializeSession(row, children.get(row.id) ?? emptySessionChildren()),
    );
  }

  /**
   * Child-данные набора сессий — четыре запроса с `ANY($1)` (никакого N+1),
   * `ORDER BY session_id, …` для стабильного порядка внутри каждой сессии.
   */
  private async _loadChildren(sessionIds: string[]): Promise<Map<string, SessionChildren>> {
    const buckets = new Map<string, SessionChildren>();
    for (const sessionId of sessionIds) buckets.set(sessionId, emptySessionChildren());
    if (sessionIds.length === 0) return buckets;

    const [messages, references, checkpoints, notes] = await Promise.all([
      this._connection.query<MessageRow>(
        'SELECT * FROM messages WHERE session_id = ANY($1::text[]) '
          + 'ORDER BY session_id, seq, created_at, id',
        [sessionIds],
      ),
      this._connection.query<SessionReferenceRow>(
        'SELECT * FROM session_references WHERE session_id = ANY($1::text[]) '
          + 'ORDER BY session_id, ordinal',
        [sessionIds],
      ),
      this._connection.query<CheckpointRow>(
        'SELECT * FROM checkpoints WHERE session_id = ANY($1::text[]) '
          + 'ORDER BY session_id, created_at, id',
        [sessionIds],
      ),
      this._connection.query<StickyNoteRow>(
        'SELECT * FROM sticky_notes WHERE session_id = ANY($1::text[]) '
          + 'ORDER BY session_id, created_at, id',
        [sessionIds],
      ),
    ]);

    for (const row of messages) buckets.get(row.session_id ?? '')?.messages.push(row);
    for (const row of references) buckets.get(row.session_id)?.references.push(row);
    for (const row of checkpoints) buckets.get(row.session_id)?.checkpoints.push(row);
    for (const row of notes) buckets.get(row.session_id)?.stickyNotes.push(row);
    return buckets;
  }

  /**
   * `message_uid` цели `updateMessage`: сначала по `seq` (при legacy-дублях —
   * первая по `seq, created_at, id`), затем fallback по доменному `id`.
   */
  private async _findMessageUid(
    tx: PostgresExecutor,
    sessionId: string,
    message: Message,
  ): Promise<string | null> {
    if (Number.isFinite(message.seq)) {
      const rows = await tx.query<{ message_uid: string }>(
        'SELECT message_uid FROM messages WHERE session_id = $1 AND seq = $2 '
          + 'ORDER BY seq, created_at, id LIMIT 1',
        [sessionId, message.seq],
      );
      if (rows[0]) return rows[0].message_uid;
    }

    if (message.id) {
      const rows = await tx.query<{ message_uid: string }>(
        'SELECT message_uid FROM messages WHERE session_id = $1 AND id = $2 '
          + 'ORDER BY seq, created_at, id LIMIT 1',
        [sessionId, message.id],
      );
      if (rows[0]) return rows[0].message_uid;
    }

    return null;
  }

  /** PROP-032: per-session сериализация записи — транзакционный advisory-лок. */
  private async _lockSession(tx: PostgresExecutor, sessionId: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)', [sessionId]);
  }

  /** `addReference`/`removeReference` отсутствующей сессии → ошибка (как в file/memory). */
  private async _assertSessionExists(tx: PostgresExecutor, sessionId: string): Promise<void> {
    const rows = await tx.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM sessions WHERE id = $1) AS present',
      [sessionId],
    );
    if (rows[0]?.present !== true) throw new Error(`Session ${sessionId} not found`);
  }
}

/** Собрать порты группы `sessions`. */
export function buildSessionPorts(deps: PortDeps): SessionPorts {
  return {
    sessions: new PostgresSessionRepository(deps.connection),
  };
}
