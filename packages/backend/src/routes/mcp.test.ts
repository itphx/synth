import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpRegistryStore } from '@itphx/synth-core';
import type { McpManager, SessionManager } from '@itphx/synth-core';
import { createMcpRoutes } from './mcp.js';
import type { McpServerConfig, SessionSettings } from '@itphx/synth-shared';
import type { AuthKit } from '../auth/middleware.js';

/** Запись сервера: карта `GET /servers` и деталь `GET|POST|PUT /servers/:name`. */
interface McpServerBody {
  name: string;
  config: McpServerConfig;
  connected?: boolean;
}

/** Инструмент в ответах probe/test/tools: маршруты отдают `{ name, description }`. */
interface McpToolInfo {
  name: string;
  description?: string;
}

/** `POST /api/v2/mcp/probe`. */
interface McpProbeBody {
  name: string;
  tools: McpToolInfo[];
}

/** `POST /api/v2/mcp/servers/:name/test`. */
interface McpServerTestBody {
  success: boolean;
  error?: string;
  toolCount?: number;
  tools?: McpToolInfo[];
}

/** `GET /api/v2/mcp/servers/:name/tools`. */
interface McpServerToolsBody {
  server: string;
  tools: McpToolInfo[];
  connected: boolean;
  probed?: boolean;
  error?: string;
}

/** MCP-скоуп сессии (`GET|PUT /api/v2/mcp/session/:sessionId`). */
interface McpSessionScopeBody {
  mcpServers: string[];
  mcpDisabledServers: string[];
  allServers: Array<{ name: string; active: boolean }>;
}

/** Тело ошибки HTTP-ответа: `{ error: { code, message } }`. */
interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * Мок AuthKit: guard'ы пропускают запрос, админ-проверка всегда `true`
 * (пользователя в контекст ставит `app.use('*', ...)` харнеса).
 */
function createMockKit(): AuthKit {
  // Фейк: реализованы только requireAuth/requireAdmin/isAdmin.
  return {
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
    requireAdmin: async (_c: Context, next: Next) => {
      await next();
    },
    isAdmin: () => true,
  } as unknown as AuthKit;
}

function makeStdioConfig(): McpServerConfig {
  return {
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
  };
}

function makeSseConfig(): McpServerConfig {
  return {
    type: 'sse',
    url: 'http://localhost:8080/mcp',
  };
}

function createMockMcpManager(connected: boolean = false) {
  return {
    getConfiguredServers: vi.fn(() => [
      { name: 'test-server', config: makeStdioConfig(), connected },
    ]),
    isServerConfigured: vi.fn((name: string) => name === 'test-server'),
    getServerConfig: vi.fn((name: string) => (name === 'test-server' ? makeStdioConfig() : undefined)),
    connectServer: vi.fn(),
    disconnectServer: vi.fn(),
    disconnectAll: vi.fn(),
    probeServer: vi.fn(async (name: string) => {
      if (name !== 'test-server') throw new Error(`MCP-сервер "${name}" не настроен`);
      return [
        { name: 'tool1', description: 'First tool', inputSchema: { type: 'object' } },
        { name: 'tool2', description: 'Second tool', inputSchema: { type: 'object' } },
      ];
    }),
    getServerTools: vi.fn((name: string) => {
      if (name !== 'test-server') return null;
      return connected
        ? [
            { name: 'tool1', description: 'First', inputSchema: { type: 'object' } },
            { name: 'tool2', description: 'Second', inputSchema: { type: 'object' } },
          ]
        : null;
    }),
    refreshServer: vi.fn(),
    setConfig: vi.fn(),
    setServerOrigins: vi.fn(),
    setServerTrusts: vi.fn(),
    setServerAuthors: vi.fn(),
    setDefaultServers: vi.fn(),
    setServerSystemEnabled: vi.fn(),
    getConfig: vi.fn(() => ({ 'test-server': makeStdioConfig() })),
  };
}

