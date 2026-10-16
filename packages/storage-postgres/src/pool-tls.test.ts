/**
 * ADR-099 × PROP-032: маппинг TLS-настроек в `pg.Pool` (`buildPoolConfig`) —
 * единый источник доверия (`storage.postgres.sslmode` + `security.tls`),
 * fail-closed без CA и защита от «тихого» DSN.
 */
import { describe, expect, it } from 'vitest';
import { assertNoDsnTlsParams, buildPoolConfig } from './pool.js';
import { PostgresStorageConfigError } from './errors.js';

const CERT_A = '-----BEGIN CERTIFICATE-----\nQUJB\n-----END CERTIFICATE-----\n';
const SCHEMA = 'public';

/** Извлекает `ssl` из собранного pg-конфига. */
function sslOf(config: Parameters<typeof buildPoolConfig>[0]): unknown {
  return buildPoolConfig(config, SCHEMA).ssl;
}

describe('buildPoolConfig: sslmode → ssl-опции', () => {
  it('sslmode не задан, ssl не задан → ssl в конфиг не проставляется (прежнее поведение)', () => {
    const cfg = buildPoolConfig({ pool: { host: 'h', database: 'd' } }, SCHEMA);
    expect(cfg).not.toHaveProperty('ssl');
  });

  it('legacy ssl:false / ssl:true пробрасываются как есть', () => {
    expect(sslOf({ pool: { host: 'h', database: 'd', ssl: false } })).toBe(false);
    expect(sslOf({ pool: { host: 'h', database: 'd', ssl: true } })).toBe(true);
  });

  it('sslmode имеет приоритет над legacy ssl', () => {
    expect(sslOf({ pool: { host: 'h', database: 'd', ssl: true, sslmode: 'disable' } })).toBe(false);
    expect(sslOf({ pool: { host: 'h', database: 'd', ssl: false, sslmode: 'require' } })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('disable → ssl:false', () => {
    expect(sslOf({ pool: { host: 'h', database: 'd', sslmode: 'disable' } })).toBe(false);
  });

  it('require → { rejectUnauthorized: false }', () => {
    expect(sslOf({ pool: { host: 'h', database: 'd', sslmode: 'require' } })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('verify-full без CA → fail-closed (доменная ошибка конфигурации)', () => {
    expect(() => buildPoolConfig({ pool: { host: 'h', database: 'd', sslmode: 'verify-full' } }, SCHEMA)).toThrow(
      PostgresStorageConfigError,
    );
    expect(() =>
      buildPoolConfig({ pool: { host: 'h', database: 'd', sslmode: 'verify-full' } }, SCHEMA),
    ).toThrow(/требует доверенный CA/);
  });

  it('verify-full + security.tls.caPem → проверка сертификата включена', () => {
    const ssl = sslOf({
      pool: { host: '10.0.0.5', database: 'd', sslmode: 'verify-full' },
      tls: { caPem: CERT_A },
    });
    expect(ssl).toEqual({ rejectUnauthorized: true, ca: CERT_A });
  });

  it('verify-full + host → servername из host', () => {
    const ssl = sslOf({
      pool: { host: 'db.internal', database: 'd', sslmode: 'verify-full' },
      tls: { caPem: CERT_A },
    }) as Record<string, unknown>;
    expect(ssl.servername).toBe('db.internal');
  });

  it('verify-full из чистого DSN (host в строке) → без servername', () => {
    const ssl = sslOf({
      connectionString: 'postgres://u:p@db.internal:5432/d',
      pool: { sslmode: 'verify-full' },
      tls: { caPem: CERT_A },
    }) as Record<string, unknown>;
    expect(ssl.servername).toBeUndefined();
  });

  it('verify-full: CA из env (SYNTH_TLS_CA_PEM) без config.tls', () => {
    const ssl = sslOf({
      pool: { host: '10.0.0.5', database: 'd', sslmode: 'verify-full' },
      env: { SYNTH_TLS_CA_PEM: CERT_A },
    });
    expect(ssl).toEqual({ rejectUnauthorized: true, ca: CERT_A });
  });
});

describe('buildPoolConfig: защита от TLS-параметров в DSN', () => {
  it('DSN с sslmode → ошибка конфигурации (до подключения)', () => {
    expect(() =>
      buildPoolConfig({ connectionString: 'postgres://u:p@h/db?sslmode=require' }, SCHEMA),
    ).toThrow(PostgresStorageConfigError);
  });

  it('DSN с TLS-параметрами + sslmode в config → ошибка (DSN молча перекрыл бы политику)', () => {
    expect(() =>
      buildPoolConfig(
        { connectionString: 'postgres://u:p@h/db?sslmode=disable', pool: { sslmode: 'verify-full' }, tls: { caPem: CERT_A } },
        SCHEMA,
      ),
    ).toThrow(/TLS-параметры в DSN/);
  });

  it('сообщение подсказывает вынести TLS из DSN', () => {
    expect(() =>
      buildPoolConfig({ connectionString: 'postgres://u:p@h/db?sslmode=disable' }, SCHEMA),
    ).toThrow(/уберите TLS-параметры из DSN или задайте их только в storage\.postgres\.sslmode/);
  });

  it('DSN с sslrootcert/sslkey → ошибка даже без sslmode в config', () => {
    expect(() =>
      buildPoolConfig({ connectionString: 'postgres://u:p@h/db?sslrootcert=/ca.pem&sslkey=/k.pem' }, SCHEMA),
    ).toThrow(/TLS-параметры в DSN/);
  });

  it('чистый DSN → ssl не задан', () => {
    const cfg = buildPoolConfig({ connectionString: 'postgres://u:p@127.0.0.1:5432/synth' }, SCHEMA);
    expect(cfg).not.toHaveProperty('ssl');
  });

  it('assertNoDsnTlsParams: чисто — не бросает; с TLS — бросает', () => {
    expect(() => assertNoDsnTlsParams('postgres://u:p@h/db')).not.toThrow();
    expect(() => assertNoDsnTlsParams(undefined)).not.toThrow();
    expect(() => assertNoDsnTlsParams('postgres://u:p@h/db?sslmode=verify-full')).toThrow(
      PostgresStorageConfigError,
    );
  });
});
