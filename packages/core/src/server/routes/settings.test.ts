import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsRoutes } from './settings.js';
import { RuntimeSettingsStore, mergeLlmGatewayConfig, mergeSecurityConfig } from '../../storage/runtime-settings.js';
import type { LlmGatewayRuntimeSettings, SecurityRuntimeSettings } from '../../storage/runtime-settings.js';
import type { AuthKit } from '../../auth/local.js';
import type { LLMGatewayConfig } from '@itphx/synth-shared';

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

  describe('GET /api/v2/settings/mcp', () => {
    it('возвращает пустой объект servers, если настройки не заданы', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ servers: {} });
    });

    it('возвращает сохранённые настройки', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const servers = {
        github: {
          default: { plan: true, act: true },
          tools: { list_issues: { plan: true, act: false } },
        },
      };
      await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers }),
      });
      const res = await app.request('/api/v2/settings/mcp');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.servers).toEqual(servers);
    });
  });

  describe('PUT /api/v2/settings/mcp', () => {
    it('сохраняет настройки и возвращает их', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const servers = {
        github: {
          default: { plan: false, act: true },
        },
      };
      const res = await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.servers).toEqual(servers);
    });

    it('отклоняет пустое имя сервера', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: { '': { default: { plan: true, act: true } } } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('отклоняет не-boolean plan/act', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: { github: { default: { plan: 'yes', act: true } } } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('отклоняет пустое имя инструмента в tools', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: { github: { tools: { '': { plan: true, act: true } } } } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('отклоняет отсутствующий servers', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('не ломает workspace при перезаписи (общий settings.json)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/keep/ws' }),
      });
      await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: { github: { default: { plan: true, act: false } } } }),
      });
      const settings = await settingsLoad(tmpDir);
      expect(settings.workspace).toBe('/keep/ws');
      expect(settings.mcpServers?.github?.default).toEqual({ plan: true, act: false });
    });

    it('переживает рестарт: новый инстанс store читает mcpServers', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: { gitlab: { default: { plan: false, act: true } } } }),
      });

      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const mcp = await restartedStore.getMcpSettings();
      expect(mcp.gitlab?.default).toEqual({ plan: false, act: true });
    });
  });

  describe('Security (askTimeoutMs)', () => {
    it('GET /api/v2/settings/security возвращает дефолт askTimeoutMs=30000', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/security');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.security.protectedPaths.enabled).toBe(true);
      expect(body.security.askTimeoutMs).toBe(30000);
    });

    it('PUT /api/v2/settings/security сохраняет askTimeoutMs и GET возвращает его (переживает рестарт)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const put = await app.request('/api/v2/settings/security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security: { protectedPaths: { enabled: false }, askTimeoutMs: 15000 } }),
      });
      expect(put.status).toBe(200);

      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const runtime = await restartedStore.getSecuritySettings();
      expect(runtime.protectedPaths?.enabled).toBe(false);
      expect(runtime.askTimeoutMs).toBe(15000);
    });

    it('PUT /api/v2/settings/security отклоняет невалидный askTimeoutMs (отрицательный/не целое)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const negative = await app.request('/api/v2/settings/security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security: { askTimeoutMs: -1 } }),
      });
      expect(negative.status).toBe(400);
      const negativeBody: any = await negative.json();
      expect(negativeBody.error.code).toBe('VALIDATION_ERROR');

      const fractional = await app.request('/api/v2/settings/security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security: { askTimeoutMs: 12.5 } }),
      });
      expect(fractional.status).toBe(400);
    });

    it('PUT /api/v2/settings/security вызывает onSecurityChange с runtime-настройкой (live-применение)', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onSecurityChange = vi.fn(async (_runtime: Partial<SecurityRuntimeSettings>) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onSecurityChange,
      }));

      const res = await app.request('/api/v2/settings/security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security: { askTimeoutMs: 20000 } }),
      });
      expect(res.status).toBe(200);
      expect(onSecurityChange).toHaveBeenCalledTimes(1);
      expect(onSecurityChange).toHaveBeenCalledWith({ askTimeoutMs: 20000 });
    });

    it('mergeSecurityConfig пробрасывает askTimeoutMs (runtime приоритетнее, дефолт 30000)', () => {
      const withAsk = mergeSecurityConfig(undefined, { askTimeoutMs: 5000 });
      expect(withAsk?.askTimeoutMs).toBe(5000);

      const defaultAsk = mergeSecurityConfig(undefined, { protectedPaths: { enabled: true } });
      expect(defaultAsk?.askTimeoutMs).toBe(30000);
    });
  });

  describe('LLM Gateway (AD-036)', () => {
    it('PUT /api/v2/settings/llm-gateway переживает рестарт', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      await app.request('/api/v2/settings/llm-gateway', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llmGateway: { enabled: true, inputMode: 'block' } }),
      });

      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const runtime = await restartedStore.getLlmGatewaySettings();
      expect(runtime.enabled).toBe(true);
      expect(runtime.inputMode).toBe('block');
    });

    it('mergeLlmGatewayConfig: runtime приоритетнее конфига, остальное наследуется из конфига', () => {
      const base: LLMGatewayConfig = {
        enabled: false,
        inputMode: 'obfuscate',
        logPayloads: false,
        payloadLogPath: '',
        rateLimit: { userPerMinute: 10, providerPerMinute: 20 },
        audit: { enabled: true, logPath: '/x/llm-gateway.jsonl' },
      };
      const merged = mergeLlmGatewayConfig(base, { enabled: true });
      expect(merged).toBeDefined();
      expect(merged!.enabled).toBe(true);
      expect(merged!.inputMode).toBe('obfuscate');
      expect(merged!.rateLimit).toEqual({ userPerMinute: 10, providerPerMinute: 20 });
      expect(merged!.audit.logPath).toBe('/x/llm-gateway.jsonl');
    });

    it('mergeLlmGatewayConfig: runtime включается даже если конфига нет', () => {
      const merged = mergeLlmGatewayConfig(undefined, { enabled: true, inputMode: 'block' });
      expect(merged).toBeDefined();
      expect(merged!.enabled).toBe(true);
      expect(merged!.inputMode).toBe('block');
      expect(merged!.rateLimit).toEqual({ userPerMinute: 60, providerPerMinute: 120 });
    });

    it('mergeLlmGatewayConfig: возвращает undefined если нет ни конфига, ни runtime', () => {
      expect(mergeLlmGatewayConfig(undefined, {})).toBeUndefined();
    });

    it('PUT /api/v2/settings/llm-gateway вызывает onLlmGatewayChange с runtime-настройкой (live-применение)', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onLlmGatewayChange = vi.fn(async (_runtime: Partial<LlmGatewayRuntimeSettings>) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onLlmGatewayChange,
      }));

      const res = await app.request('/api/v2/settings/llm-gateway', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llmGateway: { enabled: true, inputMode: 'block' } }),
      });
      expect(res.status).toBe(200);
      expect(onLlmGatewayChange).toHaveBeenCalledTimes(1);
      expect(onLlmGatewayChange).toHaveBeenCalledWith({ enabled: true, inputMode: 'block' });
    });

    it('PUT /api/v2/settings/llm-gateway await-ит асинхронный onLlmGatewayChange', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      let released = false;
      const onLlmGatewayChange = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        released = true;
      });
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onLlmGatewayChange,
      }));

      const res = await app.request('/api/v2/settings/llm-gateway', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llmGateway: { enabled: false } }),
      });
      expect(res.status).toBe(200);
      // Ответ не отдан раньше завершения колбэка
      expect(released).toBe(true);
    });

    it('PUT /workspace и PUT /mcp не вызывают onLlmGatewayChange', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onLlmGatewayChange = vi.fn();
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onLlmGatewayChange,
      }));

      await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/ws' }),
      });
      await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: { github: { default: { plan: true, act: true } } } }),
      });
      expect(onLlmGatewayChange).not.toHaveBeenCalled();
    });
  });
});

async function settingsLoad(tmpDir: string): Promise<{ workspace?: string; mcpServers?: Record<string, any> }> {
  const raw = await readFile(join(tmpDir, 'settings.json'), 'utf-8');
  return JSON.parse(raw);
}
