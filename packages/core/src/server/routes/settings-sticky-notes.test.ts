/**
 * Лимиты заметок сессии (`context.stickyNotes`) —
 * `/api/v2/settings/sticky-notes`.
 *
 * Контракт: приоритет runtime > config > default, частичный PUT (merge),
 * 400 на невалидные значения/неизвестные ключи, `restartRequired:false`,
 * сброс, немедленное применение (live-состояние), аудит `scope:'sticky-notes'`
 * и guard'ы.
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
  createLiveStickyNotesLimits,
  type LiveStickyNotesLimits,
} from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { createStickyNotesSettingsRoutes } from './settings-sticky-notes.js';

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
  config?: { maxCount?: number; maxChars?: number };
  audit?: SecurityAuditRepository;
  writeGuard?: (c: Context, next: Next) => Promise<Response | void>;
  readGuard?: (c: Context, next: Next) => Promise<Response | void>;
}

function createApp(options: AppOptions): {
  app: Hono;
  live: LiveStickyNotesLimits;
  settingsStore: RuntimeSettingsStore;
} {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const live = createLiveStickyNotesLimits({ config: options.config });
  app.route('/api/v2/settings', createStickyNotesSettingsRoutes(
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
  return app.request('/api/v2/settings/sticky-notes', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createStickyNotesSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-sticky-notes-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: дефолты схемы, источник default, без runtime', async () => {
    const { app } = createApp({ dataDir });
    const body = await json(await app.request('/api/v2/settings/sticky-notes'));
    expect(body).toEqual({
      limits: { maxCount: 50, maxChars: 2000 },
      saved: null,
      defaults: { maxCount: 50, maxChars: 2000 },
      source: 'default',
      restartRequired: false,
    });
  });

  it('config.yaml как база: источник config, defaults = config', async () => {
    const { app } = createApp({ dataDir, config: { maxCount: 10 } });
    const body = await json(await app.request('/api/v2/settings/sticky-notes'));
    expect(body.limits).toEqual({ maxCount: 10, maxChars: 2000 });
    expect(body.defaults).toEqual({ maxCount: 10, maxChars: 2000 });
    expect(body.source).toBe('config');
  });

  it('PUT: частичный патч мёржится поверх базы и применяется сразу (live)', async () => {
    const { app, live } = createApp({ dataDir, config: { maxCount: 10 } });
    const res = await put(app, { limits: { maxChars: 400 } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.limits).toEqual({ maxCount: 10, maxChars: 400 });
    expect(body.saved).toEqual({ maxChars: 400 });
    expect(body.source).toBe('runtime');
    // Live-состояние обновилось — следующие операции с заметкой видят лимит.
    expect(live.getLimits()).toEqual({ maxCount: 10, maxChars: 400 });
  });

  it('PUT: повторный патч мёржится с сохранённым runtime-значением', async () => {
    const { app } = createApp({ dataDir });
    await put(app, { limits: { maxCount: 5 } });
    const body = await json(await put(app, { limits: { maxChars: 100 } }));
    expect(body.limits).toEqual({ maxCount: 5, maxChars: 100 });
    expect(body.saved).toEqual({ maxCount: 5, maxChars: 100 });
  });

  it('PUT: невалидные значения и неизвестные ключи → 400 VALIDATION_ERROR', async () => {
    const { app, settingsStore } = createApp({ dataDir });

    for (const limits of [
      { maxCount: 0 },
      { maxCount: 1001 },
      { maxChars: 0 },
      { maxChars: 100001 },
      { maxCount: 1.5 },
      { maxCount: '10' },
      { unknown: 1 },
      null,
      [],
    ]) {
      const res = await put(app, { limits });
      expect(res.status, JSON.stringify(limits)).toBe(400);
      const body = await json(res);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(typeof body.error.message).toBe('string');
    }
    // Ничего не сохранено.
    expect(await settingsStore.getStickyNotesLimits()).toBeUndefined();
  });

  it('PUT: границы включительно (1 и 1000 / 1 и 100000)', async () => {
    const { app } = createApp({ dataDir });
    const res = await put(app, { limits: { maxCount: 1000, maxChars: 100000 } });
    expect(res.status).toBe(200);
    expect((await json(res)).limits).toEqual({ maxCount: 1000, maxChars: 100000 });
  });

  it('DELETE: сброс runtime к config/default, live очищается', async () => {
    const { app, live, settingsStore } = createApp({ dataDir, config: { maxCount: 10 } });
    await put(app, { limits: { maxCount: 1, maxChars: 50 } });

    const res = await app.request('/api/v2/settings/sticky-notes', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({
      limits: { maxCount: 10, maxChars: 2000 },
      saved: null,
      defaults: { maxCount: 10, maxChars: 2000 },
      source: 'config',
      restartRequired: false,
    });
    expect(await settingsStore.getStickyNotesLimits()).toBeUndefined();
    expect(live.getRuntime()).toBeUndefined();
    expect(live.getLimits()).toEqual({ maxCount: 10, maxChars: 2000 });
  });

  it('аудит: scope sticky-notes, action update/reset', async () => {
    const audit = createAudit();
    const { app } = createApp({ dataDir, audit });
    await put(app, { limits: { maxChars: 300 } });
    await app.request('/api/v2/settings/sticky-notes', { method: 'DELETE' });

    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[0]).toMatchObject({
      scope: 'sticky-notes',
      action: 'update',
      before: { maxCount: 50, maxChars: 2000 },
      after: { maxCount: 50, maxChars: 300 },
    });
    expect(audit.entries[1]).toMatchObject({
      scope: 'sticky-notes',
      action: 'reset',
      before: { maxCount: 50, maxChars: 300 },
      after: null,
    });
  });

  it("guard'ы: чтение и запись разделены", async () => {
    const { app } = createApp({ dataDir, readGuard: deny, writeGuard: deny });
    expect((await app.request('/api/v2/settings/sticky-notes')).status).toBe(403);
    expect((await put(app, { limits: { maxCount: 1 } })).status).toBe(403);
    expect((await app.request('/api/v2/settings/sticky-notes', { method: 'DELETE' })).status).toBe(403);
  });
});
