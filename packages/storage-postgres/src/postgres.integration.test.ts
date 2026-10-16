/**
 * Интеграционный smoke-тест PostgreSQL-драйвера (PROP-032, волна 3a).
 *
 * Гейт по env `SYNTH_TEST_POSTGRES_DSN`: без него весь блок `describe.skip`
 * (герметичный запуск без БД). С DSN — прогон против dev-Postgres.
 *
 * Изоляция: каждый тест работает в **уникальной схеме** (`synth_test_<random>`),
 * прогоняет миграции в ней; `afterEach` удаляет схему (`DROP SCHEMA … CASCADE`).
 *
 * Полный контрактный suite портов (`packages/core/src/storage/contract/*`)
 * подключается следующей волной — когда порты будут реализованы.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresStorageNotImplementedError, PostgresStorageSchemaError } from './errors.js';
import { assertSchemaCurrent, readSchemaVersion, runMigrations } from './migrate.js';
import { createPostgresConnection, type PostgresConnection } from './pool.js';
import { createPostgresStorage } from './postgres-storage.js';

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
    expect(result.applied).toEqual([1]);
    expect(result.version).toBe(1);
    expect(await readSchemaVersion(conn, schema)).toBe(1);
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
    expect(names).toContain('synth_schema_migrations');
  });

  it('повторное применение миграций идемпотентно', async () => {
    await runMigrations(conn, { schema });
    const again = await runMigrations(conn, { schema });
    expect(again.applied).toEqual([]);
    expect(await readSchemaVersion(conn, schema)).toBe(1);
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

  it('createPostgresStorage: применяет схему и собирает контекст (FS-порты + заглушки)', async () => {
    const ctx = await createPostgresStorage({ dataDir: DATA_DIR, connectionString: DSN, schema });
    expect(ctx.kind).toBe('postgres');
    // FS/package-bound порты — файловые реализации.
    expect(typeof ctx.blobs.read).toBe('function');
    expect(typeof ctx.skills.listNames).toBe('function');
    // Прочие порты — заглушки PG с понятной ошибкой.
    expect(() => ctx.sessions.list()).toThrow(PostgresStorageNotImplementedError);
  });
});
