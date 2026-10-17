import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPostgresSslOptions,
  matchTlsHostPattern,
  resolveTlsConfig,
  resolveTlsProfiles,
  selectTlsClientProfile,
  type TlsRuntimeSettings,
} from './tls.js';
import {
  readTlsRuntimeSettings,
  tlsRuntimePath,
  tlsSecretFilePath,
  tlsSecretsDir,
  validateTlsRuntimeSettings,
  writeTlsRuntimeSettings,
  writeTlsSecretFile,
} from './tls-runtime.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const CA_PEM = await readFile(join(FIX_DIR, 'tls-test-selfsigned.pem'), 'utf-8');
const CA_KEY = await readFile(join(FIX_DIR, 'tls-test-selfsigned.key'), 'utf-8');
const CLIENT_CERT = await readFile(join(FIX_DIR, 'tls-test-proxy-client.pem'), 'utf-8');
const CLIENT_KEY = await readFile(join(FIX_DIR, 'tls-test-proxy-client.key'), 'utf-8');

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-tls-runtime-'));
  dirs.push(dir);
  return dir;
}

/** Готовит каталог с материалами и возвращает runtime-настройки. */
async function makeRuntime(): Promise<{ dir: string; settings: TlsRuntimeSettings }> {
  const dir = await makeDir();
  const caFile = await writeTlsSecretFile(dir, 'ca.pem', CA_PEM);
  const defaultCert = await writeTlsSecretFile(dir, 'client.crt', CA_PEM);
  const defaultKey = await writeTlsSecretFile(dir, 'client.key', CA_KEY);
  const mapCert = await writeTlsSecretFile(dir, 'internal.crt', CLIENT_CERT);
  const mapKey = await writeTlsSecretFile(dir, 'internal.key', CLIENT_KEY);
  return {
    dir,
    settings: {
      caFile,
      rejectUnauthorized: true,
      defaultClient: { certFile: defaultCert, keyFile: defaultKey },
      mappings: [
        {
          id: 'internal',
          hosts: ['db.internal', '*.svc.internal'],
          certFile: mapCert,
          keyFile: mapKey,
          label: 'Internal DB',
        },
      ],
    },
  };
}

describe('resolveTlsProfiles (приоритеты env > runtime > config)', () => {
  it('env перекрывает runtime и config поле-уровнево', () => {
    const runtime: TlsRuntimeSettings = { caFile: '/rt/ca.pem', rejectUnauthorized: false };
    const cfg = { security: { tls: { caFile: '/cfg/ca.pem', rejectUnauthorized: true } } };
    const resolved = resolveTlsProfiles(cfg, { SYNTH_TLS_CA_FILE: '/env/ca.pem' }, runtime);
    expect(resolved.caFile).toBe('/env/ca.pem');
    expect(resolved.sources.ca).toBe('env');
    expect(resolved.rejectUnauthorized).toBe(false);
    expect(resolved.sources.rejectUnauthorized).toBe('runtime');
  });

  it('runtime перекрывает config', () => {
    const resolved = resolveTlsProfiles(
      { security: { tls: { caFile: '/cfg/ca.pem' } } },
      {},
      { caFile: '/rt/ca.pem', rejectUnauthorized: false },
    );
    expect(resolved.caFile).toBe('/rt/ca.pem');
    expect(resolved.sources.ca).toBe('runtime');
    expect(resolved.sources.rejectUnauthorized).toBe('runtime');
  });

  it('env rejectUnauthorized=false приоритетнее runtime', () => {
    const resolved = resolveTlsProfiles(undefined, { SYNTH_TLS_REJECT_UNAUTHORIZED: 'false' }, {
      rejectUnauthorized: true,
    });
    expect(resolved.rejectUnauthorized).toBe(false);
    expect(resolved.sources.rejectUnauthorized).toBe('env');
  });

  it('конфликт caFile (env) и caPem (runtime) → fail-closed', () => {
    expect(() =>
      resolveTlsProfiles(undefined, { SYNTH_TLS_CA_FILE: '/env/ca.pem' }, { caPem: CA_PEM }),
    ).toThrow(/взаимоисключа/i);
  });

  it('runtime defaultClient даёт редактируемый профиль default', () => {
    const resolved = resolveTlsProfiles(undefined, {}, {
      defaultClient: { certFile: '/c.pem', keyFile: '/k.pem' },
    });
    expect(resolved.default).toMatchObject({
      id: 'default',
      source: 'runtime',
      readOnly: false,
      certFile: '/c.pem',
    });
  });

  it('неполная клиентская пара → fail-closed', () => {
    expect(() =>
      resolveTlsProfiles({ security: { tls: { keyFile: '/cfg/k.pem' } } }, {}),
    ).toThrow(/и certFile, и keyFile/);
  });

  it('resolveTlsConfig учитывает runtime (CA и default-клиент)', () => {
    const resolved = resolveTlsConfig(undefined, {}, {
      caPem: CA_PEM,
      rejectUnauthorized: false,
      defaultClient: { certFile: '/c.pem', keyFile: '/k.pem' },
    });
    expect(resolved.caPem).toBe(CA_PEM);
    expect(resolved.rejectUnauthorized).toBe(false);
    expect(resolved.certFile).toBe('/c.pem');
  });
});

