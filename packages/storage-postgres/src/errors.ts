/**
 * Ошибки PostgreSQL-драйвера хранения (ADR-097).
 *
 * Здесь живут и «конфигурационные» ошибки драйвера, и маппинг сырых ошибок
 * `pg`/PostgreSQL в доменные классы. Маппинг — интерфейс для следующих волн
 * (порты): SQLSTATE 23505/42P01/55P03 и сетевые ошибки соединения получают
 * собственные типы, прочее — общий `PostgresQueryError`.
 */

/** Базовая ошибка драйвера хранения PostgreSQL. */
export class PostgresStorageError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PostgresStorageError';
    this.code = code;
  }
}

/** Конфиг драйвера невалиден (не задан способ подключения, плохая схема и т.п.). */
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

/** Реализация портов ещё не поставлена (инфраструктурная волна). */
export class PostgresStorageNotImplementedError extends PostgresStorageError {
  constructor(
    message = 'PostgreSQL-драйвер хранения: реализация портов ещё не поставлена (ADR-097).',
  ) {
    super(message, 'STORAGE_POSTGRES_NOT_IMPLEMENTED');
    this.name = 'PostgresStorageNotImplementedError';
  }
}

/** Версия схемы БД несовместима с ожидаемой драйвером (fail-closed). */
export class PostgresStorageSchemaError extends PostgresStorageError {
  constructor(message: string, code: 'STORAGE_POSTGRES_SCHEMA_TOO_NEW' | 'STORAGE_POSTGRES_SCHEMA_OUTDATED') {
    super(message, code);
    this.name = 'PostgresStorageSchemaError';
  }
}

/** Нарушение уникальности (SQLSTATE 23505). */
export class PostgresUniqueViolationError extends PostgresStorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'STORAGE_POSTGRES_UNIQUE_VIOLATION', options);
    this.name = 'PostgresUniqueViolationError';
  }
}

/** Обращение к несуществующей таблице (SQLSTATE 42P01) — обычно рассинхрон схемы. */
export class PostgresUndefinedTableError extends PostgresStorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'STORAGE_POSTGRES_UNDEFINED_TABLE', options);
    this.name = 'PostgresUndefinedTableError';
  }
}

/** Не удалось взять блокировку/таймаут ожидания (SQLSTATE 55P03 и производные). */
export class PostgresLockTimeoutError extends PostgresStorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'STORAGE_POSTGRES_LOCK_TIMEOUT', options);
    this.name = 'PostgresLockTimeoutError';
  }
}

/** Сбой соединения с БД (SQLSTATE класса 08, 57P0x либо сетевой код Node). */
export class PostgresConnectionError extends PostgresStorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'STORAGE_POSTGRES_CONNECTION', options);
    this.name = 'PostgresConnectionError';
  }
}

/** Прочий сбой SQL-запроса (дефолт маппинга). */
export class PostgresQueryError extends PostgresStorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'STORAGE_POSTGRES_QUERY', options);
    this.name = 'PostgresQueryError';
  }
}

/** Сетевые коды Node, сигнализирующие о недоступности/обрыве соединения. */
const CONNECTION_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
]);

function isConnectionFailure(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  if (CONNECTION_ERRNO.has(code)) return true;
  // SQLSTATE: класс 08 — connection exceptions; 57P01/57P02/57P03 — shutdown/terminating.
  return code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03';
}

/**
 * Маппинг сырой ошибки `pg`/PostgreSQL в доменный класс драйвера.
 *
 * Идемпотентен: уже доменная `PostgresStorageError` возвращается как есть (важно
 * для вложенных хелперов — `withTransaction`/`withAdvisoryLock` не оборачивают
 * ошибки callback'а повторно).
 */
export function mapPgError(err: unknown): PostgresStorageError {
  if (err instanceof PostgresStorageError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null | undefined)?.code;

  switch (code) {
    case '23505':
      return new PostgresUniqueViolationError(message, { cause: err });
    case '42P01':
      return new PostgresUndefinedTableError(message, { cause: err });
    case '55P03':
    case '55P02':
      return new PostgresLockTimeoutError(message, { cause: err });
    default:
      break;
  }

  if (isConnectionFailure(code)) return new PostgresConnectionError(message, { cause: err });
  return new PostgresQueryError(message, { cause: err });
}
