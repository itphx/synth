/**
 * Пул соединений и низкоуровневые хелперы PostgreSQL-драйвера (ADR-097, волна 3a).
 *
 * Модуль **не требует** установленного `pg` на импорте: `pg` подключается лениво,
 * внутри `createPostgresConnection`/при первом обращении к пулу (типы `pg` приходят
 * из `@types/pg` и стираются на этапе компиляции). Это требование формы поставки
 * (`pg` — `optionalDependencies`, ADR-097).
 *
 * Публичные примитивы следующей волны (портов):
 *   - `query(text, params)` — запрос через пул (с маппингом ошибок);
 *   - `withTransaction(fn)` — транзакция на выделенном соединении;
 *   - `withAdvisoryLock(key, fn)` — session-level advisory-лок (выделенное соединение);
 *   - `tryAdvisoryLock(key, fn)` — неблокирующий вариант (`pg_try_advisory_lock`).
 */

import { createHash } from 'node:crypto';
import type { Pool as PgPool, PoolClient as PgPoolClient, QueryResultRow } from 'pg';
import {
  buildPostgresSslOptions,
  findDsnTlsParams,
  stripNullBytes,
  type PostgresSslMode,
  type SecurityTlsConfig,
  type TlsRuntimeSettings,
} from '@itphx/synth-shared';
import {
  PostgresConnectionError,
  PostgresStorageConfigError,
  PostgresStorageDependencyError,
  mapPgError,
} from './errors.js';
import { DEFAULT_SCHEMA, assertValidSchema, quoteIdent } from './schema.js';

/** Локальный тип модуля `pg` (пакет опционален, но резолвится в рантайме). */
interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPool;
  Client: new (config: Record<string, unknown>) => PgPoolClient & { end(): Promise<void> };
}

/** Аннотация `string` намеренная — `import()` не должен резолвиться на этапе типов. */
const PG_MODULE: string = 'pg';

/** Кэш модуля `pg` на процесс (ленивая загрузка, без верхнеуровневого импорта). */
let pgModulePromise: Promise<PgModule> | null = null;

/** Лениво загружает optional-зависимость `pg` (один раз на процесс). */
export async function loadPgModule(): Promise<PgModule> {
  if (!pgModulePromise) {
    pgModulePromise = (async () => {
      let mod: unknown;
      try {
        mod = await import(PG_MODULE);
      } catch (cause) {
        throw new PostgresStorageDependencyError(
          'Не удалось загрузить драйвер `pg` (optional-зависимость). Установите его: pnpm add pg',
          { cause },
        );
      }
      const candidate = mod as { Pool?: unknown; default?: { Pool?: unknown } };
      const Pool = candidate.Pool ?? candidate.default?.Pool;
      if (typeof Pool !== 'function') {
        throw new PostgresStorageDependencyError('Модуль `pg` не экспортирует Pool (несовместимая версия).');
      }
      return mod as PgModule;
    })().catch((err) => {
      // Сбрасываем кэш при неудаче, чтобы следующий вызов повторил попытку.
      pgModulePromise = null;
      throw err;
    });
  }
  return pgModulePromise;
}

/** Параметры подключения/пула, транслируемые в `pg.Pool`. */
export interface PostgresPoolConfig {
  host?: string;
  port?: number;
  user?: string;
  /** Пароль (инвариант 13: env/файл; в config.yaml не хранится). */
  password?: string;
  database?: string;
  /** Максимальный размер пула (дефолт драйвера — 10). */
  max?: number;
  /** Таймаут установления соединения, мс (дефолт 5000). */
  connectionTimeoutMillis?: number;
  /** Таймаут простаивающего соединения, мс (дефолт 30000). */
  idleTimeoutMillis?: number;
  /**
   * ADR-099/ADR-097: TLS-режим (`disable`/`require`/`verify-full`; `verify-ca` —
   * алиас `verify-full`). Не задан — используется legacy `ssl`, иначе без TLS.
   */
  sslmode?: PostgresSslMode;
  /**
   * TLS: `true`/`false` либо объект опций (`ca`/`rejectUnauthorized`/…).
   * Legacy-поле: применяется, только если `sslmode` не задан.
   */
  ssl?: boolean | Record<string, unknown>;
}

