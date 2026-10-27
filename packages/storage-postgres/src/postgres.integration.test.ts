/**
 * Интеграционный smoke-тест PostgreSQL-драйвера (ADR-097, волна 3a).
 *
 * Гейт по env `SYNTH_TEST_POSTGRES_DSN`: без него весь блок `describe.skip`
 * (герметичный запуск без БД). С DSN — прогон против dev-Postgres.
 *
 * Изоляция: каждый тест работает в **уникальной схеме** (`synth_test_<random>`),
 * прогоняет миграции в ней; `afterEach` удаляет схему (`DROP SCHEMA … CASCADE`).
 *
 * Полный контрактный suite портов (`packages/core/src/storage/contract/*`)
 * прогоняется отдельно против PG — `packages/core/src/storage/contract/postgres.test.ts`
 * (тот же гейт `SYNTH_TEST_POSTGRES_DSN`).
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextConfig } from '@itphx/synth-core';
import { PostgresStorageSchemaError } from './errors.js';
import { assertSchemaCurrent, readSchemaVersion, runMigrations } from './migrate.js';
import { MIGRATIONS, latestSchemaVersion } from './migrations/index.js';
import { createPostgresConnection, type PostgresConnection } from './pool.js';
import { createPostgresStorage } from './postgres-storage.js';
import { PgContextFileRepository } from './ports/context-files.js';
import type { PortDeps } from './ports/deps.js';

const DSN = process.env.SYNTH_TEST_POSTGRES_DSN;
const describePg = DSN ? describe : describe.skip;
const DATA_DIR = join(tmpdir(), 'synth-pg-smoke');

function uniqueSchema(): string {
  return `synth_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

describePg('PostgreSQL-драйвер: smoke (подключение, миграции, fail-closed)', () => {
  let schema: string;
  let conn: PostgresConnection;

  beforeEach(() => {
    schema = uniqueSchema();
    conn = createPostgresConnection({ connectionString: DSN, schema });
  });

  afterEach(async () => {
    await conn.dropSchema(schema);
  });

  it('подключается и выполняет SELECT 1', async () => {
    const rows = await conn.query<{ one: number }>('SELECT 1 AS one');
    expect(rows[0]?.one).toBe(1);
  });

  it('применяет миграции и записывает версию схемы', async () => {
    const result = await runMigrations(conn, { schema });
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(result.version).toBe(latestSchemaVersion(MIGRATIONS));
    expect(await readSchemaVersion(conn, schema)).toBe(latestSchemaVersion(MIGRATIONS));
  });

  it('создаёт таблицы схемы (sessions/messages/… через information_schema)', async () => {
    await runMigrations(conn, { schema });
    const rows = await conn.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
      [schema],
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('projects');
    expect(names).toContain('service_keys');
    expect(names).toContain('analytics_rollups');
    expect(names).toContain('synth_schema_migrations');
  });

  it('повторное применение миграций идемпотентно', async () => {
    await runMigrations(conn, { schema });
    const again = await runMigrations(conn, { schema });
    expect(again.applied).toEqual([]);
    expect(await readSchemaVersion(conn, schema)).toBe(latestSchemaVersion(MIGRATIONS));
  });

  it('fail-closed: версия схемы в БД новее ожидаемой', async () => {
    await runMigrations(conn, { schema });
    await conn.query('INSERT INTO synth_schema_migrations (version, id) VALUES ($1, $2)', [
      999,
      'future',
    ]);
    await expect(runMigrations(conn, { schema })).rejects.toBeInstanceOf(PostgresStorageSchemaError);
  });

  it('migrate:false и отсутствующая схема → внятная ошибка (OUTDATED)', async () => {
    await expect(assertSchemaCurrent(conn, { schema })).rejects.toBeInstanceOf(
      PostgresStorageSchemaError,
    );
  });

  it('createPostgresStorage: применяет схему и собирает контекст (порты + FS-порты)', async () => {
    const ctx = await createPostgresStorage({ dataDir: DATA_DIR, connectionString: DSN, schema });
    expect(ctx.kind).toBe('postgres');
    // Реализованные доменные порты отвечают (пустая схема → пустые списки).
    expect(await ctx.sessions.list()).toEqual([]);
    expect(await ctx.projects.list()).toEqual([]);
    expect(await ctx.eventBindings.list()).toEqual([]);
    // ADR-116: `blobs` остаётся файловым по конструкции, `skills`/`contextFiles` —
    // SQL (метаданные/строки), содержимое скиллов — в blob-сторе.
    expect(typeof ctx.blobs.read).toBe('function');
    expect(typeof ctx.skills.listNames).toBe('function');
    expect(typeof ctx.contextFiles.listAllFiles).toBe('function');
    // ADR-097: соединение удерживается в контексте — закрываем явно.
    await ctx.close?.();
  });
});

/**
 * ADR-116: `PgContextFileRepository` — пользовательские файлы контекста в SQL,
 * синхронные геттеры на процесс-локальном кэше, инвалидация по сигнатуре
 * `max(updated_at)`.
 */
