import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTlsConfig, resolveTlsTrust, isPemContent } from './tls.js';
import {
  buildPostgresSslOptions,
  findDsnTlsParams,
  normalizePostgresSslMode,
} from './tls.js';
import type { TlsConfigSource } from './tls.js';

/** Валидный PEM-сертификат (содержимое неважно — важна разметка блока). */
const CERT_A = '-----BEGIN CERTIFICATE-----\nQUJB\n-----END CERTIFICATE-----\n';
const CERT_B = '-----BEGIN CERTIFICATE-----\nQkNC\n-----END CERTIFICATE-----\n';

async function withTmpFile<T>(name: string, content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-tls-test-'));
  try {
    const path = join(dir, name);
    await writeFile(path, content, 'utf-8');
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('isPemContent', () => {
  it('распознаёт PEM-блок', () => {
    expect(isPemContent(CERT_A)).toBe(true);
    expect(isPemContent('not a pem')).toBe(false);
  });
});

describe('resolveTlsConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('пустой конфиг → системное доверие (rejectUnauthorized=true, без CA)', () => {
    const resolved = resolveTlsConfig(undefined, {});
    expect(resolved.rejectUnauthorized).toBe(true);
    expect(resolved.caFile).toBeUndefined();
    expect(resolved.caPem).toBeUndefined();
  });

  it('env приоритетнее config.yaml для того же поля (ADR-023)', () => {
    const cfg: TlsConfigSource = { security: { tls: { caFile: '/cfg/ca.pem' } } };
    const env = { SYNTH_TLS_CA_FILE: '/env/ca.pem' };
    expect(resolveTlsConfig(cfg, env).caFile).toBe('/env/ca.pem');
  });

  it('пустая строка env — «не задано» (фоллбэк на config)', () => {
    const cfg: TlsConfigSource = { security: { tls: { caFile: '/cfg/ca.pem' } } };
    const env = { SYNTH_TLS_CA_FILE: '' };
    expect(resolveTlsConfig(cfg, env).caFile).toBe('/cfg/ca.pem');
  });

  it('env rejectUnauthorized=false перекрывает config', () => {
    const cfg: TlsConfigSource = { security: { tls: { rejectUnauthorized: true } } };
    const env = { SYNTH_TLS_REJECT_UNAUTHORIZED: 'false' };
    expect(resolveTlsConfig(cfg, env).rejectUnauthorized).toBe(false);
  });

  it('читает certFile/keyFile (mTLS)', () => {
    const cfg: TlsConfigSource = { security: { tls: { certFile: '/c.pem', keyFile: '/k.pem' } } };
    const resolved = resolveTlsConfig(cfg, {});
    expect(resolved.certFile).toBe('/c.pem');
    expect(resolved.keyFile).toBe('/k.pem');
  });

  it('fail-closed: caFile и caPem одновременно (config) → ошибка', () => {
    const cfg: TlsConfigSource = { security: { tls: { caFile: '/a.pem', caPem: CERT_A } } };
    expect(() => resolveTlsConfig(cfg, {})).toThrow(/взаимоисключа/i);
  });

  it('fail-closed: caFile и caPem одновременно (env) → ошибка', () => {
    const env = { SYNTH_TLS_CA_FILE: '/a.pem', SYNTH_TLS_CA_PEM: CERT_A };
    expect(() => resolveTlsConfig(undefined, env)).toThrow(/взаимоисключа/i);
  });

  it('fail-closed: env caFile + config caPem → ошибка (после слияния оба непусты)', () => {
    const cfg: TlsConfigSource = { security: { tls: { caPem: CERT_A } } };
    const env = { SYNTH_TLS_CA_FILE: '/a.pem' };
    expect(() => resolveTlsConfig(cfg, env)).toThrow(/взаимоисключа/i);
  });
});

