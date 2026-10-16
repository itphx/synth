import { describe, expect, it } from 'vitest';
import {
  createPostgresStorage,
  PostgresStorageConfigError,
  PostgresStorageNotImplementedError,
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
});

describe('createPostgresStorage', () => {
  it('скелет: валидный конфиг → ошибка «не реализовано»', async () => {
    await expect(
      createPostgresStorage({ dataDir: DATA_DIR, connectionString: CONNECTION_STRING }),
    ).rejects.toBeInstanceOf(PostgresStorageNotImplementedError);
  });

  it('падает на невалидном конфиге до обращения к БД', async () => {
    await expect(createPostgresStorage({ dataDir: DATA_DIR })).rejects.toBeInstanceOf(
      PostgresStorageConfigError,
    );
  });
});
