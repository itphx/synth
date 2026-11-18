// ADR-133: тесты runtime-настроек автопроверки обновлений
// (`/api/v2/settings/updates`): источник, env-фиксация, приоритет, `lastCheck`
// и немедленная проверка при включении.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthKit } from '../../auth/local.js';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { UpdatesRuntimeSettings } from '../../storage/runtime-settings.js';

const { checkNow } = vi.hoisted(() => ({
  checkNow: vi.fn(async () => ({
    currentVersion: '0.19.0',
    latestVersion: '0.20.0',
    channel: 'stable' as const,
    prerelease: false,
    registry: 'https://registry.npmjs.org',
    hasUpdate: true,
    checkedAt: '2026-11-11T10:00:00.000Z',
  })),
}));

// Сеть не трогаем: немедленная проверка при `PUT {check:true}` — мок.
vi.mock('../../update-checker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../update-checker.js')>();
  return { ...actual, checkForUpdates: checkNow };
});

import { createUpdatesSettingsRoutes } from './settings-updates.js';

beforeEach(() => {
  checkNow.mockClear();
});

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
      lastCheck: null,
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

describe('lastCheck — время последней проверки (ADR-133)', () => {
  /** Каталог данных с записью кэша канала `stable`. */
  async function dataDirWithCache(ts: number): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'synth-settings-updates-'));
    await writeFile(
      join(dir, 'update-check.json'),
      JSON.stringify({
        version: 2,
        channels: {
          stable: {
            currentVersion: '0.19.0',
            latestVersion: '0.20.0',
            channel: 'stable',
            prerelease: false,
            registry: 'https://registry.npmjs.org',
            hasUpdate: true,
            checkedAt: '2026-11-11T10:00:00.000Z',
            _ts: ts,
          },
        },
      }),
      'utf-8',
    );
    return dir;
  }

  it('отдаёт запись кэша без учёта TTL (свежая — stale=false)', async () => {
    const dataDir = await dataDirWithCache(Date.now());
    const app = createUpdatesSettingsRoutes(auth, { settingsStore: fakeStore(), dataDir, env: {} });
    const body = (await (await app.request('/updates')).json()) as Record<string, unknown>;
    expect(body.lastCheck).toMatchObject({
      latestVersion: '0.20.0',
      hasUpdate: true,
      stale: false,
    });
  });

  it('устаревшая запись помечена stale=true', async () => {
    const dataDir = await dataDirWithCache(Date.now() - 25 * 60 * 60 * 1000);
    const app = createUpdatesSettingsRoutes(auth, { settingsStore: fakeStore(), dataDir, env: {} });
    const body = (await (await app.request('/updates')).json()) as Record<string, unknown>;
    expect((body.lastCheck as { stale: boolean }).stale).toBe(true);
  });

  it('нет кэша или нет dataDir — lastCheck=null', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'synth-settings-updates-'));
    const withDir = createUpdatesSettingsRoutes(auth, {
      settingsStore: fakeStore(),
      dataDir: empty,
      env: {},
    });
    expect(
      ((await (await withDir.request('/updates')).json()) as Record<string, unknown>).lastCheck,
    ).toBeNull();

    const withoutDir = createUpdatesSettingsRoutes(auth, { settingsStore: fakeStore(), env: {} });
    expect(
      ((await (await withoutDir.request('/updates')).json()) as Record<string, unknown>).lastCheck,
    ).toBeNull();
  });
});

describe('PUT /settings/updates — немедленная проверка (ADR-133)', () => {
  it('включение автопроверки запускает фоновую проверку сразу', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'synth-settings-updates-'));
    const app = createUpdatesSettingsRoutes(auth, { settingsStore: fakeStore(), dataDir, env: {} });
    const res = await app.request('/updates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: true }),
    });
    expect(res.status).toBe(200);
    expect(checkNow).toHaveBeenCalledTimes(1);
    const [dir, opts] = checkNow.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(dir).toBe(dataDir);
    expect(opts).toMatchObject({ force: true, background: true });
    expect((opts.updates as Record<string, unknown>).check).toBe(true);
  });

  it('выключение проверку не запускает; без dataDir — тоже', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'synth-settings-updates-'));
    const withDir = createUpdatesSettingsRoutes(auth, {
      settingsStore: fakeStore(),
      dataDir,
      env: {},
    });
    await withDir.request('/updates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: false }),
    });
    expect(checkNow).not.toHaveBeenCalled();

    const withoutDir = createUpdatesSettingsRoutes(auth, { settingsStore: fakeStore(), env: {} });
    await withoutDir.request('/updates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: true }),
    });
    expect(checkNow).not.toHaveBeenCalled();
  });

  it('ошибка проверки не ломает ответ PUT', async () => {
    checkNow.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const dataDir = await mkdtemp(join(tmpdir(), 'synth-settings-updates-'));
    const app = createUpdatesSettingsRoutes(auth, { settingsStore: fakeStore(), dataDir, env: {} });
    const res = await app.request('/updates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: true }),
    });
    expect(res.status).toBe(200);
    // Дать промису отклониться — необработанного отказа быть не должно.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
