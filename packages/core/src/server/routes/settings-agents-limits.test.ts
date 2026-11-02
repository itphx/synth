/**
 * Пределы саб-агентов — `/api/v2/settings/agents-limits`.
 *
 * Контракт: приоритет env > runtime > config > default(0), env-lock → 409,
 * `restartRequired:false`, сброс, живое применение, аудит `scope:'agents'`,
 * `0` отключает предохранитель, `-1`/дробное — 400.
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
  createLiveSubagentMaxInputTokens,
  type LiveSubagentMaxInputTokens,
} from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { createAgentsLimitsSettingsRoutes } from './settings-agents-limits.js';

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
  live: LiveSubagentMaxInputTokens;
  settingsStore: RuntimeSettingsStore;
} {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const live = createLiveSubagentMaxInputTokens({ config: options.config, env: options.env ?? {} });
  app.route('/api/v2/settings', createAgentsLimitsSettingsRoutes(
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

describe('createAgentsLimitsSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-agents-limits-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: config > default(0), runtime применяется сразу', async () => {
    const { app, live } = createApp({ dataDir, config: 150000 });
    const get = await json(await app.request('/api/v2/settings/agents-limits'));
    expect(get).toMatchObject({
      subagentMaxInputTokens: 150000,
      saved: null,
      defaults: 150000,
      source: 'config',
      envLocked: false,
      restartRequired: false,
    });

    const put = await json(await app.request('/api/v2/settings/agents-limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subagentMaxInputTokens: 0 }),
    }));
    expect(put).toMatchObject({ subagentMaxInputTokens: 0, saved: 0, source: 'runtime' });
    expect(live.getValue()).toBe(0);
  });

  it('DELETE возвращает к config/default', async () => {
    const { app } = createApp({ dataDir, config: 150000 });
    await app.request('/api/v2/settings/agents-limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subagentMaxInputTokens: 50000 }),
    });
    const res = await json(await app.request('/api/v2/settings/agents-limits', { method: 'DELETE' }));
    expect(res).toMatchObject({ subagentMaxInputTokens: 150000, saved: null, source: 'config' });
  });

  it('env фиксирует значение: другое → 409, envLocked=true', async () => {
    const { app } = createApp({
      dataDir,
      config: 150000,
      env: { SYNTH_AGENTS_SUBAGENT_MAX_INPUT_TOKENS: '90000' },
    });
    const before = await json(await app.request('/api/v2/settings/agents-limits'));
    expect(before).toMatchObject({ subagentMaxInputTokens: 90000, source: 'env', envLocked: true });

    const res = await app.request('/api/v2/settings/agents-limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subagentMaxInputTokens: 50000 }),
    });
    expect(res.status).toBe(409);
  });

  it('отрицательное/дробное значение → 400', async () => {
    const { app } = createApp({ dataDir });
    for (const value of [-1, 1.5]) {
      const res = await app.request('/api/v2/settings/agents-limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subagentMaxInputTokens: value }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('аудит изменений — scope agents', async () => {
    const audit = createAudit();
    const { app } = createApp({ dataDir, audit });
    await app.request('/api/v2/settings/agents-limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subagentMaxInputTokens: 50000 }),
    });
    expect(audit.entries.at(-1)).toMatchObject({ scope: 'agents', action: 'update', after: 50000 });
  });
});