describe('матчинг клиентских профилей', () => {
  const profiles = {
    default: { id: 'default', hosts: [], certFile: '/d.crt', keyFile: '/d.key', source: 'runtime' as const, readOnly: false },
    mappings: [
      { id: 'exact', hosts: ['api.example.com'], certFile: '/e.crt', keyFile: '/e.key', source: 'runtime' as const, readOnly: false },
      { id: 'wild', hosts: ['*.svc.example.com'], certFile: '/w.crt', keyFile: '/w.key', source: 'runtime' as const, readOnly: false },
      { id: 'all', hosts: ['*'], certFile: '/a.crt', keyFile: '/a.key', source: 'runtime' as const, readOnly: false },
    ],
  };

  it('точный host, *.suffix, * — регистронезависимо', () => {
    expect(selectTlsClientProfile(profiles, 'API.EXAMPLE.COM')?.id).toBe('exact');
    expect(selectTlsClientProfile(profiles, 'x.svc.example.com')?.id).toBe('wild');
    expect(selectTlsClientProfile(profiles, 'other.test')?.id).toBe('all');
    expect(matchTlsHostPattern('*.example.com', 'a.b.example.com')).toBe(true);
    expect(matchTlsHostPattern('*.example.com', 'example.com')).toBe(false);
  });

  it('первое совпадение в порядке mappings', () => {
    expect(selectTlsClientProfile(profiles, 'api.example.com')?.id).toBe('exact');
  });

  it('нет совпадений → default; нет default → undefined', () => {
    expect(selectTlsClientProfile({ mappings: [] , default: profiles.default }, 'x.test')?.id).toBe('default');
    expect(selectTlsClientProfile({ mappings: [] }, 'x.test')).toBeUndefined();
  });
});

