/**
 * Публичная поверхность `@itphx/synth-storage-postgres` — опциональный драйвер
 * слоя хранения Synth на PostgreSQL (ADR-096/ADR-097, PROP-032).
 *
 * Импорт модуля не требует установленного `pg` — драйвер подключается лениво
 * внутри `createPostgresConnection`/`createPostgresStorage`.
 *
 * Волна 3a: подключение (`pool.ts`), схема и миграции (`migrate.ts` +
 * `migrations/*`), сборка контекста (`storage-context.ts`). Доменные порты —
 * следующая волна.
 */

export { createPostgresStorage, validatePostgresConfig } from './postgres-storage.js';
export type { PostgresStorageConfig } from './postgres-storage.js';

// Ошибки драйвера + маппинг сырых ошибок `pg` в доменные классы.
export * from './errors.js';

// Пул/подключение и низкоуровневые хелперы (запросы, транзакции, advisory-локи).
export {
  createPostgresConnection,
  PostgresConnection,
  advisoryLockKeyToBigInt,
  loadPgModule,
} from './pool.js';
export type { PostgresPoolConfig, PostgresConnectionConfig, PostgresExecutor } from './pool.js';

// Схема и миграции.
export { runMigrations, assertSchemaCurrent, readSchemaVersion, MIGRATIONS_TABLE } from './migrate.js';
export type { RunMigrationsOptions, MigrationResult } from './migrate.js';
export { MIGRATIONS, latestSchemaVersion } from './migrations/index.js';
export type { PostgresMigration } from './migrations/index.js';

// Идентификаторы схемы.
export { DEFAULT_SCHEMA, assertValidSchema, quoteIdent } from './schema.js';

// Сборка контекста (FS/package-bound порты — файловые, остальные — заглушки PG).
export { buildPostgresStorageContext, notImplementedPort } from './storage-context.js';
export type { BuildPostgresContextOptions } from './storage-context.js';
