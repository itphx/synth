/**
 * Публичная поверхность `@itphx/synth-storage-postgres` — опциональный драйвер
 * слоя хранения Synth на PostgreSQL (ADR-097).
 *
 * Импорт модуля не требует установленного `pg` — драйвер подключается лениво
 * внутри `createPostgresConnection`/`createPostgresStorage`.
 *
 * Волна 3a: подключение (`pool.ts`), схема и миграции (`migrate.ts` +
 * `migrations/*`), сборка контекста (`storage-context.ts`). Волна 3b: каркас
 * портов разложен по четырём файлам-группам `ports/*` (сейчас — заглушки),
 * реализация доменных портов — следующая волна.
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
  sanitizeQueryParams,
} from './pool.js';
export type {
  PostgresPoolConfig,
  PostgresConnectionConfig,
  PostgresExecutor,
  HeldPostgresClient,
} from './pool.js';

// ADR-097: БД-механизмы координации (advisory-локи) — мьютекс, лидер-выбор,
// фабрика `StorageLocks` для `StorageContext.locks`.
export { PgMutex, PgLeader, createPostgresLocks, postgresLockKey, DEFAULT_LEADER_LOCK_NAME } from './locks.js';
export type { PgMutexOptions, PgLeaderOptions } from './locks.js';

// Схема и миграции.
export { runMigrations, assertSchemaCurrent, readSchemaVersion, planMigrations, MIGRATIONS_TABLE } from './migrate.js';
export type { RunMigrationsOptions, MigrationResult, PlannedMigrations } from './migrate.js';
export { MIGRATIONS, latestSchemaVersion } from './migrations/index.js';
export type { PostgresMigration } from './migrations/index.js';

// Идентификаторы схемы.
export { DEFAULT_SCHEMA, assertValidSchema, quoteIdent } from './schema.js';

// Сборка контекста: четыре группы портов (`ports/*`) + файловые FS-порты.
export { buildPostgresStorageContext } from './storage-context.js';
export type { BuildPostgresContextOptions } from './storage-context.js';

// Группы портов (владелец каждого файла — один агент волны реализации).
export { notImplementedPort } from './ports/stub.js';
export type { PortDeps, CoreSyncDeps } from './ports/deps.js';
export { resolveCoreSyncDeps, POSTGRES_EMPTY_USER_DICTIONARIES_SUBDIR } from './ports/core-sync.js';
export { buildSessionPorts } from './ports/sessions.js';
export type { SessionPorts } from './ports/sessions.js';
export { buildPrincipalPorts } from './ports/principals.js';
export type { PrincipalPorts } from './ports/principals.js';
export { buildEventPorts } from './ports/events.js';
export type { EventPorts } from './ports/events.js';
export { buildContentPorts } from './ports/content.js';
export type { ContentPorts } from './ports/content.js';
// ADR-106 (Ф0/Ф1): порты Authority-слоя — политика инстанца (`authority_policy`)
// и append-only журнал решений (`authority_decisions`); миграция 014.
export { buildAuthorityPorts } from './ports/authority.js';
export type { AuthorityPorts } from './ports/authority.js';
// ADR-105 (Ф1): внешние доступы к коннекторам (таблица `external_credentials`,
// миграция 011; шифрование токенов — core-хелперами через ленивый `import()`).
export { buildExternalCredentialPorts } from './ports/external-credentials.js';
export type { ExternalCredentialPorts } from './ports/external-credentials.js';
// ADR-115/ADR-116: учёт ссылок на объекты blob-хранилища (таблица
// `blob_refs`, миграция 024); байты объектов остаются на томе.
export { buildBlobRefPorts, PgBlobRefRepository } from './ports/blob-refs.js';
export type { BlobRefPorts } from './ports/blob-refs.js';
// ADR-116: реестр установок пакетов расширений (ADR-086 §5; таблица
// `pack_installations`, миграция 025) — SQL вместо переходно файловой реализации.
export { buildPackPorts, PgPackRepository } from './ports/packs.js';
export type { PackPorts } from './ports/packs.js';
// ADR-116: legacy-пайплайны инстанса (ADR-051/ADR-100; таблицы
// `pipeline_definitions`/`pipeline_instances`, миграция 025) — не путать с
// движком пайплайнов ADR-101 (`ports/pipelines.ts`).
export { buildLegacyPipelinePorts, PgPipelineRepository } from './ports/legacy-pipelines.js';
export type { LegacyPipelinePorts } from './ports/legacy-pipelines.js';
// ADR-116: instance-скиллы — метаданные в SQL (`instance_skills`, миграция 026),
// содержимое — в blob-сторе (`skills/<name>/…`); порт не отдаёт путей.
export { buildSkillPorts, PgSkillRepository } from './ports/skills.js';
export type { SkillPorts } from './ports/skills.js';
