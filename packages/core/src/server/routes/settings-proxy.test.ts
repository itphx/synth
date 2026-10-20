import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveProxyConfig,
  type EgressProxyStatus,
  type ProxyConfig,
  type ResolvedProxyConfig,
} from '@itphx/synth-shared';
import { createSettingsRoutes } from './settings.js';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import { MemorySettingsRepository } from '../../storage/memory/settings.js';
import { MemorySecurityAuditRepository } from '../../storage/memory/security-audit.js';
import type { AuthKit } from '../../auth/local.js';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import { startFakeProxy } from '../../test-helpers/fake-proxy.js';
import {
  getEgressProxyConfig,
  resetEgressProxyState,
  setEgressProxyConfig,
} from '../../security/proxy-state.js';

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
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  getProxyStatus?: () => EgressProxyStatus;
  getProxyConfig?: () => ResolvedProxyConfig | null;
  checkProxy?: (request: { url?: string; config?: ResolvedProxyConfig | null }) => Promise<{
    reachable: boolean;
    latencyMs: number;
    authChallenge: 'Basic' | 'NTLM' | 'Negotiate' | 'none';
    error?: string;
  }>;
}

function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
    settingsStore: options.settingsStore ?? new RuntimeSettingsStore({ dataDir: '/tmp/unused-settings-proxy' }),
    fallbackWorkspace: '/ws',
    ...(options.audit ? { securityAudit: options.audit } : {}),
    ...(options.fallbackProxy ? { fallbackProxy: options.fallbackProxy } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    env: options.env ?? {},
    ...(options.getProxyStatus ? { getProxyStatus: options.getProxyStatus } : {}),
    ...(options.getProxyConfig ? { getProxyConfig: options.getProxyConfig } : {}),
    ...(options.checkProxy ? { checkProxy: options.checkProxy } : {}),
  }));
  return app;
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe('GET /api/v2/settings/proxy', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetEgressProxyState();
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-proxy-'));
  });

  afterEach(async () => {
    resetEgressProxyState();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('плоские поля = saved (config) + saved/running/defaults/password/restartRequired', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    const caPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const app = createApp({
      settingsStore: store,
      dataDir: tmpDir,
      env: { SYNTH_PROXY_PASSWORD: 'pass' },
      fallbackProxy: {
        url: 'http://proxy.corp:3128',
        noProxy: ['localhost'],
        fromEnv: false,
        auth: { type: 'basic', username: 'user' },
        tls: { caPem, rejectUnauthorized: false },
      },
    });

    const res = await app.request('/api/v2/settings/proxy');
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;
    // Обратная совместимость: плоские поля saved-формы.
    expect(body).toMatchObject({
      enabled: true,
      source: 'config',
      url: 'http://proxy.corp:3128',
      noProxy: ['localhost'],
      fromEnv: false,
      fallbackDirect: false,
      connectTimeoutMs: 10_000,
      auth: { type: 'basic', username: 'user' },
      tls: { hasCaPem: true, rejectUnauthorized: false },
    });
    expect(body.saved).toMatchObject({
      enabled: true,
      url: 'http://proxy.corp:3128',
      fromEnv: false,
      auth: { type: 'basic', username: 'user' },
      tls: { hasCaPem: true, rejectUnauthorized: false },
    });
    expect(body.running).toMatchObject({ enabled: false });
    expect(body.defaults).toMatchObject({
      enabled: true,
      url: 'http://proxy.corp:3128',
      fromEnv: false,
      auth: { type: 'basic', username: 'user' },
      tls: { hasCaPem: true, rejectUnauthorized: false },
    });
    expect(body.isOverridden).toBe(false);
    expect(body.password).toEqual({ source: 'env', set: true, removable: false });
    expect(body.restartRequired).toBe(true);
    expect(text).not.toContain('MIIB');
    expect(text).not.toContain('BEGIN CERTIFICATE');
    expect(text).not.toContain('"pass"');
    expect(JSON.stringify(body.auth)).not.toContain('password');
  });

  it('runtime-override: saved.source=runtime, defaults=config, isOverridden=true', async () => {
    const store = new MemorySettingsRepository();
    await store.setProxySettings({ url: 'http://ui-proxy:8080', noProxy: ['ui.local'], fromEnv: false });
    const app = createApp({
      settingsStore: store,
      fallbackProxy: { url: 'http://config-proxy:3128', fromEnv: false },
    });

    const body = await json(await app.request('/api/v2/settings/proxy'));
    expect(body.url).toBe('http://ui-proxy:8080');
    expect(body.saved).toMatchObject({ source: 'runtime', url: 'http://ui-proxy:8080' });
    expect(body.defaults).toMatchObject({ source: 'config', url: 'http://config-proxy:3128' });
    expect(body.isOverridden).toBe(true);
  });

  it('restartRequired=false, когда running совпадает с saved', async () => {
    const store = new MemorySettingsRepository();
    const runtime = { url: 'http://same:3128', noProxy: ['a'], fromEnv: false };
    await store.setProxySettings(runtime);
    setEgressProxyConfig(resolveProxyConfig({ proxy: runtime }, {}));
    const app = createApp({ settingsStore: store });
    const body = await json(await app.request('/api/v2/settings/proxy'));
    expect(body.restartRequired).toBe(false);
  });

  it('пароль из env: source=env, removable=false, значение не отдаётся', async () => {
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      env: { SYNTH_PROXY_PASSWORD: 'super-secret' },
      fallbackProxy: { url: 'http://proxy:3128', auth: { type: 'basic', username: 'user' }, fromEnv: false },
    });
    const res = await app.request('/api/v2/settings/proxy');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.password).toEqual({ source: 'env', set: true, removable: false });
    expect(JSON.stringify(body)).not.toContain('super-secret');
  });

  it('секреты/userinfo не утекают (flat + saved)', async () => {
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      fallbackProxy: {
        url: 'http://user:super-secret@proxy.corp:3128',
        httpProxy: 'http://user:super-secret@http.corp:3128',
        fromEnv: false,
      },
    });
    const res = await app.request('/api/v2/settings/proxy');
    const text = await res.text();
    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('user:');
    expect(text).not.toContain('@proxy');
    expect(JSON.parse(text).url).toBe('http://proxy.corp:3128');
  });
});

