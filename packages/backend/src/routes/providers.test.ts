import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRoutes } from './providers.js';
import { JsonStore } from '@itphx/synth-core';
import type { ProviderConfig } from '@itphx/synth-shared';

const BASE = '/api/v2/providers';

function createKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    requireAdmin: async (_c: Context, next: Next) => { await next(); },
  };
}

async function makeApp(
  tmpDir: string,
  egress?: import('./providers.js').ProviderRoutesEgressOptions,
) {
  const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
  const providerCache = new Map<string, ProviderConfig>();
  const app = new Hono();
  app.route(BASE, createProviderRoutes(createKit() as never, providerStore, providerCache, egress));
  return { app, providerStore, providerCache };
}

/**
 * Mock-AuthKit для RBAC-тестов: `requireAuth` пропускает, `requireAdmin`
 * отклоняет 403. Фиксирует, что мутации, детали и тест подключения закрыты
 * admin-guard'ом (ТД-1, фаза A).
 */
function createRbacKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    requireAdmin: async (c: Context) =>
      c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403),
  };
}

async function makeRbacApp(tmpDir: string) {
  const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
  const providerCache = new Map<string, ProviderConfig>();
  const app = new Hono();
  app.route(BASE, createProviderRoutes(createRbacKit() as never, providerStore, providerCache));
  return { app, providerStore, providerCache };
}

function postJSON(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('routes/providers: синхронизация in-memory кеша (LLM Proxy)', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-providers-test-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST /providers добавляет провайдера в кеш — виден через providerCache', async () => {
    const res = await stores.app.request(BASE, postJSON({
      name: 'new-provider',
      type: 'openai',
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-test',
    }));
    expect(res.status).toBe(201);

    const cached = stores.providerCache.get('new-provider');
    expect(cached).toBeDefined();
    expect(cached?.baseUrl).toBe('https://api.example.com/v1');
  });

  it('POST /providers с существующим именем обновляет кеш', async () => {
    await stores.providerStore.save('p1', {
      name: 'p1', type: 'openai', baseUrl: 'http://old.local', enabled: true,
    });
    stores.providerCache.set('p1', {
      name: 'p1', type: 'openai', baseUrl: 'http://old.local', enabled: true,
    });

    const res = await stores.app.request(BASE, postJSON({
      name: 'p1',
      base_url: 'http://new.local',
    }));
    expect(res.status).toBe(200);

    const cached = stores.providerCache.get('p1');
    expect(cached?.baseUrl).toBe('http://new.local');
  });

  it('DELETE /providers/:name удаляет провайдера из кеша', async () => {
    await stores.providerStore.save('p1', {
      name: 'p1', type: 'openai', baseUrl: 'http://p.local', enabled: true,
    });
    stores.providerCache.set('p1', {
      name: 'p1', type: 'openai', baseUrl: 'http://p.local', enabled: true,
    });

    const res = await stores.app.request(`${BASE}/p1`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    expect(stores.providerCache.has('p1')).toBe(false);
  });

  it('DELETE /providers/:name для несуществующего — 404 и кеш не трогается', async () => {
    const res = await stores.app.request(`${BASE}/missing`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(stores.providerCache.has('missing')).toBe(false);
  });
});

describe('routes/providers: валюта по умолчанию', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-providers-currency-test-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function listProviders(): Promise<Record<string, unknown>[]> {
    const res = await stores.app.request(BASE);
    const body = await res.json() as { providers: Record<string, unknown>[] };
    return body.providers;
  }

  it('POST с currency=RUB сохраняет и GET возвращает RUB', async () => {
    const res = await stores.app.request(BASE, postJSON({
      name: 'p-rub',
      type: 'openai',
      base_url: 'https://api.example.com/v1',
      currency: 'RUB',
    }));
    expect(res.status).toBe(201);

    const saved = await stores.providerStore.load('p-rub');
    expect(saved?.currency).toBe('RUB');

    const provider = (await listProviders()).find((p) => p.name === 'p-rub')!;
    expect(provider.currency).toBe('RUB');
  });

  it('POST с невалидной currency (XXX) — 400 VALIDATION_ERROR', async () => {
    const res = await stores.app.request(BASE, postJSON({
      name: 'p-bad',
      type: 'openai',
      base_url: 'https://api.example.com/v1',
      currency: 'XXX',
    }));
    expect(res.status).toBe(400);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(await stores.providerStore.load('p-bad')).toBeNull();
  });

  it.each([null, ''])('POST с currency=%p очищает ранее сохранённую валюту', async (cleared) => {
    await stores.providerStore.save('p-clear', {
      name: 'p-clear', type: 'openai', baseUrl: 'http://p.local', enabled: true, currency: 'CNY',
    });

    const res = await stores.app.request(BASE, postJSON({ name: 'p-clear', currency: cleared }));
    expect(res.status).toBe(200);

    const saved = await stores.providerStore.load('p-clear');
    expect(saved?.currency).toBeUndefined();
    const provider = (await listProviders()).find((p) => p.name === 'p-clear')!;
    expect(provider.currency).toBeUndefined();
  });
});

