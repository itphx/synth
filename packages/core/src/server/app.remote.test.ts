import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStandaloneApp, injectRemoteProvider } from './app.js';
import { JsonStore } from '../storage/json-store.js';
import { clearRemoteTokenProviders } from '../providers/remote.js';
import type { RemoteBackendClient } from '../remote/client.js';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';

const REMOTE_PROVIDER: ProviderConfig = {
  name: 'synth-remote',
  type: 'remote',
  baseUrl: 'https://backend.test',
  apiKey: '',
  enabled: true,
};

interface Group {
  provider: { name: string; type: string };
  models: Array<{ id: string }>;
}

afterEach(() => {
  clearRemoteTokenProviders();
});

describe('injectRemoteProvider (unit)', () => {
  it('добавляет провайдера и модели в кэши, возвращает имя remote-провайдера', () => {
    const providerCache = new Map<string, ProviderConfig>();
    const modelCache = new Map<string, ModelConfig>();

    const name = injectRemoteProvider(providerCache, modelCache, {
      provider: REMOTE_PROVIDER,
      models: [
        { id: 'remote/m1', name: 'm1', provider: 'synth-remote', enabled: true },
        { id: 'remote/m2', name: 'm2', provider: 'synth-remote', enabled: true },
      ],
      getToken: async () => 'tok',
    });

    expect(name).toBe('synth-remote');
    expect(providerCache.get('synth-remote')).toMatchObject({
      type: 'remote',
      baseUrl: 'https://backend.test',
      enabled: true,
    });
    expect(modelCache.get('remote/m1')).toBeDefined();
    expect(modelCache.get('remote/m2')).toBeDefined();
  });

  it('без remoteProvider — ничего не меняет', () => {
    const providerCache = new Map<string, ProviderConfig>();
    const modelCache = new Map<string, ModelConfig>();
    expect(injectRemoteProvider(providerCache, modelCache, undefined)).toBeUndefined();
    expect(providerCache.size).toBe(0);
    expect(modelCache.size).toBe(0);
  });
});

describe('createStandaloneApp: remoteProvider (гибрид, Часть 6)', () => {
  it('models-роут отдаёт remote-модели; в JsonStore они не пишутся', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-remote-'));
    try {
      const { app } = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        remoteProvider: {
          provider: REMOTE_PROVIDER,
          models: [{ id: 'remote/m1', name: 'm1', provider: 'synth-remote', enabled: true }],
          getToken: async () => 'tok',
        },
      });

      const res = await app.request('/api/v2/models', { headers: { Authorization: 'Bearer test-key' } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { groups: Group[] };
      const group = body.groups.find((g) => g.provider.name === 'synth-remote');
      expect(group).toBeDefined();
      expect(group!.models.map((m) => m.id)).toEqual(['remote/m1']);

      // Инъекция — только in-memory: в store ничего не записано.
      const modelStore = new JsonStore<ModelConfig>({ dataDir: dir, subdir: 'models' });
      expect(await modelStore.exists('remote/m1')).toBe(false);
      const providerStore = new JsonStore<ProviderConfig>({ dataDir: dir, subdir: 'providers' });
      expect(await providerStore.exists('synth-remote')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('remoteBlockLocalProviders: models-роут показывает только remote-модели', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-remote-block-'));
    try {
      const { app } = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        remoteProvider: {
          provider: REMOTE_PROVIDER,
          models: [{ id: 'remote/m1', name: 'm1', provider: 'synth-remote', enabled: true }],
          getToken: async () => 'tok',
        },
        remoteBlockLocalProviders: true,
      });

      // Локальный провайдер/модель — как будто уже лежали в store.
      const modelStore = new JsonStore<ModelConfig>({ dataDir: dir, subdir: 'models' });
      await modelStore.save('local/m1', { id: 'local/m1', name: 'm1', provider: 'local', enabled: true });
      const providerStore = new JsonStore<ProviderConfig>({ dataDir: dir, subdir: 'providers' });
      await providerStore.save('local', { name: 'local', type: 'openai', baseUrl: 'http://local.test', apiKey: 'k', enabled: true });

      const res = await app.request('/api/v2/models', { headers: { Authorization: 'Bearer test-key' } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { groups: Group[] };
      expect(body.groups.map((g) => g.provider.name)).toEqual(['synth-remote']);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('без remoteProvider — поведение не изменилось (remote-группы нет)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-remote-none-'));
    try {
      const { app } = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });
      const res = await app.request('/api/v2/models', { headers: { Authorization: 'Bearer test-key' } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { groups: Group[] };
      expect(body.groups.find((g) => g.provider.name === 'synth-remote')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('createStandaloneApp: RemoteEventBridge (гибрид, Часть 7)', () => {
  it('создаёт bridge из remoteClient, /api/v2/events доставляет remote:<id> через subscribeAll', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-bridge-'));
    const abort = new AbortController();
    try {
      const fakeRemote = {
        backendUrl: 'https://backend.test',
        request: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      } as unknown as RemoteBackendClient;

      const result = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        remoteClient: fakeRemote,
        remoteGetToken: async () => 'tok',
      });
      const { app, eventBus, remoteEventBridge } = result;

      // Bridge создан автоматически, но не стартует до явного вызова start().
      expect(remoteEventBridge).toBeDefined();
      expect(remoteEventBridge!.connected).toBe(false);

      const res = await app.request('/api/v2/events', {
        headers: { Authorization: 'Bearer test-key' },
        signal: abort.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // То, что сделал бы мост: публикация события удалённой сессии (remote:<id>)
      // и локальной сессии — обе доходят до UI через subscribeAll.
      eventBus!.publish('remote:ses-1', 'session.updated', { id: 'remote:ses-1', name: 'x' });
      eventBus!.publish('local-1', 'stream.chunk', { stream_id: 's1' });

      const first = await reader.read();
      expect(decoder.decode(first.value)).toContain('"sessionId":"remote:ses-1"');
      const second = await reader.read();
      expect(decoder.decode(second.value)).toContain('"sessionId":"local-1"');

      remoteEventBridge!.stop();
    } finally {
      abort.abort();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
