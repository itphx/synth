/**
 * Порт журнала аудита плагинов PostgreSQL-драйвера (PROP-090 §9, ADR-097).
 *
 * Отдельная append-only таблица `plugin_audit` (`seq bigserial` — порядок
 * «свежие первыми»). Семантика — как у файловой реализации core
 * (`FilePluginAuditStore`): append, выборка «свежие первыми» с фильтрами
 * `plugin`/`action`/`outcome`/`limit`, очистка с числом удалённых.
 */

import type {
  PluginAuditAction,
  PluginAuditEntry,
  PluginAuditOutcome,
  PluginScanVerdict,
} from '@itphx/synth-shared';
import type { PackPluginMode } from '@itphx/synth-shared';
import type {
  PluginAuditListOptions,
  PluginAuditRepository,
  StorageContext,
} from '@itphx/synth-core';
import type { CatalogTrustLevel } from '@itphx/synth-shared';
import type { PostgresExecutor } from '../pool.js';
import type { PortDeps } from './deps.js';

type Row = Record<string, unknown>;

function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

interface PluginAuditRow extends Row {
  id: string;
  ts: Date | string;
  actor: string;
  scope: string;
  action: string;
  plugin: string;
  version: string;
  trust_level: string | null;
  scan_verdict: string | null;
  content_hash: string | null;
  mode: string | null;
  outcome: string;
  reason: string | null;
  source: string | null;
}

function pluginRowToEntry(row: PluginAuditRow): PluginAuditEntry {
  const entry: PluginAuditEntry = {
    id: row.id,
    ts: toISO(row.ts),
    actor: row.actor,
    scope: 'plugin',
    action: row.action as PluginAuditAction,
    plugin: row.plugin,
    version: row.version,
    outcome: row.outcome as PluginAuditOutcome,
  };
  if (row.trust_level !== null) entry.trustLevel = row.trust_level as CatalogTrustLevel;
  if (row.scan_verdict !== null) entry.scanVerdict = row.scan_verdict as PluginScanVerdict;
  if (row.content_hash !== null) entry.contentHash = row.content_hash;
  if (row.mode !== null) entry.mode = row.mode as PackPluginMode;
  if (row.reason !== null) entry.reason = row.reason as PluginAuditEntry['reason'];
  if (row.source !== null) entry.source = row.source;
  return entry;
}

/** Реализация порта `PluginAuditRepository` поверх SQL. */
class PostgresPluginAuditRepository implements PluginAuditRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async append(entry: PluginAuditEntry): Promise<void> {
    await this._db().query(
      `INSERT INTO plugin_audit
         (id, ts, actor, scope, action, plugin, version, trust_level, scan_verdict,
          content_hash, mode, outcome, reason, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        entry.id,
        entry.ts,
        entry.actor,
        entry.scope,
        entry.action,
        entry.plugin,
        entry.version,
        entry.trustLevel ?? null,
        entry.scanVerdict ?? null,
        entry.contentHash ?? null,
        entry.mode ?? null,
        entry.outcome,
        entry.reason ?? null,
        entry.source ?? null,
      ],
    );
  }

  async list(opts: PluginAuditListOptions = {}): Promise<PluginAuditEntry[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (opts.plugin !== undefined) {
      params.push(opts.plugin);
      clauses.push(`plugin = $${params.length}`);
    }
    if (opts.action !== undefined) {
      params.push(opts.action);
      clauses.push(`action = $${params.length}`);
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
    const rows = await this._db().query<PluginAuditRow>(
      `SELECT * FROM plugin_audit ${where} ORDER BY seq DESC ${limit}`,
      params,
    );
    return rows.map(pluginRowToEntry);
  }

  async clear(): Promise<number> {
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM plugin_audit RETURNING 1) SELECT count(*)::int AS n FROM deleted',
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value : Number(value) || 0;
  }
}

/** Часть `StorageContext`, которой владеет модуль журнала плагинов. */
export type PluginAuditPorts = Pick<StorageContext, 'pluginAudit'>;

/** Собрать порт журнала аудита плагинов. */
export function buildPluginAuditPorts(deps: PortDeps): PluginAuditPorts {
  return {
    pluginAudit: new PostgresPluginAuditRepository(deps),
  };
}
