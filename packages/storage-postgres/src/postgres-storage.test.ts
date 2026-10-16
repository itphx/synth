import { describe, expect, it } from 'vitest';
import {
  createPostgresStorage,
  PostgresStorageConfigError,
  PostgresStorageError,
  validatePostgresConfig,
} from './postgres-storage.js';

const DATA_DIR = '/tmp/synth-postgres-test';
const CONNECTION_STRING = 'postgres://synth:secret@db:5432/synth';

describe('validatePostgresConfig', () => {
  it('требует способ подключения (ни connectionString, ни pool)', () => {
    expect(() => validatePostgresConfig({ dataDir: DATA_DIR })).toThrow(PostgresStorageConfigError);
  });

  it('требует host и database внутри pool', () => {
    expect(() => validatePostgresConfig({ dataDir: DATA_DIR, pool: { host: 'db' } })).toThrow(
      PostgresStorageConfigError,
    );
    expect(() => validatePostgresConfig({ dataDir: DATA_DIR, pool: { database: 'synth' } })).toThrow(
      PostgresStorageConfigError,
    );
  });

  it('принимает connectionString', () => {
    expect(() =>
      validatePostgresConfig({ dataDir: DATA_DIR, connectionString: CONNECTION_STRING }),
    ).not.toThrow();
  });

  it('принимает pool.host + pool.database', () => {
    expect(() =>
      validatePostgresConfig({ dataDir: DATA_DIR, pool: { host: 'db', database: 'synth' } }),
    ).not.toThrow();
  });

  it('отклоняет некорректный pool.port', () => {
    expect(() =>
      validatePostgresConfig({
        dataDir: DATA_DIR,
        pool: { host: 'db', database: 'synth', port: 70000 },
      }),
    ).toThrow(PostgresStorageConfigError);
  });

  it('пустые строки не считаются заданным подключением', () => {
    expect(() =>
      validatePostgresConfig({ dataDir: DATA_DIR, connectionString: '   ' }),
    ).toThrow(PostgresStorageConfigError);
  });

  it('отклоняет TLS-параметры в DSN (fail-closed до подключения)', () => {
    expect(() =>
      validatePostgresConfig({ dataDir: DATA_DIR, connectionString: `${CONNECTION_STRING}?sslmode=require` }),
    ).toThrow(/TLS-параметры в DSN/);
    expect(() =>
      validatePostgresConfig({ dataDir: DATA_DIR, connectionString: `${CONNECTION_STRING}?sslrootcert=/ca.pem` }),
    ).toThrow(PostgresStorageConfigError);
    // Чистый DSN — по-прежнему валиден.
    expect(() => validatePostgresConfig({ dataDir: DATA_DIR, connectionString: CONNECTION_STRING })).not.toThrow();
  });
});

describe('createPostgresStorage', () => {
  it('падает на невалидном конфиге до обращения к БД', async () => {
    await expect(createPostgresStorage({ dataDir: DATA_DIR })).rejects.toBeInstanceOf(
      PostgresStorageConfigError,
    );
  });

  it('падает на некорректной схеме до обращения к БД', async () => {
    await expect(
      createPostgresStorage({ dataDir: DATA_DIR, connectionString: CONNECTION_STRING, schema: 'bad-schema!' }),
    ).rejects.toBeInstanceOf(PostgresStorageConfigError);
  });

  it('недоступная БД → доменная ошибка соединения (не сырой трейс pg)', async () => {
    await expect(
      createPostgresStorage({
        dataDir: DATA_DIR,
        pool: { host: '127.0.0.1', port: 1, database: 'synth', connectionTimeoutMillis: 500 },
      }),
    ).rejects.toBeInstanceOf(PostgresStorageError);
  });
});
