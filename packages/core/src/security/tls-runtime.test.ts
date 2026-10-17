import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:https';
import * as undici from 'undici';
import { resolveProxyConfig, type TlsRuntimeSettings } from '@itphx/synth-shared';
import { writeTlsSecretFile, writeTlsRuntimeSettings } from '@itphx/synth-shared';
import {
  _resetTlsTrustForTests,
  buildTlsTrustProfiles,
  egressFetch,
  getTlsCaPath,
  getTlsStatus,
  initTlsTrust,
} from './tls.js';
import { EgressDispatcher } from './proxy-dispatcher.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const CA_PEM = await readFile(join(FIX_DIR, 'tls-test-selfsigned.pem'), 'utf-8');
const CA_KEY = await readFile(join(FIX_DIR, 'tls-test-selfsigned.key'), 'utf-8');
const CLIENT_CERT = await readFile(join(FIX_DIR, 'tls-test-proxy-client.pem'), 'utf-8');
const CLIENT_KEY = await readFile(join(FIX_DIR, 'tls-test-proxy-client.key'), 'utf-8');
const PROXY_CA = await readFile(join(FIX_DIR, 'tls-test-proxy.pem'), 'utf-8');

const dirs: string[] = [];

afterEach(async () => {
  _resetTlsTrustForTests();
  // Не оставляем глобальный dispatcher доверия другим тестам (изоляция).
  undici.setGlobalDispatcher(new undici.Agent());
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function makeBootstrap(): Promise<{ dir: string; runtime: TlsRuntimeSettings }> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-tls-core-'));
  dirs.push(dir);
  const caFile = await writeTlsSecretFile(dir, 'ca.pem', CA_PEM);
  const defaultCert = await writeTlsSecretFile(dir, 'client.crt', CA_PEM);
  const defaultKey = await writeTlsSecretFile(dir, 'client.key', CA_KEY);
  const mapCert = await writeTlsSecretFile(dir, 'internal.crt', CLIENT_CERT);
  const mapKey = await writeTlsSecretFile(dir, 'internal.key', CLIENT_KEY);
  const runtime: TlsRuntimeSettings = {
    caFile,
    rejectUnauthorized: true,
    defaultClient: { certFile: defaultCert, keyFile: defaultKey },
    mappings: [
      {
        id: 'internal',
        hosts: ['*.internal', 'db.internal'],
        certFile: mapCert,
        keyFile: mapKey,
        label: 'Internal mTLS',
      },
    ],
  };
  await writeTlsRuntimeSettings(dir, runtime);
  return { dir, runtime };
}

describe('initTlsTrust: bootstrap читается до storage/PG', () => {
  it('подхватывает security-tls.json (CA + per-host профиль) из dataDir', async () => {
    const { dir, runtime } = await makeBootstrap();
    const trust = await initTlsTrust(undefined, {}, { dataDir: dir });

    expect(getTlsCaPath()).toBe(runtime.caFile);
    expect(trust.ca).toBe(CA_PEM);
    expect(trust.profiles?.[0]).toMatchObject({
      id: 'internal',
      cert: CLIENT_CERT,
      key: CLIENT_KEY,
      readOnly: false,
    });
  });

  it('без bootstrap — прежнее поведение (системное доверие)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-tls-empty-'));
    dirs.push(dir);
    const trust = await initTlsTrust(undefined, {}, { dataDir: dir });
    expect(trust.ca).toBeUndefined();
    expect(trust.cert).toBeUndefined();
    expect(getTlsCaPath()).toBeUndefined();
  });

  it('buildTlsTrustProfiles читает mapping и default из файлов', async () => {
    const { runtime } = await makeBootstrap();
    const trust = buildTlsTrustProfiles(undefined, {}, runtime);
    expect(trust.profiles).toHaveLength(1);
    expect(trust.profiles?.[0]?.hosts).toEqual(['*.internal', 'db.internal']);
  });
});