describe('routes/providers: RBAC (мутации/детали/тест — только ADMIN)', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeRbacApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-providers-rbac-test-'));
    stores = await makeRbacApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET / — requireAuth пропускает, 200', async () => {
    const res = await stores.app.request(BASE);
    expect(res.status).toBe(200);
  });

  it('POST / — 403 (writeGuard = requireAdmin)', async () => {
    const res = await stores.app.request(BASE, postJSON({ name: 'p1', type: 'openai' }));
    expect(res.status).toBe(403);
  });

  it('DELETE /:name — 403 (writeGuard = requireAdmin)', async () => {
    const res = await stores.app.request(`${BASE}/p1`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('GET /:name — 403 (detailGuard = requireAdmin)', async () => {
    const res = await stores.app.request(`${BASE}/p1`);
    expect(res.status).toBe(403);
  });

  it('POST /:name/test — 403 (testGuard = requireAdmin)', async () => {
    const res = await stores.app.request(`${BASE}/p1/test`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('POST /fetch-icon — 403 (requireAdmin), guard раньше валидации тела', async () => {
    const res = await stores.app.request(`${BASE}/fetch-icon`, postJSON({}));
    expect(res.status).toBe(403);
  });
});

describe('routes/providers: rate limit на POST /:name/test (5/60с)', () => {  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-providers-ratelimit-test-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('6-й запрос → 429 RATE_LIMITED (guard и лимитер пропускают)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await stores.app.request(`${BASE}/p1/test`, { method: 'POST' });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);

    const body = await stores.app.request(`${BASE}/p1/test`, { method: 'POST' });
    expect(body.status).toBe(429);
    expect((await body.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });
});

describe('routes/providers: fetch-icon — SSRF-политика resolved-URL (PROP-100 дефект 3)', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-providers-fetchicon-test-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('origin с приватным/локальным адресом → 400, сеть не дёргается', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await stores.app.request(`${BASE}/fetch-icon`, postJSON({ url: 'http://127.0.0.1/' }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('отказ первичной проверки пишется в egress-журнал (scope providers, blocked)', async () => {
    const log = vi.fn();
    stores = await makeApp(tmpDir, { log });
    vi.stubGlobal('fetch', vi.fn());

    const res = await stores.app.request(`${BASE}/fetch-icon`, postJSON({ url: 'http://10.0.0.5/' }));

    expect(res.status).toBe(400);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'providers',
      status: 'blocked',
      host: '10.0.0.5',
      method: 'GET',
    }));
  });

  it('HTML указывает на приватный/локальный адрес → отказ, приватный URL не загружается', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (String(input).endsWith('/favicon.ico')) return new Response('nope', { status: 404 });
      return new Response(
        '<html><head><link rel="icon" href="http://127.0.0.1/secret.png"></head></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await stores.app.request(`${BASE}/fetch-icon`, postJSON({ url: 'https://93.184.216.34/' }));

    expect(res.status).toBe(200);
    const body = await res.json() as { icon: string | null };
    expect(body.icon).toBeNull();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain('http://127.0.0.1/secret.png');
    // Только favicon.ico + HTML origin; приватный resolved-URL не запрашивался.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('HTML указывает на публичный адрес → иконка загружается', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/favicon.ico')) return new Response('nope', { status: 404 });
      if (url === 'https://93.184.216.34') {
        return new Response(
          '<html><head><link rel="icon" href="https://93.184.216.34/icon.png"></head></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      if (url === 'https://93.184.216.34/icon.png') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await stores.app.request(`${BASE}/fetch-icon`, postJSON({ url: 'https://93.184.216.34/' }));

    expect(res.status).toBe(200);
    const body = await res.json() as { icon: string | null; source?: string };
    expect(body.icon).toMatch(/^data:image\/png;base64,/);
    expect(body.source).toBe('https://93.184.216.34/icon.png');
  });
});
