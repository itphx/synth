import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelRoutes } from './models.js';
import { JsonStore } from '../../storage/json-store.js';
import { ProviderFactory } from '../../providers/index.js';
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
  const app = createModelRoutes(createMockAuth(), modelStore, providerStore, modelCache);
  return { app, modelStore, providerStore, modelCache };
}

describe('routes/models (core): POST /fetch', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-models-fetch-'));
    stores = await makeApp(tmpDir);
    await stores.providerStore.save('p1', {
      name: 'p1', type: 'openai', baseUrl: 'http://provider.local', enabled: true,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('синхронизирует модели провайдера: новые + обогащённые, синхронизирует кеш', async () => {
    await stores.modelStore.save('p1/m1', {
      id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true,
      contextWindow: 100, contextSource: 'reference',
    });
    vi.spyOn(ProviderFactory, 'create').mockReturnValue({
      listModelsDetailed: vi.fn().mockResolvedValue([
        { id: 'm1', contextWindow: 262144 },
        { id: 'm2', contextWindow: 131072 },
      ]),
    } as never);

    const res = await stores.app.request('/fetch?provider=p1', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json() as { fetched: number; new: number; enriched: number };
    expect(body.fetched).toBe(2);
    expect(body.new).toBe(1);
    expect(body.enriched).toBe(1);

    const m1 = await stores.modelStore.load('p1/m1');
    expect(m1?.contextWindow).toBe(262144);
    expect(m1?.contextSource).toBe('api');
    const m2 = await stores.modelStore.load('p1/m2');
    expect(m2?.contextSource).toBe('api');

    expect(stores.modelCache.get('p1/m1')?.contextWindow).toBe(262144);
    expect(stores.modelCache.get('p1/m2')).toMatchObject({ id: 'p1/m2', provider: 'p1' });
  });

  it('модальности из каталога: пишутся новой модели и обновляются при отличии', async () => {
    await stores.modelStore.save('p1/m1', {
      id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true, modalities: ['text'],
    });
    vi.spyOn(ProviderFactory, 'create').mockReturnValue({
      listModelsDetailed: vi.fn().mockResolvedValue([
        { id: 'm1', modalities: ['text', 'image'] },
        { id: 'm2', modalities: ['text', 'image'] },
        { id: 'm3' },
      ]),
    } as never);

    const res = await stores.app.request('/fetch?provider=p1', { method: 'POST' });
    expect(res.status).toBe(200);

    expect((await stores.modelStore.load('p1/m1'))?.modalities).toEqual(['text', 'image']);
    expect((await stores.modelStore.load('p1/m2'))?.modalities).toEqual(['text', 'image']);
    // API модальности не сообщил — поле не появляется (модальности неизвестны,
    // ограничение не применяется).
    expect((await stores.modelStore.load('p1/m3'))?.modalities).toBeUndefined();
    expect(stores.modelCache.get('p1/m2')?.modalities).toEqual(['text', 'image']);
  });

  it('?provider= ограничивает синхронизацию одним провайдером', async () => {
    await stores.providerStore.save('p2', {
      name: 'p2', type: 'openai', baseUrl: 'http://provider2.local', enabled: true,
    });
    const createSpy = vi.spyOn(ProviderFactory, 'create').mockReturnValue({
      listModelsDetailed: vi.fn().mockResolvedValue([{ id: 'm1' }]),
    } as never);

    const res = await stores.app.request('/fetch?provider=p1', { method: 'POST' });
    const body = await res.json() as { fetched: number };
    expect(body.fetched).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]![0]).toBe('p1');
    await expect(stores.modelStore.load('p2/m1')).resolves.toBeNull();
  });

  it('пропускает отключённые провайдеры', async () => {
    await stores.providerStore.save('p-off', {
      name: 'p-off', type: 'openai', baseUrl: 'http://off.local', enabled: false,
    });
    const createSpy = vi.spyOn(ProviderFactory, 'create').mockReturnValue({
      listModelsDetailed: vi.fn().mockResolvedValue([{ id: 'm1' }]),
    } as never);

    const res = await stores.app.request('/fetch', { method: 'POST' });
    const body = await res.json() as { fetched: number };
    expect(body.fetched).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]![0]).toBe('p1');
  });

  it('ошибки провайдера попадают в errors, остальные обрабатываются', async () => {
    await stores.providerStore.save('p2', {
      name: 'p2', type: 'openai', baseUrl: 'http://provider2.local', enabled: true,
    });
    vi.spyOn(ProviderFactory, 'create').mockImplementation((name: string) => {
      if (name === 'p1') throw new Error('boom');
      return { listModelsDetailed: vi.fn().mockResolvedValue([{ id: 'm1' }]) } as never;
    });

    const res = await stores.app.request('/fetch', { method: 'POST' });
    const body = await res.json() as { fetched: number; errors?: string[] };
    expect(body.fetched).toBe(1);
    expect(body.errors?.[0]).toContain('p1: boom');
  });

  it('401 без auth при дефолтном guard', async () => {
    const app = createModelRoutes({
      requireAuth: async (c: Context) =>
        c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401),
    } as never, stores.modelStore, stores.providerStore, stores.modelCache);

    const res = await app.request('/fetch', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
