/**
 * Дефолты оптимизации контекста новых сессий —
 * `/api/v2/settings/context-defaults`.
 *
 * Контракт: приоритет runtime > config > default, частичный PUT (merge),
 * 400 на невалидные значения/неизвестные ключи, `restartRequired:false`,
 * сброс, немедленное применение в `SessionManager`, аудит
 * `scope:'context-defaults'` и guard'ы.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecurityAuditEntry } from '@itphx/synth-shared';
import { RuntimeSettingsStore, createLiveContextDefaults, type LiveContextDefaults } from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { createContextDefaultsSettingsRoutes } from './settings-context-defaults.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };
const deny = async (c: Context) => c.json({ error: { code: 'FORBIDDEN', message: 'deny' } }, 403);

/** Аудит в памяти: пишем записи, читаем для проверки scope/action. */
function createAudit(): SecurityAuditRepository & { entries: SecurityAuditEntry[] } {
  const entries: SecurityAuditEntry[] = [];
  return {
    entries,
    append: async (entry) => {
      entries.push(entry);
    },
    list: async () => [...entries].reverse(),
    clear: async () => {
      const count = entries.length;
      entries.length = 0;
      return count;
    },
  };
}

interface AppOptions {
  dataDir: string;
  config?: { slidingWindowMessageLimit?: number; contextOptimization?: 'none' | 'sliding_window' };
  audit?: SecurityAuditRepository;
  writeGuard?: (c: Context, next: Next) => Promise<Response | void>;
  readGuard?: (c: Context, next: Next) => Promise<Response | void>;
}

function createApp(options: AppOptions): {
  app: Hono;
  live: LiveContextDefaults;
  settingsStore: RuntimeSettingsStore;
} {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const live = createLiveContextDefaults({ config: options.config });
  app.route('/api/v2/settings', createContextDefaultsSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      config: options.config,
      live,
      ...(options.audit ? { securityAudit: options.audit } : {}),
    },
    {
      ...(options.readGuard ? { readGuard: options.readGuard as never } : {}),
      ...(options.writeGuard ? { writeGuard: options.writeGuard as never } : {}),
    },
  ));
  return { app, live, settingsStore };
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

async function put(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/v2/settings/context-defaults', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const DEFAULTS = {
  contextOptimization: 'compaction',
  summarizationEnabled: true,
  summarizationTriggerMode: 'messages',
  summarizeAfterN: 10,
  summarizeTokenThreshold: 50,
  summarizationHeadMessages: 2,
  summarizationTailMessages: 3,
  summarizationKeepTokens: 5000,
  compactionKeepTokens: 15000,
  compactionTokenThreshold: 85,
  slidingWindowMode: 'messages',
  slidingWindowMessageLimit: 10,
  slidingWindowTokenThreshold: 80,
} as const;

