/**
 * Настройки секции `background` (реестр фоновых прогонов) —
 * `/api/v2/settings/background`.
 *
 * Контракт: приоритет env > runtime > config > default, env-фиксация по полю →
 * 409 `ENV_LOCKED` (ни одно поле не применяется), 400 на неизвестный ключ/
 * тип/границы, `restartRequired:false`, сброс, живое применение, аудит
 * `scope:'background'`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecurityAuditEntry } from '@itphx/synth-shared';
import {
  RuntimeSettingsStore,
  createLiveBackgroundSettings,
  type LiveBackgroundSettings,
} from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { createBackgroundSettingsRoutes } from './settings-background.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };

function createAudit(): SecurityAuditRepository & { entries: SecurityAuditEntry[] } {
  const entries: SecurityAuditEntry[] = [];
  return {
    entries,
    append: async (entry) => { entries.push(entry); },
    list: async () => [...entries].reverse(),
    clear: async () => { const n = entries.length; entries.length = 0; return n; },
  };
}

function createApp(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  config?: { maxRunsPerSession?: number };
  audit?: SecurityAuditRepository;
}): { app: Hono; live: LiveBackgroundSettings; settingsStore: RuntimeSettingsStore } {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const env = options.env ?? {};
  const live = createLiveBackgroundSettings({ config: options.config, env });
  app.route('/api/v2/settings', createBackgroundSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      ...(options.config ? { config: options.config } : {}),
      live,
      env,
      ...(options.audit ? { securityAudit: options.audit } : {}),
    },
  ));
  return { app, live, settingsStore };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function put(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/v2/settings/background', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createBackgroundSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-background-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: дефолты схемы, saved=null, restartRequired=false', async () => {
    const { app } = createApp({ dataDir });
    expect(await json(await app.request('/api/v2/settings/background'))).toMatchObject({
      enabled: true,
      maxSubagentsPerSession: 2,
      maxProcessesPerSession: 5,
      maxRunsPerSession: 10,
      logMaxBytes: 10_485_760,
      retentionDays: 7,
      saved: null,
      source: 'default',
      envLocked: false,
      envLockedFields: [],
      restartRequired: false,
    });
  });

  it('PUT — частичный патч: незаданные поля сохраняются, живое состояние обновляется', async () => {
    const { app, live, settingsStore } = createApp({ dataDir });
    const view = await json(await put(app, { maxRunsPerSession: 3 }));
    expect(view).toMatchObject({
      maxRunsPerSession: 3,
      maxSubagentsPerSession: 2,
      saved: { maxRunsPerSession: 3 },
      source: 'runtime',
    });
    expect((view.sources as Record<string, string>).maxRunsPerSession).toBe('runtime');
    expect(live.getLimits().maxRunsPerSession).toBe(3);

    const second = await json(await put(app, { retentionDays: 0 }));
    expect(second).toMatchObject({
      maxRunsPerSession: 3,
      retentionDays: 0,
      saved: { maxRunsPerSession: 3, retentionDays: 0 },
    });
    expect(await settingsStore.getBackground()).toEqual({
      maxRunsPerSession: 3,
      retentionDays: 0,
    });
  });

  it('400: неизвестный ключ / тип / границы', async () => {
    const { app } = createApp({ dataDir });
    const bodies: unknown[] = [
      { maxRunsPerSessoin: 1 },
      { enabled: 'true' },
      { maxRunsPerSession: -1 },
      { maxRunsPerSession: 1.5 },
      { logMaxBytes: '10' },
      { retentionDays: 1.5 },
      {},
    ];
    for (const body of bodies) {
      const res = await put(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('409 ENV_LOCKED: поле не применяется, остальные поля запроса тоже', async () => {
    const { app, settingsStore } = createApp({
      dataDir,
      env: { SYNTH_BACKGROUND_ENABLED: 'false' },
    });
    const before = await json(await app.request('/api/v2/settings/background'));
    expect(before).toMatchObject({ enabled: false, source: 'env', envLocked: true });
    expect(before.envLockedFields).toEqual(['enabled']);

    const res = await put(app, { enabled: true, maxRunsPerSession: 1 });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body).toMatchObject({
      error: { code: 'ENV_LOCKED', fields: ['enabled'] },
    });
    // Ни одно поле запроса не применилось.
    expect(await settingsStore.getBackground()).toEqual({});
  });

  it('DELETE сбрасывает runtime всех полей', async () => {
    const { app, live } = createApp({ dataDir });
    await put(app, { maxRunsPerSession: 1, logMaxBytes: 0 });
    expect(live.getMaxLogBytes()).toBe(0);

    const reset = await json(await app.request('/api/v2/settings/background', { method: 'DELETE' }));
    expect(reset).toMatchObject({
      maxRunsPerSession: 10,
      logMaxBytes: 10_485_760,
      saved: null,
      source: 'default',
    });
    expect(live.getMaxLogBytes()).toBe(10_485_760);
  });

  it('аудит изменений — scope background', async () => {
    const audit = createAudit();
    const { app } = createApp({ dataDir, audit });
    await put(app, { maxRunsPerSession: 2 });
    expect(audit.entries.at(-1)).toMatchObject({
      scope: 'background',
      action: 'update',
      after: { maxRunsPerSession: 2 },
    });
    await app.request('/api/v2/settings/background', { method: 'DELETE' });
    expect(audit.entries.at(-1)).toMatchObject({ scope: 'background', action: 'reset' });
  });

  it('config-слой: значение из config.yaml отдаётся с source:"config"', async () => {
    const { app } = createApp({ dataDir, config: { maxRunsPerSession: 4 } });
    expect(await json(await app.request('/api/v2/settings/background'))).toMatchObject({
      maxRunsPerSession: 4,
      source: 'config',
      defaults: { maxRunsPerSession: 4 },
    });
  });
});
