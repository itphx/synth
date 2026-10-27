import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelRoutes } from './models.js';
import { JsonStore } from '../../storage/json-store.js';
import type { AuthKit } from '../../auth/local.js';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';

/**
 * ADR-115: `GET /models` отдаёт модальности входа модели (какие вложения она
 * принимает) — аддитивное поле из конфига модели (каталог провайдера при
 * синхронизации / ручной override), UI гейтит по нему выбор файлов. Поля нет —
 * модальности неизвестны, ограничение не применяется (справочника в ядре нет).
 */
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
  await providerStore.save('openai', {
    name: 'openai', type: 'openai', baseUrl: 'http://provider.local', enabled: true,
  });
  const app = createModelRoutes(createMockAuth(), modelStore, providerStore, modelCache);
  return { app, modelStore };
}

interface ModelsResponse {
  groups: Array<{ provider: { name: string }; models: Array<Record<string, unknown>> }>;
}

describe('routes/models (core): модальности входа модели (ADR-115)', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-models-modalities-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('модель без `modalities` → поля в ответе нет (модальности неизвестны)', async () => {
    await stores.modelStore.save('openai/my-model-v999', {
      id: 'openai/my-model-v999', name: 'my-model-v999', provider: 'openai', enabled: true,
    });

    const res = await stores.app.request('/');
    const body = (await res.json()) as ModelsResponse;
    const model = body.groups.find((g) => g.provider.name === 'openai')!.models[0]!;
    // Справочника модальностей в ядре нет: «неизвестно» = поле отсутствует,
    // ограничение не применяется (вложение не теряется).
    expect(model).not.toHaveProperty('modalities');
  });

  it('модальности из конфига модели отдаются как есть (каталог провайдера)', async () => {
    await stores.modelStore.save('openai/gpt-4o', {
      id: 'openai/gpt-4o',
      name: 'gpt-4o',
      provider: 'openai',
      enabled: true,
      modalities: ['text', 'image', 'pdf'],
    });

    const res = await stores.app.request('/');
    const body = (await res.json()) as ModelsResponse;
    const model = body.groups.find((g) => g.provider.name === 'openai')!.models[0]!;
    expect(model.modalities).toEqual(['text', 'image', 'pdf']);
  });

  it('пустой список модальностей эквивалентен «неизвестно» — поля нет', async () => {
    await stores.modelStore.save('openai/empty', {
      id: 'openai/empty', name: 'empty', provider: 'openai', enabled: true, modalities: [],
    });

    const res = await stores.app.request('/');
    const body = (await res.json()) as ModelsResponse;
    const model = body.groups.find((g) => g.provider.name === 'openai')!.models[0]!;
    expect(model).not.toHaveProperty('modalities');
  });

  it('POST / принимает modalities (ручной override), мусор отфильтровывается', async () => {
    const res = await stores.app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'openai/my-vision',
        provider: 'openai',
        modalities: ['text', 'image', 'bogus', 'image'],
      }),
    });
    expect(res.status).toBe(201);

    const saved = await stores.modelStore.load('openai/my-vision');
    expect(saved?.modalities).toEqual(['text', 'image']);

    // `null` — сброс: модальности снова неизвестны (поле в `GET /models` пропадает).
    const reset = await stores.app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'openai/my-vision', provider: 'openai', modalities: null }),
    });
    expect(reset.status).toBe(200);
    expect((await stores.modelStore.load('openai/my-vision'))?.modalities).toBeUndefined();
  });
});
