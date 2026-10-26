/**
 * PG-реализация порта **вопросов пользователю** (этап 1 roadmap 0.13 — блок 1.3,
 * ADR-097).
 *
 * Таблица `questions` (миграция 021): состав вопросов и ответы — `jsonb`,
 * выборки — по сессии и статусу, порядок — «свежие первыми»
 * (`created_at` убыв., тайбрейкер `id`).
 *
 * Семантика повторяет файловые реализации core (`FileQuestionStore`) и
 * in-memory (`MemoryQuestionRepository`):
 * - upsert по `id`: `created_at` не перезаписывается, `updated_at` — метка
 *   вызывающего (драйвер не подставляет «сейчас» — иначе retention-очистка по
 *   метке записи теряла бы смысл);
 * - `prune` — **только терминальные** статусы (`answered`/`cancelled`), метка
 *   которых строго старше отсечки (`updated_at < $1`).
 *
 * Драйвер не тянет core рантаймом (только `import type`), поэтому потолок
 * выборки и правила timestamps повторены здесь локально — как в
 * `ports/pipelines.ts`.
 */

import type { QuestionRepository, StorageContext } from '@itphx/synth-core';
import type { QuestionItem, QuestionRecord, QuestionStatus } from '@itphx/synth-shared';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';
import { compact, toIso, toIsoRequired } from './events-core.js';

/** Часть `StorageContext`, которой владеет группа «вопросы/фоны». */
export type QuestionPorts = Pick<StorageContext, 'questions'>;

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

/** Терминальные статусы вопроса (очищаемые; `pending` — не терминальный). */
const TERMINAL_STATUSES: readonly QuestionStatus[] = ['answered', 'cancelled'];

// ────────────────────────────────────────────────────────────────────────────
// questions (этап 1 roadmap 0.13, блок 1.3)
// ────────────────────────────────────────────────────────────────────────────

type QuestionRow = {
  id: string;
  session_id: string;
  turn_id: string | null;
  tool_call_id: string | null;
  agent_role: string | null;
  questions: unknown;
  status: string;
  answers: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
  answered_at: Date | string | null;
  cancelled_at: Date | string | null;
  cancel_reason: string | null;
  answered_by: string | null;
};

/** Запись вопроса из колонок. */
function toQuestion(row: QuestionRow): QuestionRecord {
  return compact({
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    agentRole: row.agent_role ?? undefined,
    questions: (row.questions ?? []) as QuestionItem[],
    status: row.status as QuestionStatus,
    answers: (row.answers ?? undefined) as string[][] | undefined,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
    expiresAt: toIso(row.expires_at),
    answeredAt: toIso(row.answered_at),
    cancelledAt: toIso(row.cancelled_at),
    cancelReason: row.cancel_reason ?? undefined,
    answeredBy: row.answered_by ?? undefined,
  }) as QuestionRecord;
}

/** Порт вопросов пользователю поверх таблицы `questions`. */
export class PgQuestionRepository implements QuestionRepository {
  constructor(private readonly _deps: PortDeps) {}

  async save(record: QuestionRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO questions
         (id, session_id, turn_id, tool_call_id, agent_role, questions, status, answers,
          created_at, updated_at, expires_at, answered_at, cancelled_at, cancel_reason, answered_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::timestamptz,
               $10::timestamptz, $11::timestamptz, $12::timestamptz, $13::timestamptz, $14, $15)
       ON CONFLICT (id) DO UPDATE SET
         session_id = EXCLUDED.session_id,
         turn_id = EXCLUDED.turn_id,
         tool_call_id = EXCLUDED.tool_call_id,
         agent_role = EXCLUDED.agent_role,
         questions = EXCLUDED.questions,
         status = EXCLUDED.status,
         answers = EXCLUDED.answers,
         created_at = questions.created_at,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at,
         answered_at = EXCLUDED.answered_at,
         cancelled_at = EXCLUDED.cancelled_at,
         cancel_reason = EXCLUDED.cancel_reason,
         answered_by = EXCLUDED.answered_by`,
      [
        record.id,
        record.sessionId,
        record.turnId ?? null,
        record.toolCallId ?? null,
        record.agentRole ?? null,
        jsonbParam(record.questions),
        record.status,
        record.answers !== undefined ? jsonbParam(record.answers) : null,
        record.createdAt,
        record.updatedAt,
        record.expiresAt ?? null,
        record.answeredAt ?? null,
        record.cancelledAt ?? null,
        record.cancelReason ?? null,
        record.answeredBy ?? null,
      ],
    );
  }

  async get(id: string): Promise<QuestionRecord | null> {
    const rows = await this._deps.connection.query<QuestionRow>(
      'SELECT * FROM questions WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toQuestion(rows[0]) : null;
  }

  async list(filter?: {
    sessionId?: string;
    status?: QuestionStatus;
    limit?: number;
  }): Promise<QuestionRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter?.sessionId !== undefined) {
      params.push(filter.sessionId);
      where.push(`session_id = $${params.length}`);
    }
    if (filter?.status !== undefined) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    params.push(resolveLimit(filter?.limit));
    const sql =
      'SELECT * FROM questions' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC, id ASC' +
      ` LIMIT $${params.length}`;
    const rows = await this._deps.connection.query<QuestionRow>(sql, params);
    return rows.map(toQuestion);
  }

  async prune(before: string): Promise<number> {
    const rows = await this._deps.connection.query<{ id: string }>(
      `DELETE FROM questions
        WHERE status = ANY($1::text[]) AND updated_at < $2::timestamptz
        RETURNING id`,
      [[...TERMINAL_STATUSES], before],
    );
    return rows.length;
  }
}

/** Собрать порты группы «вопросы» (этап 1 roadmap 0.13, блок 1.3). */
export function buildQuestionPorts(deps: PortDeps): QuestionPorts {
  return {
    questions: new PgQuestionRepository(deps),
  };
}
