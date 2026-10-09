import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsRoutes } from './settings.js';
import { RuntimeSettingsStore, mergeLlmGatewayConfig, mergeSecurityConfig } from '../../storage/runtime-settings.js';
import type { LlmGatewayRuntimeSettings, SecurityRuntimeSettings } from '../../storage/runtime-settings.js';
import { DEFAULT_AGENT_ID } from '../../engine/agents/index.js';
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
      expect(body).toEqual({ workspace: FALLBACK, isOverridden: false, defaults: FALLBACK });
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
      expect(body).toEqual({ workspace: '/custom/ws', isOverridden: true, defaults: FALLBACK });
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
      expect(body).toEqual({ workspace: '/persisted/ws', isOverridden: true, defaults: FALLBACK });
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
      expect(body).toEqual({ servers: {}, isOverridden: false, defaults: {} });
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

  describe('tools-policy (AD-071 §2.3)', () => {
    it('GET возвращает fallback (config), если runtime не задан', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        fallbackToolsPolicy: 'available',
      }));
      const res = await app.request('/api/v2/settings/tools-policy');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ toolsPolicy: 'available', isOverridden: false, defaults: 'available' });
    });

    it('GET по умолчанию auto (AD-071 §2.3)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/tools-policy');
      const body: any = await res.json();
      expect(body).toEqual({ toolsPolicy: 'auto', isOverridden: false, defaults: 'auto' });
    });

    it('PUT сохраняет и GET возвращает; переживает рестарт', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const put = await app.request('/api/v2/settings/tools-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsPolicy: 'available' }),
      });
      expect(put.status).toBe(200);
      const putBody: any = await put.json();
      expect(putBody).toEqual({ toolsPolicy: 'available' });

      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      expect(await restartedStore.getToolsPolicy()).toBe('available');
    });

    it('PUT отклоняет неизвестную политику', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/tools-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsPolicy: 'all' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('PUT вызывает onToolsPolicyChange (live-применение)', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onToolsPolicyChange = vi.fn(async (_policy: string) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onToolsPolicyChange,
      }));

      const res = await app.request('/api/v2/settings/tools-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsPolicy: 'auto' }),
      });
      expect(res.status).toBe(200);
      expect(onToolsPolicyChange).toHaveBeenCalledTimes(1);
      expect(onToolsPolicyChange).toHaveBeenCalledWith('auto');
    });
  });

  describe('mcp-policy (AD-071 §2.3)', () => {
    it('GET по умолчанию auto', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp-policy');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ mcpPolicy: 'auto', isOverridden: false, defaults: 'auto' });
    });

    it('GET возвращает fallback (config), если runtime не задан', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        fallbackMcpPolicy: 'available',
      }));
      const res = await app.request('/api/v2/settings/mcp-policy');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ mcpPolicy: 'available', isOverridden: false, defaults: 'available' });
    });

    it('PUT сохраняет и GET возвращает; переживает рестарт', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const put = await app.request('/api/v2/settings/mcp-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpPolicy: 'available' }),
      });
      expect(put.status).toBe(200);
      const putBody: any = await put.json();
      expect(putBody).toEqual({ mcpPolicy: 'available' });

      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      expect(await restartedStore.getMcpPolicy()).toBe('available');
    });

    it('PUT не затирает tools-policy (независимые настройки)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      await app.request('/api/v2/settings/tools-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsPolicy: 'consistency' }),
      });
      await app.request('/api/v2/settings/mcp-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpPolicy: 'available' }),
      });
      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      expect(await restartedStore.getToolsPolicy()).toBe('consistency');
      expect(await restartedStore.getMcpPolicy()).toBe('available');
    });

    it('PUT отклоняет неизвестную политику', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpPolicy: 'all' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('PUT вызывает onMcpPolicyChange (live-применение)', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onMcpPolicyChange = vi.fn(async (_policy: string) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onMcpPolicyChange,
      }));

      const res = await app.request('/api/v2/settings/mcp-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpPolicy: 'available' }),
      });
      expect(res.status).toBe(200);
      expect(onMcpPolicyChange).toHaveBeenCalledTimes(1);
      expect(onMcpPolicyChange).toHaveBeenCalledWith('available');
    });
  });

  describe('mcp-network-policy (AD-071 §2.3.1)', () => {
    it('GET по умолчанию возвращает deny приватных диапазонов', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp-network-policy');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.policy.mode).toBe('deny');
      expect(body.policy.list).toContain('10.0.0.0/8');
      expect(body.policy.list).toContain('127.0.0.0/8');
    });

    it('GET возвращает fallback (config), если runtime не задан', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        fallbackMcpNetworkPolicy: { mode: 'allow', list: ['10.0.0.0/8'] },
      }));
      const res = await app.request('/api/v2/settings/mcp-network-policy');
      const body: any = await res.json();
      expect(body).toEqual({
        policy: { mode: 'allow', list: ['10.0.0.0/8'] },
        isOverridden: false,
        defaults: { mode: 'allow', list: ['10.0.0.0/8'] },
      });
    });

    it('PUT сохраняет, GET возвращает; переживает рестарт', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const put = await app.request('/api/v2/settings/mcp-network-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { mode: 'allow', list: ['example.com', '192.168.0.0/16'] } }),
      });
      expect(put.status).toBe(200);
      const putBody: any = await put.json();
      expect(putBody).toEqual({ policy: { mode: 'allow', list: ['example.com', '192.168.0.0/16'] } });

      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      expect(await restartedStore.getMcpNetworkPolicy()).toEqual({
        mode: 'allow',
        list: ['example.com', '192.168.0.0/16'],
      });
    });

    it('PUT отклоняет неизвестный режим и не-массив списка', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const badMode = await app.request('/api/v2/settings/mcp-network-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { mode: 'block', list: [] } }),
      });
      expect(badMode.status).toBe(400);
      const badModeBody: any = await badMode.json();
      expect(badModeBody.error.code).toBe('VALIDATION_ERROR');

      const badList = await app.request('/api/v2/settings/mcp-network-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { mode: 'deny', list: '10.0.0.0/8' } }),
      });
      expect(badList.status).toBe(400);
    });

    it('PUT вызывает onMcpNetworkPolicyChange (live-применение)', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onMcpNetworkPolicyChange = vi.fn(async (_policy: unknown) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onMcpNetworkPolicyChange,
      }));

      const res = await app.request('/api/v2/settings/mcp-network-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { mode: 'allow', list: ['example.com'] } }),
      });
      expect(res.status).toBe(200);
      expect(onMcpNetworkPolicyChange).toHaveBeenCalledTimes(1);
      expect(onMcpNetworkPolicyChange).toHaveBeenCalledWith({ mode: 'allow', list: ['example.com'] });
    });
  });

  describe('tools-disabled (AD-071 §2.6)', () => {
    it('GET по умолчанию возвращает пустой конфиг', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/tools-disabled');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({
        toolsDisabled: { capabilities: [], tools: [] },
        isOverridden: false,
        defaults: { capabilities: [], tools: [] },
      });
    });

    it('GET возвращает fallback (config), если runtime не задан', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        fallbackToolsDisabled: { capabilities: ['web'], tools: ['git_read'] },
      }));
      const res = await app.request('/api/v2/settings/tools-disabled');
      const body: any = await res.json();
      expect(body).toEqual({
        toolsDisabled: { capabilities: ['web'], tools: ['git_read'] },
        isOverridden: false,
        defaults: { capabilities: ['web'], tools: ['git_read'] },
      });
    });

    it('PUT сохраняет, GET возвращает; переживает рестарт', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const put = await app.request('/api/v2/settings/tools-disabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsDisabled: { capabilities: ['git_read'], tools: ['web_search'] } }),
      });
      expect(put.status).toBe(200);
      const putBody: any = await put.json();
      expect(putBody).toEqual({ toolsDisabled: { capabilities: ['git_read'], tools: ['web_search'] } });

      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      expect(await restartedStore.getToolsDisabled()).toEqual({
        capabilities: ['git_read'],
        tools: ['web_search'],
      });
    });

    it('PUT отклоняет неизвестную capability (Zod enum)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/tools-disabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsDisabled: { capabilities: ['nope'], tools: [] } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('PUT отклоняет capability runtime (ядро сессии)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/tools-disabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsDisabled: { capabilities: ['runtime'], tools: [] } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('runtime');
    });

    it('PUT принимает capability user (отключаемая группа профиля)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/tools-disabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsDisabled: { capabilities: ['user'], tools: [] } }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.toolsDisabled).toEqual({ capabilities: ['user'], tools: [] });
    });

    it('PUT отклоняет инструмент с capability runtime (knownTools)', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        knownTools: () => [
          { name: 'plan_read', capabilities: ['runtime'] },
          { name: 'git_read', capabilities: ['git_read'] },
        ],
      }));
      const res = await app.request('/api/v2/settings/tools-disabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsDisabled: { capabilities: [], tools: ['plan_read'] } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.message).toContain('plan_read');
    });

    it('PUT принимает неизвестное имя инструмента (динамический MCP-реестр)', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        knownTools: () => [{ name: 'git_read', capabilities: ['git_read'] }],
      }));
      const res = await app.request('/api/v2/settings/tools-disabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsDisabled: { capabilities: [], tools: ['srvA_search'] } }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.toolsDisabled.tools).toEqual(['srvA_search']);
    });

    it('PUT вызывает onToolsDisabledChange (live-применение)', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onToolsDisabledChange = vi.fn(async (_config: unknown) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onToolsDisabledChange,
      }));
      const res = await app.request('/api/v2/settings/tools-disabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsDisabled: { capabilities: ['git_read'], tools: [] } }),
      });
      expect(res.status).toBe(200);
      expect(onToolsDisabledChange).toHaveBeenCalledTimes(1);
      expect(onToolsDisabledChange).toHaveBeenCalledWith({ capabilities: ['git_read'], tools: [] });
    });
  });

  describe('AD-072 Ф2: сброс runtime-настроек к умолчанию (GET meta + DELETE)', () => {
    it('DELETE /workspace очищает override и возвращает fallback', async () => {
      const { app, settingsStore } = createTestApp(tmpDir, FALLBACK);
      await app.request('/api/v2/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: '/custom/ws' }),
      });

      const res = await app.request('/api/v2/settings/workspace', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({
        status: 'restored',
        workspace: FALLBACK,
        isOverridden: false,
        defaults: FALLBACK,
      });
      expect(await settingsStore.getWorkspace()).toBeUndefined();

      const get = await app.request('/api/v2/settings/workspace');
      const getBody: any = await get.json();
      expect(getBody.workspace).toBe(FALLBACK);
      expect(getBody.isOverridden).toBe(false);
    });

    it('DELETE /mcp очищает override и отдаёт пустой дефолт', async () => {
      const { app, settingsStore } = createTestApp(tmpDir, FALLBACK);
      await app.request('/api/v2/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: { github: { default: { plan: true, act: true } } } }),
      });

      const res = await app.request('/api/v2/settings/mcp', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ status: 'restored', servers: {}, isOverridden: false, defaults: {} });
      expect(await settingsStore.getMcpSettings()).toEqual({});

      const getBody: any = await (await app.request('/api/v2/settings/mcp')).json();
      expect(getBody.isOverridden).toBe(false);
    });

    it('GET /llm-gateway отдаёт эффективное значение (runtime поверх config-дефолта) + meta', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        fallbackLlmGateway: {
          enabled: true,
          inputMode: 'block',
          rateLimit: { userPerMinute: 5, providerPerMinute: 7 },
        },
      }));
      await app.request('/api/v2/settings/llm-gateway', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llmGateway: { enabled: false } }),
      });

      const body: any = await (await app.request('/api/v2/settings/llm-gateway')).json();
      expect(body.llmGateway).toEqual({
        enabled: false,
        inputMode: 'block',
        logPayloads: false,
        rateLimit: { userPerMinute: 5, providerPerMinute: 7 },
      });
      expect(body.isOverridden).toBe(true);
      expect(body.defaults).toEqual({
        enabled: true,
        inputMode: 'block',
        logPayloads: false,
        rateLimit: { userPerMinute: 5, providerPerMinute: 7 },
      });
    });

    it('DELETE /llm-gateway очищает override, live-применяет {} и отдаёт дефолт', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onLlmGatewayChange = vi.fn(async (_runtime: Partial<LlmGatewayRuntimeSettings>) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onLlmGatewayChange,
        fallbackLlmGateway: { enabled: true, inputMode: 'block' },
      }));
      await app.request('/api/v2/settings/llm-gateway', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llmGateway: { enabled: false } }),
      });

      const res = await app.request('/api/v2/settings/llm-gateway', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.status).toBe('restored');
      expect(body.isOverridden).toBe(false);
      expect(body.llmGateway).toEqual(body.defaults);
      expect(body.defaults.rateLimit).toEqual({ userPerMinute: 60, providerPerMinute: 120 });
      expect(onLlmGatewayChange).toHaveBeenLastCalledWith({});
      expect(await settingsStore.getLlmGatewaySettings()).toEqual({});
    });

    it('GET /security отдаёт эффективное значение + meta, DELETE сбрасывает', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onSecurityChange = vi.fn(async (_runtime: Partial<SecurityRuntimeSettings>) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        onSecurityChange,
        fallbackSecurity: { protectedPaths: { enabled: false }, askTimeoutMs: 1234 },
      }));

      const defaults = { protectedPaths: { enabled: false }, askTimeoutMs: 1234 };
      const initial: any = await (await app.request('/api/v2/settings/security')).json();
      expect(initial.security).toEqual(defaults);
      expect(initial.isOverridden).toBe(false);
      expect(initial.defaults).toEqual(defaults);

      await app.request('/api/v2/settings/security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security: { protectedPaths: { enabled: true }, askTimeoutMs: 999 } }),
      });
      const overridden: any = await (await app.request('/api/v2/settings/security')).json();
      expect(overridden.security).toEqual({ protectedPaths: { enabled: true }, askTimeoutMs: 999 });
      expect(overridden.isOverridden).toBe(true);

      const res = await app.request('/api/v2/settings/security', { method: 'DELETE' });
      const body: any = await res.json();
      expect(body).toEqual({ status: 'restored', security: defaults, isOverridden: false, defaults });
      expect(onSecurityChange).toHaveBeenLastCalledWith({});
      expect(await settingsStore.getSecuritySettings()).toEqual({});
    });

    it('DELETE /tools-policy сбрасывает к fallback и live-применяет его', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onToolsPolicyChange = vi.fn(async (_policy: string) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        fallbackToolsPolicy: 'available',
        onToolsPolicyChange,
      }));
      await app.request('/api/v2/settings/tools-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsPolicy: 'consistency' }),
      });

      const body: any = await (await app.request('/api/v2/settings/tools-policy', { method: 'DELETE' })).json();
      expect(body).toEqual({ status: 'restored', toolsPolicy: 'available', isOverridden: false, defaults: 'available' });
      expect(onToolsPolicyChange).toHaveBeenLastCalledWith('available');
      expect(await settingsStore.getToolsPolicy()).toBeUndefined();
    });

    it('DELETE /mcp-policy сбрасывает к fallback и live-применяет его', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onMcpPolicyChange = vi.fn(async (_policy: string) => {});
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        fallbackMcpPolicy: 'available',
        onMcpPolicyChange,
      }));
      await app.request('/api/v2/settings/mcp-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpPolicy: 'consistency' }),
      });

      const body: any = await (await app.request('/api/v2/settings/mcp-policy', { method: 'DELETE' })).json();
      expect(body).toEqual({ status: 'restored', mcpPolicy: 'available', isOverridden: false, defaults: 'available' });
      expect(onMcpPolicyChange).toHaveBeenLastCalledWith('available');
      expect(await settingsStore.getMcpPolicy()).toBeUndefined();
    });

    it('DELETE /mcp-network-policy сбрасывает к fallback и live-применяет его', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onMcpNetworkPolicyChange = vi.fn(async (_policy: unknown) => {});
      const fallback = { mode: 'allow' as const, list: ['10.0.0.0/8'] };
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        fallbackMcpNetworkPolicy: fallback,
        onMcpNetworkPolicyChange,
      }));
      await app.request('/api/v2/settings/mcp-network-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { mode: 'deny', list: [] } }),
      });

      const body: any = await (await app.request('/api/v2/settings/mcp-network-policy', { method: 'DELETE' })).json();
      expect(body).toEqual({ status: 'restored', policy: fallback, isOverridden: false, defaults: fallback });
      expect(onMcpNetworkPolicyChange).toHaveBeenLastCalledWith(fallback);
      expect(await settingsStore.getMcpNetworkPolicy()).toBeUndefined();
    });

    it('DELETE /tools-disabled сбрасывает к fallback и live-применяет его', async () => {
      const app = new Hono();
      const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      const onToolsDisabledChange = vi.fn(async (_config: unknown) => {});
      const fallback = { capabilities: ['web'], tools: ['git_read'] };
      app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
        settingsStore,
        fallbackWorkspace: FALLBACK,
        fallbackToolsDisabled: fallback,
        onToolsDisabledChange,
      }));
      await app.request('/api/v2/settings/tools-disabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolsDisabled: { capabilities: [], tools: ['srvA_search'] } }),
      });

      const body: any = await (await app.request('/api/v2/settings/tools-disabled', { method: 'DELETE' })).json();
      expect(body).toEqual({ status: 'restored', toolsDisabled: fallback, isOverridden: false, defaults: fallback });
      expect(onToolsDisabledChange).toHaveBeenLastCalledWith(fallback);
      expect(await settingsStore.getToolsDisabled()).toBeUndefined();
    });
  });
});

