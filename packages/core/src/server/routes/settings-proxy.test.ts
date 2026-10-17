import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// (vi используется в тесте proxied-MCP ниже)
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../security/__fixtures__');
const PROXY_CERT = readFileSync(join(FIX_DIR, 'tls-test-proxy.pem'), 'utf-8');
const PROXY_KEY = readFileSync(join(FIX_DIR, 'tls-test-proxy.key'), 'utf-8');

describe('POST /api/v2/settings/proxy/check — только коннект к прокси', () => {
  it('Basic: валидные креды из активного конфига → reachable', async () => {
    const expected = `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`;
    const proxy = await startFakeProxy({ mode: 'tunnel', requireAuth: expected });
    try {
      setEgressProxyConfig(
        resolveProxyConfig(
          { proxy: { url: proxy.url, auth: { type: 'basic', username: 'user' }, fromEnv: false } },
          { SYNTH_PROXY_PASSWORD: 'pass' },
        ),
      );
      const app = createApp();
      const res = await app.request('/api/v2/settings/proxy/check', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.reachable).toBe(true);
      expect(proxy.connectAuthHeaders[0]).toBe(expected);
    } finally {
      resetEgressProxyState();
      await proxy.close();
    }
  });

  it('https-прокси: TLS-хендшейк с proxy.tls CA → reachable', async () => {
    const proxy = await startFakeProxy({
      mode: 'tunnel',
      tls: { key: PROXY_KEY, cert: PROXY_CERT },
    });
    try {
      setEgressProxyConfig(
        resolveProxyConfig(
          {
            proxy: {
              url: `https://localhost:${proxy.port}`,
              tls: { caPem: PROXY_CERT },
              fromEnv: false,
            },
          },
          {},
        ),
      );
      const app = createApp();
      const res = await app.request('/api/v2/settings/proxy/check', { method: 'POST' });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.reachable).toBe(true);
      expect(proxy.connects).toBe(1);
    } finally {
      resetEgressProxyState();
      await proxy.close();
    }
  });

  it('https-прокси без CA → reachable:false (self-signed)', async () => {
    const proxy = await startFakeProxy({
      mode: 'tunnel',
      tls: { key: PROXY_KEY, cert: PROXY_CERT },
    });
    try {
      setEgressProxyConfig(
        resolveProxyConfig(
          { proxy: { url: `https://localhost:${proxy.port}`, fromEnv: false } },
          {},
        ),
      );
      const app = createApp();
      const res = await app.request('/api/v2/settings/proxy/check', { method: 'POST' });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.reachable).toBe(false);
      expect(String(body.error)).toMatch(/self-signed|SELF_SIGNED|CERT/i);
    } finally {
      resetEgressProxyState();
      await proxy.close();
    }
  });
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

  it('SOCKS5 url в теле → reachable (greeting/CONNECT)', async () => {
    const { startFakeSocks5Proxy } = await import('../../test-helpers/fake-socks5-proxy.js');
    const socks = await startFakeSocks5Proxy();
    try {
      const app = createApp();
      const res = await app.request('/api/v2/settings/proxy/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: socks.url }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.reachable).toBe(true);
      expect(body.authChallenge).toBe('none');
      expect(socks.targets).toContain('probe.invalid:443');
    } finally {
      await socks.close();
    }
  });

  it('невалидный url в теле → unreachable с ошибкой (не 500)', async () => {
    const app = createApp();
    const res = await app.request('/api/v2/settings/proxy/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://proxy:21' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reachable).toBe(false);
    expect(String(body.error)).toMatch(/не поддерживается/i);
  });
});
