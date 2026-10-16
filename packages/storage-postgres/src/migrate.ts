/**
 * Применение и проверка миграций схемы PostgreSQL (PROP-032, волна 3a).
 *
 * Свой контур версионирования (НЕ `meta.json`/ADR-092): таблица
 * `synth_schema_migrations(version int PK, id text, applied_at timestamptz)` в
 * схеме драйвера. Применение сериализуется session-level advisory-локом, каждая
 * миграция идёт в транзакции (DDL + запись версии — атомарно).
 *
 * Политика fail-closed: версия в БД **больше** ожидаемой → ошибка
 * (`STORAGE_POSTGRES_SCHEMA_TOO_NEW`) — инстанс откатывали к старой версии
 * драйвера поверх новой схемы. При `migrate:false` (DBA-режим) схема обязана
 * быть ровно актуальной, иначе `STORAGE_POSTGRES_SCHEMA_OUTDATED`.
 */

import {
  PostgresStorageSchemaError,
  mapPgError,
} from './errors.js';
import { MIGRATIONS, latestSchemaVersion, type PostgresMigration } from './migrations/index.js';
import type { PostgresConnection, PostgresExecutor } from './pool.js';
import { DEFAULT_SCHEMA, assertValidSchema, quoteIdent } from './schema.js';

/** Имя таблицы версий схемы (в схеме драйвера, без квалификации). */
export const MIGRATIONS_TABLE = 'synth_schema_migrations';

/** Опции прогона/проверки миграций. */
export interface RunMigrationsOptions {
  schema?: string;
  /** Набор миграций (по умолчанию — полный реестр драйвера). */
  migrations?: readonly PostgresMigration[];
}

/** Итог применения: целевая версия и список применённых в этом прогоне версий. */
export interface MigrationResult {
  schema: string;
  version: number;
  applied: number[];
}

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  version    integer PRIMARY KEY,
  id         text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

function resolveSchema(options: RunMigrationsOptions | undefined): string {
  return assertValidSchema(options?.schema ?? DEFAULT_SCHEMA);
}

function resolveMigrations(options: RunMigrationsOptions | undefined): readonly PostgresMigration[] {
  return options?.migrations ?? MIGRATIONS;
}

/**
 * Текущая (максимальная применённая) версия схемы; `null` — таблицы миграций
 * (или схемы) ещё нет.
 */
export async function readSchemaVersion(
  executor: PostgresExecutor,
  schema: string = DEFAULT_SCHEMA,
): Promise<number | null> {
  const safeSchema = assertValidSchema(schema);
  const reg = await executor.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [
    `${quoteIdent(safeSchema)}.${MIGRATIONS_TABLE}`,
  ]);
  if (!reg[0]?.t) return null;
  const rows = await executor.query<{ version: number }>(
    `SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version DESC LIMIT 1`,
  );
  return rows[0]?.version ?? null;
}

function tooNewError(schema: string, actual: number, expected: number): PostgresStorageSchemaError {
  return new PostgresStorageSchemaError(
    `Схема БД '${schema}' новее поддержанной драйвером: в БД версия ${actual}, ` +
      `драйвер умеет максимум ${expected}. Похоже, инстанс откатили к более старой ` +
      `версии Synth поверх новой схемы. Обновите пакеты либо восстановите данные из бэкапа.`,
    'STORAGE_POSTGRES_SCHEMA_TOO_NEW',
  );
}

function outdatedError(schema: string, actual: number | null, expected: number): PostgresStorageSchemaError {
  const actualLabel = actual === null ? 'не найдена (таблица миграций отсутствует)' : String(actual);
  return new PostgresStorageSchemaError(
    `Схема БД '${schema}' не актуальна: текущая версия ${actualLabel}, ожидается ${expected}. ` +
      `Примените миграции (storage.postgres.migrate=true / \`synth migrate\`) либо обновите схему вручную.`,
    'STORAGE_POSTGRES_SCHEMA_OUTDATED',
  );
}

/**
 * План миграций схемы **без** применения: текущая/ожидаемая версии и версии,
 * требующие применения (для `synth migrate --dry-run` и диагностики).
 */
export interface PlannedMigrations {
  current: number | null;
  expected: number;
  pending: number[];
}

/**
 * Построить план миграций (read-only): текущая версия из БД, ожидаемая —
 * максимум реестра, `pending` — версии больше текущей (по возрастанию).
 */
export async function planMigrations(
  executor: PostgresExecutor,
  options?: RunMigrationsOptions,
): Promise<PlannedMigrations> {
  const schema = resolveSchema(options);
  const migrations = [...resolveMigrations(options)].sort((a, b) => a.version - b.version);
  const expected = latestSchemaVersion(migrations);
  const current = await readSchemaVersion(executor, schema);
  const pending = migrations
    .filter((migration) => current === null || migration.version > current)
    .map((migration) => migration.version);
  return { current, expected, pending };
}

/**
 * Применить недостающие миграции. `CREATE SCHEMA IF NOT EXISTS`, advisory-лок,
 * применение по возрастанию версии; версия в БД > ожидаемой → fail-closed.
 */
export async function runMigrations(
  conn: PostgresConnection,
  options?: RunMigrationsOptions,
): Promise<MigrationResult> {
  const schema = resolveSchema(options);
  const migrations = [...resolveMigrations(options)].sort((a, b) => a.version - b.version);
  const target = latestSchemaVersion(migrations);

  // Схема создаётся до лока: соединения пула укажут её в search_path.
  await conn.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);

  return conn.withAdvisoryLock(`synth:migrate:${schema}`, async (tx) => {
    await tx.query(CREATE_MIGRATIONS_TABLE);

    const rows = await tx.query<{ version: number }>(
      `SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version`,
    );
    const appliedVersions = new Set(rows.map((r) => r.version));
    const maxApplied = rows.reduce((max, r) => (r.version > max ? r.version : max), 0);

    if (maxApplied > target) throw tooNewError(schema, maxApplied, target);

    const applied: number[] = [];
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      try {
        await tx.query('BEGIN');
        await tx.query(migration.sql);
        await tx.query(`INSERT INTO ${MIGRATIONS_TABLE} (version, id) VALUES ($1, $2)`, [
          migration.version,
          migration.id,
        ]);
        await tx.query('COMMIT');
      } catch (err) {
        try {
          await tx.query('ROLLBACK');
        } catch {
          // rollback best-effort — исходная ошибка важнее
        }
        throw mapPgError(err);
      }
      applied.push(migration.version);
    }

    return { schema, version: target, applied };
  });
}

/**
 * Проверить актуальность схемы **без** применения (DBA-режим `migrate:false`).
 * Схема отстаёт/отсутствует или новее ожидаемой → `PostgresStorageSchemaError`.
 */
export async function assertSchemaCurrent(
  executor: PostgresExecutor,
  options?: RunMigrationsOptions,
): Promise<number> {
  const schema = resolveSchema(options);
  const target = latestSchemaVersion(resolveMigrations(options));
  const actual = await readSchemaVersion(executor, schema);
  if (actual === null || actual < target) throw outdatedError(schema, actual, target);
  if (actual > target) throw tooNewError(schema, actual, target);
  return actual;
}