describe('Settings API Routes — default-agent (админка «Агенты»)', () => {
  let tmpDir: string;
  const FALLBACK = '/fallback/workspace';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-default-agent-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET возвращает DEFAULT_AGENT_ID, если ни runtime, ни config не заданы', async () => {
    const { app } = createTestApp(tmpDir, FALLBACK);
    const res = await app.request('/api/v2/settings/default-agent');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ defaultAgent: DEFAULT_AGENT_ID, isOverridden: false, defaults: DEFAULT_AGENT_ID });
  });

  it('GET возвращает fallback из deps, если runtime не задан', async () => {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: FALLBACK,
      fallbackDefaultAgent: 'analyst',
    }));
    const res = await app.request('/api/v2/settings/default-agent');
    const body: any = await res.json();
    expect(body).toEqual({ defaultAgent: 'analyst', isOverridden: false, defaults: 'analyst' });
  });

  it('PUT сохраняет и GET возвращает; переживает рестарт', async () => {
    const { app } = createTestApp(tmpDir, FALLBACK);
    const put = await app.request('/api/v2/settings/default-agent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAgent: 'developer' }),
    });
    expect(put.status).toBe(200);
    const putBody: any = await put.json();
    expect(putBody).toEqual({ defaultAgent: 'developer' });

    const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await restartedStore.getDefaultAgent()).toBe('developer');

    const getRes = await app.request('/api/v2/settings/default-agent');
    const getBody: any = await getRes.json();
    expect(getBody).toEqual({ defaultAgent: 'developer', isOverridden: true, defaults: DEFAULT_AGENT_ID });
  });

  it('PUT отклоняет пустой id', async () => {
    const { app } = createTestApp(tmpDir, FALLBACK);
    const res = await app.request('/api/v2/settings/default-agent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAgent: '   ' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT тримит id и сохраняет trimmed-значение', async () => {
    const { app } = createTestApp(tmpDir, FALLBACK);
    const res = await app.request('/api/v2/settings/default-agent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAgent: '  developer  ' }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ defaultAgent: 'developer' });
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await store.getDefaultAgent()).toBe('developer');
  });

  it('PUT отклоняет id с недопустимыми символами', async () => {
    const { app } = createTestApp(tmpDir, FALLBACK);
    const res = await app.request('/api/v2/settings/default-agent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAgent: 'Dev Agent!' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT вызывает onDefaultAgentChange (live-применение)', async () => {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    const onDefaultAgentChange = vi.fn(async (_id: string) => {});
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: FALLBACK,
      onDefaultAgentChange,
    }));

    const res = await app.request('/api/v2/settings/default-agent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAgent: 'developer' }),
    });
    expect(res.status).toBe(200);
    expect(onDefaultAgentChange).toHaveBeenCalledWith('developer');
  });

  it('DELETE сбрасывает к fallback и live-применяет его', async () => {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    const onDefaultAgentChange = vi.fn(async (_id: string) => {});
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: FALLBACK,
      fallbackDefaultAgent: 'analyst',
      onDefaultAgentChange,
    }));
    await app.request('/api/v2/settings/default-agent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAgent: 'developer' }),
    });

    const body: any = await (await app.request('/api/v2/settings/default-agent', { method: 'DELETE' })).json();
    expect(body).toEqual({ status: 'restored', defaultAgent: 'analyst', isOverridden: false, defaults: 'analyst' });
    expect(onDefaultAgentChange).toHaveBeenLastCalledWith('analyst');
    expect(await settingsStore.getDefaultAgent()).toBeUndefined();
  });
});

