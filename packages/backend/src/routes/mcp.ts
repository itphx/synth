import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, McpManager } from '@synth/core';
import type { McpServerConfig } from '@synth/shared';

const mcpServerConfigSchema = z.object({
  type: z.enum(['stdio', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  enabled: z.boolean().optional(),
  enabledByDefault: z.boolean().optional(),
  timeout: z.number().int().min(1).optional(),
  connectTimeout: z.number().int().min(1).optional(),
});

const addServerSchema = z.object({
  name: z.string().min(1),
  config: mcpServerConfigSchema,
});

const updateServerSchema = mcpServerConfigSchema;

const sessionMcpSchema = z.object({
  mcpServers: z.array(z.string()),
});

export interface McpConfigStore {
  getServers(): Record<string, McpServerConfig>;
  addServer(name: string, config: McpServerConfig): Promise<void>;
  updateServer(name: string, config: McpServerConfig): Promise<void>;
  deleteServer(name: string): Promise<void>;
  hasServer(name: string): boolean;
  getServer(name: string): McpServerConfig | undefined;
}

export function createMcpRoutes(
  kit: AuthKit,
  configStore: McpConfigStore,
  mcpManager: McpManager | null,
  sessionManager: SessionManager | null,
): Hono {
  const app = new Hono();

  // --- Список настроенных серверов ---
  app.get('/servers', kit.requireAuth, (c) => {
    const servers = configStore.getServers();
    const result: Record<string, { name: string; config: McpServerConfig; connected: boolean }> = {};

    for (const [name, config] of Object.entries(servers)) {
      const connected = mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;
      result[name] = { name, config, connected };
    }

    return c.json(result);
  });

  // --- Добавить сервер ---
  app.post('/servers', kit.requireAdmin, async (c) => {
    const body = await c.req.json();
    const parsed = addServerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const { name, config } = parsed.data;
    if (configStore.hasServer(name)) {
      return c.json({ error: { code: 'CONFLICT', message: `Сервер "${name}" уже существует` } }, 409);
    }

    await configStore.addServer(name, config);

    // Синхронизируем конфиг менеджера, чтобы сервер сразу был доступен probe
    if (mcpManager) {
      mcpManager.setConfig({
        ...mcpManager.getConfig(),
        [name]: config,
      });
    }

    const connected = mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;
    return c.json({ name, config, connected }, 201);
  });

  // --- Получить сервер ---
  app.get('/servers/:name', kit.requireAuth, (c) => {
    const name = c.req.param('name');
    const config = configStore.getServer(name);
    if (!config) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    const connected = mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;
    return c.json({ name, config, connected });
  });

  // --- Обновить сервер ---
  app.put('/servers/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    if (!configStore.hasServer(name)) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    const body = await c.req.json();
    const parsed = updateServerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    await configStore.updateServer(name, parsed.data);

    // Если сервер был подключён — переподключаем
    if (mcpManager) {
      mcpManager.setConfig({
        ...mcpManager.getConfig(),
        [name]: parsed.data,
      });
    }

    const connected = mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;
    return c.json({ name, config: parsed.data, connected });
  });

  // --- Удалить сервер ---
  app.delete('/servers/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    if (!configStore.hasServer(name)) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    if (mcpManager) {
      await mcpManager.disconnectServer(name);
    }
    await configStore.deleteServer(name);

    return c.json({ success: true });
  });

  // --- Проверить подключение ---
  app.post('/servers/:name/test', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');

    // Принимаем опциональный конфиг в теле — для теста до сохранения
    let config = configStore.getServer(name);
    try {
      const body = await c.req.json();
      const bodyConfig = body?.config as McpServerConfig | undefined;
      if (bodyConfig) {
        config = bodyConfig;
      }
    } catch {
      // тело не JSON — используем конфиг из хранилища
    }

    if (!config) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    if (!mcpManager) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'McpManager не настроен' } }, 500);
    }

    try {
      mcpManager.setConfig({ ...mcpManager.getConfig(), [name]: config });
      const tools = await mcpManager.probeServer(name);
      return c.json({ success: true, toolCount: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description })) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, error: message });
    }
  });

  // --- Probe по имени (алиас для UI; core-совместимый формат) ---
  // POST /api/v2/mcp/probe body { name } → 200 { name, tools: [{ name, description }] }.
  // Сервер не настроен → 400 VALIDATION_ERROR, ошибка подключения → 500 MCP_CONNECT_ERROR.
  app.post('/probe', kit.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof (body as { name?: unknown }).name === 'string'
      ? ((body as { name: string }).name).trim()
      : '';

    if (!name) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Поле name обязательно и не может быть пустым' },
      }, 400);
    }

    if (!mcpManager) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'McpManager не настроен' } }, 500);
    }

    if (!mcpManager.isServerConfigured(name)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: `MCP-сервер "${name}" не настроен` },
      }, 400);
    }

    try {
      const tools = await mcpManager.probeServer(name);
      return c.json({
        name,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
    } catch (err) {
      return c.json({
        error: {
          code: 'MCP_CONNECT_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      }, 500);
    }
  });

  // --- Список инструментов сервера ---
  app.get('/servers/:name/tools', kit.requireAuth, async (c) => {
    const name = c.req.param('name');
    const config = configStore.getServer(name);
    if (!config) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    if (!mcpManager) {
      return c.json({ tools: [] });
    }

    const entry = mcpManager.getConfiguredServers().find((s) => s.name === name);
    if (!entry?.connected) {
      try {
        const tools = await mcpManager.probeServer(name);
        return c.json({ server: name, tools, connected: false, probed: true });
      } catch (err) {
        return c.json({ server: name, tools: [], connected: false, probed: true, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const tools = mcpManager.getServerTools(name) ?? [];

    return c.json({
      server: name,
      tools,
      connected: true,
    });
  });

  // --- MCP-серверы сессии ---
  if (sessionManager) {
    app.get('/session/:sessionId', kit.requireAuth, async (c) => {
      const sessionId = c.req.param('sessionId');
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
      }

      const configuredServers = configStore.getServers();
      const allServers = Object.keys(configuredServers).map((name) => ({
        name,
        active: (session.settings.mcpServers || []).includes(name),
      }));

      return c.json({
        mcpServers: session.settings.mcpServers || [],
        allServers,
      });
    });

    app.put('/session/:sessionId', kit.requireAuth, async (c) => {
      const sessionId = c.req.param('sessionId');
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
      }

      const body = await c.req.json();
      const parsed = sessionMcpSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
      }

      const { mcpServers } = parsed.data;

      for (const name of mcpServers) {
        if (!configStore.hasServer(name)) {
          return c.json({ error: { code: 'VALIDATION_ERROR', message: `Сервер "${name}" не настроен` } }, 400);
        }
      }

      session.settings.mcpServers = mcpServers;
      await sessionManager.saveSession(session);

      return c.json({
        mcpServers: session.settings.mcpServers,
        allServers: Object.keys(configStore.getServers()).map((name) => ({
          name,
          active: mcpServers.includes(name),
        })),
      });
    });
  }

  return app;
}
