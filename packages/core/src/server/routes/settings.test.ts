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
import { MemorySecurityAuditRepository } from '../../storage/memory/index.js';

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

  describe('LLM Gateway (ADR-036)', () => {
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

  describe('tools-policy (ADR-071 §2.3)', () => {
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

    it('GET по умолчанию auto (ADR-071 §2.3)', async () => {
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

  describe('mcp-policy (ADR-071 §2.3)', () => {
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

  describe('mcp-network-policy (ADR-071 §2.3.1)', () => {
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
      expect(putBody).toEqual({ policy: { mode: 'allow', list: ['example.com', '192.168.0.0/16'], exceptions: [] } });

      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      expect(await restartedStore.getMcpNetworkPolicy()).toEqual({
        mode: 'allow',
        list: ['example.com', '192.168.0.0/16'],
        exceptions: [],
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

    it('PUT принимает hostname-исключение (*.suffix) и сохраняет его', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp-network-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policy: {
            mode: 'deny',
            list: ['10.0.0.0/8'],
            exceptions: ['  *.svc.cluster.local  '],
          },
        }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      // Исключение сохраняется нормализованным (trim).
      expect(body.policy).toEqual({
        mode: 'deny',
        list: ['10.0.0.0/8'],
        exceptions: ['*.svc.cluster.local'],
      });

      // Политика переживает рестарт.
      const restartedStore = new RuntimeSettingsStore({ dataDir: tmpDir });
      expect(await restartedStore.getMcpNetworkPolicy()).toEqual({
        mode: 'deny',
        list: ['10.0.0.0/8'],
        exceptions: ['*.svc.cluster.local'],
      });
    });

    it('PUT отклоняет мусорное исключение точным сообщением (не обобщённым)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp-network-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { mode: 'deny', list: [], exceptions: ['bad host'] } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe(
        'policy: невалидная запись "bad host" (ожидается hostname, *.suffix, CIDR или IP)',
      );
    });

    it('PUT отклоняет «*» в исключениях (fail-closed: исключение не разрешает любой хост)', async () => {
      const { app } = createTestApp(tmpDir, FALLBACK);
      const res = await app.request('/api/v2/settings/mcp-network-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { mode: 'deny', list: [], exceptions: ['*'] } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.message).toBe(
        'policy: невалидная запись "*" (ожидается hostname, *.suffix, CIDR или IP)',
      );
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
      expect(onMcpNetworkPolicyChange).toHaveBeenCalledWith({ mode: 'allow', list: ['example.com'], exceptions: [] });
    });
  });

  describe('tools-disabled (ADR-071 §2.6)', () => {
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

  describe('ADR-072 Ф2: сброс runtime-настроек к умолчанию (GET meta + DELETE)', () => {
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

describe('Settings API Routes (workspace-policy, ADR-075)', () => {
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

describe('Settings API Routes (events, ADR-089)', () => {
  let tmpDir: string;
  const FALLBACK = '/default/env-or-config-workspace';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-events-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeEventsApp(
    fallbackEvents?: Partial<import('../../storage/runtime-settings.js').EventsRuntimeSettings>,
    opts?: { eventsWriteGuard?: import('hono').MiddlewareHandler },
  ) {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    const onEventsChange = vi.fn(async (_e: unknown) => {});
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: FALLBACK,
      ...(fallbackEvents ? { fallbackEvents } : {}),
      onEventsChange,
    }, opts ?? {}));
    return { app, settingsStore, onEventsChange };
  }

  it('GET /events — эффективные дефолты без runtime, isOverridden false', async () => {
    const { app } = makeEventsApp();
    const res = await app.request('/api/v2/settings/events');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.isOverridden).toBe(false);
    expect(body.defaults).toEqual({
      enabled: true,
      defaultMode: 'bound',
      ephemeralTtl: '24h',
      journalRetentionDays: 30,
      allowedSources: [],
      unknownAgentTemplate: 'drop',
      keyRateLimitPerMinute: 0,
      decisionRouting: false,
      autoBind: false,
      autoBindAgentTemplate: '',
      identityMap: {},
    });
    expect(body.events).toEqual(body.defaults);
  });

  it('GET /events — fallbackEvents из config перекрывает дефолты', async () => {
    const { app } = makeEventsApp({ enabled: false, ephemeralTtl: '1h', journalRetentionDays: 7 });
    const body: any = await (await app.request('/api/v2/settings/events')).json();
    expect(body.defaults.enabled).toBe(false);
    expect(body.defaults.ephemeralTtl).toBe('1h');
    expect(body.defaults.journalRetentionDays).toBe(7);
    expect(body.events).toEqual(body.defaults);
  });

  it('PUT /events — сохраняет патч, применяет поверх дефолтов, вызывает onEventsChange', async () => {
    const { app, settingsStore, onEventsChange } = makeEventsApp();
    const res = await app.request('/api/v2/settings/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: { enabled: false, keyRateLimitPerMinute: 10, allowedSources: ['telegram'] } }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.events).toMatchObject({ enabled: false, keyRateLimitPerMinute: 10, allowedSources: ['telegram'] });
    // Незаданные поля — дефолты.
    expect(body.events.defaultMode).toBe('bound');
    expect(await settingsStore.getEvents()).toEqual({ enabled: false, keyRateLimitPerMinute: 10, allowedSources: ['telegram'] });
    expect(onEventsChange).toHaveBeenCalledOnce();

    // GET отражает override.
    const get: any = await (await app.request('/api/v2/settings/events')).json();
    expect(get.isOverridden).toBe(true);
    expect(get.events.enabled).toBe(false);
  });

  it('PUT /events — autoBind/autoBindAgentTemplate сохраняются и применяются (ADR-089)', async () => {
    const { app, settingsStore, onEventsChange } = makeEventsApp();
    const res = await app.request('/api/v2/settings/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: { autoBind: true, autoBindAgentTemplate: 'assistant' } }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.events).toMatchObject({ autoBind: true, autoBindAgentTemplate: 'assistant' });
    expect(await settingsStore.getEvents()).toEqual({ autoBind: true, autoBindAgentTemplate: 'assistant' });
    expect(onEventsChange).toHaveBeenCalledWith(
      expect.objectContaining({ autoBind: true, autoBindAgentTemplate: 'assistant' }),
    );
  });

  it('PUT /events — identityMap сохраняется и применяется (ADR-089)', async () => {
    const { app, settingsStore, onEventsChange } = makeEventsApp();
    const res = await app.request('/api/v2/settings/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: { identityMap: { 'chat:telegram:1': 'u-1', 'tg:2': 'u-2' } } }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.events).toMatchObject({
      identityMap: { 'chat:telegram:1': 'u-1', 'tg:2': 'u-2' },
    });
    expect(await settingsStore.getEvents()).toEqual({
      identityMap: { 'chat:telegram:1': 'u-1', 'tg:2': 'u-2' },
    });
    expect(onEventsChange).toHaveBeenCalledWith(
      expect.objectContaining({ identityMap: { 'chat:telegram:1': 'u-1', 'tg:2': 'u-2' } }),
    );
  });

  it('PUT /events — невалидные поля → 400 VALIDATION_ERROR', async () => {
    const { app, onEventsChange } = makeEventsApp();
    const cases: unknown[] = [
      { events: 'nope' },
      { events: { defaultMode: 'bogus' } },
      { events: { journalRetentionDays: -1 } },
      { events: { keyRateLimitPerMinute: -1 } },
      { events: { allowedSources: 'telegram' } },
      { events: { unknownAgentTemplate: 'ghost' } },
      { events: { ephemeralTtl: '' } },
      { events: { decisionRouting: 'yes' } },
      { events: { autoBind: 'yes' } },
      { events: { autoBindAgentTemplate: 123 } },
      { events: { identityMap: 'nope' } },
      { events: { identityMap: { k: 123 } } },
    ];
    for (const body of cases) {
      const res = await app.request('/api/v2/settings/events', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR');
    }
    expect(onEventsChange).not.toHaveBeenCalled();
  });

  it('DELETE /events — сбрасывает к дефолтам и вызывает onEventsChange', async () => {
    const { app, settingsStore, onEventsChange } = makeEventsApp();
    await app.request('/api/v2/settings/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: { enabled: false } }),
    });
    const res = await app.request('/api/v2/settings/events', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe('restored');
    expect(body.isOverridden).toBe(false);
    expect(body.events.enabled).toBe(true);
    expect(await settingsStore.getEvents()).toEqual({});
    expect(onEventsChange).toHaveBeenCalledTimes(2);
  });

  it('eventsWriteGuard отклоняет PUT/DELETE, GET остаётся доступен', async () => {
    const deny: import('hono').MiddlewareHandler = async (c) =>
      c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
    const { app, settingsStore } = makeEventsApp(undefined, { eventsWriteGuard: deny });

    expect((await app.request('/api/v2/settings/events')).status).toBe(200);

    const put = await app.request('/api/v2/settings/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: { enabled: false } }),
    });
    expect(put.status).toBe(403);
    expect(await settingsStore.getEvents()).toEqual({});

    const del = await app.request('/api/v2/settings/events', { method: 'DELETE' });
    expect(del.status).toBe(403);
  });
});

describe('Settings API Routes (decision, ADR-084)', () => {
  let tmpDir: string;
  const FALLBACK = '/default/env-or-config-workspace';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-decision-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDecisionApp(
    fallbackDecision?: Partial<import('../../storage/runtime-settings.js').DecisionRuntimeSettings>,
    opts?: { decisionWriteGuard?: import('hono').MiddlewareHandler },
  ) {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    const onDecisionChange = vi.fn(async (_d: unknown) => {});
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: FALLBACK,
      ...(fallbackDecision ? { fallbackDecision } : {}),
      onDecisionChange,
    }, opts ?? {}));
    return { app, settingsStore, onDecisionChange };
  }

  it('GET /decision — эффективные дефолты без runtime, isOverridden false', async () => {
    const { app } = makeDecisionApp();
    const res = await app.request('/api/v2/settings/decision');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.isOverridden).toBe(false);
    expect(body.defaults).toEqual({
      enabled: false,
      provider: '',
      model: '',
      confidenceThreshold: 0.6,
      escalationProvider: '',
      escalationModel: '',
    });
    expect(body.decision).toEqual(body.defaults);
  });

  it('GET /decision — fallbackDecision из config перекрывает дефолты', async () => {
    const { app } = makeDecisionApp({ enabled: true, provider: 'routerai-decision' });
    const body: any = await (await app.request('/api/v2/settings/decision')).json();
    expect(body.defaults.enabled).toBe(true);
    expect(body.defaults.provider).toBe('routerai-decision');
    // Незаданные поля — дефолты схемы.
    expect(body.defaults.confidenceThreshold).toBe(0.6);
    expect(body.defaults.escalationProvider).toBe('');
    expect(body.defaults.escalationModel).toBe('');
  });

  it('PUT /decision — сохраняет escalation-тир и применяет поверх дефолтов', async () => {
    const { app, settingsStore } = makeDecisionApp();
    const res = await app.request('/api/v2/settings/decision', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: { escalationProvider: 'routerai-decision', escalationModel: 'clef' },
      }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.decision.escalationProvider).toBe('routerai-decision');
    expect(body.decision.escalationModel).toBe('clef');
    expect(await settingsStore.getDecision()).toEqual({
      escalationProvider: 'routerai-decision',
      escalationModel: 'clef',
    });
  });

  it('PUT /decision — сохраняет патч, применяет поверх дефолтов, вызывает onDecisionChange', async () => {
    const { app, settingsStore, onDecisionChange } = makeDecisionApp();
    const res = await app.request('/api/v2/settings/decision', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: { enabled: true, model: 'clef-flash', confidenceThreshold: 0.75 } }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.decision).toMatchObject({ enabled: true, model: 'clef-flash', confidenceThreshold: 0.75 });
    // Незаданные поля добраны дефолтами.
    expect(body.decision.provider).toBe('');
    expect(await settingsStore.getDecision()).toEqual({ enabled: true, model: 'clef-flash', confidenceThreshold: 0.75 });
    expect(onDecisionChange).toHaveBeenCalledOnce();

    const get: any = await (await app.request('/api/v2/settings/decision')).json();
    expect(get.isOverridden).toBe(true);
    expect(get.decision.enabled).toBe(true);
  });

  it('PUT /decision — невалидные поля → 400 VALIDATION_ERROR', async () => {
    const { app, onDecisionChange } = makeDecisionApp();
    const invalidBodies = [
      { decision: 'nope' },
      { decision: { enabled: 'yes' } },
      { decision: { confidenceThreshold: -0.1 } },
      { decision: { confidenceThreshold: 1.5 } },
      { decision: { confidenceThreshold: 'high' } },
      { decision: { provider: 42 } },
      { decision: { model: false } },
      { decision: { escalationProvider: 42 } },
      { decision: { escalationModel: false } },
    ];
    for (const body of invalidBodies) {
      const res = await app.request('/api/v2/settings/decision', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR');
    }
    expect(onDecisionChange).not.toHaveBeenCalled();
  });

  it('DELETE /decision — сбрасывает к дефолтам и вызывает onDecisionChange', async () => {
    const { app, settingsStore, onDecisionChange } = makeDecisionApp();
    await app.request('/api/v2/settings/decision', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: { enabled: true } }),
    });
    const res = await app.request('/api/v2/settings/decision', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe('restored');
    expect(body.isOverridden).toBe(false);
    expect(body.decision.enabled).toBe(false);
    expect(await settingsStore.getDecision()).toEqual({});
    expect(onDecisionChange).toHaveBeenCalledTimes(2);
  });

  it('decisionWriteGuard отклоняет PUT/DELETE, GET остаётся доступен', async () => {
    const deny: import('hono').MiddlewareHandler = async (c) =>
      c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
    const { app, settingsStore } = makeDecisionApp(undefined, { decisionWriteGuard: deny });

    expect((await app.request('/api/v2/settings/decision')).status).toBe(200);

    const put = await app.request('/api/v2/settings/decision', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: { enabled: true } }),
    });
    expect(put.status).toBe(403);
    expect(await settingsStore.getDecision()).toEqual({});

    const del = await app.request('/api/v2/settings/decision', { method: 'DELETE' });
    expect(del.status).toBe(403);
  });

  it('GET /decision/metrics — снимок метрик decision-слоя (requireAuth)', async () => {
    const { app } = makeDecisionApp();
    const res = await app.request('/api/v2/settings/decision/metrics');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.metrics).toMatchObject({
      calls: expect.any(Number),
      handled: expect.any(Number),
      fallback: expect.any(Number),
      escalated: expect.any(Number),
      attempts: { primary: expect.any(Number), escalation: expect.any(Number) },
      rejected: {
        ok: expect.any(Number),
        low_confidence: expect.any(Number),
        invalid: expect.any(Number),
        no_answer: expect.any(Number),
        no_provider: expect.any(Number),
        error: expect.any(Number),
      },
      by_model: expect.any(Object),
    });
    expect(typeof body.ts).toBe('string');
  });

  it('DELETE /decision/metrics — сбрасывает накопители (decisionWriteGuard)', async () => {
    const { app } = makeDecisionApp();
    const res = await app.request('/api/v2/settings/decision/metrics', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.metrics.calls).toBe(0);
    expect(body.metrics.handled).toBe(0);
    expect(body.metrics.fallback).toBe(0);
    expect(body.metrics.escalated).toBe(0);
    expect(body.metrics.attempts).toEqual({ primary: 0, escalation: 0 });
    expect(body.metrics.rejected).toEqual({
      ok: 0,
      low_confidence: 0,
      invalid: 0,
      no_answer: 0,
      no_provider: 0,
      error: 0,
    });
    expect(body.metrics.by_model).toEqual({});
  });

  it('decisionWriteGuard отклоняет DELETE /decision/metrics, GET доступен', async () => {
    const deny: import('hono').MiddlewareHandler = async (c) =>
      c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
    const { app } = makeDecisionApp(undefined, { decisionWriteGuard: deny });

    expect((await app.request('/api/v2/settings/decision/metrics')).status).toBe(200);
    const del = await app.request('/api/v2/settings/decision/metrics', { method: 'DELETE' });
    expect(del.status).toBe(403);
  });
});
describe('Settings API Routes — egress (настраиваемая политика)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-egress-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeEgressApp(extra: Partial<import('./settings.js').SettingsRoutesDeps> = {}) {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: '/default/egress-test-workspace',
      ...extra,
    }));
    const json = (method: string, path: string, body?: unknown) => app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { app, settingsStore, json };
  }

  it('mode=off принимается для egress.webhooks и отклоняется для tools/mcp', async () => {
    const { json } = makeEgressApp();
    const off = { mode: 'off', list: [], exceptions: [] };

    expect((await json('PUT', '/api/v2/settings/egress/webhooks', { policy: off })).status).toBe(200);
    expect((await json('PUT', '/api/v2/settings/egress/tools', { policy: off })).status).toBe(400);
    expect((await json('PUT', '/api/v2/settings/mcp-network-policy', { policy: off })).status).toBe(400);
  });

  it('невалидные записи политики → 400 VALIDATION_ERROR', async () => {
    const { json } = makeEgressApp();
    for (const rule of ['10.0.0.0/33', 'bad host', '']) {
      const res = await json('PUT', '/api/v2/settings/egress/tools', {
        policy: { mode: 'deny', list: [rule], exceptions: [] },
      });
      expect(res.status, rule || '(empty)').toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
    const badException = await json('PUT', '/api/v2/settings/egress/tools', {
      policy: { mode: 'deny', list: [], exceptions: ['bad host'] },
    });
    expect(badException.status).toBe(400);
  });

  it('POST /egress/check не делает сетевой запрос и отдаёт matchedRule/addresses', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { json } = makeEgressApp();

    const res = await json('POST', '/api/v2/settings/egress/check', {
      scope: 'tools',
      url: 'https://10.0.0.5/x',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      allowed: boolean;
      reason?: string;
      matchedRule?: string;
      addresses?: string[];
    };
    expect(body.allowed).toBe(false);
    expect(body.reason).toBeTruthy();
    expect(body.matchedRule).toBe('10.0.0.0/8');
    expect(body.addresses).toEqual(['10.0.0.5']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('live: смена политики в сторе видна следующему /egress/check без пересоздания app', async () => {
    const { json } = makeEgressApp();
    const check = async () => (await (await json('POST', '/api/v2/settings/egress/check', {
      scope: 'tools',
      url: 'https://93.184.216.34/x',
    })).json() as { allowed: boolean });

    expect((await check()).allowed).toBe(true);
    expect((await json('PUT', '/api/v2/settings/egress/tools', {
      policy: { mode: 'allow', list: ['93.184.216.34/32'], exceptions: [] },
    })).status).toBe(200);
    expect((await check()).allowed).toBe(true);

    expect((await json('PUT', '/api/v2/settings/egress/tools', {
      policy: { mode: 'deny', list: ['93.184.216.34/32'], exceptions: [] },
    })).status).toBe(200);
    expect((await check()).allowed).toBe(false);
  });

  it('аудит: PUT и DELETE пишут before/after, actor, scope', async () => {
    const audit = new MemorySecurityAuditRepository();
    const { json } = makeEgressApp({ securityAudit: audit });
    const policy = { mode: 'allow', list: ['10.0.0.0/8'], exceptions: [] };

    expect((await json('PUT', '/api/v2/settings/egress/tools', { policy })).status).toBe(200);
    expect((await json('DELETE', '/api/v2/settings/egress/tools')).status).toBe(200);

    const entries = await audit.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.action).toBe('reset');
    expect(entries[0]!.scope).toBe('tools');
    expect(entries[0]!.actor).toBe('local');
    expect(entries[0]!.before).toEqual(policy);
    expect(entries[0]!.after).toBeNull();
    expect(entries[1]!.action).toBe('update');
    expect(entries[1]!.after).toEqual(policy);
  });

  it('ошибка аудита не ломает ответ PUT', async () => {
    const broken = {
      append: async () => { throw new Error('audit down'); },
      list: async () => [],
      clear: async () => 0,
    } as unknown as MemorySecurityAuditRepository;
    const { json } = makeEgressApp({ securityAudit: broken });

    const res = await json('PUT', '/api/v2/settings/egress/webhooks', {
      policy: { mode: 'deny', list: [], exceptions: [] },
    });
    expect(res.status).toBe(200);
  });
});

describe('Settings API Routes — default-model (явная пара provider+model)', () => {
  let tmpDir: string;
  const FALLBACK = '/fallback/workspace';
  const CONFIG_PAIR = { provider: 'openai', model: 'gpt-4o' };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-default-model-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeApp(deps: Partial<Parameters<typeof createSettingsRoutes>[1]> = {}) {
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
    app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
      settingsStore,
      fallbackWorkspace: FALLBACK,
      ...deps,
    }));
    return { app, settingsStore };
  }

  function json(method: string, body?: unknown): RequestInit {
    return {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  }

  it('GET без runtime и без config-fallback → { defaultModel: null, isOverridden: false, defaults: null }', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/settings/default-model');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ defaultModel: null, isOverridden: false, defaults: null });
  });

  it('GET отдаёт config-fallback, пока runtime не задан', async () => {
    const { app } = makeApp({ fallbackDefaultModel: CONFIG_PAIR });
    const res = await app.request('/api/v2/settings/default-model');
    expect(await res.json()).toEqual({
      defaultModel: null,
      isOverridden: false,
      defaults: CONFIG_PAIR,
    });
  });

  it('PUT сохраняет пару и переживает рестарт; GET показывает override', async () => {
    const { app } = makeApp({ fallbackDefaultModel: CONFIG_PAIR });
    const put = await app.request('/api/v2/settings/default-model', json('PUT', {
      provider: '  ollama  ',
      model: '  qwen3:8b  ',
    }));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ defaultModel: { provider: 'ollama', model: 'qwen3:8b' } });

    const restarted = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await restarted.getDefaultModel()).toEqual({ provider: 'ollama', model: 'qwen3:8b' });

    const get = await app.request('/api/v2/settings/default-model');
    expect(await get.json()).toEqual({
      defaultModel: { provider: 'ollama', model: 'qwen3:8b' },
      isOverridden: true,
      defaults: CONFIG_PAIR,
    });
  });

  it('DELETE сбрасывает к config-fallback и снимает override', async () => {
    const { app, settingsStore } = makeApp({ fallbackDefaultModel: CONFIG_PAIR });
    await settingsStore.setDefaultModel({ provider: 'ollama', model: 'qwen3:8b' });

    const res = await app.request('/api/v2/settings/default-model', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'restored',
      defaultModel: CONFIG_PAIR,
      isOverridden: false,
      defaults: CONFIG_PAIR,
    });
    expect(await settingsStore.getDefaultModel()).toBeUndefined();
  });

  it('PUT с пустыми/отсутствующими provider или model → 400 VALIDATION_ERROR', async () => {
    const { app, settingsStore } = makeApp();
    for (const body of [{}, { provider: 'openai' }, { model: 'gpt-4o' }, { provider: '  ', model: 'x' }, { provider: 'x', model: '   ' }]) {
      const res = await app.request('/api/v2/settings/default-model', json('PUT', body));
      expect(res.status).toBe(400);
      const parsed = await res.json() as { error: { code: string } };
      expect(parsed.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await settingsStore.getDefaultModel()).toBeUndefined();
  });

  it('PUT с невалидным телом (не JSON) → 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/settings/default-model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
  });

  it('validateDefaultModel: строковый отказ → 400 с причиной, пара не сохраняется', async () => {
    const { app, settingsStore } = makeApp({
      validateDefaultModel: async () => 'провайдер "ghost" не найден',
    });
    const res = await app.request('/api/v2/settings/default-model', json('PUT', {
      provider: 'ghost',
      model: 'm1',
    }));
    expect(res.status).toBe(400);
    const parsed = await res.json() as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.message).toContain('ghost');
    expect(await settingsStore.getDefaultModel()).toBeUndefined();
  });

  it('validateDefaultModel: false → 400 generic; true → сохраняет и вызывает onDefaultModelChange', async () => {
    const changes: unknown[] = [];
    const { app } = makeApp({
      validateDefaultModel: async (pair) => pair.provider === 'openai',
      onDefaultModelChange: (pair) => { changes.push(pair); },
    });

    const bad = await app.request('/api/v2/settings/default-model', json('PUT', {
      provider: 'other',
      model: 'm1',
    }));
    expect(bad.status).toBe(400);

    const ok = await app.request('/api/v2/settings/default-model', json('PUT', {
      provider: 'openai',
      model: 'gpt-4o',
    }));
    expect(ok.status).toBe(200);
    expect(changes).toEqual([{ provider: 'openai', model: 'gpt-4o' }]);

    await app.request('/api/v2/settings/default-model', { method: 'DELETE' });
    expect(changes).toEqual([{ provider: 'openai', model: 'gpt-4o' }, null]);
  });
});
