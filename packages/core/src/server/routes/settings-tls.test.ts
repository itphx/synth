/**
 * ADR-099: API `/api/v2/settings/tls` — bootstrap-настройки TLS/CA из UI.
 * Проверяем контракт (без секретов), файлы 0600, read-only env/config,
 * CRUD mappings, validate и аудит без PEM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SecurityTlsConfig } from '@itphx/synth-shared';
import { readTlsRuntimeSettings, tlsSecretFilePath } from '@itphx/synth-shared';
import { createSettingsRoutes } from './settings.js';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import { MemorySecurityAuditRepository } from '../../storage/memory/security-audit.js';
import type { AuthKit } from '../../auth/local.js';
import { _resetTlsTrustForTests } from '../../security/tls.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../security/__fixtures__');
const CA_PEM = await readFile(join(FIX_DIR, 'tls-test-selfsigned.pem'), 'utf-8');
const CLIENT_CERT = await readFile(join(FIX_DIR, 'tls-test-proxy-client.pem'), 'utf-8');
const CLIENT_KEY = await readFile(join(FIX_DIR, 'tls-test-proxy-client.key'), 'utf-8');

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

interface AppOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  fallbackTls?: SecurityTlsConfig;
  audit?: MemorySecurityAuditRepository;
  writeGuard?: (c: Context, next: Next) => Promise<void>;
}

function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  app.route('/api/v2/settings', createSettingsRoutes(
    createMockAuth(),
    {
      settingsStore: new RuntimeSettingsStore({ dataDir: options.dataDir ?? '/tmp/unused-settings-tls' }),
      fallbackWorkspace: '/ws',
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      env: options.env ?? {},
      ...(options.fallbackTls ? { fallbackTls: options.fallbackTls } : {}),
      ...(options.audit ? { securityAudit: options.audit } : {}),
    },
    options.writeGuard ? { settingsWriteGuard: options.writeGuard as never } : {},
  ));
  return app;
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

function tlsPath(path: string): string {
  return path === '/' ? '/api/v2/settings/tls' : `/api/v2/settings/tls${path}`;
}

function put(app: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(tlsPath(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(tlsPath(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('GET /api/v2/settings/tls', () => {
  let dir: string;

  beforeEach(async () => {
    _resetTlsTrustForTests();
    dir = await mkdtemp(join(tmpdir(), 'synth-settings-tls-'));
  });

  afterEach(async () => {
    _resetTlsTrustForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it('отдаёт статус без PEM/ключей (CA source/count/subjects, mappings, params)', async () => {
    const app = createApp({
      dataDir: dir,
      fallbackTls: { caPem: CA_PEM },
    });
    const res = await app.request('/api/v2/settings/tls');
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;
    expect(body.ca).toMatchObject({ source: 'config', count: 1 });
    expect(body.status.ca).toMatchObject({ source: 'config', count: 1 });
    expect(body.ca.subjects.some((s: string) => s.includes('localhost'))).toBe(true);
    expect(body.params.ca).toMatchObject({ source: 'config', hasPem: true });
    expect(body.restartRequired).toBe(false);
    expect(text).not.toContain('BEGIN CERTIFICATE');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
  });

  it('без dataDir отдаёт config/env-статус (runtime не читается)', async () => {
    const app = createApp({ env: { SYNTH_TLS_CA_PEM: CA_PEM } });
    const res = await app.request('/api/v2/settings/tls');
    expect(res.status).toBe(200);
    expect((await json(res)).ca).toMatchObject({ source: 'env', count: 1 });
  });
});

describe('PUT /api/v2/settings/tls (несекретные поля)', () => {
  let dir: string;
  let audit: MemorySecurityAuditRepository;

  beforeEach(async () => {
    _resetTlsTrustForTests();
    dir = await mkdtemp(join(tmpdir(), 'synth-settings-tls-'));
    audit = new MemorySecurityAuditRepository();
  });

  afterEach(async () => {
    _resetTlsTrustForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it('сохраняет rejectUnauthorized и отдаёт restartRequired=true', async () => {
    const app = createApp({ dataDir: dir });
    const res = await put(app, '/', { tls: { rejectUnauthorized: false } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.restartRequired).toBe(true);
    expect(body.status.rejectUnauthorized).toBe(false);
    expect(readTlsRuntimeSettings(dir)?.rejectUnauthorized).toBe(false);
  });

  it('caFile+caPem вместе → 400', async () => {
    const app = createApp({ dataDir: dir });
    const res = await put(app, '/', { tls: { caFile: '/a.pem', caPem: CA_PEM } });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
  });

  it('несекретный PUT не принимает cert/keyPem', async () => {
    const app = createApp({ dataDir: dir });
    const res = await put(app, '/', { tls: { certPem: CLIENT_CERT } });
    expect(res.status).toBe(400);
  });

  it('смена CA не теряет mappings (merge)', async () => {
    const app = createApp({ dataDir: dir });
    const created = await post(app, '/mappings', {
      hosts: ['db.internal'],
      certPem: CLIENT_CERT,
      keyPem: CLIENT_KEY,
    });
    expect(created.status).toBe(200);

    const ca = await put(app, '/ca', { pem: CA_PEM });
    expect(ca.status).toBe(200);
    const runtime = readTlsRuntimeSettings(dir);
    expect(runtime?.mappings).toHaveLength(1);
    expect(runtime?.mappings?.[0]?.hosts).toEqual(['db.internal']);
    expect(runtime?.caFile).toBe(tlsSecretFilePath(dir, 'ca.pem'));
  });

  it('аудит: scope tls, before/after без PEM', async () => {
    const app = createApp({ dataDir: dir, audit });
    await put(app, '/ca', { pem: CA_PEM });
    const entries = await audit.list({ scope: 'tls' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: 'tls', action: 'update', source: 'runtime' });
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain('BEGIN CERTIFICATE');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).toContain('localhost');

    await app.request('/api/v2/settings/tls/ca', { method: 'DELETE' });
    const reset = await audit.list({ scope: 'tls' });
    expect(reset[0]).toMatchObject({ scope: 'tls', action: 'reset' });
    expect(JSON.stringify(reset[0])).not.toContain('BEGIN');
  });
});

describe('CA: загрузка/удаление и read-only env', () => {
  let dir: string;

  beforeEach(async () => {
    _resetTlsTrustForTests();
    dir = await mkdtemp(join(tmpdir(), 'synth-settings-tls-'));
  });

  afterEach(async () => {
    _resetTlsTrustForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it('PUT /ca пишет secrets/tls/ca.pem (0600) и bootstrap caFile', async () => {
    const app = createApp({ dataDir: dir });
    const res = await put(app, '/ca', { pem: CA_PEM });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.restartRequired).toBe(true);
    expect(body.status.ca).toMatchObject({ source: 'runtime', count: 1 });

    const file = tlsSecretFilePath(dir, 'ca.pem');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(readTlsRuntimeSettings(dir)?.caFile).toBe(file);
  });

  it('CA из env → 409 (read-only)', async () => {
    const app = createApp({ dataDir: dir, env: { SYNTH_TLS_CA_PEM: CA_PEM } });
    expect((await put(app, '/ca', { pem: CA_PEM })).status).toBe(409);
    expect((await app.request('/api/v2/settings/tls/ca', { method: 'DELETE' })).status).toBe(409);
  });

  it('DELETE /ca убирает runtime-CA и файл', async () => {
    const app = createApp({ dataDir: dir });
    await put(app, '/ca', { pem: CA_PEM });
    const res = await app.request('/api/v2/settings/tls/ca', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await json(res)).restartRequired).toBe(true);
    expect(readTlsRuntimeSettings(dir)?.caFile).toBeUndefined();
    await expect(stat(tlsSecretFilePath(dir, 'ca.pem'))).rejects.toThrow();
  });

  it('битый PEM → 400', async () => {
    const app = createApp({ dataDir: dir });
    const res = await put(app, '/ca', { pem: 'not a pem' });
    expect(res.status).toBe(400);
  });
});

describe('Default client (mTLS)', () => {
  let dir: string;

  beforeEach(async () => {
    _resetTlsTrustForTests();
    dir = await mkdtemp(join(tmpdir(), 'synth-settings-tls-'));
  });

  afterEach(async () => {
    _resetTlsTrustForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it('upload/remove: файлы 0600, bootstrap defaultClient', async () => {
    const app = createApp({ dataDir: dir });
    const res = await put(app, '/client', { certPem: CLIENT_CERT, keyPem: CLIENT_KEY });
    expect(res.status).toBe(200);
    const runtime = readTlsRuntimeSettings(dir);
    expect(runtime?.defaultClient?.certFile).toBe(tlsSecretFilePath(dir, 'client.crt'));
    expect(runtime?.defaultClient?.keyFile).toBe(tlsSecretFilePath(dir, 'client.key'));
    expect((await stat(tlsSecretFilePath(dir, 'client.crt'))).mode & 0o777).toBe(0o600);
    expect((await stat(tlsSecretFilePath(dir, 'client.key'))).mode & 0o777).toBe(0o600);

    const del = await app.request('/api/v2/settings/tls/client', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(readTlsRuntimeSettings(dir)?.defaultClient).toBeUndefined();
    await expect(stat(tlsSecretFilePath(dir, 'client.crt'))).rejects.toThrow();
  });

  it('default client из config → 409 (UI read-only)', async () => {
    const app = createApp({
      dataDir: dir,
      fallbackTls: {
        certFile: join(FIX_DIR, 'tls-test-proxy-client.pem'),
        keyFile: join(FIX_DIR, 'tls-test-proxy-client.key'),
      },
    });
    expect((await put(app, '/client', { certPem: CLIENT_CERT, keyPem: CLIENT_KEY })).status).toBe(409);
    expect((await app.request('/api/v2/settings/tls/client', { method: 'DELETE' })).status).toBe(409);
  });

  it('default client из env → 409, но mapping разрешён', async () => {
    const app = createApp({
      dataDir: dir,
      env: {
        SYNTH_TLS_CERT_FILE: join(FIX_DIR, 'tls-test-proxy-client.pem'),
        SYNTH_TLS_KEY_FILE: join(FIX_DIR, 'tls-test-proxy-client.key'),
      },
    });
    expect((await put(app, '/client', { certPem: CLIENT_CERT, keyPem: CLIENT_KEY })).status).toBe(409);
    const mapping = await post(app, '/mappings', {
      hosts: ['api.example.com'],
      certPem: CLIENT_CERT,
      keyPem: CLIENT_KEY,
    });
    expect(mapping.status).toBe(200);
  });
});

describe('Mappings CRUD', () => {
  let dir: string;

  beforeEach(async () => {
    _resetTlsTrustForTests();
    dir = await mkdtemp(join(tmpdir(), 'synth-settings-tls-'));
  });

  afterEach(async () => {
    _resetTlsTrustForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it('create → update hosts/label → delete; файлы 0600', async () => {
    const app = createApp({ dataDir: dir });
    const created = await post(app, '/mappings', {
      hosts: ['DB.internal', '*.svc.internal'],
      label: 'DB',
      certPem: CLIENT_CERT,
      keyPem: CLIENT_KEY,
    });
    expect(created.status).toBe(200);
    const createdBody = await json(created);
    const mapping = createdBody.mapping as { id: string };
    expect(mapping.id).toMatch(/^m_/);
    expect(createdBody.mapping.hosts).toEqual(['db.internal', '*.svc.internal']);
    expect(createdBody.mapping.certSubject).toContain('synth-test-client');

    const runtime = readTlsRuntimeSettings(dir);
    const saved = runtime?.mappings?.[0];
    expect(saved?.id).toBe(mapping.id);
    expect((await stat(saved!.certFile)).mode & 0o777).toBe(0o600);
    expect((await stat(saved!.keyFile)).mode & 0o777).toBe(0o600);

    const updated = await put(app, `/mappings/${mapping.id}`, {
      hosts: ['*.corp.example'],
      label: null,
    });
    expect(updated.status).toBe(200);
    const updatedBody = await json(updated);
    expect(updatedBody.mapping.hosts).toEqual(['*.corp.example']);
    expect(updatedBody.mapping.label).toBeUndefined();

    const del = await app.request(`/api/v2/settings/tls/mappings/${mapping.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(readTlsRuntimeSettings(dir)?.mappings).toEqual([]);
    await expect(stat(saved!.certFile)).rejects.toThrow();
  });

  it('неизвестный mapping → 404', async () => {
    const app = createApp({ dataDir: dir });
    expect((await put(app, '/mappings/nope', { hosts: ['x'] })).status).toBe(404);
    expect((await app.request('/api/v2/settings/tls/mappings/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('невалидный host-паттерн → 400; непарная пара → 400', async () => {
    const app = createApp({ dataDir: dir });
    expect((await post(app, '/mappings', {
      hosts: ['http://example.com'],
      certPem: CLIENT_CERT,
      keyPem: CLIENT_KEY,
    })).status).toBe(400);
    const created = await post(app, '/mappings', {
      hosts: ['x.example'],
      certPem: CLIENT_CERT,
      keyPem: CLIENT_KEY,
    });
    const id = (await json(created)).mapping.id as string;
    expect((await put(app, `/mappings/${id}`, { certPem: CLIENT_CERT })).status).toBe(400);
  });
});

describe('POST /api/v2/settings/tls/validate', () => {
  let dir: string;

  beforeEach(async () => {
    _resetTlsTrustForTests();
    dir = await mkdtemp(join(tmpdir(), 'synth-settings-tls-'));
  });

  afterEach(async () => {
    _resetTlsTrustForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it('ok: CA, клиентская пара и hosts', async () => {
    const app = createApp({ dataDir: dir });
    const res = await post(app, '/validate', {
      caPem: CA_PEM,
      certPem: CLIENT_CERT,
      keyPem: CLIENT_KEY,
      hosts: ['db.internal', '*.svc.internal', '*'],
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      ok: true,
      caCount: 1,
      keyMatches: true,
      hostPatternsValid: true,
      errors: [],
    });
    expect(body.certSubject).toContain('synth-test-client');
    expect(JSON.stringify(body)).not.toContain('BEGIN');
  });

  it('bad PEM / mismatch / bad host → ok:false и errors', async () => {
    const app = createApp({ dataDir: dir });
    const res = await post(app, '/validate', {
      caPem: 'not a pem',
      certPem: CA_PEM,
      keyPem: CLIENT_KEY,
      hosts: ['http://example.com'],
    });
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.keyMatches).toBe(false);
    expect(body.hostPatternsValid).toBe(false);
    expect(body.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('ключ без сертификата → ошибка', async () => {
    const app = createApp({ dataDir: dir });
    const body = await json(await post(app, '/validate', { keyPem: CLIENT_KEY }));
    expect(body.ok).toBe(false);
    expect(body.keyMatches).toBe(false);
  });
});

describe('RBAC: guard на мутациях', () => {
  let dir: string;

  beforeEach(async () => {
    _resetTlsTrustForTests();
    dir = await mkdtemp(join(tmpdir(), 'synth-settings-tls-'));
  });

  afterEach(async () => {
    _resetTlsTrustForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it('PUT/DELETE/POST (кроме validate) проходят через settingsWriteGuard', async () => {
    const writeGuard = vi.fn(async (_c: Context, next: Next) => { await next(); });
    const app = createApp({ dataDir: dir, writeGuard });

    await put(app, '/', { tls: { rejectUnauthorized: true } });
    await put(app, '/ca', { pem: CA_PEM });
    await app.request('/api/v2/settings/tls/ca', { method: 'DELETE' });
    await put(app, '/client', { certPem: CLIENT_CERT, keyPem: CLIENT_KEY });
    await app.request('/api/v2/settings/tls/client', { method: 'DELETE' });
    const created = await post(app, '/mappings', {
      hosts: ['x.example'],
      certPem: CLIENT_CERT,
      keyPem: CLIENT_KEY,
    });
    const id = (await json(created)).mapping.id as string;
    await put(app, `/mappings/${id}`, { hosts: ['y.example'] });
    await app.request(`/api/v2/settings/tls/mappings/${id}`, { method: 'DELETE' });

    // 8 мутаций (POST /validate — чтение, без writeGuard).
    expect(writeGuard).toHaveBeenCalledTimes(8);
  });
});
