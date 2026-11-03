import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, Next } from 'hono';
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

const LOCAL_PROVIDER: ProviderConfig = { name: 'local', type: 'openai', baseUrl: 'http://local.test', apiKey: 'k', enabled: true };
const REMOTE_PROVIDER: ProviderConfig = { name: 'itphx', type: 'remote', baseUrl: 'https://backend.test', apiKey: '', enabled: true };

/** Страница каталога моделей (`GET /` → `{models, total, offset, limit, next_offset}`). */
interface ModelPage {
  models: Array<{ id: string; name: string; provider: string }>;
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

describe('createModelRoutes: слияние remote-моделей (Часть 6)', () => {
  let dir: string;
  let modelStore: JsonStore<ModelConfig>;
  let providerStore: JsonStore<ProviderConfig>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-models-remote-'));
    modelStore = new JsonStore<ModelConfig>({ dataDir: dir, subdir: 'models' });
    providerStore = new JsonStore<ProviderConfig>({ dataDir: dir, subdir: 'providers' });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('без extraModels контракт не изменился: только store-модели', async () => {
    await providerStore.save('local', LOCAL_PROVIDER);
    await modelStore.save('local-m1', { id: 'local-m1', name: 'm1', provider: 'local', enabled: true });

    const app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>());
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelPage;
    expect(body.models).toHaveLength(1);
    expect(body.models[0]!.provider).toBe('local');
    expect(body.models.map((m) => m.id)).toEqual(['local-m1']);
    expect(body.total).toBe(1);
  });

  it('extraModels + extraProviders → remote-группа, дубликаты по id отфильтрованы', async () => {
    await providerStore.save('local', LOCAL_PROVIDER);
    await modelStore.save('local-m1', { id: 'local-m1', name: 'm1', provider: 'local', enabled: true });

    const app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>(), {
      extraModels: [
        { id: 'remote-m1', name: 'rm1', provider: 'itphx', enabled: true },
        { id: 'remote-m2', name: 'rm2', provider: 'itphx', enabled: true },
        // Дубликат store-модели — должен быть отброшен (первый источник — store).
        { id: 'local-m1', name: 'm1-dup', provider: 'local', enabled: true },
      ],
      extraProviders: [REMOTE_PROVIDER],
    });

    const res = await app.request('/');
    const body = (await res.json()) as ModelPage;

    const remote = body.models.filter((m) => m.provider === 'itphx');
    expect(remote.map((m) => m.id)).toEqual(['remote-m1', 'remote-m2']);

    const local = body.models.filter((m) => m.provider === 'local');
    expect(local).toHaveLength(1);
    expect(local[0]!.name).toBe('m1'); // не m1-dup
  });

  it('onlyRemoteModels → локальные модели скрыты, остаётся только remote-группа', async () => {
    await providerStore.save('local', LOCAL_PROVIDER);
    await modelStore.save('local-m1', { id: 'local-m1', name: 'm1', provider: 'local', enabled: true });

    const app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>(), {
      extraModels: [{ id: 'remote-m1', name: 'rm1', provider: 'itphx', enabled: true }],
      extraProviders: [REMOTE_PROVIDER],
      onlyRemoteModels: true,
    });

    const res = await app.request('/');
    const body = (await res.json()) as ModelPage;
    expect(body.models.map((m) => m.provider)).toEqual(['itphx']);
    expect(body.models.map((m) => m.id)).toEqual(['remote-m1']);
  });

  it('?provider=itphx фильтрует по remote-провайдеру', async () => {
    await providerStore.save('local', LOCAL_PROVIDER);
    await modelStore.save('local-m1', { id: 'local-m1', name: 'm1', provider: 'local', enabled: true });

    const app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>(), {
      extraModels: [{ id: 'remote-m1', name: 'rm1', provider: 'itphx', enabled: true }],
      extraProviders: [REMOTE_PROVIDER],
    });

    const res = await app.request('/?provider=itphx');
    const body = (await res.json()) as ModelPage;
    // Фильтр по провайдеру: в страницу попадают только модели нужного провайдера.
    expect(body.models.map((m) => m.id)).toEqual(['remote-m1']);
    expect(body.total).toBe(1);
  });

  it('enabled_only отфильтровывает отключённые remote-модели', async () => {
    const app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>(), {
      extraModels: [
        { id: 'remote-m1', name: 'rm1', provider: 'itphx', enabled: true },
        { id: 'remote-m2', name: 'rm2', provider: 'itphx', enabled: false },
      ],
      extraProviders: [REMOTE_PROVIDER],
    });

    const res = await app.request('/?enabled_only=true');
    const body = (await res.json()) as ModelPage;
    expect(body.models.map((m) => m.id)).toEqual(['remote-m1']);
  });
});
