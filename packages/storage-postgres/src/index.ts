/**
 * Публичная поверхность `@itphx/synth-storage-postgres` — опциональный драйвер
 * слоя хранения Synth на PostgreSQL (ADR-096/ADR-097, PROP-032).
 *
 * Импорт модуля не требует установленного `pg` — драйвер подключается лениво
 * внутри `createPostgresStorage`.
 */

export {
  createPostgresStorage,
  validatePostgresConfig,
  PostgresStorageError,
  PostgresStorageConfigError,
  PostgresStorageDependencyError,
  PostgresStorageNotImplementedError,
} from './postgres-storage.js';
export type { PostgresStorageConfig, PostgresPoolConfig } from './postgres-storage.js';
