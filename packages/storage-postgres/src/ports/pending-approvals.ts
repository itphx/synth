/**
 * PG-реализация порта **ожиданий подтверждения прав** (ADR-029, ADR-097).
 *
 * Таблица `pending_approvals` (миграция 035): состав ожидания (тул, аргументы,
 * причина, «виновник») и метаданные (сессия, владелец, момент публикации,
 * таймаут, ход, принципал). Выборка — по сессии.
 *
 * Почему отдельная таблица, а не поле документа сессии: `sessions` пишется
 * полной перезаменой (`save`), а результаты параллельных тулов — точечно
 * (`appendMessage`, ADR-118 §4). Запись ожидания в тот же документ затирала бы
 * точечные записи → гонка lost update.
 *
 * Семантика повторяет файловые реализации core (`FilePendingApprovalStore`) и
 * in-memory (`MemoryPendingApprovalRepository`): upsert по `approvalId`,
 * список с фильтром по сессии, `delete` идемпотентно, `clear` — число снятых
 * записей.
 */

import type {
  PendingApprovalRecord,
  PendingApprovalRepository,
  StorageContext,
} from '@itphx/synth-core';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';
import { toIsoRequired } from './events-core.js';

/** Часть `StorageContext`, которой владеет группа «ожидания подтверждений». */
export type PendingApprovalPorts = Pick<StorageContext, 'pendingApprovals'>;

/** Строка таблицы `pending_approvals`. */
type PendingApprovalRow = {
  approval_id: string;
  session_id: string;
  owner_id: string | null;
  tool_name: string;
  arguments: unknown;
  reason: string;
  trigger: unknown;
  asked_at: Date | string;
  timeout_ms: number;
  turn_id: string | null;
  principal: string | null;
};

/** Запись ожидания из колонок. */
function toRecord(row: PendingApprovalRow): PendingApprovalRecord {
  const trigger = row.trigger && typeof row.trigger === 'object' && !Array.isArray(row.trigger)
    ? (row.trigger as PendingApprovalRecord['trigger'])
    : undefined;
  return {
    approvalId: row.approval_id,
    sessionId: row.session_id,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    toolName: row.tool_name,
    arguments: (row.arguments && typeof row.arguments === 'object' && !Array.isArray(row.arguments))
      ? (row.arguments as Record<string, unknown>)
      : {},
    reason: row.reason ?? '',
    ...(trigger ? { trigger } : {}),
    askedAt: toIsoRequired(row.asked_at),
    timeoutMs: row.timeout_ms ?? 0,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.principal ? { principal: row.principal } : {}),
  };
}

/** Порт ожиданий подтверждения прав поверх таблицы `pending_approvals`. */
export class PgPendingApprovalRepository implements PendingApprovalRepository {
  constructor(private readonly _deps: PortDeps) {}

  async save(record: PendingApprovalRecord): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO pending_approvals
         (approval_id, session_id, owner_id, tool_name, arguments, reason, trigger,
          asked_at, timeout_ms, turn_id, principal)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::timestamptz, $9, $10, $11)
       ON CONFLICT (approval_id) DO UPDATE SET
         session_id = EXCLUDED.session_id,
         owner_id   = EXCLUDED.owner_id,
         tool_name  = EXCLUDED.tool_name,
         arguments  = EXCLUDED.arguments,
         reason     = EXCLUDED.reason,
         trigger    = EXCLUDED.trigger,
         asked_at   = EXCLUDED.asked_at,
         timeout_ms = EXCLUDED.timeout_ms,
         turn_id    = EXCLUDED.turn_id,
         principal  = EXCLUDED.principal`,
      [
        record.approvalId,
        record.sessionId,
        record.ownerId ?? null,
        record.toolName,
        jsonbParam(record.arguments ?? {}),
        record.reason ?? '',
        record.trigger ? jsonbParam(record.trigger) : null,
        record.askedAt,
        record.timeoutMs ?? 0,
        record.turnId ?? null,
        record.principal ?? null,
      ],
    );
  }

  async delete(approvalId: string): Promise<void> {
    await this._deps.connection.query(
      'DELETE FROM pending_approvals WHERE approval_id = $1',
      [approvalId],
    );
  }

  async list(sessionId?: string): Promise<PendingApprovalRecord[]> {
    const params: unknown[] = [];
    let sql = 'SELECT * FROM pending_approvals';
    if (sessionId !== undefined) {
      params.push(sessionId);
      sql += ` WHERE session_id = $${params.length}`;
    }
    // Порядок — «сначала опубликованные» (asked_at возраст., тайбрейкер id).
    sql += ' ORDER BY asked_at ASC, approval_id ASC';
    const rows = await this._deps.connection.query<PendingApprovalRow>(sql, params);
    return rows.map(toRecord);
  }

  async clear(sessionId?: string): Promise<number> {
    const params: unknown[] = [];
    let sql = 'DELETE FROM pending_approvals';
    if (sessionId !== undefined) {
      params.push(sessionId);
      sql += ` WHERE session_id = $${params.length}`;
    }
    sql += ' RETURNING approval_id';
    const rows = await this._deps.connection.query<{ approval_id: string }>(sql, params);
    return rows.length;
  }
}

/** Собрать порт ожиданий подтверждения прав (ADR-029). */
export function buildPendingApprovalPorts(deps: PortDeps): PendingApprovalPorts {
  return {
    pendingApprovals: new PgPendingApprovalRepository(deps),
  };
}
