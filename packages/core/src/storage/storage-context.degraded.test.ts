// PROP-032 (W5): деградированный режим слоя хранения.
// - `halt` → старт падает `StorageUnavailableError` с внятным текстом;
// - `fallback-file` → файловый контекст в ОТДЕЛЬНОМ `fallbackDir` + `StorageDegradedInfo`;
// - рантайм-состояние публикуется в ось доступности тулов;
// - доменные данные в фоллбек не пишутся (ни на старте, ни при отклонённой мутации);
// - `close()` на живом PG-контексте освобождает пул (гейт `SYNTH_TEST_POSTGRES_DSN`);
// - fail-closed: ошибки конфигурации/зависимостей/«схема новее» фоллбек НЕ включают,
//   независимо от `degradedMode`.
//
// `postgres`-tаблица бьёт в заведомо пустой порт (`127.0.0.1:5433`) — соединение
// отклоняется сразу и классифицируется как отказ БД (`PostgresConnectionError`) →
// деградация. Тест требует собранного драйвера `@itphx/synth-storage-postgres`:
// его отсутствие — ошибка зависимости и по новой политике ведёт в fail-closed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createStorageContextAsync, StorageUnavailableError } from './storage-context.js';
import type { StorageContext } from './storage-context.js';
import { createStorageDegradedGuard } from '../server/storage-degraded.js';
import {
  setStorageDegradedState,
  isStorageDegraded,
  getStorageDegradedState,
} from '../engine/permission/storage-state.js';

/**
 * PROP-032 (W5): драйвер прогревается один раз на модуль — до первого теста.
 *
 * Динамический `import()` внутри `createStorageContextAsync` (код под тестом)
 * иначе грузит модуль-драйвер **в теле теста**: загрузка (трансформация
 * ~30 модулей драйвера + `pg`) под параллельной нагрузкой полного прогона
 * занимает 10–70 с и съедает весь бюджет `testTimeout` — тест падает по
 * таймауту, хотя проверяемая логика (классификация отказа) отрабатывает за
 * ~200 мс. Top-level await не подчиняется `testTimeout`/`hookTimeout` —
 * в этом и смысл прогрева: после него `import()` в коде под тестом
 * разрешается из кеша модулей за миллисекунды.
 *
 * `.catch()` обязателен: драйвера может не быть (пакет опционален) — тогда
 * импорт не должен ронять файл, а код под тестом обязан классифицировать
 * неудачную загрузку как ошибку зависимости (fail-closed, см. ADR-098).
 */
const POSTGRES_DRIVER_PACKAGE: string = '@itphx/synth-storage-postgres';
await import(POSTGRES_DRIVER_PACKAGE).catch(() => undefined);

const DSN = process.env.SYNTH_TEST_POSTGRES_DSN;

/** Заведомо недоступный PG (порт ничего не слушает → соединение отклоняется). */
const UNREACHABLE_PG = { host: '127.0.0.1', port: 5433, database: 'synth', user: 'synth' } as const;

