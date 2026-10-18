/**
 * Порты журналов безопасности PostgreSQL-драйвера (egress/ADR-071):
 * `securityAudit` — аудит изменений egress/security-политик,
 * `egressRequests` — журнал внешних запросов.
 *
 * Обе таблицы append-only (`seq bigserial` — порядок «свежие первыми»).
 * `before`/`after` в security-аудите хранятся в JSONB (снимки политики могут быть
 * `null`); журнал egress не содержит тел/заголовков.
 */

import type {
  EgressRequestLogEntry,
  SecurityAuditEntry,
} from '@itphx/synth-shared';
import type {
  EgressRequestLogListOptions,
  EgressRequestLogRepository,
  SecurityAuditListOptions,
  SecurityAuditRepository,
  StorageContext,
} from '@itphx/synth-core';
import type { PostgresExecutor } from '../pool.js';
import { jsonbLiteral } from '../json-param.js';
import type { PortDeps } from './deps.js';

type Row = Record<string, unknown>;

function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function jsonParam(value: unknown): string {
  return jsonbLiteral(value ?? null);
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// securityAudit
// ────────────────────────────────────────────────────────────────────────────

interface SecurityAuditRow extends Row {
  id: string;
  ts: Date | string;
  actor: string;
  scope: string;
  action: string;
  source: string;
  before_jsonb: unknown;
  after_jsonb: unknown;
  version: number | string;
}

function securityRowToEntry(row: SecurityAuditRow): SecurityAuditEntry {
  return {
    id: row.id,
    ts: toISO(row.ts),
    actor: row.actor,
    scope: row.scope as SecurityAuditEntry['scope'],
    action: row.action as SecurityAuditEntry['action'],
    source: row.source as SecurityAuditEntry['source'],
    before: row.before_jsonb ?? null,
    after: row.after_jsonb ?? null,
    version: typeof row.version === 'number' ? row.version : Number(row.version) || 1,
  };
}

class PostgresSecurityAuditRepository implements SecurityAuditRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async append(entry: SecurityAuditEntry): Promise<void> {
    await this._db().query(
      `INSERT INTO security_audit (id, ts, actor, scope, action, source, before_jsonb, after_jsonb, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [
        entry.id,
        entry.ts,
        entry.actor,
        entry.scope,
        entry.action,
        entry.source,
        jsonParam(entry.before),
        jsonParam(entry.after),
        entry.version,
      ],
    );
  }

  async list(opts: SecurityAuditListOptions = {}): Promise<SecurityAuditEntry[]> {
    const params: unknown[] = [];
    let where = '';
    if (opts.scope !== undefined) {
      params.push(opts.scope);
      where = `WHERE scope = $${params.length}`;
    }
    let limit = '';
    if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
      params.push(Math.floor(opts.limit));
      limit = `LIMIT $${params.length}::int`;
    }
    const rows = await this._db().query<SecurityAuditRow>(
      `SELECT * FROM security_audit ${where} ORDER BY seq DESC ${limit}`,
      params,
    );
    return rows.map(securityRowToEntry);
  }

  async clear(): Promise<number> {
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM security_audit RETURNING 1) SELECT count(*)::int AS n FROM deleted',
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value : Number(value) || 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// egressRequests
// ────────────────────────────────────────────────────────────────────────────

interface EgressRequestRow extends Row {
  id: string;
  ts: Date | string;
  scope: string;
  host: string;
  url: string;
  method: string | null;
  status: string;
  via: string | null;
  http_status: number | null;
  bytes: number | string | null;
  duration_ms: number | null;
  reason: string | null;
  matched_rule: string | null;
  session_id: string | null;
  project_id: string | null;
  actor: string | null;
}

function egressRowToEntry(row: EgressRequestRow): EgressRequestLogEntry {
  const entry: EgressRequestLogEntry = {
    id: row.id,
    ts: toISO(row.ts),
    scope: row.scope as EgressRequestLogEntry['scope'],
    host: row.host,
    url: row.url,
    status: row.status as EgressRequestLogEntry['status'],
  };
  if (row.method !== null) entry.method = row.method;
  if (row.via !== null) entry.via = row.via as EgressRequestLogEntry['via'];
  if (row.http_status !== null) entry.httpStatus = row.http_status;
  const bytes = toNumber(row.bytes);
  if (bytes !== undefined) entry.bytes = bytes;
  if (row.duration_ms !== null) entry.durationMs = row.duration_ms;
  if (row.reason !== null) entry.reason = row.reason;
  if (row.matched_rule !== null) entry.matchedRule = row.matched_rule;
  if (row.session_id !== null) entry.sessionId = row.session_id;
  if (row.project_id !== null) entry.projectId = row.project_id;
  if (row.actor !== null) entry.actor = row.actor;
  return entry;
}

class PostgresEgressRequestLogRepository implements EgressRequestLogRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async append(entry: EgressRequestLogEntry): Promise<void> {
    await this._db().query(
      `INSERT INTO egress_requests
         (id, ts, scope, host, url, method, status, via, http_status, bytes, duration_ms,
          reason, matched_rule, session_id, project_id, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        entry.id,
        entry.ts,
        entry.scope,
        entry.host,
        entry.url,
        entry.method ?? null,
        entry.status,
        entry.via ?? null,
        entry.httpStatus ?? null,
        entry.bytes ?? null,
        entry.durationMs ?? null,
        entry.reason ?? null,
        entry.matchedRule ?? null,
        entry.sessionId ?? null,
        entry.projectId ?? null,
        entry.actor ?? null,
      ],
    );
  }

  async list(opts: EgressRequestLogListOptions = {}): Promise<EgressRequestLogEntry[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (opts.scope !== undefined) {
      params.push(opts.scope);
      clauses.push(`scope = $${params.length}`);
    }
    if (opts.status !== undefined) {
      params.push(opts.status);
      clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let limit = '';
    if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
      params.push(Math.floor(opts.limit));
      limit = `LIMIT $${params.length}::int`;
    }
    const rows = await this._db().query<EgressRequestRow>(
      `SELECT * FROM egress_requests ${where} ORDER BY seq DESC ${limit}`,
      params,
    );
    return rows.map(egressRowToEntry);
  }

  async prune(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM egress_requests WHERE ts < $1 RETURNING 1) SELECT count(*)::int AS n FROM deleted',
      [cutoff],
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value : Number(value) || 0;
  }

  async clear(): Promise<number> {
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM egress_requests RETURNING 1) SELECT count(*)::int AS n FROM deleted',
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value : Number(value) || 0;
  }
}

/** Часть `StorageContext`, которой владеет группа `audit`. */
export type AuditPorts = Pick<StorageContext, 'securityAudit' | 'egressRequests'>;

/** Собрать порты журналов безопасности. */
export function buildAuditPorts(deps: PortDeps): AuditPorts {
  return {
    securityAudit: new PostgresSecurityAuditRepository(deps),
    egressRequests: new PostgresEgressRequestLogRepository(deps),
  };
}
