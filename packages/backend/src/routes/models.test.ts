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
  await providerStore.save('p1', {
    name: 'p1',
    type: 'openai',
    baseUrl: 'http://provider.local',
    enabled: true,
  });
  const app = new Hono();
  app.route(BASE, createModelRoutes(createKit() as never, modelStore, providerStore));
  return { app, modelStore };
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
});
