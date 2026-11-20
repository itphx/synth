/**
 * Событие шины `models.updated` на HTTP-путях каталога провайдеров и моделей.
 *
 * Баг: «модель, добавленная/удалённая/сделанная дефолтной в другом клиенте или
 * тулом из чата, не появляется в селекте модели чата». Причина — сервер молчал
 * о мутации каталога: селект грузит полный каталог лениво **один раз** (guard
 * `catalogLoaded`, `stores/providersStore.ts`) и перечитывать его было не из
 * чего.
 *
 * Контракт проверяется здесь целиком:
 * - провайдеры (`createProviderRoutes`): `POST /` (`provider`),
 *   `PATCH /:name` (`provider`), `DELETE /:name` (`provider`);
 * - модели (`createModelRoutes`): `POST /` (`save`, а с `set_as_default` —
 *   `default`), `DELETE /:id` (`delete`), `POST /fetch` (`fetch`, только если
 *   каталог реально записан);
 * - **не** публикуется при ошибке: 400 (невалидное тело), 404 (нет
 *   провайдера/модели) и при синхронизации без единой записи;
 * - payload — только провайдер, id модели и вид мутации: `api_key`, `base_url`
 *   (в URL иногда лежит токен) и прочий конфиг провайдера в событие не попадают
 *   ни при каких условиях (инвариант 13 `AGENTS.md`).
 *
 * Хук подменён фейком (`onModelsChanged` — тот же хук, что у
 * `modelsChangedPublisher`): тест про контракт фабрики, а не про EventBus
 * (сам шов — `src/events/models-events.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRoutes } from './providers.js';
import { createModelRoutes } from './models.js';
import { JsonStore } from '../../storage/json-store.js';
import { ProviderFactory } from '../../providers/index.js';
import type { AuthKit } from '../../auth/local.js';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';
import { publishModelsUpdated } from '../../events/models-events.js';
import type { ModelsChangedInfo } from '../../events/models-events.js';

/** Записанное событие (канал + тип + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: инстансные события + события канала сессии. */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel: 'instance', type, data });
    },
    publish: (channel: string, type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel, type, data });
    },
  };
}

/** Тот же путь публикации, что у точки сборки: `modelsChangedPublisher(eventBus)`. */
function modelsHook(published: PublishedEvent[]) {
  const bus = makeBus(published);
  return (info: ModelsChangedInfo) => publishModelsUpdated(bus, info);
}

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    // Фейк: реализованы только `getCurrentUser`/`requireAuth`.
  } as unknown as AuthKit;
}

