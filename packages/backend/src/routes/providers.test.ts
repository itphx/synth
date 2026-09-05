import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRoutes } from './providers.js';
import { JsonStore } from '../storage/json-store.js';
import type { ProviderConfig } from '@itphx/synth-shared';

const BASE = '/api/v2/providers';

function createKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    requireAdmin: async (_c: Context, next: Next) => { await next(); },
  };
}

async function makeApp(tmpDir: string) {
  const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
  const providerCache = new Map<string, ProviderConfig>();
  const app = new Hono();
  app.route(BASE, createProviderRoutes(createKit() as never, providerStore, providerCache));
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
