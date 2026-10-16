/**
 * Драйвер слоя хранения Synth на PostgreSQL — публичная фабрика (ADR-096/ADR-097,
 * PROP-032).
 *
 * Пакет `@itphx/synth-storage-postgres` — in-tree **опциональный** драйвер: он
 * реализует доменные порты `StorageContext` и подключается из
 * `createStorageContext` динамическим `import()` при `storage.backend === 'postgres'`.
 *
 * Волна 3a — **инфраструктура**: пул/подключение, схема БД и миграции
 * (`migrate.ts` + `migrations/*`), сборка контекста (`storage-context.ts`).
 * Доменные порты реализуются следующей волной, поэтому `createPostgresStorage`
 * применяет (или проверяет) схему и возвращает контекст с файловыми FS-портами
 * и заглушками PG-портов.
 *
 * `pg` — `optionalDependencies` пакета и подключается **лениво** (`pool.ts`):
 * импорт модуля драйвера не требует установленного `pg`.
 */

import type { StorageContext, StorageContextConfig } from '@itphx/synth-core';
import { PostgresStorageConfigError } from './errors.js';
import { assertSchemaCurrent, runMigrations } from './migrate.js';
import {
  createPostgresConnection,
  type PostgresConnectionConfig,
} from './pool.js';
import { DEFAULT_SCHEMA, assertValidSchema } from './schema.js';
import { buildPostgresStorageContext } from './storage-context.js';

// Реэкспорт ошибок драйвера (в т.ч. для обратной совместимости импортов).
export * from './errors.js';
export type { PostgresPoolConfig, PostgresConnectionConfig } from './pool.js';
export type { PostgresExecutor } from './pool.js';

/** Конфиг драйвера: параметры подключения к БД + общие параметры слоя хранения. */
export interface PostgresStorageConfig extends StorageContextConfig, PostgresConnectionConfig {
  /** Схема БД (по умолчанию — `public`). */
  schema?: string;
  /** Применять миграции схемы при сборке контекста (по умолчанию — `true`). */
  migrate?: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Валидация конфига **до** любого обращения к БД: нужен либо
 * `connectionString`, либо пара `pool.host` + `pool.database`; схема — безопасный
 * идентификатор.
 */
export function validatePostgresConfig(config: PostgresStorageConfig): void {
  if (!isNonEmptyString(config.dataDir)) {
    throw new PostgresStorageConfigError('Не задан `dataDir` (базовый каталог инстанса).');
  }

  const pool = config.pool;
  if (pool !== undefined) {
    const port = pool.port;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new PostgresStorageConfigError(
        `Некорректный \`pool.port\`: ${String(port)} (ожидается целое 1–65535).`,
      );
    }
  }

  if (config.schema !== undefined) assertValidSchema(config.schema);

  const hasConnectionString = isNonEmptyString(config.connectionString);
  const hasPoolFields = !!pool && isNonEmptyString(pool.host) && isNonEmptyString(pool.database);

  if (!hasConnectionString && !hasPoolFields) {
    throw new PostgresStorageConfigError(
      'Не задан способ подключения: укажите `connectionString` либо `pool.host` + `pool.database`.',
    );
  }
}

/**
 * Собрать `StorageContext` на PostgreSQL (форма — ADR-097/PROP-032).
 *
 * Валидирует конфиг, лениво подключается к БД, применяет миграции (или, при
 * `migrate:false`, проверяет актуальность схемы — fail-closed) и возвращает
 * контекст: FS/package-bound порты (`skills`/`contextFiles`/`blobs`) — файловые,
 * остальные — заглушки PG (порты реализуются следующей волной).
 */
export async function createPostgresStorage(config: PostgresStorageConfig): Promise<StorageContext> {
  validatePostgresConfig(config);

  const schema = config.schema ?? DEFAULT_SCHEMA;
  const conn = createPostgresConnection({
    connectionString: config.connectionString,
    pool: config.pool,
    password: config.password,
    schema,
    statementTimeoutMillis: config.statementTimeoutMillis,
    idleInTransactionTimeoutMillis: config.idleInTransactionTimeoutMillis,
    applicationName: config.applicationName,
  });

  try {
    if (config.migrate === false) {
      await assertSchemaCurrent(conn, { schema });
    } else {
      await runMigrations(conn, { schema });
    }
  } catch (err) {
    await conn.end().catch(() => undefined);
    throw err;
  }

  // Волна 3a: соединение не удерживается в контексте (порты — заглушки),
  // поэтому пул закрывается, чтобы не утекал. Следующая волна удержит соединение
  // внутри PG-реализаций портов.
  await conn.end().catch(() => undefined);

  return buildPostgresStorageContext({
    dataDir: config.dataDir,
    secretKey: config.secretKey,
    env: config.env,
  });
}