/** Конфиг подключения драйвера (подмножество полного конфига драйвера). */
export interface PostgresConnectionConfig {
  /** Строка подключения `postgres://…`; приоритетнее полей `pool`. */
  connectionString?: string;
  /** Параметры подключения, если не задана `connectionString`. */
  pool?: PostgresPoolConfig;
  /**
   * ADR-099: доверие TLS/CA (`security.tls`) — источник CA/mTLS для
   * `sslmode=verify-full` (`buildPostgresSslOptions`).
   */
  tls?: SecurityTlsConfig;
  /**
   * ADR-099: runtime bootstrap-настройки TLS (`{dataDir}/security-tls.json`) —
   * per-host mTLS-профили (выбор по `host` БД) и CA/rejectUnauthorized.
   */
  tlsRuntime?: TlsRuntimeSettings;
  /** Env для резолва `security.tls` (ADR-023: env > runtime > config). */
  env?: NodeJS.ProcessEnv;
  /** Пароль БД отдельным полем (env/файл) — приоритетнее `pool.password`. */
  password?: string;
  /** Схема БД (namespace таблиц); по умолчанию `public`. */
  schema?: string;
  /** `statement_timeout`, мс (дефолт 15000). */
  statementTimeoutMillis?: number;
  /** `idle_in_transaction_session_timeout`, мс (дефолт 60000). */
  idleInTransactionTimeoutMillis?: number;
  /** `application_name` (дефолт `synth`). */
  applicationName?: string;
}

export const DEFAULT_POOL_MAX = 10;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_APPLICATION_NAME = 'synth';
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Исполнитель запросов: общий контракт для пула (`query`) и выделенного
 * соединения (транзакция/advisory-лок). Возвращает массив строк.
 */
export interface PostgresExecutor {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
}

/**
 * ADR-097: выделенное соединение, удерживаемое вызывающим (напр. для
 * session-level advisory-лока лидера). Пока оно не возвращено в пул, пул не
 * может его переиспользовать — держите не больше одного такого соединения на
 * процесс, если в этом нет необходимости (`poolMax` по умолчанию невелик).
 */
export interface HeldPostgresClient {
  /** Исполнитель запросов на выделенном соединении. */
  executor: PostgresExecutor;
  /** Вернуть соединение в пул (идемпотентно, best-effort). */
  release(): void;
  /** Подписка на разрыв/ошибку соединения (детект потери advisory-лока). */
  onError(handler: (err: unknown) => void): void;
}

/** Преобразует пользовательский ключ в 64-битный знаковый advisory-лок-ключ. */
export function advisoryLockKeyToBigInt(key: string): bigint {
  const digest = createHash('sha256').update(key).digest();
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value = (value << 8n) | BigInt(digest[i] ?? 0);
  }
  const SIGN = 0x8000000000000000n;
  const MOD = 0x1_0000_0000_0000_0000n;
  return value >= SIGN ? value - MOD : value;
}

/** Собирает объект конфигурации `pg.Pool` из конфига драйвера. */
export function buildPoolConfig(config: PostgresConnectionConfig, schema: string): Record<string, unknown> {
  // ADR-099/ADR-097: TLS-параметры в DSN запрещены — `pg` накладывает DSN поверх
  // конфига (`Object.assign({}, config, parse(connectionString))`) и молча
  // перекрывает явные ssl-опции (вплоть до отключения TLS).
  assertNoDsnTlsParams(config.connectionString);

  const pool = config.pool;
  const pgConfig: Record<string, unknown> = {
    max: pool?.max ?? DEFAULT_POOL_MAX,
    connectionTimeoutMillis: pool?.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: pool?.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
    // ADR-097: незанятые соединения не удерживают event loop — CLI-команды
    // (`synth migrate`/`doctor`/…) со `storage.backend=postgres` завершаются,
    // а не висят вечно из-за открытых idle-клиентов пула.
    allowExitOnIdle: true,
    statement_timeout: config.statementTimeoutMillis ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout:
      config.idleInTransactionTimeoutMillis ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: config.applicationName ?? DEFAULT_APPLICATION_NAME,
    // Схема драйвера — первая в search_path (таблицы без квалификации).
    options: `-c search_path=${quoteIdent(schema)},public`,
  };

  if (config.connectionString) {
    pgConfig.connectionString = config.connectionString;
  } else {
    if (pool?.host) pgConfig.host = pool.host;
    if (pool?.port !== undefined) pgConfig.port = pool.port;
    if (pool?.user) pgConfig.user = pool.user;
    if (pool?.database) pgConfig.database = pool.database;
  }

  const password = config.password ?? pool?.password;
  if (password) pgConfig.password = password;

  // ADR-099/ADR-097: единый источник TLS — `sslmode` (`storage.postgres.sslmode`)
  // + `security.tls` (CA/mTLS). Не задан — прежнее поведение (legacy `ssl` либо
  // дефолт `pg` — без TLS). Ошибки сборки (нет CA при `verify-full`) — fail-closed
  // доменной ошибкой конфигурации.
  if (pool?.sslmode !== undefined) {
    let ssl: boolean | Record<string, unknown> | undefined;
    try {
      ssl = buildPostgresSslOptions({
        sslmode: pool.sslmode,
        connectionString: config.connectionString,
        host: pool.host,
        config: config.tls ? { security: { tls: config.tls } } : undefined,
        env: config.env,
        runtime: config.tlsRuntime,
      }).ssl;
    } catch (err) {
      throw new PostgresStorageConfigError(err instanceof Error ? err.message : String(err));
    }
    if (ssl !== undefined) pgConfig.ssl = ssl;
  } else if (pool?.ssl !== undefined) {
    pgConfig.ssl = pool.ssl;
  }

  return pgConfig;
}

