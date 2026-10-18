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

interface GroupModel {
  id: string;
  name: string;
  isDefault: boolean;
}

async function makeApp(
  tmpDir: string,
  opts: Parameters<typeof createModelRoutes>[4] = {},
) {
  const modelStore = new JsonStore<ModelConfig>({ dataDir: tmpDir, subdir: 'models' });
  const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
  const modelCache = new Map<string, ModelConfig>();
  const providerCache = new Map<string, ProviderConfig>();
  await providerStore.save('p1', {
    name: 'p1', type: 'openai', baseUrl: 'http://p1.local', enabled: true, defaultModel: 'm1',
  });
  await providerStore.save('p2', {
    name: 'p2', type: 'openai', baseUrl: 'http://p2.local', enabled: true,
  });
  const app = createModelRoutes(createMockAuth(), modelStore, providerStore, modelCache, opts);
  return { app, modelStore, providerStore, modelCache, providerCache };
}

async function listModels(app: ReturnType<typeof createModelRoutes>): Promise<GroupModel[]> {
  const res = await app.request('/');
  expect(res.status).toBe(200);
  const body = await res.json() as { groups: Array<{ models: GroupModel[] }> };
  return body.groups.flatMap((group) => group.models);
}

function postJSON(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('routes/models: модель по умолчанию (явная пара provider+model)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-models-default-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('пара задана — isDefault только у неё, legacy isDefault/provider.defaultModel игнорируются', async () => {
    const { app, modelStore } = await makeApp(tmpDir, {
      getDefaultModel: () => ({ provider: 'p2', model: 'm2' }),
    });
    await modelStore.save('p1/m1', {
      id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true, isDefault: true,
    });
    await modelStore.save('p2/m2', {
      id: 'p2/m2', name: 'm2', provider: 'p2', enabled: true, isDefault: false,
    });

    const models = await listModels(app);
    expect(models.find((m) => m.id === 'p1/m1')?.isDefault).toBe(false);
    expect(models.find((m) => m.id === 'p2/m2')?.isDefault).toBe(true);
  });

  it('пара не задана — legacy-поведение (isDefault модели и provider.defaultModel)', async () => {
    const { app, modelStore } = await makeApp(tmpDir, {
      getDefaultModel: () => null,
    });
    await modelStore.save('p1/m1', {
      id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true,
    });
    await modelStore.save('p2/m2', {
      id: 'p2/m2', name: 'm2', provider: 'p2', enabled: true, isDefault: true,
    });
    await modelStore.save('p2/m3', {
      id: 'p2/m3', name: 'm3', provider: 'p2', enabled: true,
    });

    const models = await listModels(app);
    // provider.defaultModel = m1 у p1.
    expect(models.find((m) => m.id === 'p1/m1')?.isDefault).toBe(true);
    // legacy isDefault модели.
    expect(models.find((m) => m.id === 'p2/m2')?.isDefault).toBe(true);
    expect(models.find((m) => m.id === 'p2/m3')?.isDefault).toBe(false);
  });

  it('set_as_default записывает пару provider+model и обновляет legacy provider.defaultModel', async () => {
    const pairs: unknown[] = [];
    const { app, providerStore, modelCache } = await makeApp(tmpDir, {
      supportSetAsDefault: true,
      providerCache: new Map<string, ProviderConfig>(),
      setDefaultModel: (pair) => { pairs.push(pair); },
    });
    await providerStore.save('p1', {
      name: 'p1', type: 'openai', baseUrl: 'http://p1.local', enabled: true, defaultModel: 'm1',
    });

    const res = await app.request('/', postJSON({
      id: 'p1/m2',
      name: 'm2',
      provider: 'p1',
      set_as_default: true,
    }));
    expect(res.status).toBe(201);
    expect(pairs).toEqual([{ provider: 'p1', model: 'm2' }]);
    expect((await providerStore.load('p1'))?.defaultModel).toBe('m2');
    expect(modelCache.get('p1/m2')).toBeDefined();
  });

  it('set_as_default без провайдера в каталоге — пара не записывается', async () => {
    const pairs: unknown[] = [];
    const { app } = await makeApp(tmpDir, {
      supportSetAsDefault: true,
      providerCache: new Map<string, ProviderConfig>(),
      setDefaultModel: (pair) => { pairs.push(pair); },
    });

    const res = await app.request('/', postJSON({
      id: 'ghost/m1',
      name: 'm1',
      provider: 'ghost',
      set_as_default: true,
    }));
    expect(res.status).toBe(201);
    expect(pairs).toEqual([]);
  });

  it('set_as_default снимает legacy isDefault у других моделей провайдера', async () => {
    const { app, modelStore, modelCache } = await makeApp(tmpDir, {
      supportSetAsDefault: true,
      providerCache: new Map<string, ProviderConfig>(),
      setDefaultModel: () => {},
    });
    await modelStore.save('p1/m1', {
      id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true, isDefault: true,
    });
    modelCache.set('p1/m1', {
      id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true, isDefault: true,
    });

    const res = await app.request('/', postJSON({
      id: 'p1/m2',
      name: 'm2',
      provider: 'p1',
      set_as_default: true,
    }));
    expect(res.status).toBe(201);
    expect(modelCache.get('p1/m1')?.isDefault).toBe(false);
  });
});