/** Состояние фейковой сессии: метаданные + «свидетель» в истории. */
interface FakeSession {
  id: string;
  settings: SessionSettings;
  /** Время последней записи — проверяется паритет `touchUpdatedAt`. */
  updatedAt: string;
  /** История (для проверки, что точечная правка её не переписывает). */
  messages: Array<{ id: string; content: string }>;
}

/** Заведомо старая метка: любое движение `updatedAt` видно однозначно. */
const FAKE_OLD_STAMP = '2020-01-01T00:00:00.000Z';

function createMockSessionManager() {
  const sessions = new Map<string, FakeSession>();
  return {
    getSession: async (id: string) => {
      return sessions.get(id) ?? null;
    },
    saveSession: async (session: FakeSession) => {
      sessions.set(session.id, session);
    },
    /**
     * Порт `SessionRepository.mutateMeta`: мутатор работает с **клоном**
     * метаданных, `shouldWrite`/`touchUpdatedAt` соблюдаются, отсутствующая
     * сессия — `{found:false}` (мутатор не вызывается).
     */
    mutateMeta: async (
      id: string,
      mutator: (meta: FakeSession) => unknown,
      opts?: { touchUpdatedAt?: boolean; shouldWrite?: (value: unknown) => boolean },
    ) => {
      const current = sessions.get(id);
      if (!current) return { found: false as const };
      const meta = structuredClone(current);
      const value = mutator(meta);
      if (opts?.shouldWrite && !opts.shouldWrite(value)) {
        return { found: true as const, value, session: current };
      }
      if (opts?.touchUpdatedAt !== false) meta.updatedAt = new Date().toISOString();
      sessions.set(id, meta);
      return { found: true as const, value, session: meta };
    },
    _setSession(id: string, settings: Partial<SessionSettings>) {
      sessions.set(id, {
        id,
        settings: settings as SessionSettings,
        updatedAt: FAKE_OLD_STAMP,
        messages: [],
      });
    },
    /** Записать «свидетеля» в историю (как уже существующее сообщение). */
    _addMessage(id: string, content: string) {
      const session = sessions.get(id);
      if (!session) throw new Error(`Нет фейковой сессии ${id}`);
      session.messages = [...session.messages, { id: `m${session.messages.length + 1}`, content }];
    },
    _getSession(id: string) {
      return sessions.get(id) ?? null;
    },
  };
}

function createTestApp(
  registry: McpRegistryStore,
  mcpManager: ReturnType<typeof createMockMcpManager>,
  sessionManager: ReturnType<typeof createMockSessionManager>,
) {
  const app = new Hono();
  const kit = createMockKit();
  // Харнес считает запросы админскими (`isAdmin: () => true`); в реальном
  // backend контекст ставит глобальный `attachUser`, поэтому воспроизводим
  // ADMIN-пользователя — комбинированные guard'ы читают `c.get('user')`.
  app.use('*', async (c: Context, next: Next) => {
    c.set('user', { id: 'admin', username: 'admin', roles: ['ADMIN'] });
    await next();
  });
  const mcpRoutes = createMcpRoutes(
    kit,
    // Фейк: реализованы только методы, нужные legacy-роутам/пробе.
    mcpManager as unknown as McpManager,
    // Фейк: реализованы getSession/saveSession/mutateMeta (нужны `/session/:id`).
    sessionManager as unknown as SessionManager,
    { registry },
  );
  app.route('/api/v2/mcp', mcpRoutes);
  return app;
}