/**
 * ADR-099/ADR-097: fail-closed проверка DSN на TLS-параметры. DSN из
 * `storage.postgres.dsn` не должен нести `sslmode`/`sslrootcert`/`sslcert`/`sslkey`/…:
 * `pg` накладывает DSN поверх конфига и молча перекрывает `ssl`-объект, что
 * обнуляло бы политику CA. Задавайте TLS только в `storage.postgres.sslmode` +
 * `security.tls`.
 */
export function assertNoDsnTlsParams(connectionString: string | undefined): void {
  const found = findDsnTlsParams(connectionString);
  if (found.length === 0) return;
  throw new PostgresStorageConfigError(
    `TLS-параметры в DSN запрещены (обнаружено: ${found.join(', ')}). ` +
      'Драйвер `pg` накладывает DSN поверх конфига и молча перекрывает ssl-опции ' +
      '(вплоть до отключения TLS) — уберите TLS-параметры из DSN или задайте их ' +
      'только в storage.postgres.sslmode + security.tls',
  );
}

/** Минимальный контракт соединения/пула `pg` (без жёсткой привязки к overload-ам). */
interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Защитная сеть драйвера: удаляет реальные U+0000 из строковых параметров
 * запроса (PostgreSQL отвергает их в `text`/`jsonb`). `Buffer`, числа и прочие
 * не-строки не трогаются; SQL-текст не меняется. JSON-параметры дополнительно
 * санитизируются до `JSON.stringify` (`jsonbParam`), иначе NUL стал бы escape'ом
 * `\u0000`, который в готовой строке уже неотличим от литеральной
 * последовательности.
 */
export function sanitizeQueryParams(params?: unknown[]): unknown[] | undefined {
  if (!params || params.length === 0) return params;
  let changed = false;
  const sanitized = params.map((param) => {
    if (typeof param === 'string' && param.includes('\u0000')) {
      changed = true;
      return stripNullBytes(param);
    }
    return param;
  });
  return changed ? sanitized : params;
}

/** Обёртка-исполнитель над соединением с маппингом ошибок в доменные классы. */
function wrapExecutor(client: PgQueryable): PostgresExecutor {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]> {
      try {
        const result = await client.query(text, sanitizeQueryParams(params));
        return result.rows as T[];
      } catch (err) {
        throw mapPgError(err);
      }
    },
  };
}

/**
 * Соединение с PostgreSQL: ленивый пул + примитивы запросов/транзакций/локов.
 * Каждый вызов `createPostgresConnection` создаёт независимое соединение
 * (никаких модульных синглтонов — важно для герметичных тестов и переключаемых схем).
 */
export class PostgresConnection implements PostgresExecutor {
  private readonly _schema: string;
  private readonly _poolConfig: Record<string, unknown>;
  private _pool: PgPool | null = null;
  /** `end()` уже вызван: пул закрыт, ленивое пересоздание запрещено. */
  private _closed = false;

  constructor(config: PostgresConnectionConfig) {
    this._schema = assertValidSchema(config.schema ?? DEFAULT_SCHEMA);
    this._poolConfig = buildPoolConfig(config, this._schema);
  }

  /** Схема, к которой привязано соединение. */
  get schema(): string {
    return this._schema;
  }

  /** Ленивое создание пула (первое обращение к БД). */
  async getPool(): Promise<PgPool> {
    // ADR-097 (W5): после `end()` пул не пересоздаётся — иначе запрос после
    // `close()` снова поднимал бы соединение и «закрытие» было бы фиктивным.
    if (this._closed) {
      throw new PostgresConnectionError(
        'Соединение с PostgreSQL закрыто (end()): пул недоступен.',
      );
    }
    if (!this._pool) {
      const pg = await loadPgModule();
      this._pool = new pg.Pool(this._poolConfig);
    }
    return this._pool;
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]> {
    const pool = await this.getPool();
    try {
      const result = await pool.query<T>(text, sanitizeQueryParams(params));
      return result.rows;
    } catch (err) {
      throw mapPgError(err);
    }
  }

