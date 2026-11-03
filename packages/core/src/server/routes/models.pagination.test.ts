// Постраничный каталог моделей (`GET /api/v2/models`): поиск, фильтры,
// пагинация и форма ответа `{models, total, offset, limit, next_offset}`.
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

interface ModelPage {
  models: Array<{ id: string; name: string; provider: string; enabled: boolean; modalities?: string[] }>;
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

describe('routes/models: поиск и пагинация каталога', () => {
  let tmpDir: string;
  let modelStore: JsonStore<ModelConfig>;
  let providerStore: JsonStore<ProviderConfig>;
  let app: ReturnType<typeof createModelRoutes>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-models-page-'));
    modelStore = new JsonStore<ModelConfig>({ dataDir: tmpDir, subdir: 'models' });
    providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
    await providerStore.save('openai', {
      name: 'openai', type: 'openai', baseUrl: 'http://provider.local', enabled: true,
    });
    await providerStore.save('anthropic', {
      name: 'anthropic', type: 'anthropic', baseUrl: 'http://provider2.local', enabled: true,
    });
    app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>());

    for (let i = 1; i <= 5; i++) {
      await modelStore.save(`openai/m${i}`, {
        id: `openai/m${i}`, name: `m${i}`, provider: 'openai', enabled: true,
      });
    }
    await modelStore.save('anthropic/claude', {
      id: 'anthropic/claude', name: 'claude', provider: 'anthropic', enabled: false,
      modalities: ['text', 'image'],
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function page(query = ''): Promise<ModelPage> {
    const res = await app.request(`/${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as ModelPage;
  }

  it('ответ — страница: models/total/offset/limit/next_offset', async () => {
    const body = await page();
    expect(Object.keys(body).sort()).toEqual(['limit', 'models', 'next_offset', 'offset', 'total']);
    expect(body.total).toBe(6);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(100);
    expect(body.next_offset).toBeNull();
    expect(body.models).toHaveLength(6);
  });

  it('limit/offset режут страницу, next_offset — курсор следующей', async () => {
    const first = await page('?limit=2&offset=0');
    expect(first.models).toHaveLength(2);
    expect(first.limit).toBe(2);
    expect(first.total).toBe(6);
    expect(first.next_offset).toBe(2);

    const second = await page('?limit=2&offset=2');
    expect(second.models.map((m) => m.id)).not.toEqual(first.models.map((m) => m.id));
    expect(second.offset).toBe(2);
    expect(second.next_offset).toBe(4);

    const last = await page('?limit=2&offset=4');
    expect(last.models).toHaveLength(2);
    expect(last.next_offset).toBeNull();
  });

  it('search ищет по id/имени/провайдеру без учёта регистра', async () => {
    const byId = await page('?search=CLAUDE');
    expect(byId.models.map((m) => m.id)).toEqual(['anthropic/claude']);

    const byProvider = await page('?search=OPENAI');
    expect(byProvider.models).toHaveLength(5);

    const byName = await page('?search=m3');
    expect(byName.models.map((m) => m.id)).toEqual(['openai/m3']);

    const none = await page('?search=нет-такой');
    expect(none.models).toHaveLength(0);
    expect(none.total).toBe(0);
  });

  it('фильтры provider/enabled/modality сохраняются', async () => {
    const byProvider = await page('?provider=anthropic');
    expect(byProvider.models.map((m) => m.id)).toEqual(['anthropic/claude']);

    const onlyEnabled = await page('?enabled=true');
    expect(onlyEnabled.models.every((m) => m.enabled)).toBe(true);
    expect(onlyEnabled.total).toBe(5);

    const onlyDisabled = await page('?enabled=false');
    expect(onlyDisabled.models.map((m) => m.id)).toEqual(['anthropic/claude']);

    const byModality = await page('?modality=image');
    expect(byModality.models.map((m) => m.id)).toEqual(['anthropic/claude']);
  });

  it('невалидные limit/offset → 400 VALIDATION_ERROR', async () => {
    const badLimit = await app.request('/?limit=abc');
    expect(badLimit.status).toBe(400);
    expect(((await badLimit.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const tooBig = await app.request('/?limit=501');
    expect(tooBig.status).toBe(400);

    const zeroLimit = await app.request('/?limit=0');
    expect(zeroLimit.status).toBe(400);

    const badOffset = await app.request('/?offset=-1');
    expect(badOffset.status).toBe(400);
    expect(((await badOffset.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('сортировка страницы: сначала провайдер, затем имя модели', async () => {
    const body = await page();
    expect(body.models.map((m) => m.id)).toEqual([
      'anthropic/claude',
      'openai/m1',
      'openai/m2',
      'openai/m3',
      'openai/m4',
      'openai/m5',
    ]);
  });
});