describe('getTlsStatus (будущий API)', () => {
  it('не отдаёт PEM/ключи; показывает subject и readOnly', async () => {
    const { runtime } = await makeBootstrap();
    const status = getTlsStatus({ runtime });

    expect(status.ca.count).toBe(1);
    expect(status.ca.subjects.some((subject) => subject.includes('localhost'))).toBe(true);
    expect(status.defaultClient?.readOnly).toBe(false);
    expect(status.mappings[0]).toMatchObject({
      id: 'internal',
      hosts: ['*.internal', 'db.internal'],
      source: 'runtime',
      readOnly: false,
    });
    expect(status.mappings[0]?.certSubject).toContain('synth-test-client');

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('BEGIN CERTIFICATE');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
  });

  it('config-источники read-only', () => {
    const status = getTlsStatus({
      config: {
        security: {
          tls: {
            caPem: CA_PEM,
            certFile: join(FIX_DIR, 'tls-test-proxy-client.pem'),
            keyFile: join(FIX_DIR, 'tls-test-proxy-client.key'),
          },
        },
      },
      env: {},
    });
    expect(status.defaultClient).toMatchObject({ source: 'config', readOnly: true, hasKey: true });
    expect(status.params.client?.readOnly).toBe(true);
    expect(status.params.ca).toMatchObject({ source: 'config', hasPem: true });
  });

  it('env приоритетнее runtime и помечает параметр read-only', () => {
    const status = getTlsStatus({
      config: { security: { tls: { caPem: CA_PEM } } },
      env: { SYNTH_TLS_REJECT_UNAUTHORIZED: 'false' },
      runtime: { rejectUnauthorized: true },
    });
    expect(status.rejectUnauthorized).toBe(false);
    expect(status.params.ca?.source).toBe('config');
  });

  it('saved vs running: после init изменение runtime → restartRequired', async () => {
    const { dir, runtime } = await makeBootstrap();
    await initTlsTrust(undefined, {}, { dataDir: dir });

    const same = getTlsStatus({ runtime, dataDir: dir });
    expect(same.running?.applied).toBe(true);
    expect(same.restartRequired).toBe(false);

    const changed = getTlsStatus({
      runtime: { ...runtime, mappings: [], defaultClient: { certFile: runtime.defaultClient!.certFile!, keyFile: runtime.defaultClient!.keyFile! } },
      dataDir: dir,
    });
    expect(changed.restartRequired).toBe(true);
  });
});

describe('EgressDispatcher: выбор профиля по host', () => {
  const proxy = resolveProxyConfig({ proxy: { enabled: false } }, {});
  const defaultTls = { ca: CA_PEM, rejectUnauthorized: true };
  const profiles = [
    {
      id: 'internal',
      hosts: ['api.internal', '*.svc.internal'],
      tls: { ca: CA_PEM, cert: CLIENT_CERT, key: CLIENT_KEY, rejectUnauthorized: true },
    },
    { id: 'all', hosts: ['*'], tls: { ca: CA_PEM, cert: CA_PEM, key: CA_KEY, rejectUnauthorized: true } },
  ];

  it('exact / *.suffix / * и default fallback', () => {
    const exact = new EgressDispatcher({ proxy, tls: defaultTls, tlsProfiles: profiles });
    expect(exact.tlsProfileIdFor('https://api.internal/')).toBe('internal');
    expect(exact.tlsProfileIdFor('https://x.svc.internal/')).toBe('internal');
    expect(exact.tlsProfileIdFor('https://other.test/')).toBe('all');
    expect(exact.requestTlsFor('https://api.internal/').cert).toBe(CLIENT_CERT);
    void exact.close();

    const fallbackOnly = new EgressDispatcher({
      proxy,
      tls: defaultTls,
      tlsProfiles: [profiles[0]!],
    });
    expect(fallbackOnly.tlsProfileIdFor('https://other.test/')).toBe('default');
    expect(fallbackOnly.requestTlsFor('https://other.test/').cert).toBeUndefined();
    void fallbackOnly.close();
  });
});

describe('EgressDispatcher: mTLS к цели по host', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer(
      {
        key: CA_KEY,
        cert: CA_PEM,
        requestCert: true,
        rejectUnauthorized: false,
        ca: PROXY_CA,
      },
      (_req, res) => {
        const peer = (_req.socket as import('node:tls').TLSSocket).getPeerCertificate();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cn: peer?.subject?.CN ?? null }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('для совпавшего host отправляется клиентский сертификат', async () => {
    const proxy = resolveProxyConfig({ proxy: { enabled: false } }, {});
    const dispatcher = new EgressDispatcher({
      proxy,
      tls: { ca: CA_PEM, rejectUnauthorized: true },
      tlsProfiles: [
        {
          id: 'localhost-mtls',
          hosts: ['localhost'],
          tls: { ca: CA_PEM, cert: CLIENT_CERT, key: CLIENT_KEY, rejectUnauthorized: true },
        },
      ],
    });
    try {
      const res = await egressFetch(`https://localhost:${port}/`, {}, { dispatcher });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ cn: 'synth-test-client' });
    } finally {
      await dispatcher.close();
    }
  });
});