  /** Транзакция на выделенном соединении; ошибка callback'а → `ROLLBACK`. */
  async withTransaction<T>(fn: (tx: PostgresExecutor) => Promise<T>): Promise<T> {
    const client = await this._acquire();
    const tx = wrapExecutor(client);
    try {
      await tx.query('BEGIN');
      const result = await fn(tx);
      await tx.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await tx.query('ROLLBACK');
      } catch {
        // rollback best-effort: соединение вернётся в пул, исходная ошибка важнее
      }
      throw mapPgError(err);
    } finally {
      client.release();
    }
  }

  /**
   * Выполнить `fn` под session-level advisory-локом (выделенное соединение:
   * лок живёт всю сессию, не транзакцию). Результат `fn` возвращается.
   */
  async withAdvisoryLock<T>(key: string, fn: (tx: PostgresExecutor) => Promise<T>): Promise<T> {
    const lockKey = advisoryLockKeyToBigInt(key).toString();
    return this._withDedicatedClient(async (tx) => {
      await tx.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
      try {
        return await fn(tx);
      } finally {
        await tx.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]).catch(() => undefined);
      }
    });
  }

  /**
   * Неблокирующий advisory-лок: `acquired:false`, если лок уже кем-то взят
   * (свой или чужой процесс). Успех — `{ acquired:true, result }`.
   */
  async tryAdvisoryLock<T>(
    key: string,
    fn: (tx: PostgresExecutor) => Promise<T>,
  ): Promise<{ acquired: boolean; result?: T }> {
    const lockKey = advisoryLockKeyToBigInt(key).toString();
    return this._withDedicatedClient(async (tx) => {
      const rows = await tx.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [lockKey],
      );
      if (rows[0]?.locked !== true) return { acquired: false };
      try {
        const result = await fn(tx);
        return { acquired: true, result };
      } finally {
        await tx.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]).catch(() => undefined);
      }
    });
  }

  /**
   * Захватить выделенное соединение, удерживаемое вызывающим (не возвращается в
   * пул до `release()`). Нужно для session-level advisory-локов: лок живёт ровно
   * столько, сколько открыто соединение, и снимается автоматически при его
   * разрыве/закрытии (ADR-097).
   */
  async acquireHeldClient(): Promise<HeldPostgresClient> {
    const client = await this._acquire();
    const executor = wrapExecutor(client);
    let released = false;
    const errorHandlers: Array<(err: unknown) => void> = [];

    // `pg.PoolClient` — EventEmitter; на ошибке соединения (сервер упал, сеть
    // оборвалась) эмитит `error`. Потребитель (лидер) снимает себя с лидерства.
    // Слушатель снимаем на `release()`: клиент возвращается в пул и
    // переиспользуется — иначе накопились бы «висячие» обработчики.
    const onClientError = (err: unknown): void => {
      for (const handler of errorHandlers) {
        try {
          handler(err);
        } catch {
          // обратный вызов потребителя не должен ломать обработку ошибки
        }
      }
    };
    const emitter = client as unknown as {
      on?: (event: string, cb: (err: unknown) => void) => void;
      off?: (event: string, cb: (err: unknown) => void) => void;
      removeListener?: (event: string, cb: (err: unknown) => void) => void;
    };
    emitter.on?.('error', onClientError);

    return {
      executor,
      release: () => {
        if (released) return;
        released = true;
        if (emitter.off) emitter.off('error', onClientError);
        else emitter.removeListener?.('error', onClientError);
        try {
          client.release();
        } catch {
          // пул закрывается / соединение уже отдано — best-effort
        }
      },
      onError: (handler) => {
        errorHandlers.push(handler);
      },
    };
  }

  /** Закрыть пул (идемпотентно). После закрытия запросы запрещены (не пересоздаём пул). */
  async end(): Promise<void> {
    this._closed = true;
    const pool = this._pool;
    this._pool = null;
    if (pool) await pool.end();
  }

  /**
   * Удалить схему (`DROP SCHEMA … CASCADE`) — тестовая/сервисная операция.
   * Пул закрывается, удаление выполняется отдельным клиентом без `search_path`
   * на удаляемую схему.
   */
  async dropSchema(schema: string = this._schema): Promise<void> {
    const safeSchema = assertValidSchema(schema);
    await this.end();
    const pg = await loadPgModule();
    const baseConfig = { ...this._poolConfig };
    delete baseConfig.options;
    const client = new pg.Client(baseConfig);
    try {
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(safeSchema)} CASCADE`);
    } catch (err) {
      throw mapPgError(err);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async _acquire(): Promise<PgPoolClient> {
    const pool = await this.getPool();
    try {
      return await pool.connect();
    } catch (err) {
      throw mapPgError(err);
    }
  }

  private async _withDedicatedClient<T>(
    fn: (tx: PostgresExecutor) => Promise<T>,
  ): Promise<T> {
    const client = await this._acquire();
    try {
      return await fn(wrapExecutor(client));
    } finally {
      client.release();
    }
  }
}

/** Создать соединение с PostgreSQL (ленивый пул; `pg` загружается при первом запросе). */
export function createPostgresConnection(config: PostgresConnectionConfig): PostgresConnection {
  return new PostgresConnection(config);
}
