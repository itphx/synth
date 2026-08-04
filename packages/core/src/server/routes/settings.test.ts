import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsRoutes } from './settings.js';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function createTestApp(tmpDir: string, fallbackWorkspace: string) {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
  app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
    settingsStore,
    fallbackWorkspace,
  }));
  return { app, settingsStore };
}

describe('Settings API Routes (workspace)', () => {
  let tmpDir: string;
  const FALLBACK = '/default/env-or-config-workspace';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/v2/settings/workspace', () => {
    it('возвращает fallback (env/config/default), если runtime-настройка не задана', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/workspace');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ workspace: FALLBACK });
    });

    it('возвращает runtime-настройку после её сохранения', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/custom/ws' }),
      });
      const res = await app.request('/api/v2/settings/workspace');
      const body: any = await res.json();
      expect(body).toEqual({ workspace: '/custom/ws' });
    });
  });

  describe('PUT /api/v2/settings/workspace', () => {
    it('сохраняет workspace и возвращает его', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '  /trimmed/ws  ' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ workspace: '/trimmed/ws' });
    });

    it('отклоняет пустой workspace', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '   ' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('отклоняет отсутствующий workspace', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('не ломает другие runtime-настройки при перезаписи', async () => {
      const { app, settingsStore } = createTestApp(tmpDir, FALLBACK);
      await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/first' }),
      });
      await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/second' }),
      });
      const settings = await settingsStore.load();
      expect(settings.workspace).toBe('/second');
    });
  });

  describe('персистентность (переживание рестарта)', () => {
    it('новый инстанс store (эмуляция рестарта) читает сохранённое значение', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const put = await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/persisted/ws' }),
      });
      expect(put.status).toBe(200);

      // Рестарт: новый store + новый роут поверх того же dataDir
      const restartedApp = new Hono();
      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      restartedApp.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore: restartedStore,
        fallbackWorkspace: FALLBACK,
      }));

      const res = await restartedApp.request('/api/v2/settings/workspace');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ workspace: '/persisted/ws' });
    });

    it('значение записано в {dataDir}/settings.json атомарно (без tmp-хвостов)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/disk/ws' }),
      });
      const raw = await readFile(join(tmpDir, 'settings.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.workspace).toBe('/disk/ws');
      // в каталоге только settings.json, никаких .tmp.* файлов
      const files = await (await import('node:fs/promises')).readdir(tmpDir);
      expect(files.filter((f) => f.includes('.tmp.') || f.endsWith('.json'))).toEqual(['settings.json']);
    });
  });
});