describePg('PG-драйвер: файлы контекста — кэш и инвалидация (ADR-116)', () => {
  let schema: string;
  let conn: PostgresConnection;

  /** Порт с собственным кэшем (имитация второго процесса/реплики). */
  async function makePort(signatureTtlMs: number): Promise<PgContextFileRepository> {
    // Порт файлов контекста не использует `coreSync` (это sync-данные
    // словарей/секретов) — для теста достаточно соединения.
    const deps = { connection: conn, dataDir: DATA_DIR, coreSync: {} } as unknown as PortDeps;
    const userDataDir = join(DATA_DIR, 'context');
    const systemPromptsDir = new ContextConfig({ userDataDir }).systemPromptsDir;
    const port = new PgContextFileRepository(deps, {
      systemPromptsDir,
      createConfig: (overrides) =>
        new ContextConfig({ userDataDir, systemPromptsDir, overrides }),
      signatureTtlMs,
    });
    await port.initialize();
    return port;
  }

  beforeEach(async () => {
    schema = uniqueSchema();
    conn = createPostgresConnection({ connectionString: DSN, schema });
    await runMigrations(conn, { schema });
  });

  afterEach(async () => {
    await conn.dropSchema(schema);
  });

  it('запись видна сразу; чужая правка подхватывается по сигнатуре updated_at', async () => {
    const a = await makePort(0);
    const b = await makePort(0);

    expect(await a.saveFile('ABOUT.md', '# A', 'user')).toBe(true);
    expect(a.getFile('ABOUT.md', 'user')?.content).toBe('# A');
    await a.pendingRefresh();

    // Пауза: сигнатура сравнивается по миллисекундам.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await b.saveFile('ABOUT.md', '# B', 'user')).toBe(true);

    // Синхронное чтение у `a` отдаёт свой кэш и запускает фоновую проверку.
    expect(a.getFile('ABOUT.md', 'user')?.content).toBe('# A');
    await a.pendingRefresh();
    expect(a.getFile('ABOUT.md', 'user')?.content).toBe('# B');
  });

  it('listAllFiles видит файл из БД; restoreFile снимает override', async () => {
    const port = await makePort(0);
    await port.saveFile('NOTES.md', 'заметка', 'user');

    const file = port
      .listAllFiles()
      .find((entry) => entry.category === 'user' && entry.filename === 'NOTES.md');
    expect(file).toBeDefined();
    expect(file!.size).toBe(Buffer.byteLength('заметка', 'utf-8'));

    expect(await port.restoreFile('NOTES.md', 'user')).toBe(true);
    expect(port.getFile('NOTES.md', 'user')).toBeNull();
    // Повторное восстановление — false (override'а уже нет).
    expect(await port.restoreFile('NOTES.md', 'user')).toBe(false);
  });
});
