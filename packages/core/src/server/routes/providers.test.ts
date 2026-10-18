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

describe('routes/providers (core): алиасы полей и валидация URL', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-providers-alias-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST только с url/model/apiKey (как отдаёт GET) — сохраняется и GET отдаёт их', async () => {
    const res = await stores.app.request('/', postJSON({
      name: 'by-get',
      type: 'openai',
      url: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-alias',
    }));
    expect(res.status).toBe(201);

    const saved = await stores.providerStore.load('by-get');
    expect(saved?.baseUrl).toBe('https://api.example.com/v1');
    expect(saved?.defaultModel).toBe('gpt-4o-mini');
    expect(saved?.apiKey).toBe('sk-alias');

    const list = await (await stores.app.request('/')).json() as {
      providers: Array<Record<string, unknown>>;
    };
    const provider = list.providers.find((p) => p.name === 'by-get')!;
    expect(provider.url).toBe('https://api.example.com/v1');
    expect(provider.model).toBe('gpt-4o-mini');
  });

  it('POST без url → 400 VALIDATION_ERROR, провайдер не сохранён', async () => {
    const res = await stores.app.request('/', postJSON({ name: 'no-url', type: 'openai' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(await stores.providerStore.load('no-url')).toBeNull();
  });

  it('POST с относительным/невалидным url → 400 VALIDATION_ERROR', async () => {
    const res = await stores.app.request('/', postJSON({
      name: 'bad-url', type: 'openai', base_url: 'not-a-url',
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(await stores.providerStore.load('bad-url')).toBeNull();
  });

  it('PATCH /:name частично обновляет поля, алиасы принимаются, url валидируется', async () => {
    await stores.providerStore.save('p-patch', {
      name: 'p-patch', type: 'openai', baseUrl: 'http://old.local', enabled: true,
    });

    // Частичное обновление без url — baseUrl сохраняется.
    const ok = await stores.app.request('/p-patch', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'new-model' }),
    });
    expect(ok.status).toBe(200);
    const saved = await stores.providerStore.load('p-patch');
    expect(saved?.baseUrl).toBe('http://old.local');
    expect(saved?.defaultModel).toBe('new-model');
    expect(stores.providerCache.get('p-patch')?.defaultModel).toBe('new-model');

    // Невалидный url → 400, изменения не применяются.
    const bad = await stores.app.request('/p-patch', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://x/y' }),
    });
    expect(bad.status).toBe(400);
    expect((await stores.providerStore.load('p-patch'))?.baseUrl).toBe('http://old.local');

    const missing = await stores.app.request('/missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('routes/providers (core): num_ctx / numCtx', () => {
  let tmpDir: string;
  let stores: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-providers-numctx-'));
    stores = await makeApp(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST принимает snake_case num_ctx и GET отдаёт поле', async () => {
    const res = await stores.app.request('/', postJSON({
      name: 'ollama',
      type: 'ollama',
      base_url: 'http://localhost:11434',
      num_ctx: 8192,
    }));
    expect(res.status).toBe(201);
    expect((await stores.providerStore.load('ollama'))?.numCtx).toBe(8192);

    const detail = await (await stores.app.request('/ollama')).json() as { numCtx?: number };
    expect(detail.numCtx).toBe(8192);

    const list = await (await stores.app.request('/')).json() as {
      providers: Array<Record<string, unknown>>;
    };
    expect(list.providers.find((p) => p.name === 'ollama')?.num_ctx).toBe(8192);
  });

  it('POST принимает camelCase numCtx (алиас)', async () => {
    const res = await stores.app.request('/', postJSON({
      name: 'ollama-camel',
      type: 'ollama',
      base_url: 'http://localhost:11434',
      numCtx: 4096,
    }));
    expect(res.status).toBe(201);
    expect((await stores.providerStore.load('ollama-camel'))?.numCtx).toBe(4096);
  });

  it('POST с num_ctx <= 0 или не-целым → 400 VALIDATION_ERROR, не сохраняется', async () => {
    for (const bad of [0, -1, 1.5, 'abc']) {
      const res = await stores.app.request('/', postJSON({
        name: `bad-${String(bad)}`,
        type: 'ollama',
        base_url: 'http://localhost:11434',
        num_ctx: bad,
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(await stores.providerStore.load(`bad-${String(bad)}`)).toBeNull();
    }
  });

  it('PATCH /:name задаёт num_ctx, null очищает; без поля — сохраняется', async () => {
    await stores.providerStore.save('p', {
      name: 'p', type: 'ollama', baseUrl: 'http://localhost:11434', enabled: true, numCtx: 2048,
    });

    // Без поля — значение сохраняется.
    const keep = await stores.app.request('/p', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:8b' }),
    });
    expect(keep.status).toBe(200);
    expect((await stores.providerStore.load('p'))?.numCtx).toBe(2048);

    // Обновление.
    const upd = await stores.app.request('/p', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numCtx: 16384 }),
    });
    expect(upd.status).toBe(200);
    expect((await stores.providerStore.load('p'))?.numCtx).toBe(16384);

    // Явная очистка.
    const clear = await stores.app.request('/p', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num_ctx: null }),
    });
    expect(clear.status).toBe(200);
    expect((await stores.providerStore.load('p'))?.numCtx).toBeUndefined();

    // Невалидное значение → 400, значение не меняется.
    const bad = await stores.app.request('/p', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num_ctx: -5 }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('routes/providers (core): default_provider из явной пары provider+model', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-providers-default-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeListApp(getDefaultModel?: () => { provider: string; model: string } | null) {
    const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
    const providerCache = new Map<string, ProviderConfig>();
    await providerStore.save('__remote', {
      name: '__remote', type: 'openai', baseUrl: 'http://remote.local', enabled: true,
    });
    await providerStore.save('itphx', {
      name: 'itphx', type: 'openai', baseUrl: 'http://itphx.local', enabled: true,
    });
    await providerStore.save('ollama', {
      name: 'ollama', type: 'ollama', baseUrl: 'http://ollama.local', enabled: true,
    });
    const app = createProviderRoutes(createMockAuth(), providerStore, providerCache, {
      testEnabled: true,
      getDefaultModel,
    });
    return app;
  }

  it('is_default/default_provider — ровно провайдер из пары, не «первый»', async () => {
    const app = await makeListApp(() => ({ provider: 'ollama', model: 'qwen3:8b' }));
    const body = await (await app.request('/')).json() as {
      providers: Array<{ name: string; is_default: boolean }>;
      default_provider: string;
    };

    expect(body.default_provider).toBe('ollama');
    expect(body.providers.filter((p) => p.is_default).map((p) => p.name)).toEqual(['ollama']);
  });

  it('пара не задана — default_provider пуст и ни один провайдер не дефолтный', async () => {
    const app = await makeListApp(undefined);
    const body = await (await app.request('/')).json() as {
      providers: Array<{ name: string; is_default: boolean }>;
      default_provider: string;
    };

    expect(body.default_provider).toBe('');
    expect(body.providers.every((p) => p.is_default === false)).toBe(true);
  });

  it('пара указывает на несуществующего провайдера — никто не дефолтный', async () => {
    const app = await makeListApp(() => ({ provider: 'ghost', model: 'm1' }));
    const body = await (await app.request('/')).json() as {
      providers: Array<{ name: string; is_default: boolean }>;
      default_provider: string;
    };

    expect(body.default_provider).toBe('ghost');
    expect(body.providers.every((p) => p.is_default === false)).toBe(true);
  });
});