describe('деградация хранилища: политика при недоступном postgres (PROP-032 W5)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-degraded-'));
    setStorageDegradedState(null);
  });

  afterEach(async () => {
    setStorageDegradedState(null);
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('halt: старт падает StorageUnavailableError с внятным текстом (не сырой трейс)', async () => {
    const err = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: UNREACHABLE_PG,
      degradedMode: 'halt',
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StorageUnavailableError);
    const e = err as StorageUnavailableError;
    expect(e.code).toBe('STORAGE_UNAVAILABLE');
    expect(e.name).toBe('StorageUnavailableError');
    expect(e.message).toContain('storage.degradedMode');
    expect(e.message).toContain('halt');
    expect(e.message).toContain('старт остановлен');
    expect(e.message).toContain('Причина:');
    // Рантайм-состояние деградации при halt не публикуется.
    expect(isStorageDegraded()).toBe(false);
  });

  it('fallback-file: файловый контекст в fallbackDir + заполненный StorageDegradedInfo', async () => {
    const fallbackDir = join(dataDir, 'fb');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ctx = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: UNREACHABLE_PG,
      degradedMode: 'fallback-file',
      fallbackDir,
    });

    // Поднялись на файловом бэкенде (не memory/postgres).
    expect(ctx.kind).toBe('file');
    expect(ctx.degraded?.active).toBe(true);
    expect(ctx.degraded?.backend).toBe('postgres');
    expect(ctx.degraded?.fallbackDir).toBe(fallbackDir);
    expect(ctx.degraded?.reason).toBeTruthy();
    expect(Number.isNaN(Date.parse(ctx.degraded!.since))).toBe(false);
    expect(typeof ctx.degraded?.probe).toBe('function');

    // Громкое предупреждение в лог (оператор должен узнать об аварии).
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('ДЕГРАДИРОВАННЫЙ');
    expect(logged).toContain(fallbackDir);

    // Рантайм-состояние опубликовано (ось доступности тулов).
    expect(isStorageDegraded()).toBe(true);
    expect(getStorageDegradedState().fallbackDir).toBe(fallbackDir);
  });

  it('fallback-file: без явного fallbackDir — дефолт {dataDir}/fallback (отдельно от dataDir)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: UNREACHABLE_PG,
      degradedMode: 'fallback-file',
    });
    expect(ctx.degraded?.fallbackDir).toBe(join(dataDir, 'fallback'));
  });

  it('после старта в фоллбеке нет доменных записей (ни в fallbackDir, ни в dataDir)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: UNREACHABLE_PG,
      degradedMode: 'fallback-file',
    });
    const fallbackDir = ctx.degraded!.fallbackDir;

    expect(existsSync(join(fallbackDir, 'sessions'))).toBe(false);
    expect(existsSync(join(fallbackDir, 'projects'))).toBe(false);
    expect(existsSync(join(fallbackDir, 'settings.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'sessions'))).toBe(false);
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(false);
  });

  it('деградация + guard: отклонённая мутация не создаёт доменных записей в фоллбеке', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: UNREACHABLE_PG,
      degradedMode: 'fallback-file',
    });

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user' as never, { id: 'admin', roles: ['ADMIN'] } as never);
      await next();
    });
    app.use(
      '*',
      createStorageDegradedGuard({
        getDegraded: () => ctx.degraded ?? null,
        isAdmin: () => true,
      }),
    );
    // «Мутирующий» роут, который писал бы доменные данные, если бы guard пропустил.
    app.post('/api/v2/settings/workspace', async (c) => {
      await ctx.settings.setWorkspace('/ws/should-not-write');
      return c.json({ ok: true });
    });

    const res = await app.request('/api/v2/settings/workspace', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await ctx.settings.getWorkspace()).toBeUndefined();
    expect(existsSync(join(ctx.degraded!.fallbackDir, 'settings.json'))).toBe(false);
  });

  it('probe: недоступный backend → {ok:false, error}', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: UNREACHABLE_PG,
      degradedMode: 'fallback-file',
    });
    const probe = await ctx.degraded!.probe!();
    expect(probe.ok).toBe(false);
    expect(probe.error).toBeTruthy();
  });

  it('fail-closed: ошибка конфигурации (нет способа подключения) — фоллбек НЕ применяется', async () => {
    // `postgres` без `dsn`/`host`+`database` — `PostgresStorageConfigError`.
    // Даже при `degradedMode='fallback-file'` политика деградации не применяется:
    // старт останавливается, чтобы опечатка не маскировалась пустым хранилищем.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: { port: 5433 },
      degradedMode: 'fallback-file',
      fallbackDir: join(dataDir, 'fb'),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect((err as StorageUnavailableError).code).toBe('STORAGE_UNAVAILABLE');
    expect((err as StorageUnavailableError).message).toContain('fail-closed');
    // Рантайм-состояние деградации не публикуется — фоллбека не было.
    expect(isStorageDegraded()).toBe(false);
    expect(existsSync(join(dataDir, 'fb', 'sessions'))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('fail-closed: невалидный storage.backend — не уводится на файловый backend', async () => {
    const err = await createStorageContextAsync('bogus' as never, { dataDir }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect((err as StorageUnavailableError).message).toContain('bogus');
  });

  it('диагностический schemaMode=skip не применяет политику деградации', async () => {
    // `skip` не трогает схему (и не открывает соединение) — контекст возвращается
    // как postgres, деградация НЕ включается (ошибки подключения, если случились бы,
    // пробрасывались бы наверх — политика fallback-file не применяется).
    const ctx = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: UNREACHABLE_PG,
      degradedMode: 'fallback-file',
      postgresSchemaMode: 'skip',
    });
    expect(ctx.kind).toBe('postgres');
    expect(ctx.degraded).toBeUndefined();
    expect(isStorageDegraded()).toBe(false);
    await ctx.close?.().catch(() => undefined);
  });
});