describe('PUT/DELETE /api/v2/settings/proxy', () => {
  let tmpDir: string;
  let store: RuntimeSettingsStore;
  let audit: MemorySecurityAuditRepository;

  beforeEach(async () => {
    resetEgressProxyState();
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-proxy-put-'));
    store = new RuntimeSettingsStore({ dataDir: tmpDir });
    audit = new MemorySecurityAuditRepository();
  });

  afterEach(async () => {
    resetEgressProxyState();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('PUT persists и не применяет live; аудит before/after без пароля; ответ redacted', async () => {
    const caPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const app = createApp({
      settingsStore: store,
      audit,
      dataDir: tmpDir,
      env: { SYNTH_PROXY_PASSWORD: 'pass' },
    });
    const res = await app.request('/api/v2/settings/proxy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy: {
          url: 'http://proxy:3128',
          noProxy: ['localhost'],
          fromEnv: false,
          auth: { type: 'basic', username: 'user' },
          tls: { caPem, rejectUnauthorized: false },
        },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;
    expect(body.restartRequired).toBe(true);
    expect(body.saved).toMatchObject({
      enabled: true,
      url: 'http://proxy:3128',
      fromEnv: false,
      auth: { type: 'basic', username: 'user' },
      tls: { hasCaPem: true, rejectUnauthorized: false },
    });
    expect(text).not.toContain('MIIB');
    expect(text).not.toContain('"pass"');
    expect(await store.getProxySettings()).toMatchObject({ url: 'http://proxy:3128' });
    // Live не применился: running остаётся выключенным до рестарта.
    expect(getEgressProxyConfig()).toBeNull();
    const afterGet = await json(await app.request('/api/v2/settings/proxy'));
    expect(afterGet.running).toMatchObject({ enabled: false });
    expect(afterGet.saved).toMatchObject({ enabled: true, url: 'http://proxy:3128' });

    const entries = await audit.list({ scope: 'proxy' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: 'proxy', action: 'update', source: 'runtime' });
    expect(JSON.stringify(entries)).not.toContain('"pass"');
    expect(JSON.stringify(entries)).not.toContain('MIIB');
  });

  it('DELETE сбрасывает runtime и пишет аудит reset; ответ redacted', async () => {
    const caPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    await store.setProxySettings({
      url: 'http://ui:3128',
      fromEnv: false,
      auth: { type: 'basic', username: 'user' },
      tls: { caPem, rejectUnauthorized: false },
    });
    const app = createApp({
      settingsStore: store,
      audit,
      dataDir: tmpDir,
      env: { SYNTH_PROXY_PASSWORD: 'pass' },
      fallbackProxy: { url: 'http://config:3128', fromEnv: false },
    });
    const res = await app.request('/api/v2/settings/proxy', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;
    expect(body.status).toBe('restored');
    expect(body.saved).toMatchObject({ url: 'http://config:3128' });
    expect(text).not.toContain('MIIB');
    expect(text).not.toContain('"pass"');
    expect(await store.getProxySettings()).toBeUndefined();
    const entries = await audit.list({ scope: 'proxy' });
    expect(entries[0]).toMatchObject({ action: 'reset', after: null });
    expect(entries[0]!.before).toMatchObject({ url: 'http://ui:3128' });
    expect(JSON.stringify(entries)).not.toContain('MIIB');
  });

  it('validation: bad URL / socks: / ntlm / пароль в userinfo → 400', async () => {
    const app = createApp({ settingsStore: store, dataDir: tmpDir });
    const cases: Array<{ proxy: unknown; message: RegExp }> = [
      { proxy: { url: 'not-a-url' }, message: /некорректный URL/i },
      { proxy: { url: 'socks://proxy:1080' }, message: /socks:/i },
      {
        proxy: { url: 'http://proxy:3128', auth: { type: 'ntlm', username: 'u' } },
        message: /не поддерживается/i,
      },
      { proxy: { url: 'http://user:secret@proxy:3128' }, message: /пароль в URL не хранится/i },
    ];
    for (const item of cases) {
      const res = await app.request('/api/v2/settings/proxy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxy: item.proxy }),
      });
      expect(res.status, JSON.stringify(item.proxy)).toBe(400);
      const body = await json(res);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(String(body.error.message)).toMatch(item.message);
      expect(JSON.stringify(body)).not.toContain('user:secret');
      expect(JSON.stringify(body)).not.toContain('@proxy');
    }
    expect(await store.getProxySettings()).toBeUndefined();
  });

  it('auth.username без пароля → 400; с паролем из env → сохраняется', async () => {
    const app = createApp({ settingsStore: store, dataDir: tmpDir, env: {} });
    const missing = await app.request('/api/v2/settings/proxy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy: { url: 'http://proxy:3128', auth: { type: 'basic', username: 'user' }, fromEnv: false },
      }),
    });
    expect(missing.status).toBe(400);
    expect((await json(missing)).error.message).toMatch(/не задан пароль/);

    const withPassword = createApp({
      settingsStore: store,
      dataDir: tmpDir,
      env: { SYNTH_PROXY_PASSWORD: 'pass' },
    });
    const ok = await withPassword.request('/api/v2/settings/proxy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy: { url: 'http://proxy:3128', auth: { type: 'basic', username: 'user' }, fromEnv: false },
      }),
    });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await store.getProxySettings())).not.toContain('"pass"');
  });

  it('auth.password в теле → 400; настройки не изменились (инвариант 13)', async () => {
    await store.setProxySettings({ url: 'http://saved:3128', fromEnv: false });
    const app = createApp({
      settingsStore: store,
      dataDir: tmpDir,
      env: { SYNTH_PROXY_PASSWORD: 'pass' },
    });

    const res = await app.request('/api/v2/settings/proxy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy: {
          url: 'http://proxy:3128',
          fromEnv: false,
          auth: { type: 'basic', username: 'user', password: 'top-secret' },
        },
      }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(String(body.error.message)).toMatch(/пароль не хранится в настройках/);
    // Значение пароля не echoed и не попало в settings.json.
    expect(text).not.toContain('top-secret');
    expect(await store.getProxySettings()).toMatchObject({ url: 'http://saved:3128' });
    const raw = await readFile(join(tmpDir, 'settings.json'), 'utf-8');
    expect(raw).not.toContain('top-secret');
  });
});

