/**
 * Порт lock-файла плагинов PostgreSQL-драйвера (PROP-068 §4.4 / PROP-090 §5,
 * ADR-097).
 *
 * Отдельная таблица `plugin_lock` (ключ — имя плагина). Семантика — как у
 * файловой реализации core (`FilePluginLockStore`): upsert по имени
 * (`installed_at` сохраняется, `updated_at` обновляется), чтечение, список с
 * детерминированным порядком по имени, снятие записи.
 *
 * **Ступень отката (долги Д2).** Колонка `previous jsonb` (миграция `009`) —
 * одна предыдущая версия для `rollback`; отсутствует (`NULL`) у записи,
 * поставленной обычной установкой. `pg` отдаёт `jsonb` разобранным объектом,
 * но драйвер не полагается на это: строка нормализуется (объект или JSON-
 * строка), неполное значение игнорируется (fail-safe — откат просто
 * недоступен, чтение записи не падает).
 */

import type { PluginLockEntry, PluginLockPrevious } from '@itphx/synth-shared';
import type { CatalogTrustLevel } from '@itphx/synth-shared';
import type { PluginScanVerdict } from '@itphx/synth-shared';
import type { PluginLockRepository, StorageContext } from '@itphx/synth-core';
import type { PostgresExecutor } from '../pool.js';
import type { PortDeps } from './deps.js';

type Row = Record<string, unknown>;

function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Разобрать `previous` из `jsonb` (объект или JSON-строка); неполное — `undefined`. */
function normalizePrevious(value: unknown): PluginLockPrevious | undefined {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.version !== 'string' || typeof record.content_hash !== 'string') {
    return undefined;
  }
  const previous: PluginLockPrevious = {
    version: record.version,
    content_hash: record.content_hash,
    installed_at: typeof record.installed_at === 'string' ? record.installed_at : '',
  };
  if (typeof record.entry === 'string') previous.entry = record.entry;
  return previous;
}

interface PluginLockRow extends Row {
  name: string;
  version: string;
  source: string;
  identifier: string | null;
  trust_level: string;
  scan_verdict: string;
  content_hash: string;
  ref: string | null;
  entry: string | null;
  installed_at: Date | string;
  updated_at: Date | string;
  previous?: unknown;
}

function pluginLockRowToEntry(row: PluginLockRow): PluginLockEntry {
  const entry: PluginLockEntry = {
    name: row.name,
    version: row.version,
    source: row.source,
    trust_level: row.trust_level as CatalogTrustLevel,
    scan_verdict: row.scan_verdict as PluginScanVerdict,
    content_hash: row.content_hash,
    installed_at: toISO(row.installed_at),
    updated_at: toISO(row.updated_at),
  };
  if (row.identifier !== null) entry.identifier = row.identifier;
  if (row.ref !== null) entry.ref = row.ref;
  if (row.entry !== null) entry.entry = row.entry;
  const previous = normalizePrevious(row.previous);
  if (previous) entry.previous = previous;
  return entry;
}

/** Реализация порта `PluginLockRepository` поверх SQL. */
class PostgresPluginLockRepository implements PluginLockRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async save(entry: PluginLockEntry): Promise<void> {
    await this._db().query(
      `INSERT INTO plugin_lock
         (name, version, source, identifier, trust_level, scan_verdict, content_hash,
          ref, entry, installed_at, updated_at, previous)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (name) DO UPDATE SET
         version      = EXCLUDED.version,
         source       = EXCLUDED.source,
         identifier   = EXCLUDED.identifier,
         trust_level  = EXCLUDED.trust_level,
         scan_verdict = EXCLUDED.scan_verdict,
         content_hash = EXCLUDED.content_hash,
         ref          = EXCLUDED.ref,
         entry        = EXCLUDED.entry,
         installed_at = plugin_lock.installed_at,
         updated_at   = EXCLUDED.updated_at,
         previous     = EXCLUDED.previous`,
      [
        entry.name,
        entry.version,
        entry.source,
        entry.identifier ?? null,
        entry.trust_level,
        entry.scan_verdict,
        entry.content_hash,
        entry.ref ?? null,
        entry.entry ?? null,
        entry.installed_at,
        entry.updated_at,
        entry.previous ? JSON.stringify(entry.previous) : null,
      ],
    );
  }

  async get(name: string): Promise<PluginLockEntry | null> {
    const rows = await this._db().query<PluginLockRow>(
      'SELECT * FROM plugin_lock WHERE name = $1',
      [name],
    );
    const row = rows[0];
    return row ? pluginLockRowToEntry(row) : null;
  }

  async list(): Promise<PluginLockEntry[]> {
    const rows = await this._db().query<PluginLockRow>(
      'SELECT * FROM plugin_lock ORDER BY name ASC',
    );
    return rows.map(pluginLockRowToEntry);
  }

  async delete(name: string): Promise<boolean> {
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM plugin_lock WHERE name = $1 RETURNING 1) SELECT count(*)::int AS n FROM deleted',
      [name],
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value > 0 : Number(value) > 0;
  }
}

/** Часть `StorageContext`, которой владеет модуль lock-файла плагинов. */
export type PluginLockPorts = Pick<StorageContext, 'pluginLock'>;

/** Собрать порт lock-файла плагинов. */
export function buildPluginLockPorts(deps: PortDeps): PluginLockPorts {
  return {
    pluginLock: new PostgresPluginLockRepository(deps),
  };
}
