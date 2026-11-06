/**
 * Режим инстанса для SSH-ключей (`ssh.mode`) — `/api/v2/settings/ssh`.
 *
 * Контракт: приоритет env > runtime > config > default(`tools`), env-lock →
 * 409, `restartRequired:false`, сброс к конфигу, 400 на невалидный режим,
 * живое применение (live-состояние), аудит `scope:'ssh'`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecurityAuditEntry, SshMode } from '@itphx/synth-shared';
import {
  RuntimeSettingsStore,
  createLiveSshMode,
  type LiveSshMode,
} from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { createSshSettingsRoutes } from './settings-ssh.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };

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
  config?: SshMode;
  env?: NodeJS.ProcessEnv;
  audit?: SecurityAuditRepository;
}

function createApp(options: AppOptions): {
  app: Hono;
  live: LiveSshMode;
  settingsStore: RuntimeSettingsStore;
} {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const live = createLiveSshMode({
    config: options.config,
    env: options.env ?? {},
  });
  app.route('/api/v2/settings', createSshSettingsRoutes(
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

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

async function put(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/v2/settings/ssh', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createSshSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-ssh-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: дефолт tools, источник default, без runtime', async () => {
    const { app } = createApp({ dataDir });
    const body = await json(await app.request('/api/v2/settings/ssh'));
    expect(body).toEqual({
      mode: 'tools',
      saved: null,
      defaults: 'tools',
      source: 'default',
      envLocked: false,
      restartRequired: false,
    });
  });

  it('config.yaml как база: источник config', async () => {
    const { app } = createApp({ dataDir, config: 'agent' });
    const body = await json(await app.request('/api/v2/settings/ssh'));
    expect(body.mode).toBe('agent');
    expect(body.defaults).toBe('agent');
    expect(body.source).toBe('config');
  });

  it('PUT: режим сохраняется и применяется сразу (live)', async () => {
    const { app, live } = createApp({ dataDir });
    const res = await put(app, { mode: 'agent' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.mode).toBe('agent');
    expect(body.saved).toBe('agent');
    expect(body.source).toBe('runtime');
    expect(body.restartRequired).toBe(false);
    expect(live.getMode()).toBe('agent');

    const after = await json(await app.request('/api/v2/settings/ssh'));
    expect(after.mode).toBe('agent');
  });

  it('DELETE: сброс runtime к конфигу', async () => {
    const { app } = createApp({ dataDir, config: 'agent' });
    await put(app, { mode: 'tools' });
    const body = await json(await app.request('/api/v2/settings/ssh', { method: 'DELETE' }));
    expect(body).toMatchObject({ mode: 'agent', saved: null, source: 'config' });
  });

  it('невалидный режим → 400 VALIDATION_ERROR', async () => {
    const { app } = createApp({ dataDir });
    for (const mode of ['xxx', '', 42, null]) {
      const res = await put(app, { mode });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('env фиксирует значение: другое → 409, envLocked=true', async () => {
    const { app } = createApp({ dataDir, env: { SYNTH_SSH_MODE: 'agent' } });
    const before = await json(await app.request('/api/v2/settings/ssh'));
    expect(before).toMatchObject({ mode: 'agent', source: 'env', envLocked: true });

    const res = await put(app, { mode: 'tools' });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe('CONFLICT');
  });

  it('env фиксирует значение: DELETE сбрасывает runtime, эффективное значение — env', async () => {
    // Поведение как у соседнего settings-роута (`agents-limits`): env-фиксация
    // блокирует только смену значения (PUT), сброс runtime-override допустим —
    // эффективный режим всё равно определяется env.
    const { app } = createApp({ dataDir, env: { SYNTH_SSH_MODE: 'agent' } });
    await put(app, { mode: 'agent' });
    const res = await app.request('/api/v2/settings/ssh', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ mode: 'agent', saved: null, source: 'env', envLocked: true });
  });

  it('аудит изменений — scope ssh', async () => {
    const audit = createAudit();
    const { app } = createApp({ dataDir, audit });
    await put(app, { mode: 'agent' });
    expect(audit.entries.at(-1)).toMatchObject({ scope: 'ssh', action: 'update', after: 'agent' });

    await app.request('/api/v2/settings/ssh', { method: 'DELETE' });
    expect(audit.entries.at(-1)).toMatchObject({ scope: 'ssh', action: 'reset', after: null });
  });
});
