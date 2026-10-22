/**
 * ADR-097: БД-механизмы межпроцессной координации — мьютекс и лидер-выбор
 * поверх session-level advisory-локов PostgreSQL.
 *
 * Заменяют файловые примитивы core (`FileMutex`/`FileLeader`) при
 * `storage.backend=postgres`: файловый лок работает только на общем FS, а в
 * кластере реплики могут не иметь общего диска. Advisory-лок БД, напротив,
 * разделяется всеми соединениями к одной БД независимо от хоста.
 *
 * Ключи. Имя лока namespaced-ится префиксом `synth:` и превращается в 64-битный
 * знаковый ключ детерминированным хешем (`advisoryLockKeyToBigInt`, sha256) —
 * тот же способ, что в `PostgresConnection.withAdvisoryLock`, поэтому ключи разных
 * подсистем (`synth:migrate:<schema>`, `synth:scheduler/leader`, …) не пересекаются.
 *
 * Session-level лок удерживается **соединением**, а не транзакцией: он
 * автоматически снимается при его разрыве/закрытии (свойство PostgreSQL —
 * используем его как надёжный механизм освобождения, а не боремся с ним).
 *
 * Пул. Удерживаемое соединение не возвращается в пул до снятия лока, поэтому под
 * PG-лидера расходуется один постоянный клиент на процесс; учитывайте это при
 * `poolMax` (по умолчанию 10, `pool.ts`).
 */

import {
  advisoryLockKeyToBigInt,
  type HeldPostgresClient,
  type PostgresConnection,
} from './pool.js';
import type {
  LeaderFactoryOptions,
  LockOptions,
  Mutex,
  MutexFactoryOptions,
  SchedulerLeader,
  StorageLocks,
} from '@itphx/synth-core';

/** Префикс namespace'а advisory-ключей Synth (не пересекается с чужими ключами). */
const LOCK_NAMESPACE = 'synth:';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_MS = 25;

/** Имя лока лидера планировщика по умолчанию. */
export const DEFAULT_LEADER_LOCK_NAME = 'scheduler/leader';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Не держать event loop живым из-за ожидания лока.
    timer.unref?.();
  });
}

/** Namespaced-имя → строка 64-битного advisory-ключа. */
export function postgresLockKey(name: string): string {
  return advisoryLockKeyToBigInt(`${LOCK_NAMESPACE}${name}`).toString();
}

const TRY_LOCK_SQL = 'SELECT pg_try_advisory_lock($1::bigint) AS locked';
const UNLOCK_SQL = 'SELECT pg_advisory_unlock($1::bigint)';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Опции `PgMutex`. */
export interface PgMutexOptions {
  /** Соединение драйвера (пул); под лок берётся выделенный клиент. */
  connection: PostgresConnection;
  /** Namespaced-имя лока (без префикса `synth:`). */
  name: string;
  /** Общий таймаут захвата, мс (по умолчанию 5_000). */
  timeoutMs?: number;
  /** Пауза между попытками захвата, мс (по умолчанию 25). */
  retryMs?: number;
  /** Принято для совместимости с `MutexFactoryOptions`; advisory-лок не стареет. */
  staleMs?: number;
}

/**
 * ADR-097: мьютекс на session-level `pg_advisory_lock` (выделенное соединение).
 *
 * Семантика (паритет с `FileMutex`, ADR-051/ADR-089):
 * - захват с ретраями `pg_try_advisory_lock` до `timeoutMs`;
 * - по истечении — `warn` и выполнение `fn` **без** лока (осознанный fail-open);
 * - освобождение — `pg_advisory_unlock` в `finally` + возврат соединения в пул;
 * - при **недоступной БД** (не удалось получить соединение/выполнить запрос) —
 *   ошибка пробрасывается наружу (не зависание и не «тихий» fail-open: без БД
 *   backend всё равно неработоспособен).
 */
export class PgMutex implements Mutex {
  private readonly _connection: PostgresConnection;
  private readonly _key: string;
  private readonly _name: string;
  private readonly _timeoutMs: number;
  private readonly _retryMs: number;

