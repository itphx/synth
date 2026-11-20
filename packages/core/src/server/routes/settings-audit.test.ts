/**
 * Настройки журнала решений по подтверждениям прав (`scope:'permission'`) —
 * `/api/v2/settings/audit`.
 *
 * Контракт: приоритет env > runtime > дефолт (слоя `config` нет), env-фиксация
 * по полю → 409 `ENV_LOCKED` (ни одно поле запроса не применяется), 400 на
 * неизвестный ключ/тип/границы, частичный патч, живое применение (`refresh()`
 * + retention-прогон журнала, `prune` best-effort), сброс runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeSettingsStore,
  createLiveAuditSettings,
  type LiveAuditSettings,
} from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { createAuditSettingsRoutes } from './settings-audit.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };

/** Фейк журнала security-аудита: считает вызовы `prune` (и умеет падать). */
function createAuditRepo(options: { fail?: boolean } = {}): {
  repo: SecurityAuditRepository;
  pruneCalls: number[];
} {
  const pruneCalls: number[] = [];
  const repo: SecurityAuditRepository = {
    append: async () => {},
    list: async () => [],
    clear: async () => 0,
    prune: async (days: number) => {
      pruneCalls.push(days);
      if (options.fail === true) throw new Error('хранилище недоступно');
      return 0;
    },
  };
  return { repo, pruneCalls };
}

