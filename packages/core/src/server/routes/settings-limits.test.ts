/**
 * Лимиты операций с сессиями — `/api/v2/settings/limits`.
 *
 * Контракт: приоритет env > runtime > config > default(10), env-lock → 409,
 * `restartRequired:false`, сброс, живое применение, аудит `scope:'limits'`,
 * `0` отключает лимит, `-1`/дробное — 400.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecurityAuditEntry } from '@itphx/synth-shared';
import { DEFAULT_SESSION_OPS_PER_MINUTE } from '@itphx/synth-shared/config';
import {
  RuntimeSettingsStore,
  createLiveSessionOpsPerMinute,
  type LiveSessionOpsPerMinute,
} from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { createRequestLimitsSettingsRoutes } from './settings-limits.js';

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

interface AppOptions {
  dataDir: string;
  config?: number;
  env?: NodeJS.ProcessEnv;
  audit?: SecurityAuditRepository;
}

function createApp(options: AppOptions): {
  app: Hono;
  live: LiveSessionOpsPerMinute;
  settingsStore: RuntimeSettingsStore;
} {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const live = createLiveSessionOpsPerMinute({ config: options.config, env: options.env ?? {} });
  app.route('/api/v2/settings', createRequestLimitsSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      config: options.config,
      live,
      env: options.env ?? {},
      ...(options.audit ? { securityAudit: options.audit } : {}),
    },
  ));
  return { app, live, settingsStore };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('createRequestLimitsSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-limits-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: default 10; config применяется; runtime — сразу', async () => {
    const { app: defaultApp } = createApp({ dataDir });
    const defaults = await json(await defaultApp.request('/api/v2/settings/limits'));
    expect(defaults).toMatchObject({
      sessionOpsPerMinute: 10,
      saved: null,
      defaults: 10,
      source: 'default',
      envLocked: false,
      restartRequired: false,
    });

    const { app, live } = createApp({ dataDir, config: 25 });
    const get = await json(await app.request('/api/v2/settings/limits'));
    expect(get).toMatchObject({
      sessionOpsPerMinute: 25,
      saved: null,
      defaults: 25,
      source: 'config',
    });

    const put = await json(await app.request('/api/v2/settings/limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionOpsPerMinute: 0 }),
    }));
    expect(put).toMatchObject({ sessionOpsPerMinute: 0, saved: 0, source: 'runtime' });
    expect(live.getValue()).toBe(0);
  });

  it('DELETE возвращает к config/default', async () => {
    const { app } = createApp({ dataDir, config: 25 });
    await app.request('/api/v2/settings/limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionOpsPerMinute: 50 }),
    });
    const res = await json(await app.request('/api/v2/settings/limits', { method: 'DELETE' }));
    expect(res).toMatchObject({ sessionOpsPerMinute: 25, saved: null, source: 'config' });
  });

  it('реальная сборка deps: config равен дефолту (10) → source:"default", после DELETE снова default', async () => {
    // `config.synth.limits.sessionOpsPerMinute` на чистом инстансе уже 10
    // (Zod `prefault`) — это не явная настройка, поэтому бейдж «по умолчанию».
    const { app, live } = createApp({
      dataDir,
      config: DEFAULT_SESSION_OPS_PER_MINUTE,
      env: {},
    });

    const before = await json(await app.request('/api/v2/settings/limits'));
    expect(before).toMatchObject({
      sessionOpsPerMinute: 10,
      saved: null,
      defaults: 10,
      source: 'default',
      envLocked: false,
      restartRequired: false,
    });

    await app.request('/api/v2/settings/limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionOpsPerMinute: 30 }),
    });
    expect(live.getValue()).toBe(30);

    const reset = await json(await app.request('/api/v2/settings/limits', { method: 'DELETE' }));
    expect(reset).toMatchObject({
      sessionOpsPerMinute: 10,
      saved: null,
      defaults: 10,
      source: 'default',
    });
  });

  it('env фиксирует значение: другое → 409, envLocked=true', async () => {
    const { app } = createApp({
      dataDir,
      config: 25,
      env: { SYNTH_LIMITS_SESSION_OPS_PER_MINUTE: '7' },
    });
    const before = await json(await app.request('/api/v2/settings/limits'));
    expect(before).toMatchObject({ sessionOpsPerMinute: 7, source: 'env', envLocked: true });

    const res = await app.request('/api/v2/settings/limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionOpsPerMinute: 50 }),
    });
    expect(res.status).toBe(409);
  });

  it('отрицательное/дробное/нечисловое значение → 400', async () => {
    const { app } = createApp({ dataDir });
    for (const value of [-1, 1.5, '10', null]) {
      const res = await app.request('/api/v2/settings/limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionOpsPerMinute: value }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('аудит изменений — scope limits', async () => {
    const audit = createAudit();
    const { app } = createApp({ dataDir, audit });
    await app.request('/api/v2/settings/limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionOpsPerMinute: 50 }),
    });
    expect(audit.entries.at(-1)).toMatchObject({ scope: 'limits', action: 'update', after: 50 });
  });

  it('ошибка аудита не ломает ответ', async () => {
    const audit: SecurityAuditRepository = {
      append: async () => { throw new Error('audit down'); },
      list: async () => [],
      clear: async () => 0,
    };
    const { app } = createApp({ dataDir, audit });
    const res = await app.request('/api/v2/settings/limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionOpsPerMinute: 50 }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ sessionOpsPerMinute: 50, source: 'runtime' });
  });
});