async function settingsLoad(tmpDir: string): Promise<{ workspace?: string; mcpServers?: Record<string, any> }> {
  const raw = await readFile(join(tmpDir, 'settings.json'), 'utf-8');
  return JSON.parse(raw);
}

describe('Settings API Routes (workspace-policy, AD-075)', () => {
  let tmpDir: string;
  const FALLBACK = '/default/ws';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-wsp-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET: дефолт confirm при отсутствии runtime/конфига', async () => {
    const { app } = createTestApp(tmpDir, FALLBACK);
    const body: any = await (await app.request('/api/v2/settings/workspace-policy')).json();
    expect(body).toEqual({ outsideRoot: 'confirm', isOverridden: false, defaults: 'confirm' });
  });

  it('PUT: сохраняет политику и live-применяет её', async () => {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    const onWorkspacePolicyChange = vi.fn(async (_p: string) => {});
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: FALLBACK,
      fallbackWorkspaceOutsideRootPolicy: 'confirm',
      onWorkspacePolicyChange,
    }));

    const put = await app.request('/api/v2/settings/workspace-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outsideRoot: 'deny' }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ outsideRoot: 'deny' });
    expect(onWorkspacePolicyChange).toHaveBeenCalledWith('deny');
    expect(await settingsStore.getWorkspacePolicy()).toBe('deny');

    const get: any = await (await app.request('/api/v2/settings/workspace-policy')).json();
    expect(get).toEqual({ outsideRoot: 'deny', isOverridden: true, defaults: 'confirm' });
  });

  it('PUT: невалидное значение отклоняется (400)', async () => {
    const { app } = createTestApp(tmpDir, FALLBACK);
    const res = await app.request('/api/v2/settings/workspace-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outsideRoot: 'allow' }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE: сбрасывает к fallback', async () => {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: FALLBACK,
      fallbackWorkspaceOutsideRootPolicy: 'deny',
    }));
    await app.request('/api/v2/settings/workspace-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outsideRoot: 'confirm' }),
    });
    const body: any = await (await app.request('/api/v2/settings/workspace-policy', { method: 'DELETE' })).json();
    expect(body).toEqual({ status: 'restored', outsideRoot: 'deny', isOverridden: false, defaults: 'deny' });
    expect(await settingsStore.getWorkspacePolicy()).toBeUndefined();
  });

  it('workspacePolicyReadOnly: GET отдаёт fallback + readOnly, PUT/DELETE → 403', async () => {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    const onWorkspacePolicyChange = vi.fn(async (_p: string) => {});
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: FALLBACK,
      fallbackWorkspaceOutsideRootPolicy: 'deny',
      workspacePolicyReadOnly: true,
      onWorkspacePolicyChange,
    }));

    const get = await app.request('/api/v2/settings/workspace-policy');
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      outsideRoot: 'deny', isOverridden: false, defaults: 'deny', readOnly: true,
    });

    const put = await app.request('/api/v2/settings/workspace-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outsideRoot: 'confirm' }),
    });
    expect(put.status).toBe(403);
    expect(((await put.json()) as any).error.code).toBe('WORKSPACE_POLICY_READ_ONLY');
    expect(onWorkspacePolicyChange).not.toHaveBeenCalled();
    expect(await settingsStore.getWorkspacePolicy()).toBeUndefined();

    const del = await app.request('/api/v2/settings/workspace-policy', { method: 'DELETE' });
    expect(del.status).toBe(403);
    expect(((await del.json()) as any).error.code).toBe('WORKSPACE_POLICY_READ_ONLY');
  });
});