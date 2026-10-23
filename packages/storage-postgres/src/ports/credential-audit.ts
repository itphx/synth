/**
 * Порт журнала операций со слоем доступов PostgreSQL-драйвера (ADR-105 Ф4,
 * ADR-097).
 *
 * Отдельная append-only таблица `credential_audit` (`seq bigserial` — порядок
 * «свежие первыми»). Семантика — как у файловой реализации core
 * (`FileCredentialAuditStore`): append, выборка «свежие первыми» с фильтрами
 * `credentialId`/`provider`/`op`/`outcome`/`limit`, очистка с числом удалённых.
 *
 * **Секретов в таблице нет**: ни значения токена, ни `secret_enc`/`refresh_enc`
 * (они лежат в отдельной таблице `external_credentials`), ни сырых путей и id
 * сессий/пользователей (ADR-105 §7).
 */

import type {
  ExternalCredentialAuditEntry,
  ExternalCredentialAuditOp,
  ExternalCredentialAuditOutcome,
} from '@itphx/synth-shared';
import type {
  CredentialAuditListOptions,
  CredentialAuditRepository,
  StorageContext,
} from '@itphx/synth-core';
import type { PostgresExecutor } from '../pool.js';
import type { PortDeps } from './deps.js';

type Row = Record<string, unknown>;

function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

interface CredentialAuditRow extends Row {
  id: string;
  ts: Date | string;
  op: string;
  credential_id: string;
  provider: string;
  outcome: string;
  error_code: string | null;
  connector_id: string | null;
}

function credentialAuditRowToEntry(row: CredentialAuditRow): ExternalCredentialAuditEntry {
  const entry: ExternalCredentialAuditEntry = {
    id: row.id,
    ts: toISO(row.ts),
    op: row.op as ExternalCredentialAuditOp,
    credentialId: row.credential_id,
    provider: row.provider,
    outcome: row.outcome as ExternalCredentialAuditOutcome,
  };
  if (row.error_code !== null) entry.errorCode = row.error_code;
  if (row.connector_id !== null) entry.connectorId = row.connector_id;
  return entry;
}

/** Реализация порта `CredentialAuditRepository` поверх SQL. */
class PostgresCredentialAuditRepository implements CredentialAuditRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async append(entry: ExternalCredentialAuditEntry): Promise<void> {
    await this._db().query(
      `INSERT INTO credential_audit
         (id, ts, op, credential_id, provider, outcome, error_code, connector_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        entry.id,
        entry.ts,
        entry.op,
        entry.credentialId,
        entry.provider,
        entry.outcome,
        entry.errorCode ?? null,
        entry.connectorId ?? null,
      ],
    );
  }

  async list(opts: CredentialAuditListOptions = {}): Promise<ExternalCredentialAuditEntry[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (opts.credentialId !== undefined) {
      params.push(opts.credentialId);
      clauses.push(`credential_id = $${params.length}`);
    }
    if (opts.provider !== undefined) {
      params.push(opts.provider);
      clauses.push(`provider = $${params.length}`);
    }
    if (opts.op !== undefined) {
      params.push(opts.op);
      clauses.push(`op = $${params.length}`);
    }
    if (opts.outcome !== undefined) {
      params.push(opts.outcome);
      clauses.push(`outcome = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let limit = '';
    if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
      params.push(Math.floor(opts.limit));
      limit = `LIMIT $${params.length}::int`;
    }
    const rows = await this._db().query<CredentialAuditRow>(
      `SELECT * FROM credential_audit ${where} ORDER BY seq DESC ${limit}`,
      params,
    );
    return rows.map(credentialAuditRowToEntry);
  }

  async clear(): Promise<number> {
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM credential_audit RETURNING 1) SELECT count(*)::int AS n FROM deleted',
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value : Number(value) || 0;
  }
}

/** Часть `StorageContext`, которой владеет модуль журнала доступов. */
export type CredentialAuditPorts = Pick<StorageContext, 'credentialAudit'>;

/** Собрать порт журнала операций со слоем доступов. */
export function buildCredentialAuditPorts(deps: PortDeps): CredentialAuditPorts {
  return {
    credentialAudit: new PostgresCredentialAuditRepository(deps),
  };
}
