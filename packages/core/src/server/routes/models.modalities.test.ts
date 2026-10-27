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
 * принимает) — аддитивное поле, UI гейтит по нему выбор файлов.
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

  it('известная vision-модель — модальности из справочника', async () => {
    await stores.modelStore.save('openai/gpt-4o', {
      id: 'openai/gpt-4o', name: 'gpt-4o', provider: 'openai', enabled: true,
    });

    const res = await stores.app.request('/');
    const body = (await res.json()) as ModelsResponse;
    const model = body.groups.find((g) => g.provider.name === 'openai')!.models[0]!;
    expect(model.modalities).toEqual(['text', 'image', 'pdf']);
  });

  it('неизвестная модель — консервативный фолбэк (только текст)', async () => {
    await stores.modelStore.save('openai/my-model-v999', {
      id: 'openai/my-model-v999', name: 'my-model-v999', provider: 'openai', enabled: true,
    });

    const res = await stores.app.request('/');
    const body = (await res.json()) as ModelsResponse;
    const model = body.groups.find((g) => g.provider.name === 'openai')!.models[0]!;
    expect(model.modalities).toEqual(['text']);
  });
});
