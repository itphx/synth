import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsRoutes, RuntimeSettingsStore } from '@itphx/core';
import type { SettingsRoutesDeps } from '@itphx/core';

function createMockKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    getCurrentUser: () => null,
  };
}

function createTestApp(settingsStore: RuntimeSettingsStore, fallbackWorkspace: string) {
  const app = new Hono();
  const kit = createMockKit();
  const deps: SettingsRoutesDeps = { settingsStore, fallbackWorkspace };
  app.route('/api/v2/settings', createSettingsRoutes(kit as any, deps));
  return app;
}

describe('Settings API Routes (workspace/mcp)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/v2/settings/workspace', () => {
    it('возвращает fallback, когда runtime-настройка не задана', async () => {
      const store = new RuntimeSettingsStore({ dataDir: tmpDir });
      const app = createTestApp(store, '/fallback/workspace');
      const res = await app.request('/api/v2/settings/workspace');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.workspace).toBe('/fallback/workspace');
    });

    it('возвращает сохранённый workspace после PUT (персистентность)', async () => {
      const store = new RuntimeSettingsStore({ dataDir: tmpDir });
      const app = createTestApp(store, '/fallback/workspace');

      const putRes = await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/data/workspaces/my' }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await app.request('/api/v2/settings/workspace');
      const body: any = await getRes.json();
      expect(body.workspace).toBe('/data/workspaces/my');
    });

    it('переживает рестарт: новый store на том же dataDir видит значение', async () => {
      const store1 = new RuntimeSettingsStore({ dataDir: tmpDir });
      const app1 = createTestApp(store1, '/fallback/workspace');
      await app1.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/persisted/ws' }),
      });

      const store2 = new RuntimeSettingsStore({ dataDir: tmpDir });
      const app2 = createTestApp(store2, '/fallback/workspace');
      const res = await app2.request('/api/v2/settings/workspace');
      const body: any = await res.json();
      expect(body.workspace).toBe('/persisted/ws');
    });
  });

  describe('PUT /api/v2/settings/workspace', () => {
    it('возвращает 400 для пустого workspace', async () => {
      const store = new RuntimeSettingsStore({ dataDir: tmpDir });
      const app = createTestApp(store, '/fallback/workspace');
      const res = await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '   ' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 400 при отсутствии поля workspace', async () => {
      const store = new RuntimeSettingsStore({ dataDir: tmpDir });
      const app = createTestApp(store, '/fallback/workspace');
      const res = await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v2/settings/mcp', () => {
    it('возвращает пустой объект серверов по умолчанию', async () => {
      const store = new RuntimeSettingsStore({ dataDir: tmpDir });
      const app = createTestApp(store, '/fallback/workspace');
      const res = await app.request('/api/v2/settings/mcp');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.servers).toEqual({});
    });
  });

  describe('PUT /api/v2/settings/mcp', () => {
    it('сохраняет валидную конфигурацию серверов', async () => {
      const store = new RuntimeSettingsStore({ dataDir: tmpDir });
      const app = createTestApp(store, '/fallback/workspace');
      const servers = {
        filesystem: {
          default: { plan: true, act: true },
          tools: {
            read_file: { plan: true, act: true },
            write_file: { plan: false, act: true },
          },
        },
      };
      const res = await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers }),
      });
      expect(res.status).toBe(200);

      const getRes = await app.request('/api/v2/settings/mcp');
      const body: any = await getRes.json();
      expect(body.servers.filesystem.default).toEqual({ plan: true, act: true });
    });

    it('возвращает 400 для невалидной структуры серверов', async () => {
      const store = new RuntimeSettingsStore({ dataDir: tmpDir });
      const app = createTestApp(store, '/fallback/workspace');
      const res = await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: { bad: { default: { plan: 'yes' } } } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
