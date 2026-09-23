import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRoutes } from './providers.js';
import { JsonStore } from '../../storage/json-store.js';
import type { AuthKit } from '../../auth/local.js';
import type { ProviderConfig } from '@itphx/synth-shared';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

async function makeApp(tmpDir: string) {
  const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
  const providerCache = new Map<string, ProviderConfig>();
  const app = createProviderRoutes(createMockAuth(), providerStore, providerCache, { testEnabled: true });
  return { app, providerStore, providerCache };
}

function postJSON(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('routes/providers (core): синхронизация in-memory кеша', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-providers-test-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST /providers добавляет провайдера в кеш', async () => {
    const res = await stores.app.request('/', postJSON({
      name: 'new-provider',
      type: 'openai',
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-test',
    }));
    expect(res.status).toBe(201);

    expect(stores.providerCache.get('new-provider')?.baseUrl).toBe('https://api.example.com/v1');
  });

  it('DELETE /providers/:name удаляет провайдера из кеша', async () => {
    await stores.providerStore.save('p1', {
      name: 'p1', type: 'openai', baseUrl: 'http://p.local', enabled: true,
    });
    stores.providerCache.set('p1', {
      name: 'p1', type: 'openai', baseUrl: 'http://p.local', enabled: true,
    });

    const res = await stores.app.request('/p1', { method: 'DELETE' });
    expect(res.status).toBe(204);

    expect(stores.providerCache.has('p1')).toBe(false);
  });
});
