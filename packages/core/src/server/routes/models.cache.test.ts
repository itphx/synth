import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelRoutes } from './models.js';
import { JsonStore } from '../../storage/json-store.js';
import type { AuthKit } from '../../auth/local.js';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

async function makeApp(tmpDir: string) {
  const modelStore = new JsonStore<ModelConfig>({ dataDir: tmpDir, subdir: 'models' });
  const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
  const modelCache = new Map<string, ModelConfig>();
  await providerStore.save('p1', {
    name: 'p1', type: 'openai', baseUrl: 'http://provider.local', enabled: true,
  });
  const app = createModelRoutes(createMockAuth(), modelStore, providerStore, modelCache);
  return { app, modelStore, modelCache };
}

function postJSON(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('routes/models (core): синхронизация in-memory кеша', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-models-test-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST /models добавляет модель в кеш', async () => {
    const res = await stores.app.request('/', postJSON({
      id: 'p1/m1',
      name: 'm1',
      provider: 'p1',
    }));
    expect(res.status).toBe(201);

    expect(stores.modelCache.get('p1/m1')).toMatchObject({ id: 'p1/m1', name: 'm1', provider: 'p1' });
  });

  it('DELETE /models/:id удаляет модель из кеша', async () => {
    await stores.modelStore.save('p1/m1', {
      id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true,
    });
    stores.modelCache.set('p1/m1', { id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true });

    const res = await stores.app.request('/p1%2Fm1', { method: 'DELETE' });
    expect(res.status).toBe(204);

    expect(stores.modelCache.has('p1/m1')).toBe(false);
  });
});
