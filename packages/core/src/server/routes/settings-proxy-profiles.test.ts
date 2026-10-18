/**
 * ADR-099: профили прокси — GET/PUT (profiles/rules), пароли профилей,
 * загрузка TLS/mTLS-материалов и target-check (`/settings/proxy/test`).
 * Секреты/PEM наружу не отдаются; файлы — 0600/0700.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type EgressPolicy,
  type ProxyConfig,
  type ResolvedProxyConfig,
  type SecurityTlsConfig,
} from '@itphx/synth-shared';
import { createSettingsRoutes } from './settings.js';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import { MemorySettingsRepository } from '../../storage/memory/settings.js';
import { MemorySecurityAuditRepository } from '../../storage/memory/security-audit.js';
import type { AuthKit } from '../../auth/local.js';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import { resetEgressProxyState } from '../../security/proxy-state.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../security/__fixtures__');
const CA_PEM = await readFile(join(FIX_DIR, 'tls-test-selfsigned.pem'), 'utf-8');
const CLIENT_CERT = await readFile(join(FIX_DIR, 'tls-test-proxy-client.pem'), 'utf-8');
const CLIENT_KEY = await readFile(join(FIX_DIR, 'tls-test-proxy-client.key'), 'utf-8');
const OTHER_KEY = await readFile(join(FIX_DIR, 'tls-test-selfsigned.key'), 'utf-8');

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

interface AppOptions {
  settingsStore?: SettingsRepository;
  audit?: MemorySecurityAuditRepository;
  fallbackProxy?: Partial<ProxyConfig>;
  fallbackEgressTools?: EgressPolicy;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  getProxyConfig?: () => ResolvedProxyConfig | null;
  fallbackTls?: SecurityTlsConfig;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
    settingsStore: options.settingsStore ?? new RuntimeSettingsStore({ dataDir: '/tmp/unused-settings-proxy-profiles' }),
    fallbackWorkspace: '/ws',
    ...(options.audit ? { securityAudit: options.audit } : {}),
    ...(options.fallbackProxy ? { fallbackProxy: options.fallbackProxy } : {}),
    ...(options.fallbackEgressTools ? { fallbackEgressTools: options.fallbackEgressTools } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.getProxyConfig ? { getProxyConfig: options.getProxyConfig } : {}),
    ...(options.fallbackTls ? { fallbackTls: options.fallbackTls } : {}),
    ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
    env: options.env ?? {},
  }));
  return app;
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

function putJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const PROFILES_CONFIG: Partial<ProxyConfig> = {
  enabled: true,
  mode: 'selected',
  defaultProfile: 'corp',
  fromEnv: false,
  profiles: {
    corp: { label: 'Corp', url: 'http://proxy.corp:3128' },
    other: { url: 'http://proxy.other:3128' },
  },
  rules: [
    { id: 'r1', label: 'Example', hosts: ['*.example.com'], action: 'proxy', profile: 'corp' },
    { id: 'r2', hosts: ['direct.local'], action: 'direct' },
  ],
};

describe('GET /api/v2/settings/proxy — профили и правила', () => {
  let dir: string;

  beforeEach(async () => {
    resetEgressProxyState();
    dir = await mkdtemp(join(tmpdir(), 'synth-proxy-profiles-get-'));
  });

  afterEach(async () => {
    resetEgressProxyState();
    await rm(dir, { recursive: true, force: true });
  });

  it('отдаёт mode/defaultProfile/profiles/rules и пароль каждого профиля без значения', async () => {
    const store = new RuntimeSettingsStore({ dataDir: dir });
    await store.setProxySettings(PROFILES_CONFIG);
    const app = createApp({ settingsStore: store, dataDir: dir });

    const res = await app.request('/api/v2/settings/proxy');
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;

    expect(body).toMatchObject({ mode: 'selected', defaultProfile: 'corp', isOverridden: true });
    expect(body.saved).toMatchObject({ mode: 'selected', defaultProfile: 'corp' });
    expect(Object.keys(body.saved.profiles).sort()).toEqual(['corp', 'other']);
    expect(body.saved.profiles.corp).toMatchObject({
      name: 'corp',
      label: 'Corp',
      url: 'http://proxy.corp:3128',
      legacy: false,
      password: { source: 'none', set: false, removable: false },
    });
    expect(body.saved.rules).toEqual([
      { id: 'r1', label: 'Example', hosts: ['*.example.com'], action: 'proxy', profile: 'corp' },
      { id: 'r2', hosts: ['direct.local'], action: 'direct' },
    ]);
    // Обратная совместимость: top-level password остаётся.
    expect(body.password).toEqual({ source: 'none', set: false, removable: false });
    expect(text).not.toMatch(/password"\s*:\s*"[^"]+"/);
  });

  it('password профиля из env (SYNTH_PROXY_<NAME>_PASSWORD) — source=env, значение не отдаётся', async () => {
    const store = new RuntimeSettingsStore({ dataDir: dir });
    await store.setProxySettings(PROFILES_CONFIG);
    const app = createApp({
      settingsStore: store,
      dataDir: dir,
      env: { SYNTH_PROXY_CORP_PASSWORD: 'corp-secret' },
    });

    const res = await app.request('/api/v2/settings/proxy');
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;
    expect(body.saved.profiles.corp.password).toEqual({ source: 'env', set: true, removable: false });
    expect(body.saved.profiles.other.password).toEqual({ source: 'none', set: false, removable: false });
    expect(text).not.toContain('corp-secret');
  });

  it('legacy-default (без profiles) — synthetic профиль default и legacy-пароль', async () => {
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      dataDir: dir,
      env: { SYNTH_PROXY_PASSWORD: 'legacy-secret' },
      fallbackProxy: { url: 'http://legacy:3128', fromEnv: false },
    });
    const res = await app.request('/api/v2/settings/proxy');
    const body = await json(res);
    expect(body.saved.profiles.default).toMatchObject({
      name: 'default',
      legacy: true,
      url: 'http://legacy:3128',
      password: { source: 'env', set: true, removable: false },
    });
    expect(body.defaultProfile).toBe('default');
  });
});

describe('PUT /api/v2/settings/proxy — профили и правила', () => {
  let dir: string;
  let store: RuntimeSettingsStore;
  let audit: MemorySecurityAuditRepository;

  beforeEach(async () => {
    resetEgressProxyState();
    dir = await mkdtemp(join(tmpdir(), 'synth-proxy-profiles-put-'));
    store = new RuntimeSettingsStore({ dataDir: dir });
    audit = new MemorySecurityAuditRepository();
  });

  afterEach(async () => {
    resetEgressProxyState();
    await rm(dir, { recursive: true, force: true });
  });

  it('сохраняет profiles/rules целиком; аудит без секретов; restartRequired', async () => {
    const app = createApp({ settingsStore: store, audit, dataDir: dir });
    const res = await putJson(app, '/api/v2/settings/proxy', { proxy: PROFILES_CONFIG });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.restartRequired).toBe(true);
    expect(body.saved).toMatchObject({ mode: 'selected', defaultProfile: 'corp' });
    expect(Object.keys(body.saved.profiles).sort()).toEqual(['corp', 'other']);

    expect(await store.getProxySettings()).toMatchObject(PROFILES_CONFIG as unknown as Record<string, unknown>);
    const entries = await audit.list({ scope: 'proxy' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: 'proxy', action: 'update' });
    expect(entries[0]!.after).toMatchObject({ mode: 'selected', defaultProfile: 'corp' });
    expect(JSON.stringify(entries)).not.toContain('BEGIN CERTIFICATE');
  });

  it('удаление профиля, на который ссылается правило/defaultProfile → 400, стор не меняется', async () => {
    const app = createApp({ settingsStore: store, dataDir: dir });
    expect((await putJson(app, '/api/v2/settings/proxy', { proxy: PROFILES_CONFIG })).status).toBe(200);

    const withoutCorp: unknown = {
      ...PROFILES_CONFIG,
      profiles: { other: PROFILES_CONFIG.profiles!.other! },
    };
    const res = await putJson(app, '/api/v2/settings/proxy', { proxy: withoutCorp });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(String(body.error.message)).toMatch(/профиль "corp" не найден/);

    const saved = await store.getProxySettings();
    expect(saved?.profiles?.corp).toBeDefined();
  });
});

describe('PUT/DELETE /api/v2/settings/proxy/profiles/:name/password', () => {
  let dir: string;

  beforeEach(async () => {
    resetEgressProxyState();
    dir = await mkdtemp(join(tmpdir(), 'synth-proxy-profile-pass-'));
  });

  afterEach(async () => {
    resetEgressProxyState();
    await rm(dir, { recursive: true, force: true });
  });

  async function appWithProfiles(env: NodeJS.ProcessEnv = {}, audit?: MemorySecurityAuditRepository): Promise<Hono> {
    const store = new RuntimeSettingsStore({ dataDir: dir });
    await store.setProxySettings(PROFILES_CONFIG);
    return createApp({ settingsStore: store, dataDir: dir, env, ...(audit ? { audit } : {}) });
  }

  it('пишет {dataDir}/secrets/proxy/<name>.password 0600/0700, не отдаёт значение; DELETE удаляет', async () => {
    const audit = new MemorySecurityAuditRepository();
    const app = await appWithProfiles({}, audit);

    const res = await putJson(app, '/api/v2/settings/proxy/profiles/corp/password', { password: 'corp-secret' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.password).toEqual({ source: 'file', set: true, removable: true });
    expect(JSON.stringify(body)).not.toContain('corp-secret');

    const file = join(dir, 'secrets', 'proxy', 'corp.password');
    expect(await readFile(file, 'utf-8')).toContain('corp-secret');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'secrets', 'proxy'))).mode & 0o777).toBe(0o700);

    const entries = await audit.list({ scope: 'proxy' });
    expect(JSON.stringify(entries)).not.toContain('corp-secret');
    expect(entries[0]!.after).toMatchObject({ profile: 'corp', password: { source: 'file', set: true } });

    const get = await json(await app.request('/api/v2/settings/proxy'));
    expect(get.saved.profiles.corp.password).toEqual({ source: 'file', set: true, removable: true });

    const del = await app.request('/api/v2/settings/proxy/profiles/corp/password', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await json(del)).password).toEqual({ source: 'none', set: false, removable: false });
    await expect(readFile(file, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('default (legacy) — файл {dataDir}/secrets/proxy-password', async () => {
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      dataDir: dir,
      fallbackProxy: { url: 'http://legacy:3128', fromEnv: false },
    });
    const res = await putJson(app, '/api/v2/settings/proxy/profiles/default/password', { password: 'legacy' });
    expect(res.status).toBe(200);
    expect(await readFile(join(dir, 'secrets', 'proxy-password'), 'utf-8')).toContain('legacy');
  });

  it('env-пароль профиля приоритетнее: PUT/DELETE → 409', async () => {
    const app = await appWithProfiles({ SYNTH_PROXY_CORP_PASSWORD: 'env-pass' });
    for (const method of ['PUT', 'DELETE'] as const) {
      const res = await app.request('/api/v2/settings/proxy/profiles/corp/password', {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify({ password: 'new' }) } : {}),
      });
      expect(res.status, method).toBe(409);
      expect((await json(res)).error.code).toBe('CONFLICT');
    }
  });

  it('env SYNTH_PROXY_PASSWORD для legacy-default → 409', async () => {
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      dataDir: dir,
      env: { SYNTH_PROXY_PASSWORD: 'env-pass' },
      fallbackProxy: { url: 'http://legacy:3128', fromEnv: false },
    });
    const res = await putJson(app, '/api/v2/settings/proxy/profiles/default/password', { password: 'x' });
    expect(res.status).toBe(409);
  });

  it('неизвестный профиль → 404 (PUT/DELETE)', async () => {
    const app = await appWithProfiles();
    const put = await putJson(app, '/api/v2/settings/proxy/profiles/nope/password', { password: 'x' });
    expect(put.status).toBe(404);
    expect((await json(put)).error.code).toBe('NOT_FOUND');
    const del = await app.request('/api/v2/settings/proxy/profiles/nope/password', { method: 'DELETE' });
    expect(del.status).toBe(404);
  });

  it('профиль с auth без пароля: пароль задаётся (bootstrap), затем GET резолвится', async () => {
    const store = new RuntimeSettingsStore({ dataDir: dir });
    await store.setProxySettings({
      enabled: true,
      mode: 'all',
      defaultProfile: 'corp',
      fromEnv: false,
      profiles: {
        corp: { url: 'http://proxy:3128', auth: { type: 'basic', username: 'user' } },
      },
    });
    const app = createApp({ settingsStore: store, dataDir: dir });

    // До пароля saved-резолв падает (fail-closed), но профиль существует.
    expect((await app.request('/api/v2/settings/proxy')).status).toBe(400);

    const res = await putJson(app, '/api/v2/settings/proxy/profiles/corp/password', { password: 'pass' });
    expect(res.status).toBe(200);
    const get = await json(await app.request('/api/v2/settings/proxy'));
    expect(get.saved.profiles.corp).toMatchObject({
      auth: { type: 'basic', username: 'user' },
      password: { source: 'file', set: true, removable: true },
    });
  });

  it('пустой пароль → 400', async () => {
    const app = await appWithProfiles();
    const res = await putJson(app, '/api/v2/settings/proxy/profiles/corp/password', { password: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('PUT/DELETE /api/v2/settings/proxy/profiles/:name/tls/*', () => {
  let dir: string;

  beforeEach(async () => {
    resetEgressProxyState();
    dir = await mkdtemp(join(tmpdir(), 'synth-proxy-profile-tls-'));
  });

  afterEach(async () => {
    resetEgressProxyState();
    await rm(dir, { recursive: true, force: true });
  });

  async function appWithProfiles(audit?: MemorySecurityAuditRepository): Promise<{ app: Hono; store: RuntimeSettingsStore }> {
    const store = new RuntimeSettingsStore({ dataDir: dir });
    await store.setProxySettings(PROFILES_CONFIG);
    const app = createApp({ settingsStore: store, dataDir: dir, ...(audit ? { audit } : {}) });
    return { app, store };
  }

  it('CA: валидирует, пишет ca.pem 0600, путь в конфиге, ответ без PEM; DELETE удаляет', async () => {
    const audit = new MemorySecurityAuditRepository();
    const { app, store } = await appWithProfiles(audit);
    const res = await putJson(app, '/api/v2/settings/proxy/profiles/corp/tls/ca', { pem: CA_PEM });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;
    expect(body.restartRequired).toBe(true);
    const file = join(dir, 'secrets', 'proxy', 'corp', 'ca.pem');
    expect(body.status.profiles.corp.tls).toMatchObject({ caFile: file, hasCaPem: false });
    expect(text).not.toContain('BEGIN CERTIFICATE');

    expect(await readFile(file, 'utf-8')).toContain('BEGIN CERTIFICATE');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'secrets', 'proxy', 'corp'))).mode & 0o777).toBe(0o700);
    expect((await store.getProxySettings())?.profiles?.corp?.tls?.caFile).toBe(file);

    const entries = await audit.list({ scope: 'proxy' });
    expect(JSON.stringify(entries)).not.toContain('BEGIN CERTIFICATE');

    const del = await app.request('/api/v2/settings/proxy/profiles/corp/tls/ca', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await json(del)).status.profiles.corp.tls?.caFile).toBeUndefined();
    await expect(readFile(file, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('client: cert↔key, файлы 0600, DELETE удаляет; несовпадение ключа → 400', async () => {
    const { app, store } = await appWithProfiles();
    const bad = await putJson(app, '/api/v2/settings/proxy/profiles/corp/tls/client', {
      certPem: CLIENT_CERT,
      keyPem: OTHER_KEY,
    });
    expect(bad.status).toBe(400);
    expect(String((await json(bad)).error.message)).toMatch(/ключ|key/i);

    const res = await putJson(app, '/api/v2/settings/proxy/profiles/corp/tls/client', {
      certPem: CLIENT_CERT,
      keyPem: CLIENT_KEY,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const certFile = join(dir, 'secrets', 'proxy', 'corp', 'client.crt');
    const keyFile = join(dir, 'secrets', 'proxy', 'corp', 'client.key');
    expect(body.status.profiles.corp.tls).toMatchObject({ certFile, keyFile });
    expect(JSON.stringify(body)).not.toContain('BEGIN PRIVATE KEY');
    expect((await stat(certFile)).mode & 0o777).toBe(0o600);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect((await store.getProxySettings())?.profiles?.corp?.tls?.keyFile).toBe(keyFile);

    const del = await app.request('/api/v2/settings/proxy/profiles/corp/tls/client', { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = await json(del);
    expect(after.status.profiles.corp.tls?.certFile).toBeUndefined();
    expect(after.status.profiles.corp.tls?.keyFile).toBeUndefined();
    await expect(readFile(certFile, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(keyFile, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('legacy-default: CA обновляет top-level proxy.tls', async () => {
    const store = new RuntimeSettingsStore({ dataDir: dir });
    await store.setProxySettings({ url: 'http://legacy:3128', fromEnv: false });
    const app = createApp({ settingsStore: store, dataDir: dir });
    const res = await putJson(app, '/api/v2/settings/proxy/profiles/default/tls/ca', { pem: CA_PEM });
    expect(res.status).toBe(200);
    const body = await json(res);
    const file = join(dir, 'secrets', 'proxy', 'default', 'ca.pem');
    expect(body.status.tls).toMatchObject({ caFile: file });
    const saved = await store.getProxySettings();
    expect(saved?.tls?.caFile).toBe(file);
    expect(saved?.profiles).toBeUndefined();
  });

  it('неизвестный профиль → 404', async () => {
    const { app } = await appWithProfiles();
    for (const path of ['/tls/ca', '/tls/client']) {
      const res = await putJson(app, `/api/v2/settings/proxy/profiles/nope${path}`, {
        pem: CA_PEM,
        certPem: CLIENT_CERT,
        keyPem: CLIENT_KEY,
      });
      expect(res.status, path).toBe(404);
    }
  });

  it('невалидный CA → 400, файл не создаётся', async () => {
    const { app } = await appWithProfiles();
    const res = await putJson(app, '/api/v2/settings/proxy/profiles/corp/tls/ca', { pem: 'not-a-pem' });
    expect(res.status).toBe(400);
    await expect(readFile(join(dir, 'secrets', 'proxy', 'corp', 'ca.pem'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('POST /api/v2/settings/proxy/test — target-check', () => {
  let dir: string;

  beforeEach(async () => {
    resetEgressProxyState();
    dir = await mkdtemp(join(tmpdir(), 'synth-proxy-target-'));
  });

  afterEach(async () => {
    resetEgressProxyState();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubHead(status = 204, headers: Record<string, string> = {}): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response(null, { status, headers }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('прямой маршрут (noProxy): HEAD без редиректов, usingSaved/restartRequired', async () => {
    const fetchMock = stubHead();
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      dataDir: dir,
      resolveHost: async () => ['93.184.216.34'],
      fallbackProxy: { url: 'http://proxy:3128', noProxy: ['skip.example.com'], fromEnv: false },
    });
    const res = await postJson(app, '/api/v2/settings/proxy/test', { url: 'http://skip.example.com/x' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      ok: true,
      httpStatus: 204,
      usingSaved: true,
      restartRequired: true,
      route: { action: 'direct', via: 'direct', reason: 'no-proxy' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('HEAD');
    expect(init.redirect).toBe('manual');
  });

  it('профиль/правило: route.proxyUrl redacted (без пароля), target не содержит кред', async () => {
    const fetchMock = stubHead(200);
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      dataDir: dir,
      fallbackProxy: {
        enabled: true,
        mode: 'selected',
        defaultProfile: 'corp',
        fromEnv: false,
        profiles: {
          corp: { label: 'Corp', url: 'http://user:secret@proxy.corp:3128' },
        },
        rules: [{ id: 'r1', label: 'Rule', hosts: ['*.example.com'], action: 'proxy', profile: 'corp' }],
      },
    });
    const res = await postJson(app, '/api/v2/settings/proxy/test', { url: 'https://api.example.com/x' });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;
    expect(body).toMatchObject({
      ok: true,
      usingSaved: true,
      route: {
        action: 'proxy',
        via: 'proxy',
        reason: 'rule',
        ruleId: 'r1',
        ruleLabel: 'Rule',
        profile: 'corp',
        profileLabel: 'Corp',
        proxyUrl: 'http://proxy.corp:3128',
      },
    });
    expect(text).not.toContain('secret');
    expect(text).not.toContain('user:');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('407 от прокси → ok:false, httpStatus/authChallenge', async () => {
    stubHead(407, { 'proxy-authenticate': 'NTLM' });
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      dataDir: dir,
      fallbackProxy: { url: 'http://proxy:3128', fromEnv: false },
    });
    const body = await json(await postJson(app, '/api/v2/settings/proxy/test', { url: 'http://target.example/x' }));
    expect(body.ok).toBe(false);
    expect(body.httpStatus).toBe(407);
    expect(body.authChallenge).toBe('NTLM');
    expect(body.route.action).toBe('proxy');
  });

  it('egress-политика запрещает → ok:false, route возвращается, запрос не выполняется', async () => {
    const fetchMock = stubHead();
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      dataDir: dir,
      fallbackProxy: { url: 'http://proxy:3128', fromEnv: false },
      fallbackEgressTools: { mode: 'deny', list: ['blocked.example'], exceptions: [] },
    });
    const body = await json(await postJson(app, '/api/v2/settings/proxy/test', { url: 'http://blocked.example/x' }));
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.route.action).toBe('proxy');
    expect(body.usingSaved).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL: ftp/userinfo/пустой → 400 без запроса', async () => {
    const fetchMock = stubHead();
    const app = createApp({ settingsStore: new MemorySettingsRepository(), dataDir: dir });
    for (const url of ['ftp://example.com/x', 'http://u:p@example.com/x', '']) {
      const res = await postJson(app, '/api/v2/settings/proxy/test', { url });
      expect(res.status, url).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