describe('resolveTlsTrust', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('пустой конфиг → доверие не сконфигурировано, системное', () => {
    const trust = resolveTlsTrust(undefined, {});
    expect(trust.enabled).toBe(false);
    expect(trust.rejectUnauthorized).toBe(true);
    expect(trust.ca).toBeUndefined();
  });

  it('валидный caPem → enabled, ca = PEM', () => {
    const cfg: TlsConfigSource = { security: { tls: { caPem: CERT_A } } };
    const trust = resolveTlsTrust(cfg, {});
    expect(trust.enabled).toBe(true);
    expect(trust.ca).toBe(CERT_A);
  });

  it('fail-closed: caPem без PEM-блока → ошибка', () => {
    const cfg: TlsConfigSource = { security: { tls: { caPem: 'not a pem' } } };
    expect(() => resolveTlsTrust(cfg, {})).toThrow(/не содержит PEM/i);
  });

  it('fail-closed: отсутствующий caFile → ошибка', () => {
    const cfg: TlsConfigSource = { security: { tls: { caFile: '/no/such/ca.pem' } } };
    expect(() => resolveTlsTrust(cfg, {})).toThrow(/не удалось прочитать/i);
  });

  it('fail-closed: caFile не PEM → ошибка', async () => {
    await withTmpFile('ca.pem', 'just text', async (path) => {
      const cfg: TlsConfigSource = { security: { tls: { caFile: path } } };
      expect(() => resolveTlsTrust(cfg, {})).toThrow(/не содержит PEM/i);
    });
  });

  it('валидный caFile → ca = содержимое файла', async () => {
    await withTmpFile('ca.pem', CERT_B, async (path) => {
      const cfg: TlsConfigSource = { security: { tls: { caFile: path } } };
      const trust = resolveTlsTrust(cfg, {});
      expect(trust.enabled).toBe(true);
      expect(trust.ca).toBe(CERT_B);
    });
  });

  it('rejectUnauthorized=false → enabled даже без CA', () => {
    const cfg: TlsConfigSource = { security: { tls: { rejectUnauthorized: false } } };
    const trust = resolveTlsTrust(cfg, {});
    expect(trust.enabled).toBe(true);
    expect(trust.rejectUnauthorized).toBe(false);
  });

  it('certFile/keyFile → enabled (mTLS), пути пробрасываются', () => {
    const cfg: TlsConfigSource = { security: { tls: { certFile: '/c.pem', keyFile: '/k.pem' } } };
    const trust = resolveTlsTrust(cfg, {});
    expect(trust.enabled).toBe(true);
    expect(trust.certFile).toBe('/c.pem');
    expect(trust.keyFile).toBe('/k.pem');
  });

  it('невалидный SYNTH_TLS_REJECT_UNAUTHORIZED → warn + фолбэк на config', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg: TlsConfigSource = { security: { tls: { rejectUnauthorized: false } } };
      const env = { SYNTH_TLS_REJECT_UNAUTHORIZED: 'nope' };
      const trust = resolveTlsTrust(cfg, env);
      expect(trust.rejectUnauthorized).toBe(false); // фолбэк на config
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('SYNTH_TLS_REJECT_UNAUTHORIZED'));
    } finally {
      warn.mockRestore();
    }
  });

  it('невалидный SYNTH_TLS_REJECT_UNAUTHORIZED без config → true (дефолт)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveTlsTrust(undefined, { SYNTH_TLS_REJECT_UNAUTHORIZED: 'x' }).rejectUnauthorized).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('normalizePostgresSslMode', () => {
  it('канонические значения проходят как есть', () => {
    expect(normalizePostgresSslMode('disable')).toBe('disable');
    expect(normalizePostgresSslMode('require')).toBe('require');
    expect(normalizePostgresSslMode('verify-full')).toBe('verify-full');
  });

  it('verify-ca — алиас verify-full с предупреждением', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(normalizePostgresSslMode('verify-ca')).toBe('verify-full');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('verify-ca'));
    } finally {
      warn.mockRestore();
    }
  });

  it('пусто/неизвестное → undefined (без warn для пустого)', () => {
    expect(normalizePostgresSslMode(undefined)).toBeUndefined();
    expect(normalizePostgresSslMode('')).toBeUndefined();
    expect(normalizePostgresSslMode('bogus')).toBeUndefined();
  });
});

describe('findDsnTlsParams', () => {
  it('URL-форма: находит sslmode/sslrootcert', () => {
    expect(findDsnTlsParams('postgres://u:p@h:5432/db?sslmode=require')).toEqual(['sslmode']);
    expect(
      findDsnTlsParams('postgres://u:p@h/db?sslmode=verify-full&sslrootcert=/ca.pem'),
    ).toEqual(expect.arrayContaining(['sslmode', 'sslrootcert']));
  });

  it('libpq-подобная форма: sslmode= без URL', () => {
    expect(findDsnTlsParams('host=h dbname=db sslmode=require')).toEqual(['sslmode']);
  });

  it('чистый DSN → пусто', () => {
    expect(findDsnTlsParams('postgres://u:p@127.0.0.1:5432/synth')).toEqual([]);
    expect(findDsnTlsParams(undefined)).toEqual([]);
    expect(findDsnTlsParams('')).toEqual([]);
  });
});