describe('createContextDefaultsSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-context-defaults-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: дефолты схемы, источник default, без runtime', async () => {
    const { app } = createApp({ dataDir });
    const body = await json(await app.request('/api/v2/settings/context-defaults'));
    expect(body).toEqual({
      defaults: DEFAULTS,
      saved: null,
      defaultsSource: 'default',
      source: 'default',
      restartRequired: false,
    });
  });

  it('GET: config задаёт базу и источник config', async () => {
    const { app } = createApp({
      dataDir,
      config: { contextOptimization: 'sliding_window', slidingWindowMessageLimit: 20 },
    });
    const body = await json(await app.request('/api/v2/settings/context-defaults'));
    expect(body.defaults.contextOptimization).toBe('sliding_window');
    expect(body.defaults.slidingWindowMessageLimit).toBe(20);
    expect(body.defaults.summarizeAfterN).toBe(10);
    expect(body.defaultsSource).toBe('config');
    expect(body.source).toBe('config');
  });

  it('PUT: частичный патч мёржится поверх config и применяется сразу (live)', async () => {
    const { app, live, settingsStore } = createApp({
      dataDir,
      config: { slidingWindowMessageLimit: 20 },
    });

    const res = await put(app, { defaults: { contextOptimization: 'summarization', summarizeAfterN: 4 } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.defaults.contextOptimization).toBe('summarization');
    expect(body.defaults.summarizeAfterN).toBe(4);
    // config-значение не потеряно.
    expect(body.defaults.slidingWindowMessageLimit).toBe(20);
    expect(body.saved).toEqual({ contextOptimization: 'summarization', summarizeAfterN: 4 });
    expect(body.source).toBe('runtime');
    expect(body.defaultsSource).toBe('config');
    expect(body.restartRequired).toBe(false);

    expect(live.getDefaults().contextOptimization).toBe('summarization');
    expect(await settingsStore.getContextDefaults()).toEqual({
      contextOptimization: 'summarization',
      summarizeAfterN: 4,
    });
  });

  it('PUT: невалидные значения/неизвестные ключи → 400 VALIDATION_ERROR', async () => {
    const { app } = createApp({ dataDir });
    const cases: unknown[] = [
      { defaults: { summarizeAfterN: 0 } },
      { defaults: { summarizeTokenThreshold: 101 } },
      { defaults: { slidingWindowMessageLimit: 0 } },
      { defaults: { contextOptimization: 'unknown' } },
      { defaults: { unknownKey: 1 } },
      { defaults: 'nope' },
      {},
    ];
    for (const body of cases) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }
    // Пустое тело — тоже 400.
    const empty = await app.request('/api/v2/settings/context-defaults', { method: 'PUT' });
    expect(empty.status).toBe(400);
  });

  it('DELETE: сброс runtime к config/default', async () => {
    const { app, live } = createApp({
      dataDir,
      config: { slidingWindowMessageLimit: 20 },
    });
    await put(app, { defaults: { summarizeAfterN: 3 } });
    expect(live.getDefaults().summarizeAfterN).toBe(3);

    const res = await app.request('/api/v2/settings/context-defaults', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.defaults.summarizeAfterN).toBe(10);
    expect(body.defaults.slidingWindowMessageLimit).toBe(20);
    expect(body.saved).toBeNull();
    expect(body.source).toBe('config');
    expect(live.getDefaults().summarizeAfterN).toBe(10);
  });

  it('live-эффект: SessionManager применяет дефолты к новым сессиям без рестарта', async () => {
    const { app, live } = createApp({ dataDir });
    const store = new FileStore({ dataDir });
    const manager = new SessionManager(store, { contextDefaults: () => live.getDefaults() });

    const before = await manager.createSession({});
    expect(before.settings.contextOptimization).toBe('compaction');
    expect(before.settings.summarizeAfterN).toBe(10);

    await put(app, { defaults: { contextOptimization: 'summarization', summarizeAfterN: 4 } });

    const after = await manager.createSession({});
    expect(after.settings.contextOptimization).toBe('summarization');
    expect(after.settings.summarizeAfterN).toBe(4);

    // Явные настройки запроса приоритетнее дефолтов инстанса.
    const explicit = await manager.createSession({
      settings: { contextOptimization: 'sliding_window', summarizeAfterN: 2 },
    });
    expect(explicit.settings.contextOptimization).toBe('sliding_window');
    expect(explicit.settings.summarizeAfterN).toBe(2);

    // Существующая сессия не изменилась.
    const reloaded = await manager.getSession(before.id);
    expect(reloaded!.settings.contextOptimization).toBe('compaction');
  });

  it('аудит: update и reset пишут scope context-defaults', async () => {
    const audit = createAudit();
    const { app } = createApp({ dataDir, audit });

    await put(app, { defaults: { summarizeAfterN: 4 } });
    await app.request('/api/v2/settings/context-defaults', { method: 'DELETE' });

    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[0]).toMatchObject({
      scope: 'context-defaults',
      action: 'update',
      source: 'runtime',
      before: DEFAULTS,
    });
    expect((audit.entries[0]!.after as Record<string, unknown>).summarizeAfterN).toBe(4);
    expect(audit.entries[1]).toMatchObject({
      scope: 'context-defaults',
      action: 'reset',
      after: null,
    });
  });

  it('guard-ы: чтение под readGuard, мутации под writeGuard', async () => {
    const { app } = createApp({ dataDir, readGuard: deny, writeGuard: deny });
    expect((await app.request('/api/v2/settings/context-defaults')).status).toBe(403);
    expect((await put(app, { defaults: { summarizeAfterN: 4 } })).status).toBe(403);
    expect((await app.request('/api/v2/settings/context-defaults', { method: 'DELETE' })).status).toBe(403);
  });
});