// ── Живой PG (гейт env `SYNTH_TEST_POSTGRES_DSN`) ────────────────────────────
// Требует собранного драйвера `@itphx/synth-storage-postgres` + пакета `pg`.
(DSN ? describe : describe.skip)('close() освобождает пул живого PG-контекста', () => {
  const POSTGRES_DRIVER_PACKAGE: string = '@itphx/synth-storage-postgres';

  interface PostgresDriverModule {
    createPostgresStorage(config: Record<string, unknown>): Promise<StorageContext>;
    createPostgresConnection(config: Record<string, unknown>): {
      dropSchema(schema?: string): Promise<void>;
      query(text: string, params?: unknown[]): Promise<unknown[]>;
      end(): Promise<void>;
    };
  }

  let dataDir: string;
  let schema: string;
  let disposers: Array<() => Promise<void>>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-degraded-pg-'));
    schema = `synth_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    disposers = [];
    setStorageDegradedState(null);
  });

  afterEach(async () => {
    const pending = disposers;
    disposers = [];
    await Promise.allSettled(pending.map((d) => d()));
    const driver = (await import(POSTGRES_DRIVER_PACKAGE)) as unknown as PostgresDriverModule;
    await driver
      .createPostgresConnection({ connectionString: DSN, schema })
      .dropSchema(schema)
      .catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('healthy-контекст: запрос до close успешен, после close — падает', async () => {
    // `halt`: любая ошибка сборки видна сразу (не маскируется файловым фоллбеком) —
    // иначе контекст молча становился бы `kind:'file'` и тест «плыл».
    const ctx = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: { dsn: DSN, schema },
      degradedMode: 'halt',
    });
    expect(ctx.kind).toBe('postgres');
    expect(ctx.degraded).toBeUndefined();
    expect(isStorageDegraded()).toBe(false);
    expect(ctx.close).toBeTypeOf('function');
    disposers.push(async () => {
      await ctx.close?.().catch(() => undefined);
    });

    // До close пул живой.
    await expect(ctx.sessions.listForUserScope('u-1', [])).resolves.toBeInstanceOf(Array);

    await ctx.close!();

    // После close пул закрыт — следующий запрос обязан упасть.
    await expect(ctx.sessions.listForUserScope('u-1', [])).rejects.toThrow();
  });

  it('схема отстаёт (schemaMode=assert) → деградация с подсказкой synth migrate', async () => {
    // Схема ещё не создана → `assertSchemaCurrent` → `STORAGE_POSTGRES_SCHEMA_OUTDATED`,
    // это отказ «схема», не конфиг: должна сработать деградация (данные в БД есть),
    // а причина — содержать подсказку про `synth migrate`.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fallbackDir = join(dataDir, 'fb-outdated');

    const ctx = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: { dsn: DSN, schema },
      degradedMode: 'fallback-file',
      fallbackDir,
      postgresSchemaMode: 'assert',
    });

    expect(ctx.kind).toBe('file');
    expect(ctx.degraded?.active).toBe(true);
    expect(ctx.degraded?.reason).toContain('synth migrate');
    expect(isStorageDegraded()).toBe(true);
  });

  it('схема новее драйвера → fail-closed (не фоллбек), даже при fallback-file', async () => {
    const driver = (await import(POSTGRES_DRIVER_PACKAGE)) as unknown as PostgresDriverModule;
    // Создаём схему с миграциями и подкладываем «будущую» версию 999.
    const first = await driver.createPostgresStorage({
      dataDir,
      connectionString: DSN,
      schema,
      schemaMode: 'apply',
    });
    await first.close?.();
    const conn = driver.createPostgresConnection({ connectionString: DSN, schema });
    await conn.query('INSERT INTO synth_schema_migrations (version, id) VALUES (999, $1)', ['future']);
    await conn.end();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await createStorageContextAsync('postgres', {
      dataDir,
      postgres: { dsn: DSN, schema },
      degradedMode: 'fallback-file',
      fallbackDir: join(dataDir, 'fb-too-new'),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect((err as StorageUnavailableError).message).toContain('fail-closed');
    expect(isStorageDegraded()).toBe(false);
    // Фоллбек не создавался — «данные исчезли» не имитируем.
    expect(existsSync(join(dataDir, 'fb-too-new'))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});
