/**
 * ADR-097: тесты БД-механизмов координации (`PgMutex`/`PgLeader`, advisory-локи).
 *
 * Гейт по env `SYNTH_TEST_POSTGRES_DSN`: без него весь блок `describe.skip`.
 * Advisory-локи не требуют схемы/миграций — тесты берут соединение и работают
 * с session-level локами напрямую; `afterEach` только закрывает пул.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresConnectionError } from './errors.js';
import { PgLeader, PgMutex, postgresLockKey } from './locks.js';
import { createPostgresConnection, type PostgresConnection } from './pool.js';

// Тест (е) динамически импортирует собранный core (сравнение с `FileMutex`) —
// первый импорт тяжёлый; даём запас по времени (как контрактный suite core).
vi.setConfig({ testTimeout: 30000 });

const DSN = process.env.SYNTH_TEST_POSTGRES_DSN;
const describePg = DSN ? describe : describe.skip;

function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Структурный контракт мьютекса (без статической зависимости от core в тесте). */
interface TestMutex {
  withLock<T>(fn: () => Promise<T>, opts?: { heartbeat?: boolean }): Promise<T>;
}

/**
 * Общий сценарий сериализации: `a` **гарантированно** держит лок, затем
 * запускается `b` того же имени. Пока `a` не отпустил — `b` не стартует.
 *
 * Детерминизм важен: `a`/`b` — независимые клиенты (разные соединения пула), и
 * какой из них первым получит соединение, не определено. Поэтому ждём сигнала
 * «a вошёл в секцию», и только потом стартуем `b`.
 */
async function assertSerializes(a: TestMutex, b: TestMutex): Promise<void> {
  const order: string[] = [];
  let signalHolding: () => void = () => {};
  const holding = new Promise<void>((resolve) => {
    signalHolding = resolve;
  });
  let releaseA: () => void = () => {};
  const holdA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const pa = a.withLock(async () => {
    order.push('a:start');
    signalHolding();
    await holdA;
    order.push('a:end');
  });
  await holding; // a точно держит лок

  const pb = b.withLock(async () => {
    order.push('b:start');
    order.push('b:end');
  });
  await sleep(150);
  expect(order).not.toContain('b:start'); // b ждёт — не стартовал

  releaseA();
  await Promise.all([pa, pb]);
  expect(order).toContain('a:end');
  expect(order).toContain('b:end');
  expect(order.indexOf('b:start')).toBeGreaterThan(order.indexOf('a:end'));
}

describePg('PostgreSQL advisory-локи (ADR-097)', () => {
  let conn: PostgresConnection;

  beforeEach(() => {
    conn = createPostgresConnection({ connectionString: DSN });
  });

  afterEach(async () => {
    await conn.end();
  });

  it('ключи: детерминированы и различаются по имени', () => {
    expect(postgresLockKey('scheduler/leader')).toBe(postgresLockKey('scheduler/leader'));
    expect(postgresLockKey('a')).not.toBe(postgresLockKey('b'));
  });

  it('(а) два withLock с одним именем сериализуются (второй ждёт)', async () => {
    const name = uniqueName('mutex-serialize');
    const a = new PgMutex({ connection: conn, name, timeoutMs: 4000, retryMs: 20 });
    const b = new PgMutex({ connection: conn, name, timeoutMs: 4000, retryMs: 20 });
    await assertSerializes(a, b);
  });

  it('(б) разные имена не блокируют друг друга', async () => {
    const a = new PgMutex({ connection: conn, name: uniqueName('mutex-a'), timeoutMs: 1000, retryMs: 20 });
    const b = new PgMutex({ connection: conn, name: uniqueName('mutex-b'), timeoutMs: 1000, retryMs: 20 });

    const order: string[] = [];
    let signalHolding: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      signalHolding = resolve;
    });
    let releaseA: () => void = () => {};
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const pa = a.withLock(async () => {
      order.push('a:start');
      signalHolding();
      await holdA;
      order.push('a:end');
    });
    await holding; // a держит лок mutex-a

    // b с ДРУГИМ именем должен пройти, пока a ещё держит свой лок.
    await b.withLock(async () => {
      order.push('b:start');
      order.push('b:end');
    });
    expect(order).not.toContain('a:end');
    expect(order).toEqual(['a:start', 'b:start', 'b:end']);

    releaseA();
    await pa;
    expect(order).toContain('a:end');
  });

  it('(в) два PgLeader не могут быть лидерами одновременно', async () => {
    const name = uniqueName('leader');
    const a = new PgLeader({ connection: conn, name });
    const b = new PgLeader({ connection: conn, name });
    try {
      expect(await a.acquire()).toBe(true);
      expect(a.isLeader).toBe(true);
      expect(await b.acquire()).toBe(false);
      expect(b.isLeader).toBe(false);
    } finally {
      await a.release();
      await b.release();
    }
  });

  it('(г) после release лок освобождается — следующий захват проходит', async () => {
    const name = uniqueName('leader-release');
    const a = new PgLeader({ connection: conn, name });
    expect(await a.acquire()).toBe(true);
    await a.release();
    expect(a.isLeader).toBe(false);

    const b = new PgLeader({ connection: conn, name });
    try {
      expect(await b.acquire()).toBe(true);
    } finally {
      await b.release();
    }

    // withLock освобождает лок сам: следующий захват того же имени проходит.
    const m = uniqueName('mutex-release');
    await new PgMutex({ connection: conn, name: m, timeoutMs: 2000 }).withLock(async () => 'first');
    const second = await new PgMutex({ connection: conn, name: m, timeoutMs: 2000 }).withLock(
      async () => 'second',
    );
    expect(second).toBe('second');
  });

  it('(д) недоступная БД → понятная ошибка, не зависание', async () => {
    const bad = createPostgresConnection({
      connectionString: 'postgres://synth:secret@127.0.0.1:1/none',
      pool: { connectionTimeoutMillis: 300 },
    });
    const mutex = new PgMutex({ connection: bad, name: 'db-down', timeoutMs: 200 });
    const leader = new PgLeader({ connection: bad, name: 'db-down-leader' });
    try {
      await expect(mutex.withLock(async () => 'x')).rejects.toBeInstanceOf(PostgresConnectionError);
      await expect(leader.acquire()).rejects.toBeInstanceOf(PostgresConnectionError);
    } finally {
      await bad.end().catch(() => undefined);
    }
  });

  it('(е) Mutex-семантика едина для FileMutex и PgMutex', async () => {
    const { FileMutex } = await import('@itphx/synth-core');

    const tmp = await mkdtemp(join(tmpdir(), 'synth-lock-contract-'));
    try {
      const path = join(tmp, 'resource.lock');
      await assertSerializes(new FileMutex({ path }), new FileMutex({ path }));

      const name = uniqueName('unified');
      await assertSerializes(
        new PgMutex({ connection: conn, name, timeoutMs: 4000, retryMs: 20 }),
        new PgMutex({ connection: conn, name, timeoutMs: 4000, retryMs: 20 }),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