describe('MCP API Routes (legacy /servers — адаптеры над реестром)', () => {
  let registry: McpRegistryStore;
  let tmpDir: string;
  let mcpManager: ReturnType<typeof createMockMcpManager>;
  let sessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-mcp-routes-'));
    registry = new McpRegistryStore({ dataDir: tmpDir });
    await registry.add({ name: 'test-server', config: makeStdioConfig(), origin: 'instance', trust: 'builtin' });
    mcpManager = createMockMcpManager(true);
    sessionManager = createMockSessionManager();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/v2/mcp/servers', () => {
    it('возвращает список серверов со статусом подключения', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, McpServerBody>;
      expect(body['test-server']).toBeDefined();
      expect(body['test-server']!.config.type).toBe('stdio');
      expect(body['test-server']!.connected).toBe(true);
    });

    it('возвращает empty объект когда серверов нет', async () => {
      const emptyRegistry = new McpRegistryStore({ dataDir: join(tmpDir, 'empty') });
      mcpManager.getConfiguredServers.mockReturnValue([]);
      const app = createTestApp(emptyRegistry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, McpServerBody>;
      expect(Object.keys(body)).toHaveLength(0);
    });
  });

  describe('POST /api/v2/mcp/servers', () => {
    it('добавляет новый сервер', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'new-server',
          config: { type: 'stdio', command: 'python', args: ['server.py'] },
        }),
      });
      expect(res.status).toBe(201);
      expect(await registry.getByName('new-server')).not.toBeNull();
    });

    it('ADR-071: сохраняет description сервера', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'described',
          config: { type: 'sse', url: 'http://localhost/mcp', description: 'Мой MCP' },
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as McpServerBody;
      expect(body.config.description).toBe('Мой MCP');
      const entry = await registry.getByName('described');
      expect(entry?.config.description).toBe('Мой MCP');
    });

    it('возвращает 409 для дубликата', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test-server',
          config: makeStdioConfig(),
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error?.code).toBe('CONFLICT');
    });

    it('возвращает 400 для невалидного тела', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '', config: {} }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v2/mcp/servers/:name', () => {
    it('возвращает конфигурацию сервера', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server');
      expect(res.status).toBe(200);
      const body = (await res.json()) as McpServerBody;
      expect(body.name).toBe('test-server');
      expect(body.config.type).toBe('stdio');
    });

    it('возвращает 404 для неизвестного сервера', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/v2/mcp/servers/:name', () => {
    it('обновляет существующий сервер', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeSseConfig()),
      });
      expect(res.status).toBe(200);
      const entry = await registry.getByName('test-server');
      expect(entry?.config.type).toBe('sse');
      expect(mcpManager.setConfig).toHaveBeenCalled();
    });

    it('возвращает 404 для неизвестного сервера', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeStdioConfig()),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v2/mcp/servers/:name', () => {
    it('удаляет сервер', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await registry.getByName('test-server')).toBeNull();
      expect(mcpManager.disconnectServer).toHaveBeenCalledWith('test-server');
    });

    it('возвращает 404 для неизвестного сервера', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/mcp/servers/:name/test', () => {
    it('успешно тестирует подключение', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server/test', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as McpServerTestBody;
      expect(body.success).toBe(true);
      expect(body.tools).toHaveLength(2);
    });

    it('возвращает ошибку для неизвестного сервера', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown/test', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('возвращает ошибку при сбое probe', async () => {
      mcpManager.probeServer.mockRejectedValueOnce(new Error('Connection timeout'));
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server/test', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as McpServerTestBody;
      expect(body.success).toBe(false);
      expect(body.error).toContain('Connection timeout');
    });
  });

  describe('POST /api/v2/mcp/probe', () => {
    it('успешно пробует сервер и возвращает инструменты', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-server' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as McpProbeBody;
      expect(body.name).toBe('test-server');
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0]).toEqual({ name: 'tool1', description: 'First tool' });
    });

    it('возвращает 400 для пустого name', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '  ' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 400 для ненастроенного сервера', async () => {
      mcpManager.isServerConfigured.mockReturnValue(false);
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'unknown' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 500 при сбое probe', async () => {
      mcpManager.probeServer.mockRejectedValueOnce(new Error('Connection timeout'));
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-server' }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error?.code).toBe('MCP_CONNECT_ERROR');
      expect(body.error?.message).toContain('Connection timeout');
    });
  });

  describe('GET /api/v2/mcp/servers/:name/tools', () => {
    it('возвращает инструменты подключённого сервера', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server/tools');
      expect(res.status).toBe(200);
      const body = (await res.json()) as McpServerToolsBody;
      expect(body.server).toBe('test-server');
      expect(body.connected).toBe(true);
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0]!.name).toBe('tool1');
    });

    it('пробует получить инструменты отключённого сервера', async () => {
      mcpManager = createMockMcpManager(false);
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/test-server/tools');
      expect(res.status).toBe(200);
      const body = (await res.json()) as McpServerToolsBody;
      expect(body.connected).toBe(false);
      expect(body.probed).toBe(true);
      expect(body.tools).toHaveLength(2);
    });

    it('возвращает 404 для неизвестного сервера', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/servers/unknown/tools');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v2/mcp/session/:sessionId', () => {
    it('возвращает активные MCP-серверы сессии', async () => {
      sessionManager._setSession('s1', { mcpServers: ['test-server', 'other'] });
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/s1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as McpSessionScopeBody;
      expect(body.mcpServers).toContain('test-server');
      const testSrv = body.allServers.find((s) => s.name === 'test-server')!;
      expect(testSrv).toBeDefined();
      expect(testSrv.active).toBe(true);
    });

    it('возвращает 404 для несуществующей сессии', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/v2/mcp/session/:sessionId', () => {
    it('устанавливает активные MCP-серверы для сессии', async () => {
      sessionManager._setSession('s1', { mcpServers: [] });
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/s1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers: ['test-server'] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as McpSessionScopeBody;
      expect(body.mcpServers).toContain('test-server');
    });

    it('пишет через mutateMeta: updatedAt не двигается, свидетель цел, ответ прежний', async () => {
      // Второй сервер в реестре — чтобы проверить и opt-out список.
      await registry.add({ name: 'other', config: makeStdioConfig(), origin: 'instance', trust: 'builtin' });
      sessionManager._setSession('s1', { mcpServers: [] });
      // «Свидетель» — уже существующее сообщение: правка MCP-скоупа не должна
      // переписывать историю снимком.
      sessionManager._addMessage('s1', 'свидетель');
      const app = createTestApp(registry, mcpManager, sessionManager);

      const res = await app.request('/api/v2/mcp/session/s1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers: ['test-server'], mcpDisabledServers: ['other'] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        mcpServers: string[];
        mcpDisabledServers: string[];
        allServers: Array<{ name: string; active: boolean }>;
      };
      // Ответ прежний: оба поля скоупа и флаг активности.
      expect(body.mcpServers).toEqual(['test-server']);
      expect(body.mcpDisabledServers).toEqual(['other']);
      expect(body.allServers.find((s) => s.name === 'test-server')?.active).toBe(true);

      const saved = sessionManager._getSession('s1')!;
      expect(saved.settings.mcpServers).toEqual(['test-server']);
      expect(saved.settings.mcpDisabledServers).toEqual(['other']);
      expect(saved.messages.map((m) => m.content)).toEqual(['свидетель']);
      // Паритет: legacy-роут писал через `saveSession` — `updatedAt` не двигался.
      expect(saved.updatedAt).toBe(FAKE_OLD_STAMP);
    });

    it('возвращает 400 для невалидного тела', async () => {
      sessionManager._setSession('s1', { mcpServers: [] });
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/s1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrong: 'field' }),
      });
      expect(res.status).toBe(400);
    });

    it('возвращает 404 для несуществующей сессии', async () => {
      const app = createTestApp(registry, mcpManager, sessionManager);
      const res = await app.request('/api/v2/mcp/session/nonexistent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers: ['test-server'] }),
      });
      expect(res.status).toBe(404);
    });
  });
});