describe('bootstrap-хранилище security-tls.json', () => {
  it('write → read (roundtrip), файл 0600, каталог секретов 0700', async () => {
    const { dir, settings } = await makeRuntime();
    await writeTlsRuntimeSettings(dir, settings);

    const fileStat = await stat(tlsRuntimePath(dir));
    expect(fileStat.mode & 0o777).toBe(0o600);
    const secretsStat = await stat(tlsSecretsDir(dir));
    expect(secretsStat.mode & 0o777).toBe(0o700);
    const materialStat = await stat(tlsSecretFilePath(dir, 'ca.pem'));
    expect(materialStat.mode & 0o777).toBe(0o600);

    const loaded = readTlsRuntimeSettings(dir);
    expect(loaded?.mappings?.[0]?.id).toBe('internal');
    expect(loaded?.caFile).toBe(settings.caFile);
  });

  it('файла нет → undefined (прежнее поведение)', () => {
    const dir = join(tmpdir(), 'synth-tls-missing');
    expect(readTlsRuntimeSettings(dir)).toBeUndefined();
  });

  it('невалидный JSON → fail-closed', async () => {
    const dir = await makeDir();
    await writeFile(tlsRuntimePath(dir), '{nope', 'utf-8');
    expect(() => readTlsRuntimeSettings(dir)).toThrow(/невалидный JSON/i);
  });

  it('валидация: cert и key не соответствуют друг другу → ошибка', async () => {
    const dir = await makeDir();
    const cert = await writeTlsSecretFile(dir, 'client.crt', CA_PEM);
    const key = await writeTlsSecretFile(dir, 'client.key', CLIENT_KEY);
    expect(() =>
      validateTlsRuntimeSettings({ defaultClient: { certFile: cert, keyFile: key } }),
    ).toThrow(/не соответствуют/i);
  });

  it('валидация: пустые hosts / плохой паттерн / дубликат id', () => {
    expect(() =>
      validateTlsRuntimeSettings({
        mappings: [{ id: 'a', hosts: [], certFile: '/c', keyFile: '/k' }],
      }),
    ).toThrow(/hosts/);
    expect(() =>
      validateTlsRuntimeSettings({
        mappings: [{ id: 'a', hosts: ['http://example.com'], certFile: '/c', keyFile: '/k' }],
      }),
    ).toThrow(/паттерн/);
    expect(() =>
      validateTlsRuntimeSettings({
        mappings: [
          {
            id: 'a',
            hosts: ['x'],
            certFile: join(FIX_DIR, 'tls-test-selfsigned.pem'),
            keyFile: join(FIX_DIR, 'tls-test-selfsigned.key'),
          },
          {
            id: 'a',
            hosts: ['y'],
            certFile: join(FIX_DIR, 'tls-test-selfsigned.pem'),
            keyFile: join(FIX_DIR, 'tls-test-selfsigned.key'),
          },
        ],
      }),
    ).toThrow(/дубликат/i);
  });

  it('валидация: отсутствующий материал → fail-closed', () => {
    expect(() =>
      validateTlsRuntimeSettings({
        mappings: [{ id: 'a', hosts: ['x'], certFile: '/no/such.crt', keyFile: '/no/such.key' }],
      }),
    ).toThrow(/не удалось прочитать/i);
  });
});

describe('PostgreSQL: профиль по host БД', () => {
  it('mapping выбирается по host, иначе default', async () => {
    const { dir, settings } = await makeRuntime();
    const runtime = { ...settings, caPem: CA_PEM, caFile: undefined };
    void dir;

    const mapped = buildPostgresSslOptions({
      sslmode: 'verify-full',
      host: 'db.internal',
      runtime,
    });
    expect(mapped.ssl).toMatchObject({
      rejectUnauthorized: true,
      ca: CA_PEM,
      cert: CLIENT_CERT,
      key: CLIENT_KEY,
      servername: 'db.internal',
    });

    const fallback = buildPostgresSslOptions({
      sslmode: 'verify-full',
      host: 'other.example.com',
      runtime,
    });
    expect(fallback.ssl).toMatchObject({ cert: CA_PEM, key: CA_KEY, servername: 'other.example.com' });
  });

  it('host из DSN тоже выбирает mapping', () => {
    const runtime: TlsRuntimeSettings = {
      caPem: CA_PEM,
      mappings: [
        { id: 'db', hosts: ['db.internal'], certFile: join(FIX_DIR, 'tls-test-proxy-client.pem'), keyFile: join(FIX_DIR, 'tls-test-proxy-client.key') },
      ],
    };
    const result = buildPostgresSslOptions({
      sslmode: 'verify-full',
      connectionString: 'postgres://u:p@db.internal:5432/synth',
      runtime,
    });
    expect(result.ssl).toMatchObject({ cert: CLIENT_CERT });
  });
});
