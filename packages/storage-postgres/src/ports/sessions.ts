/**
 * Порт `SessionRepository` поверх PostgreSQL (PROP-032, волна 3b).
 *
 * Группа портов **сессий** PostgreSQL-драйвера: единственная фабрика
 * `buildSessionPorts(deps)` собирает `StorageContext['sessions']`.
 *
 * Семантика — паритет с файловой (`FileStore`) и in-memory
 * (`MemorySessionRepository`) реализациями:
 *   - `save` — **одна транзакция**: upsert строки `sessions` + согласование
 *     сообщений и child-таблиц (`session_references`/`checkpoints`/`sticky_notes`):
 *     upsert по естественному ключу + `DELETE` отсутствующих (полного rewrite нет);
 *     `session_references` — полная замена (ссылки допускают дубликаты одной
 *     `ref_session_id`, порядок — `ordinal`);
 *   - per-session сериализация записи — транзакционный `pg_advisory_xact_lock`
 *     (держится до `COMMIT`; аналог per-session `AsyncLock` файловой реализации);
 *   - `UNIQUE (session_id, seq)` в `messages` объявлен `DEFERRABLE` — на время
 *     записи берётся `SET CONSTRAINTS ALL DEFERRED`, поэтому перестановка `seq`
 *     (ветвление/merge) валидна к концу транзакции;
 *   - чтения (`load`/`list`/`listForUser`/`listForUserScope`/`search`) отдают
 *     **полную** `Session`; сообщения/child-строки подгружаются **батчем**
 *     (`WHERE session_id = ANY($1)`, без N+1);
 *   - `listLight` — метаданные без истории (`messages`/`pendingMessages`/
 *     `checkpoints` пусты, child-таблицы не читаются): одна выборка из `sessions`
 *     тем же `WHERE`/порядком, что у `list`;
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
import type { Session, SessionReference } from '@itphx/synth-shared';
import type { SessionFilter, SessionRepository, StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import {
  checkpointRow,
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

/** Значение для jsonb-колонки: нативный объект/массив → JSON-строка. */
function jsonParam(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(value);
  return json === undefined ? null : json;
}

/** Значения строки в порядке колонок (jsonb — сериализуются, `undefined` → `NULL`). */
function rowValues(
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

/** Дедупликация строк по ключу (одна и та же строка не может быть затронута дважды в `INSERT`). */
function dedupeByKey(rows: Array<Record<string, unknown>>, key: string): Array<Record<string, unknown>> {
  const unique = new Map<string, Record<string, unknown>>();
  for (const row of rows) unique.set(String(row[key]), row);
  return [...unique.values()];
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

/** Удаление строк сессии, отсутствующих в текущем состоянии (дельтовое согласование). */
async function deleteAbsent(
  tx: PostgresExecutor,
  table: string,
  keyColumn: string,
  sessionId: string,
  keys: string[],
): Promise<void> {
  await tx.query(
    `DELETE FROM ${table} WHERE session_id = $1 AND ${keyColumn} <> ALL($2::text[])`,
    [sessionId, keys],
  );
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
   * Запись сессии: одна транзакция, per-session advisory-лок, дельтовое
   * согласование сообщений и child-таблиц.
   */
  async save(session: Session): Promise<void> {
    const sessionRow = serializeSession(session);
    const messageRows = dedupeByKey(
      (session.messages ?? []).map((msg) => messageRow(msg, session.id)),
      'id',
    );
    const referenceRows = (session.references ?? []).map((ref, index) =>
      referenceRow(session.id, ref, index),
    );
    const checkpointRows = dedupeByKey((session.checkpoints ?? []).map(checkpointRow), 'id');
    const noteRows = dedupeByKey(
      (session.stickyNotes ?? []).map((note) => stickyNoteRow(session.id, note)),
      'id',
    );

    await this._connection.withTransaction(async (tx) => {
      await this._lockSession(tx, session.id);
      // `UNIQUE (session_id, seq)` объявлен DEFERRABLE: перестановка `seq`
      // (ветвление/merge) проверяется на COMMIT, а не на каждой вставке.
      await tx.query('SET CONSTRAINTS ALL DEFERRED');

      await upsertRows(tx, 'sessions', SESSION_FIELDS, [sessionRow], SESSION_JSON_FIELDS, ['id']);

      await upsertRows(tx, 'messages', MESSAGE_FIELDS, messageRows, MESSAGE_JSON_FIELDS, ['id']);
      await deleteAbsent(tx, 'messages', 'id', session.id, messageRows.map((row) => String(row.id)));

      // Ссылки — полная замена (паритет с файловой реализацией: `save`
      // перезаписывает `session.references` целиком); `id`/`ordinal` — свежие,
      // дубликаты одной `ref_session_id` допустимы (разные диапазоны).
      await tx.query('DELETE FROM session_references WHERE session_id = $1', [session.id]);
      await upsertRows(
        tx,
        'session_references',
        REFERENCE_FIELDS,
        referenceRows,
        REFERENCE_JSON_FIELDS,
        ['id'],
      );

      await upsertRows(tx, 'checkpoints', CHECKPOINT_FIELDS, checkpointRows, CHECKPOINT_JSON_FIELDS, ['id']);
      await deleteAbsent(tx, 'checkpoints', 'id', session.id, checkpointRows.map((row) => String(row.id)));

      await upsertRows(tx, 'sticky_notes', NOTE_FIELDS, noteRows, NOTE_JSON_FIELDS, ['id']);
      await deleteAbsent(tx, 'sticky_notes', 'id', session.id, noteRows.map((row) => String(row.id)));
    });
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
        'SELECT * FROM messages WHERE session_id = ANY($1::text[]) ORDER BY session_id, seq',
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
