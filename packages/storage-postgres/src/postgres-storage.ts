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
import { resolveCoreSyncDeps } from './ports/core-sync.js';
import type { CoreSyncDeps } from './ports/deps.js';
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
  /**
   * PROP-032: режим работы со схемой при сборке (`apply`/`assert`/`skip`);
   * приоритетнее `migrate`. `skip` — только подключение (диагностика/CLI,
   * управляющие миграциями сами). Не задан — выводится из `migrate`
   * (`false` → `assert`, иначе `apply`).
   */
  schemaMode?: 'apply' | 'assert' | 'skip';
  /**
   * ADR-097/PROP-032: синхронные данные/хелперы core (`secretPatterns`/
   * `protectedPaths`/`dictionaries`), инъектируемые core'ом
   * (`packages/core/src/storage/storage-context.ts`). Не заданы (прямой вызов
   * фабрики) — драйвер собирает их ленивым `import('@itphx/synth-core')`.
   */
  coreSync?: CoreSyncDeps;
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
    // PROP-032: режим схемы — `apply` (дефолт), `assert` (DBA), `skip` (диагностика).
    const schemaMode = config.schemaMode ?? config.postgresSchemaMode
      ?? (config.migrate === false ? 'assert' : 'apply');
    if (schemaMode === 'assert') {
      await assertSchemaCurrent(conn, { schema });
    } else if (schemaMode === 'apply') {
      await runMigrations(conn, { schema });
    }
  } catch (err) {
    await conn.end().catch(() => undefined);
    throw err;
  }

  // PROP-032: соединение удерживается в контексте (порты БД ходят через него),
  // `ctx.close()` закрывает пул. Незанятые соединения не удерживают event loop
  // (`allowExitOnIdle` в `pool.ts`), поэтому CLI-команды завершаются.
  return buildPostgresStorageContext({
    dataDir: config.dataDir,
    secretKey: config.secretKey,
    env: config.env,
    systemDictionariesDir: config.systemDictionariesDir,
    contextUserDataDir: config.contextUserDataDir,
    connection: conn,
    // Инъекция из core (штатный путь) либо ленивый `import()` (прямой вызов).
    coreSync:
      config.coreSync ??
      (await resolveCoreSyncDeps({
        dataDir: config.dataDir,
        systemDictionariesDir: config.systemDictionariesDir,
      })),
  });
}
