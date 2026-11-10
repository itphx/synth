// ADR-133: тесты runtime-настроек автопроверки обновлений
// (`/api/v2/settings/updates`): источник, env-фиксация, приоритет.
import { describe, expect, it } from 'vitest';
import type { AuthKit } from '../../auth/local.js';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { UpdatesRuntimeSettings } from '../../storage/runtime-settings.js';
import { createUpdatesSettingsRoutes } from './settings-updates.js';

const auth = {
  requireAuth: async (_c: unknown, next: () => Promise<void>) => next(),
} as unknown as AuthKit;

/** Минимальный фейк порта: только секция `updates`. */
function fakeStore(): SettingsRepository & { _updates?: UpdatesRuntimeSettings } {
  const store = {
    _updates: undefined as UpdatesRuntimeSettings | undefined,
    async getUpdates() {
      return { ...(store._updates ?? {}) };
    },
    async setUpdates(config: UpdatesRuntimeSettings) {
      store._updates = { ...store._updates, ...config };
    },
    async clearUpdates() {
      store._updates = undefined;
    },
  };
  return store as unknown as SettingsRepository & { _updates?: UpdatesRuntimeSettings };
}

describe('GET /settings/updates (ADR-133)', () => {
  it('по умолчанию: check=false, source=default, канал auto, дефолтные реестры', async () => {
    const app = createUpdatesSettingsRoutes(auth, { settingsStore: fakeStore(), env: {} });
    const res = await app.request('/updates');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      check: false,
      source: 'default',
      envLocked: false,
      channel: 'auto',
      intervalHours: 24,
      stableRegistry: 'https://registry.npmjs.org',
      betaRegistry: 'https://git.itphx.ru/api/packages/itphx/npm/',
      restartRequired: false,
    });
  });

  it('config.yaml: check=true → source=config', async () => {
    const app = createUpdatesSettingsRoutes(auth, {
      settingsStore: fakeStore(),
      config: { check: true, channel: 'beta' },
      env: {},
    });
    const body = (await (await app.request('/updates')).json()) as Record<string, unknown>;
    expect(body.check).toBe(true);
    expect(body.source).toBe('config');
    expect(body.channel).toBe('beta');
  });

  it('env SYNTH_UPDATES_CHECK=true → source=env, envLocked', async () => {
    const app = createUpdatesSettingsRoutes(auth, {
      settingsStore: fakeStore(),
      env: { SYNTH_UPDATES_CHECK: 'true' },
    });
    const body = (await (await app.request('/updates')).json()) as Record<string, unknown>;
    expect(body.check).toBe(true);
    expect(body.source).toBe('env');
    expect(body.envLocked).toBe(true);
  });
});

describe('PUT/DELETE /settings/updates (ADR-133)', () => {
  it('PUT пишет runtime и отдаёт restartRequired:false', async () => {
    const store = fakeStore();
    const app = createUpdatesSettingsRoutes(auth, { settingsStore: store, env: {} });
    const res = await app.request('/updates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ check: true, source: 'runtime', restartRequired: false });
    expect(store._updates).toEqual({ check: true });
  });

  it('runtime приоритетнее config, но ниже env', async () => {
    const store = fakeStore();
    const app = createUpdatesSettingsRoutes(auth, {
      settingsStore: store,
      config: { check: false },
      env: {},
    });
    await app.request('/updates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: true }),
    });
    const body = (await (await app.request('/updates')).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ check: true, source: 'runtime' });
  });

  it('PUT при env → 409 CONFLICT', async () => {
    const store = fakeStore();
    const app = createUpdatesSettingsRoutes(auth, {
      settingsStore: store,
      env: { SYNTH_UPDATES_CHECK: 'false' },
    });
    const res = await app.request('/updates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: true }),
    });
    expect(res.status).toBe(409);
    expect(store._updates).toBeUndefined();
  });

  it('PUT с невалидным телом → 400', async () => {
    const app = createUpdatesSettingsRoutes(auth, { settingsStore: fakeStore(), env: {} });
    const res = await app.request('/updates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE сбрасывает runtime → source=default', async () => {
    const store = fakeStore();
    store._updates = { check: true };
    const app = createUpdatesSettingsRoutes(auth, { settingsStore: store, env: {} });
    const res = await app.request('/updates', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ check: false, source: 'default' });
    expect(store._updates).toBeUndefined();
  });
});