function createApp(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  securityAudit?: SecurityAuditRepository;
}): {
  app: Hono;
  live: LiveAuditSettings;
  settingsStore: RuntimeSettingsStore;
} {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const env = options.env ?? {};
  const live = createLiveAuditSettings({ store: settingsStore, env });
  app.route('/api/v2/settings', createAuditSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      live,
      env,
      ...(options.securityAudit ? { securityAudit: options.securityAudit } : {}),
    },
  ));
  return { app, live, settingsStore };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function put(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/v2/settings/audit', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createAuditSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-audit-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: дефолты (decisions / 30 дней), source=default, env не зафиксирован', async () => {
    const { app } = createApp({ dataDir });
    expect(await json(await app.request('/api/v2/settings/audit'))).toEqual({
      permission: { mode: 'decisions', retentionDays: 30 },
      source: 'default',
      sources: { mode: 'default', retentionDays: 'default' },
      defaults: { mode: 'decisions', retentionDays: 30 },
      envLocked: false,
      envLockedFields: [],
    });
  });

  it('PUT меняет mode и retentionDays и переживает повторный GET', async () => {
    const { app, live, settingsStore } = createApp({ dataDir });

    const view = await json(await put(app, { permission: { mode: 'all' } }));
    expect(view).toEqual({
      permission: { mode: 'all', retentionDays: 30 },
      source: 'runtime',
      sources: { mode: 'runtime', retentionDays: 'default' },
      defaults: { mode: 'decisions', retentionDays: 30 },
      envLocked: false,
      envLockedFields: [],
    });
    // Живое состояние (его читает шов журнала) обновилось сразу.
    expect(live.getMode()).toBe('all');

    const second = await json(await put(app, { permission: { retentionDays: 7 } }));
    // Патч частичный: ранее заданный mode сохранился.
    expect(second).toMatchObject({
      permission: { mode: 'all', retentionDays: 7 },
      source: 'runtime',
    });
    expect((second.sources as Record<string, string>).retentionDays).toBe('runtime');
    expect(live.getRetentionDays()).toBe(7);

    expect(await json(await app.request('/api/v2/settings/audit'))).toMatchObject({
      permission: { mode: 'all', retentionDays: 7 },
      source: 'runtime',
    });
    expect(await settingsStore.getAudit()).toEqual({
      permission: { mode: 'all', retentionDays: 7 },
    });
  });

  it('400: неизвестный ключ, неверный тип, вне границ, пустой патч', async () => {
    const { app, settingsStore } = createApp({ dataDir });
    const bodies: unknown[] = [
      {},
      { permission: {} },
      { permission: 'all' },
      { permission: { mode: 'every' } },
      { permission: { mode: 42 } },
      { permission: { retentionDays: 0 } },
      { permission: { retentionDays: 3651 } },
      { permission: { retentionDays: 1.5 } },
      { permission: { retentionDays: null } },
      { permission: { retentionDays: '30' } },
      { permission: { retentionDay: 30 } },
      { permission: { mode: 'all', retentionDays: 0 } },
      // Поля секции живут только в `permission` (плоский патч — ошибка).
      { mode: 'all' },
    ];
    for (const body of bodies) {
      const res = await put(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const payload = await json(res);
      expect((payload.error as Record<string, unknown>).code).toBe('VALIDATION_ERROR');
    }
    // Ни один невалидный запрос не записал runtime-секцию.
    expect(await settingsStore.getAudit()).toEqual({});
  });

  it('409 ENV_LOCKED: зафиксированный env mode не применяется, а retentionDays — отдельно', async () => {
    const { app, settingsStore } = createApp({
      dataDir,
      env: { SYNTH_AUDIT_PERMISSION_MODE: 'all' },
    });

    const before = await json(await app.request('/api/v2/settings/audit'));
    expect(before).toMatchObject({
      permission: { mode: 'all' },
      source: 'env',
      envLocked: true,
      envLockedFields: ['mode'],
    });

    const locked = await put(app, { permission: { mode: 'decisions', retentionDays: 10 } });
    expect(locked.status).toBe(409);
    expect(await json(locked)).toMatchObject({
      error: { code: 'ENV_LOCKED', fields: ['mode'] },
    });
    // Ни одно поле запроса не применилось (даже незафиксированное).
    expect(await settingsStore.getAudit()).toEqual({});

    // Env-фиксация — по полю: правка retentionDays проходит.
    const allowed = await put(app, { permission: { retentionDays: 10 } });
    expect(allowed.status).toBe(200);
    expect(await json(allowed)).toMatchObject({
      permission: { mode: 'all', retentionDays: 10 },
      source: 'env',
    });
  });

  it('DELETE сбрасывает runtime к env/дефолту', async () => {
    const { app, live, settingsStore } = createApp({ dataDir });
    await put(app, { permission: { mode: 'all', retentionDays: 5 } });
    expect(live.getMode()).toBe('all');
    expect(await settingsStore.getAudit()).toEqual({
      permission: { mode: 'all', retentionDays: 5 },
    });

    const reset = await json(
      await app.request('/api/v2/settings/audit', { method: 'DELETE' }),
    );
    expect(reset).toEqual({
      permission: { mode: 'decisions', retentionDays: 30 },
      source: 'default',
      sources: { mode: 'default', retentionDays: 'default' },
      defaults: { mode: 'decisions', retentionDays: 30 },
      envLocked: false,
      envLockedFields: [],
    });
    expect(live.getMode()).toBe('decisions');
    expect(live.getRetentionDays()).toBe(30);
    expect(await settingsStore.getAudit()).toEqual({});
  });

  it('границы retentionDays (1 и 3650) принимаются', async () => {
    const { app } = createApp({ dataDir });
    for (const days of [1, 3650]) {
      const res = await put(app, { permission: { retentionDays: days } });
      expect(res.status, String(days)).toBe(200);
      expect(await json(res)).toMatchObject({ permission: { retentionDays: days } });
    }
  });

  it('без живого состояния retention берётся из записанного снимка', async () => {
    const { repo, pruneCalls } = createAuditRepo();
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir });
    app.route('/api/v2/settings', createAuditSettingsRoutes(
      { requireAuth },
      { settingsStore, securityAudit: repo, env: {} },
    ));

    const res = await put(app, { permission: { retentionDays: 9 } });
    expect(res.status).toBe(200);
    expect(pruneCalls).toEqual([9]);
  });

  it('PUT прогоняет retention журнала с эффективным сроком хранения', async () => {
    const { repo, pruneCalls } = createAuditRepo();
    const { app } = createApp({ dataDir, securityAudit: repo });

    await put(app, { permission: { retentionDays: 5 } });
    expect(pruneCalls).toEqual([5]);

    // Смена только mode — прогон идёт с уже сохранённым retention.
    await put(app, { permission: { mode: 'all' } });
    expect(pruneCalls).toEqual([5, 5]);
  });

  it('ошибка prune не ломает PUT (best-effort)', async () => {
    const { repo, pruneCalls } = createAuditRepo({ fail: true });
    const { app, settingsStore } = createApp({ dataDir, securityAudit: repo });

    const res = await put(app, { permission: { retentionDays: 3 } });
    expect(res.status).toBe(200);
    expect(pruneCalls).toEqual([3]);
    expect(await settingsStore.getAudit()).toEqual({ permission: { retentionDays: 3 } });
  });
});
