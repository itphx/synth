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
const REMOTE_PROVIDER: ProviderConfig = { name: 'synth-remote', type: 'remote', baseUrl: 'https://backend.test', apiKey: '', enabled: true };

interface Group {
  provider: { name: string; type: string };
  models: Array<{ id: string; name: string; provider: string }>;
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
    const body = (await res.json()) as { groups: Group[] };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]!.provider.name).toBe('local');
    expect(body.groups[0]!.models.map((m) => m.id)).toEqual(['local-m1']);
  });

  it('extraModels + extraProviders → remote-группа, дубликаты по id отфильтрованы', async () => {
    await providerStore.save('local', LOCAL_PROVIDER);
    await modelStore.save('local-m1', { id: 'local-m1', name: 'm1', provider: 'local', enabled: true });

    const app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>(), {
      extraModels: [
        { id: 'remote-m1', name: 'rm1', provider: 'synth-remote', enabled: true },
        { id: 'remote-m2', name: 'rm2', provider: 'synth-remote', enabled: true },
        // Дубликат store-модели — должен быть отброшен (первый источник — store).
        { id: 'local-m1', name: 'm1-dup', provider: 'local', enabled: true },
      ],
      extraProviders: [REMOTE_PROVIDER],
    });

    const res = await app.request('/');
    const body = (await res.json()) as { groups: Group[] };

    const remoteGroup = body.groups.find((g) => g.provider.name === 'synth-remote')!;
    expect(remoteGroup).toBeDefined();
    expect(remoteGroup.models.map((m) => m.id)).toEqual(['remote-m1', 'remote-m2']);
    expect(remoteGroup.provider.type).toBe('remote');

    const localGroup = body.groups.find((g) => g.provider.name === 'local')!;
    expect(localGroup.models).toHaveLength(1);
    expect(localGroup.models[0]!.name).toBe('m1'); // не m1-dup
  });

  it('onlyRemoteModels → локальные модели скрыты, остаётся только remote-группа', async () => {
    await providerStore.save('local', LOCAL_PROVIDER);
    await modelStore.save('local-m1', { id: 'local-m1', name: 'm1', provider: 'local', enabled: true });

    const app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>(), {
      extraModels: [{ id: 'remote-m1', name: 'rm1', provider: 'synth-remote', enabled: true }],
      extraProviders: [REMOTE_PROVIDER],
      onlyRemoteModels: true,
    });

    const res = await app.request('/');
    const body = (await res.json()) as { groups: Group[] };
    expect(body.groups.map((g) => g.provider.name)).toEqual(['synth-remote']);
    expect(body.groups[0]!.models.map((m) => m.id)).toEqual(['remote-m1']);
  });

  it('?provider=synth-remote фильтрует по remote-провайдеру', async () => {
    await providerStore.save('local', LOCAL_PROVIDER);
    await modelStore.save('local-m1', { id: 'local-m1', name: 'm1', provider: 'local', enabled: true });

    const app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>(), {
      extraModels: [{ id: 'remote-m1', name: 'rm1', provider: 'synth-remote', enabled: true }],
      extraProviders: [REMOTE_PROVIDER],
    });

    const res = await app.request('/?provider=synth-remote');
    const body = (await res.json()) as { groups: Group[] };
    // Существующий контракт: все провайдеры присутствуют, несовпадающие — с пустым списком.
    const remoteGroup = body.groups.find((g) => g.provider.name === 'synth-remote')!;
    expect(remoteGroup.models.map((m) => m.id)).toEqual(['remote-m1']);
    const localGroup = body.groups.find((g) => g.provider.name === 'local');
    expect(localGroup?.models).toEqual([]);
  });

  it('enabled_only отфильтровывает отключённые remote-модели', async () => {
    const app = createModelRoutes(createMockAuth(), modelStore, providerStore, new Map<string, ModelConfig>(), {
      extraModels: [
        { id: 'remote-m1', name: 'rm1', provider: 'synth-remote', enabled: true },
        { id: 'remote-m2', name: 'rm2', provider: 'synth-remote', enabled: false },
      ],
      extraProviders: [REMOTE_PROVIDER],
    });

    const res = await app.request('/?enabled_only=true');
    const body = (await res.json()) as { groups: Group[] };
    expect(body.groups[0]!.models.map((m) => m.id)).toEqual(['remote-m1']);
  });
});