function postJSON(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

let tmpDir: string;

function makeProvidersApp(published: PublishedEvent[]) {
  const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
  const providerCache = new Map<string, ProviderConfig>();
  const app = createProviderRoutes(createMockAuth(), providerStore, providerCache, {
    testEnabled: true,
    onModelsChanged: modelsHook(published),
  });
  return { app, providerStore, providerCache };
}

function makeModelsApp(
  published: PublishedEvent[],
  opts: Parameters<typeof createModelRoutes>[4] = {},
) {
  const modelStore = new JsonStore<ModelConfig>({ dataDir: tmpDir, subdir: 'models' });
  const providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
  const modelCache = new Map<string, ModelConfig>();
  const providerCache = new Map<string, ProviderConfig>();
  const app = createModelRoutes(createMockAuth(), modelStore, providerStore, modelCache, {
    providerCache,
    onModelsChanged: modelsHook(published),
    ...opts,
  });
  return { app, modelStore, providerStore, modelCache, providerCache };
}

async function seedProvider(store: JsonStore<ProviderConfig>, name = 'p1') {
  await store.save(name, {
    name,
    type: 'openai',
    baseUrl: 'http://provider.local',
    enabled: true,
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-models-events-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('createProviderRoutes — событие models.updated на write-путях', () => {
  let published: PublishedEvent[];

  beforeEach(() => {
    published = [];
  });

  it('POST / публикует { action: provider, provider }', async () => {
    const { app } = makeProvidersApp(published);

    const res = await app.request('/', postJSON({
      name: 'itphx',
      type: 'openai',
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-secret-key',
    }));

    expect(res.status).toBe(201);
    expect(published).toEqual([
      { channel: 'instance', type: 'models.updated', data: { action: 'provider', provider: 'itphx' } },
    ]);
    // Секреты провайдера в событие не попадают.
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain('sk-secret-key');
    expect(serialized).not.toContain('api.example.com');
  });

  it('PATCH /:name публикует { action: provider, provider }', async () => {
    const { app, providerStore } = makeProvidersApp(published);
    await seedProvider(providerStore);

    const res = await app.request('/p1', postJSON({ enabled: false }, 'PATCH'));

    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'models.updated', data: { action: 'provider', provider: 'p1' } },
    ]);
  });

  it('DELETE /:name публикует { action: provider, provider }', async () => {
    const { app, providerStore } = makeProvidersApp(published);
    await seedProvider(providerStore);

    const res = await app.request('/p1', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(published).toEqual([
      { channel: 'instance', type: 'models.updated', data: { action: 'provider', provider: 'p1' } },
    ]);
  });

  it('ошибки молчат: 400 (нет имени), 400 (плохой URL), 404 (нет провайдера)', async () => {
    const { app, providerStore } = makeProvidersApp(published);

    expect((await app.request('/', postJSON({ name: '' }))).status).toBe(400);
    expect((await app.request('/', postJSON({
      name: 'bad', base_url: 'not-a-url',
    }))).status).toBe(400);
    expect((await app.request('/missing', postJSON({ enabled: false }, 'PATCH'))).status).toBe(404);
    expect((await app.request('/missing', { method: 'DELETE' })).status).toBe(404);
    expect(published).toEqual([]);

    // Контроль: после ошибок исправная запись событие всё же публикует.
    await seedProvider(providerStore);
    expect((await app.request('/p1', { method: 'DELETE' })).status).toBe(204);
    expect(published).toHaveLength(1);
  });
});

describe('createModelRoutes — событие models.updated на write-путях', () => {
  let published: PublishedEvent[];

  beforeEach(async () => {
    published = [];
  });

  it('POST / (новая модель) публикует { action: save, provider, modelId }', async () => {
    const { app, providerStore } = makeModelsApp(published);
    await seedProvider(providerStore);

    const res = await app.request('/', postJSON({
      id: 'p1/m1',
      name: 'm1',
      provider: 'p1',
    }));

    expect(res.status).toBe(201);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'models.updated',
        data: { action: 'save', provider: 'p1', modelId: 'm1' },
      },
    ]);
  });

  it('POST / (обновление модели) тоже публикует save', async () => {
    const { app, providerStore, modelStore } = makeModelsApp(published);
    await seedProvider(providerStore);
    await modelStore.save('p1/m1', { id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true });

    const res = await app.request('/', postJSON({ id: 'p1/m1', provider: 'p1', enabled: false }));

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'models.updated',
        data: { action: 'save', provider: 'p1', modelId: 'm1' },
      },
    ]);
  });

  it('POST / с set_as_default публикует default (дефолтная пара тоже изменилась)', async () => {
    const { app, providerStore } = makeModelsApp(published, {
      supportSetAsDefault: true,
      setDefaultModel: () => {},
    });
    await seedProvider(providerStore);

    const res = await app.request('/', postJSON({
      id: 'p1/m1',
      name: 'm1',
      provider: 'p1',
      set_as_default: true,
    }));

    expect(res.status).toBe(201);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'models.updated',
        data: { action: 'default', provider: 'p1', modelId: 'm1' },
      },
    ]);
  });

  it('DELETE /:id публикует { action: delete, provider, modelId }', async () => {
    const { app, providerStore, modelStore } = makeModelsApp(published);
    await seedProvider(providerStore);
    await modelStore.save('p1/m1', { id: 'p1/m1', name: 'm1', provider: 'p1', enabled: true });

    // id модели содержит «/» (`provider/model`) — клиент кодирует его
    // (`encodeURIComponent`), как и `deleteModel` в UI.
    const res = await app.request('/p1%2Fm1', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'models.updated',
        data: { action: 'delete', provider: 'p1', modelId: 'm1' },
      },
    ]);
  });

  it('ошибки молчат: 400 (нет id), 404 (нет модели)', async () => {
    const { app } = makeModelsApp(published);

    expect((await app.request('/', postJSON({ provider: 'p1' }))).status).toBe(400);
    expect((await app.request('/p1/missing', { method: 'DELETE' })).status).toBe(404);
    expect(published).toEqual([]);
  });

  it('POST /fetch публикует { action: fetch, provider } после записи каталога', async () => {
    const { app, providerStore } = makeModelsApp(published);
    await seedProvider(providerStore);
    vi.spyOn(ProviderFactory, 'create').mockReturnValue({
      listModelsDetailed: async () => [{ id: 'm1' }],
    } as never);

    const res = await app.request('/fetch?provider=p1', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'models.updated', data: { action: 'fetch', provider: 'p1' } },
    ]);
  });

  it('POST /fetch без единой записи (ничего не изменилось) молчит', async () => {
    const { app, providerStore, modelStore } = makeModelsApp(published);
    await seedProvider(providerStore);
    await modelStore.save('p1/m1', {
      id: 'p1/m1',
      name: 'm1',
      provider: 'p1',
      enabled: true,
      contextWindow: 100,
      contextSource: 'reference',
    });
    vi.spyOn(ProviderFactory, 'create').mockReturnValue({
      // Окно совпадает с сохранённым — писать нечего.
      listModelsDetailed: async () => [{ id: 'm1', contextWindow: 100 }],
    } as never);

    const res = await app.request('/fetch?provider=p1', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(published).toEqual([]);
  });

  it('POST /fetch с ошибкой провайдера молчит (каталог не записан)', async () => {
    const { app, providerStore } = makeModelsApp(published);
    await seedProvider(providerStore);
    vi.spyOn(ProviderFactory, 'create').mockReturnValue({
      listModelsDetailed: async () => { throw new Error('boom'); },
    } as never);

    const res = await app.request('/fetch?provider=p1', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(published).toEqual([]);
  });
});
