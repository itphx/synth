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

describe('routes/models (core): compatibility и shorthand requires_reasoning', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-models-compat-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function post(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('POST compatibility → GET отдаёт; shorthand requires_reasoning сохраняется', async () => {
    const res = await stores.app.request('/', post({
      id: 'openai/mistral-large',
      provider: 'openai',
      compatibility: { requireAssistantAfterTool: true, maxTokensField: 'max_completion_tokens' },
      requires_reasoning: true,
    }));
    expect(res.status).toBe(201);

    const saved = await stores.modelStore.load('openai/mistral-large');
    expect(saved?.compatibility).toEqual({
      requireAssistantAfterTool: true,
      maxTokensField: 'max_completion_tokens',
    });
    expect(saved?.requiresReasoning).toBe(true);

    const list = await (await stores.app.request('/')).json() as ModelsResponse;
    const model = list.groups[0]!.models.find((m) => m.id === 'openai/mistral-large')!;
    expect(model.compatibility).toEqual({
      requireAssistantAfterTool: true,
      maxTokensField: 'max_completion_tokens',
    });
    expect(model.requiresReasoning).toBe(true);
  });

  it('compatibility: null — сброс только совместимости, shorthand остаётся', async () => {
    await stores.modelStore.save('openai/m1', {
      id: 'openai/m1', name: 'm1', provider: 'openai', enabled: true,
      compatibility: { streamUsage: false },
      requiresReasoning: true,
    });
    const res = await stores.app.request('/', post({
      id: 'openai/m1',
      provider: 'openai',
      compatibility: null,
    }));
    expect(res.status).toBe(200);
    const saved = await stores.modelStore.load('openai/m1');
    expect(saved?.compatibility).toBeUndefined();
    expect(saved?.requiresReasoning).toBe(true);
  });

  it('requires_reasoning: null — сброс и shorthand, и compatibility.requireReasoning', async () => {
    await stores.modelStore.save('openai/m2', {
      id: 'openai/m2', name: 'm2', provider: 'openai', enabled: true,
      compatibility: { requireReasoning: true, streamUsage: false },
      requiresReasoning: true,
    });
    const res = await stores.app.request('/', post({
      id: 'openai/m2',
      provider: 'openai',
      requires_reasoning: null,
    }));
    expect(res.status).toBe(200);
    const saved = await stores.modelStore.load('openai/m2');
    expect(saved?.requiresReasoning).toBeUndefined();
    // Остальные поля совместимости сохраняются, снят только requireReasoning.
    expect(saved?.compatibility).toEqual({ streamUsage: false });
  });

  it('compatibility: объект заменяет прежний целиком; {requireReasoning:false} оставляет только это поле', async () => {
    await stores.modelStore.save('openai/m0', {
      id: 'openai/m0', name: 'm0', provider: 'openai', enabled: true,
      compatibility: { requireReasoning: true, maxTokensField: 'max_tokens' },
    });
    const res = await stores.app.request('/', post({
      id: 'openai/m0',
      provider: 'openai',
      compatibility: { requireReasoning: false },
    }));
    expect(res.status).toBe(200);
    const saved = await stores.modelStore.load('openai/m0');
    // Замена, не наложение: `maxTokensField` не наследуется (это «авто»).
    expect(saved?.compatibility).toEqual({ requireReasoning: false });
  });

  it('POST без поля compatibility не затирает прежнюю совместимость', async () => {
    await stores.modelStore.save('openai/m3', {
      id: 'openai/m3', name: 'm3', provider: 'openai', enabled: true,
      compatibility: { requireReasoning: true, maxTokensField: 'max_tokens' },
    });
    const res = await stores.app.request('/', post({
      id: 'openai/m3',
      provider: 'openai',
      description: 'updated',
    }));
    expect(res.status).toBe(200);
    const saved = await stores.modelStore.load('openai/m3');
    expect(saved?.compatibility).toEqual({ requireReasoning: true, maxTokensField: 'max_tokens' });
  });

  it('неизвестное поле compatibility → 400 VALIDATION_ERROR', async () => {
    const res = await stores.app.request('/', post({
      id: 'openai/bad',
      provider: 'openai',
      compatibility: { bogusField: true },
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