  constructor(options: PgMutexOptions) {
    this._connection = options.connection;
    this._name = options.name;
    this._key = postgresLockKey(options.name);
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  // `opts.heartbeat` игнорируется: session-level лок держится соединением.
  async withLock<T>(fn: () => Promise<T>, _opts?: LockOptions): Promise<T> {
    // Ошибка получения соединения (БД недоступна) — понятная ошибка наружу.
    const held = await this._connection.acquireHeldClient();

    let acquired = false;
    const deadline = Date.now() + this._timeoutMs;
    try {
      for (;;) {
        const rows = await held.executor.query<{ locked: boolean }>(TRY_LOCK_SQL, [this._key]);
        if (rows[0]?.locked === true) {
          acquired = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await delay(this._retryMs);
      }
    } catch (err) {
      held.release();
      throw err;
    }

    if (!acquired) {
      console.warn(
        `[PgMutex] не удалось захватить лок ${this._name} за ${this._timeoutMs}мс — продолжаем без блокировки`,
      );
      held.release();
      return fn();
    }

    try {
      return await fn();
    } finally {
      await held.executor.query(UNLOCK_SQL, [this._key]).catch(() => undefined);
      held.release();
    }
  }
}

/** Опции `PgLeader`. */
export interface PgLeaderOptions {
  /** Соединение драйвера (пул); под лидерство берётся постоянный клиент. */
  connection: PostgresConnection;
  /** Namespaced-имя лока (по умолчанию `scheduler/leader`). */
  name?: string;
  /** Принято для совместимости с `LeaderFactoryOptions`; advisory-лок не стареет. */
  tickMs?: number;
  /** Принято для совместимости; advisory-лок не стареет. */
  staleMs?: number;
}

/**
 * ADR-097: лидер-выбор планировщика на удерживаемом session-level advisory-локе
 * (ADR-051/ADR-089). Совместим с `SchedulerLeader`.
 *
 * - `acquire()` — одна попытка `pg_try_advisory_lock` на **постоянном** соединении:
 *   `true` — мы лидер (соединение удерживается всё время лидерства), `false` —
 *   лок занят другим процессом. Ошибка БД пробрасывается (не зависание).
 * - `touch()` — no-op: в отличие от файлового лиза, advisory-лок живёт, пока живо
 *   соединение, и не требует heartbeat.
 * - `release()` — `pg_advisory_unlock` + возврат соединения в пул.
 * - **Разрыв соединения** (сервер/сеть) эмитит `error` у клиента: лидер явно
 *   снимает себя (`isLeader === false`) и логирует — «молчаливым» лидером после
 *   потери лока процесс не остаётся.
 */
export class PgLeader implements SchedulerLeader {
  private readonly _connection: PostgresConnection;
  private readonly _key: string;
  private readonly _name: string;
  private _held: HeldPostgresClient | null = null;
  private _isLeader = false;

  constructor(options: PgLeaderOptions) {
    this._connection = options.connection;
    this._name = options.name ?? DEFAULT_LEADER_LOCK_NAME;
    this._key = postgresLockKey(this._name);
  }

  /** Держим ли лидерство прямо сейчас (с учётом детекта разрыва соединения). */
  get isLeader(): boolean {
    return this._isLeader;
  }

  async acquire(): Promise<boolean> {
    if (this._isLeader && this._held) return true;

    const held = await this._connection.acquireHeldClient();
    try {
      const rows = await held.executor.query<{ locked: boolean }>(TRY_LOCK_SQL, [this._key]);
      if (rows[0]?.locked !== true) {
        held.release();
        return false;
      }
    } catch (err) {
      held.release();
      throw err;
    }

    held.onError((err) => {
      if (!this._isLeader) return;
      this._isLeader = false;
      const dropped = this._held;
      this._held = null;
      // Соединение уже мертво: лок снят вместе с ним, unlock/release не нужны.
      dropped?.release();
      console.warn(
        `[PgLeader] потеряно соединение лидерства (${this._name}) — лидерство снято: ${errorMessage(err)}`,
      );
    });

    this._held = held;
    this._isLeader = true;
    return true;
  }

  // Session-level лок держится соединением — heartbeat не нужен.
  async touch(): Promise<void> {}

  async release(): Promise<void> {
    const held = this._held;
    this._isLeader = false;
    this._held = null;
    if (!held) return;
    try {
      await held.executor.query(UNLOCK_SQL, [this._key]);
    } catch {
      // соединение могло уже умереть — лок снимется вместе с ним
    }
    held.release();
  }
}

/**
 * ADR-097: примитивы координации PG, публикуемые в `StorageContext.locks`
 * (`StorageLocks`) — composition root подставляет их вместо файловых.
 */
export function createPostgresLocks(connection: PostgresConnection): StorageLocks {
  return {
    createMutex: (options: MutexFactoryOptions) =>
      new PgMutex({
        connection,
        name: options.name,
        timeoutMs: options.timeoutMs,
        retryMs: options.retryMs,
        staleMs: options.staleMs,
      }),
    createLeader: (options: LeaderFactoryOptions) =>
      new PgLeader({
        connection,
        name: options.name,
        tickMs: options.tickMs,
        staleMs: options.staleMs,
      }),
  };
}
