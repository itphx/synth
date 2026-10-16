/**
 * Драйвер слоя хранения Synth на PostgreSQL — форма поставки (ADR-096/ADR-097,
 * PROP-032).
 *
 * Пакет `@itphx/synth-storage-postgres` — in-tree **опциональный** драйвер: он
 * реализует доменные порты `StorageContext` и подключается из
 * `createStorageContext` динамическим `import()` при `storage.backend === 'postgres'`.
 *
 * Волна 2b: контракт функции и форма поставки. Реальная реализация портов —
 * следующая волна, поэтому `createPostgresStorage` валидирует конфиг и
 * завершается понятной ошибкой «не реализовано».
 *
 * `pg` — `optionalDependencies` пакета и подключается **лениво** (внутри функции,
 * а не на верхнем уровне модуля): импорт самого драйвера не должен требовать
 * установленного `pg`.
 */

import type { StorageContext, StorageContextConfig } from '@itphx/synth-core';

/**
 * Имя optional-зависимости драйвера. Тип намеренно расширен до `string`, чтобы
 * `import()` не требовал типов `pg` на этапе компиляции (типы — для реализации
 * следующей волны).
 */
const PG_MODULE: string = 'pg';

/** Параметры подключения к PostgreSQL (транслируются в пул `pg`). */
export interface PostgresPoolConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Максимальный размер пула (при отсутствии — дефолт `pg`). */
  max?: number;
  /** Таймаут установления соединения, мс. */
  connectionTimeoutMillis?: number;
  /** Таймаут простаивающего соединения, мс. */
  idleTimeoutMillis?: number;
  /** TLS: `true`/`false` либо объект опций (`ca`/`rejectUnauthorized`/…). */
  ssl?: boolean | Record<string, unknown>;
}

/** Конфиг драйвера: параметры подключения к БД + общие параметры слоя хранения. */
export interface PostgresStorageConfig extends StorageContextConfig {
  /** Строка подключения `postgres://…`; приоритетнее полей `pool`. */
  connectionString?: string;
  /** Параметры подключения, если не задана `connectionString`. */
  pool?: PostgresPoolConfig;
  /** Схема БД (по умолчанию — `public`). */
  schema?: string;
  /** Применять миграции схемы при сборке контекста (по умолчанию — `true`). */
  migrate?: boolean;
}

/** Базовая ошибка драйвера хранения PostgreSQL. */
export class PostgresStorageError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PostgresStorageError';
    this.code = code;
  }
}

/** Конфиг драйвера невалиден (не задан способ подключения и т.п.). */
export class PostgresStorageConfigError extends PostgresStorageError {
  constructor(message: string) {
    super(message, 'STORAGE_POSTGRES_CONFIG_INVALID');
    this.name = 'PostgresStorageConfigError';
  }
}

/** Optional-зависимость `pg` недоступна (не установлена). */
export class PostgresStorageDependencyError extends PostgresStorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'STORAGE_POSTGRES_DEPENDENCY_MISSING', options);
    this.name = 'PostgresStorageDependencyError';
  }
}

/** Реализация портов ещё не поставлена (скелет волны 2b). */
export class PostgresStorageNotImplementedError extends PostgresStorageError {
  constructor(
    message = 'PostgreSQL-драйвер хранения ещё не реализован (PROP-032, скелет волны 2b).',
  ) {
    super(message, 'STORAGE_POSTGRES_NOT_IMPLEMENTED');
    this.name = 'PostgresStorageNotImplementedError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Валидация конфига **до** любого обращения к БД: нужен либо
 * `connectionString`, либо пара `pool.host` + `pool.database`.
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

  const hasConnectionString = isNonEmptyString(config.connectionString);
  const hasPoolFields = !!pool && isNonEmptyString(pool.host) && isNonEmptyString(pool.database);

  if (!hasConnectionString && !hasPoolFields) {
    throw new PostgresStorageConfigError(
      'Не задан способ подключения: укажите `connectionString` либо `pool.host` + `pool.database`.',
    );
  }
}

/**
 * Ленивая загрузка optional-зависимости `pg`.
 *
 * Импорт выполняется внутри функции — модуль драйвера остаётся импортируемым
 * без установленного `pg` (PROP-032 §«Форма поставки»).
 */
async function loadPgModule(): Promise<void> {
  try {
    await import(PG_MODULE);
  } catch (cause) {
    throw new PostgresStorageDependencyError(
      'Не удалось загрузить драйвер `pg` (optional-зависимость). Установите его: pnpm add pg',
      { cause },
    );
  }
}

/**
 * Собрать `StorageContext` на PostgreSQL (форма — ADR-097/PROP-032).
 *
 * Скелет: валидирует конфиг, лениво проверяет наличие `pg` и завершается
 * `PostgresStorageNotImplementedError`; реализация доменных портов
 * (`storage/ports/*`) и прогон контрактного suite — следующая волна.
 */
export async function createPostgresStorage(
  config: PostgresStorageConfig,
): Promise<StorageContext> {
  validatePostgresConfig(config);

  // Ленивая загрузка optional-зависимости (не на верхнем уровне модуля).
  await loadPgModule();

  throw new PostgresStorageNotImplementedError();
}