describe('buildPostgresSslOptions', () => {
  it('sslmode не задан и ssl не задан → без TLS (прежнее поведение)', () => {
    expect(buildPostgresSslOptions({})).toEqual({});
  });

  it('sslmode не задан: legacy ssl пробрасывается как есть', () => {
    expect(buildPostgresSslOptions({ ssl: false })).toEqual({ ssl: false });
    expect(buildPostgresSslOptions({ ssl: true })).toEqual({ ssl: true });
  });

  it('disable → ssl:false (CA/mTLS игнорируются)', () => {
    const cfg: TlsConfigSource = { security: { tls: { caPem: CERT_A, certFile: '/c.pem', keyFile: '/k.pem' } } };
    expect(buildPostgresSslOptions({ sslmode: 'disable', config: cfg })).toEqual({ ssl: false });
  });

  it('require → rejectUnauthorized:false без CA', () => {
    expect(buildPostgresSslOptions({ sslmode: 'require' })).toEqual({
      ssl: { rejectUnauthorized: false },
    });
  });

  it('verify-full без CA → fail-closed', () => {
    expect(() => buildPostgresSslOptions({ sslmode: 'verify-full' })).toThrow(/требует доверенный CA/);
  });

  it('verify-full с caPem → проверка включена + CA', () => {
    const cfg: TlsConfigSource = { security: { tls: { caPem: CERT_A } } };
    expect(buildPostgresSslOptions({ sslmode: 'verify-full', config: cfg })).toEqual({
      ssl: { rejectUnauthorized: true, ca: CERT_A },
    });
  });

  it('verify-full: servername проставляется из host (не IP)', () => {
    const cfg: TlsConfigSource = { security: { tls: { caPem: CERT_A } } };
    const result = buildPostgresSslOptions({ sslmode: 'verify-full', config: cfg, host: 'db.internal' });
    expect((result.ssl as Record<string, unknown>).servername).toBe('db.internal');
  });

  it('verify-full: IP-хост — servername НЕ проставляется (SNI по IP запрещён)', () => {
    const cfg: TlsConfigSource = { security: { tls: { caPem: CERT_A } } };
    const result = buildPostgresSslOptions({ sslmode: 'verify-full', config: cfg, host: '10.0.0.5' });
    expect(result.ssl).toEqual({ rejectUnauthorized: true, ca: CERT_A });
  });

  it('verify-full: DSN задан — servername не проставляется (host берёт pg)', () => {
    const cfg: TlsConfigSource = { security: { tls: { caPem: CERT_A } } };
    const result = buildPostgresSslOptions({
      sslmode: 'verify-full',
      config: cfg,
      host: 'db.internal',
      connectionString: 'postgres://u:p@db.internal/db',
    });
    expect((result.ssl as Record<string, unknown>).servername).toBeUndefined();
  });

  it('verify-ca: алиас verify-full (warn) с проверкой сертификата', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg: TlsConfigSource = { security: { tls: { caPem: CERT_A } } };
      const result = buildPostgresSslOptions({ sslmode: 'verify-ca', config: cfg });
      expect(result.ssl).toEqual({ rejectUnauthorized: true, ca: CERT_A });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('verify-ca'));
    } finally {
      warn.mockRestore();
    }
  });

  it('verify-full: CA из caFile + mTLS cert/key из файлов', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-pg-tls-'));
    try {
      const caPath = join(dir, 'ca.pem');
      const certPath = join(dir, 'client.pem');
      const keyPath = join(dir, 'client.key');
      await writeFile(caPath, CERT_B, 'utf-8');
      await writeFile(certPath, CERT_A, 'utf-8');
      await writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n', 'utf-8');
      const cfg: TlsConfigSource = {
        security: { tls: { caFile: caPath, certFile: certPath, keyFile: keyPath } },
      };
      const result = buildPostgresSslOptions({ sslmode: 'verify-full', config: cfg });
      expect(result.ssl).toMatchObject({
        rejectUnauthorized: true,
        ca: CERT_B,
        cert: CERT_A,
        key: expect.stringContaining('BEGIN PRIVATE KEY'),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('require с mTLS: cert/key добавляются к unverified-шифрованию', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-pg-tls-'));
    try {
      const certPath = join(dir, 'client.pem');
      const keyPath = join(dir, 'client.key');
      await writeFile(certPath, CERT_A, 'utf-8');
      await writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n', 'utf-8');
      const cfg: TlsConfigSource = { security: { tls: { certFile: certPath, keyFile: keyPath } } };
      const result = buildPostgresSslOptions({ sslmode: 'require', config: cfg });
      expect(result.ssl).toMatchObject({ rejectUnauthorized: false, cert: CERT_A });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('mTLS: задан только один из certFile/keyFile → ошибка', () => {
    const cfg: TlsConfigSource = { security: { tls: { certFile: '/c.pem' } } };
    expect(() => buildPostgresSslOptions({ sslmode: 'require', config: cfg })).toThrow(/и certFile, и keyFile/);
  });
});