describe('PUT/DELETE /api/v2/settings/proxy/password', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetEgressProxyState();
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-proxy-pass-'));
  });

  afterEach(async () => {
    resetEgressProxyState();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('записывает файл 0600/каталог 0700, не отдаёт значение; DELETE удаляет', async () => {
    const audit = new MemorySecurityAuditRepository();
    const app = createApp({ settingsStore: new MemorySettingsRepository(), dataDir: tmpDir, audit });

    const res = await app.request('/api/v2/settings/proxy/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'top-secret' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.password).toEqual({ source: 'file', set: true, removable: true });
    const text = JSON.stringify(body);
    expect(text).not.toContain('top-secret');

    const file = join(tmpDir, 'secrets', 'proxy-password');
    expect(await readFile(file, 'utf-8')).toContain('top-secret');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(tmpDir, 'secrets'))).mode & 0o777).toBe(0o700);

    const entries = await audit.list({ scope: 'proxy' });
    expect(JSON.stringify(entries)).not.toContain('top-secret');
    expect(entries[0]!.after).toMatchObject({ password: { source: 'file', set: true } });

    const del = await app.request('/api/v2/settings/proxy/password', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await json(del)).password).toEqual({ source: 'none', set: false, removable: false });
    await expect(readFile(file, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('env SYNTH_PROXY_PASSWORD приоритетнее: PUT/DELETE → 409', async () => {
    const app = createApp({
      settingsStore: new MemorySettingsRepository(),
      dataDir: tmpDir,
      env: { SYNTH_PROXY_PASSWORD: 'env-pass' },
    });
    for (const method of ['PUT', 'DELETE'] as const) {
      const res = await app.request('/api/v2/settings/proxy/password', {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify({ password: 'new' }) } : {}),
      });
      expect(res.status, method).toBe(409);
      expect((await json(res)).error.code).toBe('CONFLICT');
    }
    const get = await json(await app.request('/api/v2/settings/proxy'));
    expect(get.password).toEqual({ source: 'env', set: true, removable: false });
  });

  it('пустой пароль → 400, значение не пишется', async () => {
    const app = createApp({ settingsStore: new MemorySettingsRepository(), dataDir: tmpDir });
    const res = await app.request('/api/v2/settings/proxy/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '   ' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v2/settings/proxy/check — saved, а не running', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetEgressProxyState();
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-proxy-check-'));
  });

  afterEach(async () => {
    resetEgressProxyState();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('без url проверяет saved-конфигурацию (runtime) и ставит usingSaved=true', async () => {
    const store = new MemorySettingsRepository();
    await store.setProxySettings({ url: 'http://saved:3128', fromEnv: false });
    setEgressProxyConfig(resolveProxyConfig({ proxy: { url: 'http://running:3128', fromEnv: false } }, {}));

    const checkProxy = vi.fn(async (_request: { url?: string; config?: ResolvedProxyConfig | null }) => ({
      reachable: true,
      latencyMs: 1,
      authChallenge: 'none' as const,
    }));
    const app = createApp({ settingsStore: store, dataDir: tmpDir, checkProxy });

    const res = await app.request('/api/v2/settings/proxy/check', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.usingSaved).toBe(true);
    expect(checkProxy).toHaveBeenCalledTimes(1);
    const arg = checkProxy.mock.calls[0]![0];
    expect(arg.config?.url).toBe('http://saved:3128');
  });

  it('явный url → usingSaved=false, проверяется он', async () => {
    const checkProxy = vi.fn(async (_request: { url?: string; config?: ResolvedProxyConfig | null }) => ({
      reachable: true,
      latencyMs: 1,
      authChallenge: 'none' as const,
    }));
    const app = createApp({ settingsStore: new MemorySettingsRepository(), checkProxy });
    const res = await app.request('/api/v2/settings/proxy/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://explicit:3128' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).usingSaved).toBe(false);
    expect(checkProxy.mock.calls[0]![0]).toEqual({ url: 'http://explicit:3128' });
  });

  it('сохранена невалидная конфигурация (битый URL) → 400 без падения', async () => {
    const store = new MemorySettingsRepository();
    await store.setProxySettings({ url: 'http://proxy:3128', auth: { type: 'basic', username: 'u' }, fromEnv: false });
    const app = createApp({ settingsStore: store, dataDir: tmpDir, env: {} });
    const res = await app.request('/api/v2/settings/proxy/check', { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v2/settings/proxy/check — реальный коннект (без инъекции)', () => {
  it('Basic: креды из saved (env-пароль) → reachable', async () => {
    const expected = `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`;
    const proxy = await startFakeProxy({ mode: 'tunnel', requireAuth: expected });
    try {
      const store = new MemorySettingsRepository();
      await store.setProxySettings({
        url: proxy.url,
        auth: { type: 'basic', username: 'user' },
        fromEnv: false,
      });
      const app = createApp({
        settingsStore: store,
        env: { SYNTH_PROXY_PASSWORD: 'pass' },
      });
      const res = await app.request('/api/v2/settings/proxy/check', { method: 'POST' });
      const body = await json(res);
      expect(body.reachable).toBe(true);
      expect(body.usingSaved).toBe(true);
      expect(proxy.connectAuthHeaders[0]).toBe(expected);
    } finally {
      await proxy.close();
    }
  });

  it('unreachable saved → reachable:false + error', async () => {
    const dead = await startFakeProxy({ mode: 'tunnel' });
    const url = dead.url;
    await dead.close();
    const store = new MemorySettingsRepository();
    await store.setProxySettings({ url, fromEnv: false });
    const app = createApp({ settingsStore: store });
    const body = await json(await app.request('/api/v2/settings/proxy/check', { method: 'POST' }));
    expect(body.reachable).toBe(false);
    expect(typeof body.error).toBe('string');
  });
});
