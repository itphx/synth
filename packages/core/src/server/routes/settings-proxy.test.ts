import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// (vi используется в тесте proxied-MCP ниже)
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  proxyStatus,
  resolveProxyConfig,
  type EgressProxyStatus,
  type ResolvedProxyConfig,
} from '@itphx/synth-shared';
import { createSettingsRoutes } from './settings.js';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { AuthKit } from '../../auth/local.js';
import { startFakeProxy } from '../../test-helpers/fake-proxy.js';
import { resetEgressProxyState, setEgressProxyConfig } from '../../security/proxy-state.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function createApp(deps: {
  getProxyStatus?: () => EgressProxyStatus;
  resolveHost?: (host: string) => Promise<string[]>;
} = {}) {
  const app = new Hono();
  app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
    settingsStore: new RuntimeSettingsStore({ dataDir: '/tmp/unused-settings-proxy' }),
    fallbackWorkspace: '/ws',
    ...deps,
  }));
  return app;
}

describe('GET /api/v2/settings/proxy', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-proxy-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('read-only статус: поля и restartRequired', async () => {
    const app = new Hono();
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore: new RuntimeSettingsStore({ dataDir: tmpDir }),
      fallbackWorkspace: '/ws',
      getProxyStatus: () => ({
        enabled: true,
        source: 'config',
        url: 'http://proxy.corp:3128',
        noProxy: ['localhost'],
        fallbackDirect: true,
        connectTimeoutMs: 5000,
        restartRequired: true,
      }),
    }));

    const res = await app.request('/api/v2/settings/proxy');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: true,
      source: 'config',
      url: 'http://proxy.corp:3128',
      fallbackDirect: true,
      connectTimeoutMs: 5000,
      restartRequired: true,
    });
  });

  it('секреты/userinfo не утекают', async () => {
    // Конфиг теоретически может содержать userinfo (D2); статус обязан редактировать.
    const config: ResolvedProxyConfig = {
      enabled: true,
      source: 'config',
      url: 'http://user:super-secret@proxy.corp:3128',
      httpProxy: 'http://user:super-secret@http.corp:3128',
      noProxy: [],
      fromEnv: false,
      fallbackDirect: false,
      connectTimeoutMs: 1000,
    };
    const app = createApp({ getProxyStatus: () => proxyStatus(config) });
    const res = await app.request('/api/v2/settings/proxy');
    const body = await res.text();
    expect(body).not.toContain('super-secret');
    expect(body).not.toContain('user:');
    expect(body).not.toContain('@proxy');
    expect(JSON.parse(body).url).toBe('http://proxy.corp:3128');
  });
});

describe('POST /api/v2/settings/proxy/check — только коннект к прокси', () => {
  it('reachable + authChallenge (407 → Basic)', async () => {
    const proxy = await startFakeProxy({ mode: '407', authChallenge: 'Basic realm="corp"' });
    try {
      const app = createApp();
      const res = await app.request('/api/v2/settings/proxy/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: proxy.url }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.reachable).toBe(true);
      expect(body.authChallenge).toBe('Basic');
      expect(typeof body.latencyMs).toBe('number');
    } finally {
      await proxy.close();
    }
  });

  it('unreachable — reachable:false + error, без падения', async () => {
    const dead = await startFakeProxy({ mode: 'tunnel' });
    const url = dead.url;
    await dead.close();

    const app = createApp();
    const res = await app.request('/api/v2/settings/proxy/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reachable).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('scope=mcp + proxied: hostname-правила без DNS/CIDR (резолвер не вызван)', async () => {
    setEgressProxyConfig(
      resolveProxyConfig({ proxy: { url: 'http://proxy.corp:3128', fromEnv: false } }, {}),
    );
    const resolveHost = vi.fn(async () => ['127.0.0.1']);
    try {
      const app = createApp({ resolveHost });
      const res = await app.request('/api/v2/settings/egress/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'mcp', url: 'https://public.example/x' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.allowed).toBe(true);
      expect(body.proxied).toBe(true);
      expect(body.addressChecksActive).toBe(false);
      expect(resolveHost).not.toHaveBeenCalled();
    } finally {
      resetEgressProxyState();
    }
  });

  it('scope=mcp без прокси: прежнее поведение — DNS-резолв вызывается', async () => {
    const resolveHost = vi.fn(async () => ['93.184.216.34']);
    const app = createApp({ resolveHost });
    const res = await app.request('/api/v2/settings/egress/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'mcp', url: 'https://public.example/x' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.allowed).toBe(true);
    expect(body.addressChecksActive).toBe(true);
    expect(resolveHost).toHaveBeenCalledTimes(1);
  });

  it('невалидный url в теле → unreachable с ошибкой (не 500)', async () => {
    const app = createApp();
    const res = await app.request('/api/v2/settings/proxy/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'socks5://proxy:1080' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reachable).toBe(false);
    expect(String(body.error)).toMatch(/SOCKS5/i);
  });
});
