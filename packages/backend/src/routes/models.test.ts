import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelRoutes } from './models.js';
import { JsonStore } from '../storage/json-store.js';
import { ProviderFactory } from '@itphx/synth-core';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';

const BASE = '/api/v2/models';

function createKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    requireAdmin: async (_c: Context, next: Next) => { await next(); },
  };
}

async function makeApp(tmpDir: string) {
  const modelStore = new JsonStore<ModelConfig>({ dataDir: tmpDir, subdir: 'models' });
  const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
  const modelCache = new Map<string, ModelConfig>();
  const providerCache = new Map<string, ProviderConfig>();
  await providerStore.save('p1', {
    name: 'p1',
    type: 'openai',
    baseUrl: 'http://provider.local',
    enabled: true,
  });
  const app = new Hono();
  app.route(BASE, createModelRoutes(createKit() as never, modelStore, providerStore, modelCache, providerCache));
  return { app, modelStore, providerStore, modelCache, providerCache };
}

function postJSON(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('routes/models', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-models-test-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('POST /models принимает snake_case, GET возвращает camelCase', async () => {
    const res = await stores.app.request(BASE, postJSON({
      id: 'p1/m1',
      name: 'm1',
      provider: 'p1',
      context_window: 4096,
      context_source: 'manual',
      input_price: 1.5,
      output_price: 0.75,
    }));
    expect(res.status).toBe(201);

    const list = await stores.app.request(BASE);
    const body = await list.json() as { groups: Array<{ provider: { name: string }; models: Array<Record<string, unknown>> }> };
    const model = body.groups.find((g) => g.provider.name === 'p1')!.models[0]!;
    expect(model.contextWindow).toBe(4096);
    expect(model.contextSource).toBe('manual');
    expect(model.inputPrice).toBe(1.5);
    expect(model.outputPrice).toBe(0.75);
  });

  it('POST /models принимает camelCase', async () => {
    const res = await stores.app.request(BASE, postJSON({
      id: 'p1/m2',
      name: 'm2',
      provider: 'p1',
      contextWindow: 8192,
      contextSource: 'api',
    }));
    expect(res.status).toBe(201);

    const saved = await stores.modelStore.load('p1/m2');
    expect(saved?.contextWindow).toBe(8192);
    expect(saved?.contextSource).toBe('api');
  });

  it('POST /models c context_window=null очищает сохранённое окно и сбрасывает source', async () => {
    await stores.modelStore.save('p1/m1', {
      id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true,
      contextWindow: 4096, contextSource: 'manual',
    });

    const res = await stores.app.request(BASE, postJSON({
      id: 'p1/m1',
      context_window: null,
      context_source: 'unknown',
    }));
    expect(res.status).toBe(200);

    const saved = await stores.modelStore.load('p1/m1');
    expect(saved?.contextWindow).toBeUndefined();
    expect(saved?.contextSource).toBe('unknown');
  });

  describe('POST /models/fetch', () => {
    it('не перезаписывает вручную заданное окно (source=manual)', async () => {
      await stores.modelStore.save('p1/m1', {
        id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true,
        contextWindow: 999, contextSource: 'manual',
      });
      vi.spyOn(ProviderFactory, 'create').mockReturnValue({
        listModelsDetailed: vi.fn().mockResolvedValue([{ id: 'm1', contextWindow: 262144 }]),
      } as never);

      const res = await stores.app.request(`${BASE}/fetch?provider=p1`, { method: 'POST' });
      const body = await res.json() as { enriched: number };
      expect(body.enriched).toBe(0);

      const saved = await stores.modelStore.load('p1/m1');
      expect(saved?.contextWindow).toBe(999);
      expect(saved?.contextSource).toBe('manual');
    });

    it('обновляет окно из провайдера, если source не manual (reference/unknown/0)', async () => {
      await stores.modelStore.save('p1/m1', {
        id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true,
        contextWindow: 100, contextSource: 'reference',
      });
      await stores.modelStore.save('p1/m2', {
        id: 'p1/m2', name: 'm2', provider: 'p1', enabled: true,
        contextWindow: 0, contextSource: 'unknown',
      });
      vi.spyOn(ProviderFactory, 'create').mockReturnValue({
        listModelsDetailed: vi.fn().mockResolvedValue([
          { id: 'm1', contextWindow: 262144 },
          { id: 'm2', contextWindow: 131072 },
        ]),
      } as never);

      const res = await stores.app.request(`${BASE}/fetch?provider=p1`, { method: 'POST' });
      const body = await res.json() as { enriched: number };
      expect(body.enriched).toBe(2);

      const m1 = await stores.modelStore.load('p1/m1');
      expect(m1?.contextWindow).toBe(262144);
      expect(m1?.contextSource).toBe('api');
      const m2 = await stores.modelStore.load('p1/m2');
      expect(m2?.contextWindow).toBe(131072);
      expect(m2?.contextSource).toBe('api');
    });
  });

  describe('синхронизация in-memory кеша (LLM Proxy)', () => {
    it('POST /models добавляет модель в кеш', async () => {
      const res = await stores.app.request(BASE, postJSON({
        id: 'p1/m1',
        name: 'm1',
        provider: 'p1',
        context_window: 4096,
      }));
      expect(res.status).toBe(201);

      const cached = stores.modelCache.get('p1/m1');
      expect(cached).toBeDefined();
      expect(cached?.contextWindow).toBe(4096);
    });

    it('POST /models c set_as_default обновляет defaultModel провайдера в кеше и снимает isDefault с других моделей', async () => {
      await stores.modelStore.save('p1/m1', {
        id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true, isDefault: true,
      });
      await stores.modelStore.save('p1/m2', {
        id: 'p1/m2', name: 'm2', provider: 'p1', enabled: true, isDefault: false,
      });
      stores.modelCache.set('p1/m1', { id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true, isDefault: true });
      stores.modelCache.set('p1/m2', { id: 'p1/m2', name: 'm2', provider: 'p1', enabled: true, isDefault: false });

      const res = await stores.app.request(BASE, postJSON({
        id: 'p1/m2',
        name: 'm2',
        provider: 'p1',
        set_as_default: true,
      }));
      expect(res.status).toBe(200);

      expect(stores.providerCache.get('p1')?.defaultModel).toBe('m2');
      expect(stores.modelCache.get('p1/m1')?.isDefault).toBe(false);
      expect(stores.modelCache.get('p1/m2')).toBeDefined();
      // isDefault на самой модели не выставляется — дефолт определяется через provider.defaultModel
      expect(stores.providerCache.get('p1')).toEqual(expect.objectContaining({ defaultModel: 'm2' }));
    });

    it('POST /models/fetch кладёт новые и обогащённые модели в кеш', async () => {
      await stores.modelStore.save('p1/m1', {
        id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true,
        contextWindow: 100, contextSource: 'reference',
      });
      stores.modelCache.set('p1/m1', { id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true, contextWindow: 100, contextSource: 'reference' });
      vi.spyOn(ProviderFactory, 'create').mockReturnValue({
        listModelsDetailed: vi.fn().mockResolvedValue([
          { id: 'm1', contextWindow: 262144 },
          { id: 'm2', contextWindow: 131072 },
        ]),
      } as never);

      const res = await stores.app.request(`${BASE}/fetch?provider=p1`, { method: 'POST' });
      expect(res.status).toBe(200);

      expect(stores.modelCache.get('p1/m1')?.contextWindow).toBe(262144);
      expect(stores.modelCache.get('p1/m2')).toMatchObject({
        id: 'p1/m2', name: 'm2', provider: 'p1', contextWindow: 131072,
      });
    });

    it('DELETE /models/:id удаляет модель из кеша', async () => {
      await stores.modelStore.save('p1/m1', {
        id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true,
      });
      stores.modelCache.set('p1/m1', { id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true });

      const res = await stores.app.request(`${BASE}/p1%2Fm1`, { method: 'DELETE' });
      expect(res.status).toBe(204);

      expect(stores.modelCache.has('p1/m1')).toBe(false);
    });
  });

  describe('валюта модели', () => {
    interface CurrencyGroup {
      provider: { name: string; currency?: string };
      models: Array<Record<string, unknown>>;
    }

    async function listGroups(): Promise<CurrencyGroup[]> {
      const res = await stores.app.request(BASE);
      const body = await res.json() as { groups: CurrencyGroup[] };
      return body.groups;
    }

    it('POST с currency=CNY сохраняет модель, GET возвращает model.currency и provider.currency', async () => {
      await stores.providerStore.save('p-cur', {
        name: 'p-cur', type: 'openai', baseUrl: 'http://p.local', enabled: true, currency: 'USD',
      });

      const res = await stores.app.request(BASE, postJSON({
        id: 'p-cur/m-cur',
        name: 'm-cur',
        provider: 'p-cur',
        currency: 'CNY',
      }));
      expect(res.status).toBe(201);

      const saved = await stores.modelStore.load('p-cur/m-cur');
      expect(saved?.currency).toBe('CNY');

      const group = (await listGroups()).find((g) => g.provider.name === 'p-cur')!;
      expect(group.provider.currency).toBe('USD');
      expect(group.models[0]!.currency).toBe('CNY');
    });

    it('POST с невалидной currency (XXX) — значение игнорируется', async () => {
      const res = await stores.app.request(BASE, postJSON({
        id: 'p1/m-bad',
        name: 'm-bad',
        provider: 'p1',
        currency: 'XXX',
      }));
      expect(res.status).toBe(201);

      const saved = await stores.modelStore.load('p1/m-bad');
      expect(saved?.currency).toBeUndefined();

      const group = (await listGroups()).find((g) => g.provider.name === 'p1')!;
      const model = group.models.find((m) => m.id === 'p1/m-bad')!;
      expect(model.currency).toBeUndefined();
    });
  });
});
