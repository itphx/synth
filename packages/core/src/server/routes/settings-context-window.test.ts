/**
 * Политика ограничения контекстного окна — `/api/v2/settings/context-window`.
 *
 * Проверяем контракт: приоритет источников (env > runtime > config > default),
 * `envLocked` (409 на другое значение), `restartRequired:false`, сброс,
 * применение в живом резолвере без рестарта, аудит `scope:'context-window'`
 * и guard'ы.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecurityAuditEntry } from '@itphx/synth-shared';
import { RuntimeSettingsStore, createLiveContextWindowPolicy, type LiveContextWindowPolicy } from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { createContextWindowSettingsRoutes } from './settings-context-window.js';

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
  config?: 'off' | 'warn' | 'enforce';
  env?: NodeJS.ProcessEnv;
  audit?: SecurityAuditRepository;
  writeGuard?: (c: Context, next: Next) => Promise<Response | void>;
  readGuard?: (c: Context, next: Next) => Promise<Response | void>;
}

function createApp(options: AppOptions): {
  app: Hono;
  live: LiveContextWindowPolicy;
  settingsStore: RuntimeSettingsStore;
} {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const live = createLiveContextWindowPolicy({ config: options.config, env: options.env ?? {} });
  app.route('/api/v2/settings', createContextWindowSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      config: options.config,
      live,
      env: options.env ?? {},
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
  return app.request('/api/v2/settings/context-window', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createContextWindowSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-context-window-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: дефолт схемы (warn), источник default, без envLocked', async () => {
    const { app } = createApp({ dataDir });
    const body = await json(await app.request('/api/v2/settings/context-window'));
    expect(body).toEqual({
      policy: 'warn',
      saved: null,
      defaults: 'warn',
      source: 'default',
      envLocked: false,
      restartRequired: false,
    });
  });

  it('GET: config.yaml задаёт base и источник config', async () => {
    const { app } = createApp({ dataDir, config: 'off' });
    const body = await json(await app.request('/api/v2/settings/context-window'));
    expect(body.policy).toBe('off');
    expect(body.defaults).toBe('off');
    expect(body.source).toBe('config');
  });

  it('PUT: валидное значение → runtime, применяется сразу (live)', async () => {
    const { app, live, settingsStore } = createApp({ dataDir, config: 'warn' });

    const res = await put(app, { policy: 'enforce' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.policy).toBe('enforce');
    expect(body.saved).toBe('enforce');
    expect(body.defaults).toBe('warn');
    expect(body.source).toBe('runtime');
    expect(body.restartRequired).toBe(false);

    expect(live.getPolicy()).toBe('enforce');
    expect(await settingsStore.getContextWindowPolicy()).toBe('enforce');
  });

  it('PUT: невалидное значение → 400 VALIDATION_ERROR', async () => {
    const { app } = createApp({ dataDir });
    for (const policy of ['strict', '', null, 42]) {
      const res = await put(app, { policy });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }
    // Пустое тело — тоже 400.
    const empty = await app.request('/api/v2/settings/context-window', { method: 'PUT' });
    expect(empty.status).toBe(400);
  });

  it('DELETE: сброс runtime к config/default', async () => {
    const { app, live } = createApp({ dataDir, config: 'off' });
    await put(app, { policy: 'enforce' });
    expect(live.getPolicy()).toBe('enforce');

    const res = await app.request('/api/v2/settings/context-window', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.policy).toBe('off');
    expect(body.saved).toBeNull();
    expect(body.source).toBe('config');
    expect(live.getPolicy()).toBe('off');
  });

  it('envLocked: env приоритетнее runtime, другое значение → 409 CONFLICT', async () => {
    const env = { SYNTH_CONTEXT_WINDOW_POLICY: 'off' };
    const { app, live } = createApp({ dataDir, config: 'warn', env });

    const view = await json(await app.request('/api/v2/settings/context-window'));
    expect(view.policy).toBe('off');
    expect(view.source).toBe('env');
    expect(view.envLocked).toBe(true);

    const conflict = await put(app, { policy: 'enforce' });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe('CONFLICT');
    expect(live.getPolicy()).toBe('off');

    // То же значение, что в env, — не конфликт (идемпотентно).
    const same = await put(app, { policy: 'off' });
    expect(same.status).toBe(200);
    expect((await json(same)).policy).toBe('off');
  });

  it('аудит: update и reset пишут scope context-window', async () => {
    const audit = createAudit();
    const { app } = createApp({ dataDir, audit });

    await put(app, { policy: 'enforce' });
    await app.request('/api/v2/settings/context-window', { method: 'DELETE' });

    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[0]).toMatchObject({
      scope: 'context-window',
      action: 'update',
      source: 'runtime',
      before: 'warn',
      after: 'enforce',
    });
    expect(audit.entries[1]).toMatchObject({
      scope: 'context-window',
      action: 'reset',
      after: null,
    });
  });

  it('guard-ы: чтение под readGuard, мутации под writeGuard', async () => {
    const { app } = createApp({ dataDir, readGuard: deny, writeGuard: deny });
    expect((await app.request('/api/v2/settings/context-window')).status).toBe(403);
    expect((await put(app, { policy: 'off' })).status).toBe(403);
    expect((await app.request('/api/v2/settings/context-window', { method: 'DELETE' })).status).toBe(403);
  });
});
