/**
 * Порты Authority-слоя PostgreSQL-драйвера (ADR-106 Ф0/Ф1, ADR-097).
 *
 * - `authority_policy` — политика полномочий **инстанса** (таблица из
 *   миграции 014): одна строка (`id = 'instance'`), документ — JSONB. «Политика
 *   не задана» (строк нет) и «политика задана и ничего не разрешает» (пустой
 *   документ) — **разные** состояния: первое означает «ось инстанса не
 *   применима», второе — «ось сужает до нуля». Чтение невалидного документа
 *   считается **отсутствием политики** (fail-closed на оси «user», а не
 *   «политика без грантов») — паритет с файловой реализацией core
 *   (`FileAuthorityPolicyStore`).
 * - `authority_decisions` — append-only журнал решений (таблица из миграции
 *   014; `seq bigserial` — порядок «свежие первыми», как у `security_audit`/
 *   `plugin_audit`).
 *
 * Политика и журнал — **отдельные** сущности: журнал фиксирует решения о
 * правах, политика — потолок инстанса (ADR-106 §«Инварианты модели», п. 8).
 *
 * Драйвер не дублирует доменную валидацию: схема `authorityPolicySchema`
 * берётся из `@itphx/synth-shared` (обычная зависимость пакета).
 */

import type { AuthorityDecisionEntry, AuthorityPolicy } from '@itphx/synth-shared';
import { authorityPolicySchema, nowISO } from '@itphx/synth-shared';
import type {
  AuthorityDecisionJournal,
  AuthorityDecisionListOptions,
  AuthorityPolicyRepository,
  StorageContext,
} from '@itphx/synth-core';
import type { PostgresExecutor } from '../pool.js';
import { jsonbLiteral } from '../json-param.js';
import type { PortDeps } from './deps.js';

type Row = Record<string, unknown>;

/** Ключ единственной строки политики инстанца. */
const AUTHORITY_POLICY_ROW_ID = 'instance';

/** ISO-строка из `timestamptz` (pg отдаёт `Date`) либо строки. */
function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// ────────────────────────────────────────────────────────────────────────────
// authorityPolicy (ADR-106 Ф0)
// ────────────────────────────────────────────────────────────────────────────

interface AuthorityPolicyRow extends Row {
  id: string;
  document: unknown;
  updated_at: Date | string;
}

/** Порт политики полномочий инстанса поверх таблицы `authority_policy`. */
class PostgresAuthorityPolicyRepository implements AuthorityPolicyRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  /** Политика инстанца; `null` — документа нет или он невалиден. */
  async getPolicy(): Promise<AuthorityPolicy | null> {
    const rows = await this._db().query<AuthorityPolicyRow>(
      'SELECT * FROM authority_policy WHERE id = $1',
      [AUTHORITY_POLICY_ROW_ID],
    );
    const row = rows[0];
    if (!row) return null;

    const parsed = authorityPolicySchema.safeParse(row.document);
    if (!parsed.success) {
      // Документ невалиден — политика считается незаданной (fail-closed на
      // оси «user», а не «политика без грантов»).
      console.warn(
        `[PostgresAuthorityPolicyRepository] документ политики Authority невалиден — считается отсутствующим: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
      return null;
    }
    return parsed.data;
  }

  /** Полная замена политики (атомарная upsert по ключу `instance`). */
  async savePolicy(policy: AuthorityPolicy): Promise<void> {
    const validated = authorityPolicySchema.parse(policy);
    await this._db().query(
      `INSERT INTO authority_policy (id, document, updated_at)
       VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (id) DO UPDATE
         SET document = EXCLUDED.document, updated_at = EXCLUDED.updated_at`,
      [AUTHORITY_POLICY_ROW_ID, jsonbLiteral(validated), nowISO()],
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// authorityDecisions (ADR-106 Ф1)
// ────────────────────────────────────────────────────────────────────────────

interface AuthorityDecisionRow extends Row {
  id: string;
  ts: Date | string;
  principal: string;
  action: string;
  target: string;
  effect: string;
  source: string;
  reason: string | null;
  mode: string | null;
  permission_effect: string | null;
}

function rowToDecision(row: AuthorityDecisionRow): AuthorityDecisionEntry {
  const entry: AuthorityDecisionEntry = {
    id: row.id,
    ts: toISO(row.ts),
    principal: row.principal,
    action: row.action,
    target: row.target,
    effect: row.effect as AuthorityDecisionEntry['effect'],
    source: row.source,
    reason: row.reason,
    mode: (row.mode ?? 'shadow') as AuthorityDecisionEntry['mode'],
  };
  // `permissionEffect` — только в shadow-режиме (в enforced — отсутствует).
  if (row.permission_effect !== null && row.permission_effect !== undefined) {
    entry.permissionEffect = row.permission_effect as AuthorityDecisionEntry['permissionEffect'];
  }
  return entry;
}

/** Порт append-only журнала решений Authority-слоя поверх `authority_decisions`. */
class PostgresAuthorityDecisionJournal implements AuthorityDecisionJournal {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async append(entry: AuthorityDecisionEntry): Promise<void> {
    await this._db().query(
      `INSERT INTO authority_decisions
         (id, ts, principal, action, target, effect, source, reason, mode, permission_effect)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        entry.id,
        entry.ts,
        entry.principal,
        entry.action,
        entry.target,
        entry.effect,
        entry.source,
        entry.reason ?? null,
        entry.mode ?? 'shadow',
        entry.permissionEffect ?? null,
      ],
    );
  }

  /** Решения «свежие первыми»; фильтры `action`/`effect`/`source`, `limit` — последние N. */
  async list(opts: AuthorityDecisionListOptions = {}): Promise<AuthorityDecisionEntry[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (opts.action !== undefined) {
      params.push(opts.action);
      clauses.push(`action = $${params.length}`);
    }
    if (opts.effect !== undefined) {
      params.push(opts.effect);
      clauses.push(`effect = $${params.length}`);
    }
    if (opts.source !== undefined) {
      params.push(opts.source);
      clauses.push(`source = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let limit = '';
    const { limit: requested } = opts;
    if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
      params.push(Math.floor(requested));
      limit = `LIMIT $${params.length}::int`;
    }
    const rows = await this._db().query<AuthorityDecisionRow>(
      `SELECT * FROM authority_decisions ${where} ORDER BY seq DESC ${limit}`,
      params,
    );
    return rows.map(rowToDecision);
  }

  async clear(): Promise<number> {
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM authority_decisions RETURNING 1) SELECT count(*)::int AS n FROM deleted',
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value : Number(value) || 0;
  }
}

/** Часть `StorageContext`, которой владеет модуль портов Authority-слоя. */
export type AuthorityPorts = Pick<StorageContext, 'authorityPolicy' | 'authorityDecisions'>;

/** Собрать порты Authority-слоя (ADR-106 Ф0/Ф1). */
export function buildAuthorityPorts(deps: PortDeps): AuthorityPorts {
  return {
    authorityPolicy: new PostgresAuthorityPolicyRepository(deps),
    authorityDecisions: new PostgresAuthorityDecisionJournal(deps),
  };
}
